/**
 * Offline, deterministic geometric shape recogniser.
 *
 * Classifies a stroke (or a small group of strokes) as
 *   line | arrow | circle | ellipse | rectangle | triangle | diamond | none
 * and returns a fitted, *snapped* geometry plus a confidence in [0, 1].
 *
 * Approach:
 *  - lines: chord/arc-length ratio and max deviation from the chord;
 *  - arrows: a straight shaft ending in a short head (one or two barbs pointing back),
 *    either within the same stroke (tail → tip → barbs) or as separate nearby strokes;
 *  - closed shapes (endpoint gap small vs. perimeter, overshoot trimmed): the convex hull is
 *    reduced to 3/4 vertices (Visvalingam area elimination); area ratios + point-to-edge
 *    residuals decide triangle/quad; quads are split into rectangles (right angles) and
 *    diamonds (vertices at bbox side midpoints); otherwise a PCA ellipse fit decides
 *    circle/ellipse. Non-convex loops ("8", "B", letters) are rejected.
 */
import type { Stroke } from '../schema';
import {
  angleDeg,
  angleDiff,
  bbox,
  centroid,
  convexHull,
  dist,
  distPointSegment,
  distToPolygon,
  pathLength,
  polygonArea,
  resample,
  rotate,
  strokePoints,
  type Pt,
} from './geometry';

export type ShapeKind = 'line' | 'arrow' | 'circle' | 'ellipse' | 'rectangle' | 'triangle' | 'diamond' | 'none';

export type ShapeGeometry =
  | { kind: 'line'; a: Pt; b: Pt }
  /** a = tail, b = tip; `heads: 'both'` draws a head at `a` too */
  | { kind: 'arrow'; a: Pt; b: Pt; heads: 'end' | 'both' }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  /** rotation in degrees (clockwise, y down), rx along the rotated x axis */
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { kind: 'rectangle'; cx: number; cy: number; w: number; h: number; rotation: number }
  | { kind: 'triangle'; points: [Pt, Pt, Pt] }
  | { kind: 'diamond'; cx: number; cy: number; w: number; h: number }
  | { kind: 'none' };

export interface Recognition {
  kind: ShapeKind;
  confidence: number;
  geometry: ShapeGeometry;
  strokeIds: string[];
}

/** Minimum confidence for treating a recognition as a shape. */
export const SHAPE_CONFIDENCE = 0.6;
/** Angles within this many degrees of a multiple of 45° snap to it. */
export const ANGLE_SNAP_DEG = 8;
/** Rectangles/ellipses whose rotation is within this many degrees of axis-aligned snap. */
export const AXIS_SNAP_DEG = 10;
/** Ellipses with minor/major ratio above this become circles. */
export const CIRCLE_RATIO = 0.85;

const NONE: ShapeGeometry = { kind: 'none' };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function none(ids: string[] = []): Recognition {
  return { kind: 'none', confidence: 0, geometry: NONE, strokeIds: ids };
}

function dedupe(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || l.x !== p.x || l.y !== p.y) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Snaps segment ab to the nearest multiple of 45° (rotating about its midpoint) when within `tol` degrees. */
export function snapSegment(a: Pt, b: Pt, tol = ANGLE_SNAP_DEG): [Pt, Pt] {
  const ang = angleDeg(a, b);
  const target = Math.round(ang / 45) * 45;
  if (Math.abs(ang - target) > tol) return [{ ...a }, { ...b }];
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const half = dist(a, b) / 2;
  const r = (target * Math.PI) / 180;
  const dx = Math.cos(r) * half;
  const dy = Math.sin(r) * half;
  const fix = (v: number) => Math.round(v * 10) / 10;
  return [
    { x: fix(m.x - dx), y: fix(m.y - dy) },
    { x: fix(m.x + dx), y: fix(m.y + dy) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Lines

interface LineFit {
  a: Pt;
  b: Pt;
  straightness: number;
  maxDev: number;
  conf: number;
}

function fitLine(pts: readonly Pt[]): LineFit | null {
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);
  const L = pathLength(pts);
  if (chord < 8 || L === 0) return null;
  const straightness = chord / L;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, distPointSegment(p, a, b));
  const devRatio = maxDev / chord;
  if (straightness < 0.93 || devRatio > 0.08) return null;
  const conf = 0.6 + 0.4 * Math.min(clamp01((straightness - 0.93) / 0.05), clamp01(1 - devRatio / 0.08));
  return { a, b, straightness, maxDev, conf };
}

// ---------------------------------------------------------------------------------------------
// Arrows

interface HeadAnalysis {
  sides: number;
  /** most forward point along the shaft direction (negative = ahead of the tip) */
  forward: number;
  conf: number;
}

/**
 * Analyses head points relative to a tip. `back` is the unit vector from the tip towards the tail.
 * Barbs must point backwards at 12°–75° from the shaft and be 10%–45% of the shaft length.
 */
function analyzeHead(tip: Pt, back: Pt, pts: readonly Pt[], shaftLen: number): HeadAnalysis | null {
  if (!pts.length) return null;
  let posV = 0;
  let posU = 0;
  let negV = 0;
  let negU = 0;
  let forward = Infinity;
  for (const p of pts) {
    const rx = p.x - tip.x;
    const ry = p.y - tip.y;
    const u = rx * back.x + ry * back.y;
    const v = rx * -back.y + ry * back.x;
    if (Math.hypot(rx, ry) > 0.5 * shaftLen) return null;
    if (u < -0.12 * shaftLen) return null;
    forward = Math.min(forward, u);
    if (v > posV) {
      posV = v;
      posU = u;
    }
    if (v < negV) {
      negV = v;
      negU = u;
    }
  }
  const barb = (u: number, v: number) => {
    const len = Math.hypot(u, v);
    if (len < 0.08 * shaftLen || Math.abs(v) < 0.04 * shaftLen) return 0;
    const ang = (Math.atan2(Math.abs(v), u) * 180) / Math.PI;
    if (ang < 12 || ang > 75) return 0;
    // prefer ~35° barbs
    return 1 - Math.min(1, Math.abs(ang - 35) / 60);
  };
  const sPos = barb(posU, posV);
  const sNeg = barb(negU, negV);
  const sides = (sPos > 0 ? 1 : 0) + (sNeg > 0 ? 1 : 0);
  if (!sides) return null;
  // head points should hug the barb segments (tip → barb end)
  const ends: Pt[] = [];
  if (sPos > 0) ends.push({ x: tip.x + posU * back.x - posV * back.y, y: tip.y + posU * back.y + posV * back.x });
  if (sNeg > 0) ends.push({ x: tip.x + negU * back.x - negV * back.y, y: tip.y + negU * back.y + negV * back.x });
  let dev = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const e of ends) best = Math.min(best, distPointSegment(p, tip, e));
    dev += best;
  }
  dev /= pts.length;
  if (dev > 0.1 * shaftLen) return null;
  const quality = sides === 2 ? 0.88 + 0.07 * ((sPos + sNeg) / 2) : 0.62 + 0.06 * Math.max(sPos, sNeg);
  const conf = quality * (1 - 0.3 * clamp01(dev / (0.1 * shaftLen)));
  return { sides, forward, conf };
}

function unit(a: Pt, b: Pt): Pt {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/** Single-stroke arrow: tail → tip (straight shaft) → head barbs. Tries both drawing directions. */
function fitArrowSingle(pts: readonly Pt[]): { a: Pt; b: Pt; conf: number } | null {
  let best: { a: Pt; b: Pt; conf: number } | null = null;
  for (const seq of [pts, [...pts].reverse()]) {
    const tail = seq[0];
    let far = 0;
    for (let i = 0; i < seq.length; i++) far = Math.max(far, dist(tail, seq[i]));
    // the tip is the first point (nearly) farthest from the tail: the head may revisit it
    let ti = 0;
    while (ti < seq.length - 1 && dist(tail, seq[ti]) < far * 0.98) ti++;
    const shaftLen = far;
    if (shaftLen < 20 || ti < 2 || ti >= seq.length - 2) continue;
    const tip = seq[ti];
    const shaft = seq.slice(0, ti + 1);
    let maxDev = 0;
    for (const p of shaft) maxDev = Math.max(maxDev, distPointSegment(p, tail, tip));
    if (maxDev > 0.07 * shaftLen || pathLength(shaft) / shaftLen > 1.1) continue;
    const head = seq.slice(ti);
    const headLen = pathLength(head);
    if (headLen < 0.12 * shaftLen || headLen > 1.3 * shaftLen) continue;
    const h = analyzeHead(tip, unit(tip, tail), head, shaftLen);
    if (!h) continue;
    const conf = h.conf * (1 - 0.3 * clamp01(maxDev / (0.07 * shaftLen)));
    if (!best || conf > best.conf) best = { a: tail, b: tip, conf };
  }
  return best;
}

/**
 * Multi-stroke arrow: a straight `shaft` stroke plus one or more short head strokes
 * (a "V", or two separate barbs) near one or both of its endpoints.
 */
export function fitArrowGroup(shaft: readonly Pt[], heads: readonly (readonly Pt[])[]): { a: Pt; b: Pt; heads: 'end' | 'both'; conf: number } | null {
  const line = fitLine(resample(dedupe(shaft), 48));
  if (!line || !heads.length) return null;
  const len = dist(line.a, line.b);
  const ends = [line.a, line.b];
  const groups: Pt[][] = [[], []];
  for (const h of heads) {
    if (!h.length) return null;
    const dA = Math.min(...h.map((p) => dist(p, ends[0])));
    const dB = Math.min(...h.map((p) => dist(p, ends[1])));
    const which = dA <= dB ? 0 : 1;
    if (Math.min(dA, dB) > 0.18 * len) return null;
    groups[which].push(...resample(dedupe(h), 24));
  }
  const res: { idx: number; h: HeadAnalysis }[] = [];
  for (const idx of [0, 1]) {
    if (!groups[idx].length) continue;
    const tip = ends[idx];
    const other = ends[1 - idx];
    const h = analyzeHead(tip, unit(tip, other), groups[idx], len);
    if (!h) return null;
    res.push({ idx, h });
  }
  if (!res.length) return null;
  const tipIdx = res.length === 2 ? 1 : res[0].idx;
  const tipHead = res.find((r) => r.idx === tipIdx)!.h;
  let tip = ends[tipIdx];
  const tail = ends[1 - tipIdx];
  if (tipHead.forward < 0) {
    // the head's apex is slightly beyond the shaft end: extend the shaft to it
    const dir = unit(tail, tip);
    const ext = Math.min(-tipHead.forward, 0.1 * len);
    tip = { x: tip.x + dir.x * ext, y: tip.y + dir.y * ext };
  }
  const conf = Math.min(...res.map((r) => r.h.conf)) * (0.85 + 0.15 * line.conf);
  return { a: tail, b: tip, heads: res.length === 2 ? 'both' : 'end', conf };
}

// ---------------------------------------------------------------------------------------------
// Closed shapes

/** Finds the closing point of a loop; returns the trimmed loop or null when the stroke is open. */
function closeLoop(R: readonly Pt[], L: number): Pt[] | null {
  const n = R.length;
  const lim = Math.floor(n * 0.3);
  let best = Infinity;
  let bi = 0;
  let bj = n - 1;
  for (let i = 0; i <= lim; i++) {
    for (let j = n - 1 - lim; j < n; j++) {
      if (j - i < n * 0.5) continue;
      const d = dist(R[i], R[j]);
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  if (best > 0.1 * L) return null;
  const loop = R.slice(bi, bj + 1);
  if (pathLength(loop) < 0.6 * L) return null;
  return loop;
}

/** Visvalingam-style reduction of a convex polygon to k vertices (max-area preserving). */
function reducePolygon(poly: readonly Pt[], k: number): Pt[] {
  const p = poly.map((q) => ({ ...q }));
  const tri = (a: Pt, b: Pt, c: Pt) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  while (p.length > k) {
    let mi = 0;
    let ma = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length]);
      if (a < ma) {
        ma = a;
        mi = i;
      }
    }
    p.splice(mi, 1);
  }
  return p;
}

interface PolyFit {
  poly: Pt[];
  ratio: number;
  meanErr: number;
  maxErr: number;
}

function fitPolygon(loop: readonly Pt[], hull: readonly Pt[], hullArea: number, k: number, diag: number): PolyFit {
  const poly = hull.length > k ? reducePolygon(hull, k) : hull.map((q) => ({ ...q }));
  const ratio = poly.length >= 3 ? Math.abs(polygonArea(poly)) / hullArea : 0;
  let sum = 0;
  let max = 0;
  for (const q of loop) {
    const d = distToPolygon(q, poly) / diag;
    sum += d;
    if (d > max) max = d;
  }
  return { poly, ratio, meanErr: sum / loop.length, maxErr: max };
}

function interiorAngle(prev: Pt, cur: Pt, next: Pt): number {
  const a = angleDeg(cur, prev);
  const b = angleDeg(cur, next);
  return angleDiff(a, b);
}

function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function normAxis(deg: number): number {
  // into (-45, 45]
  let r = ((deg % 90) + 90) % 90;
  if (r > 45) r -= 90;
  return r;
}

function fitRectangle(loop: readonly Pt[], quad: readonly Pt[]): { cx: number; cy: number; w: number; h: number; rotation: number; angleErr: number } {
  // orientation = circular mean of edge angles modulo 90°
  let sx = 0;
  let sy = 0;
  let angleErr = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const w = dist(a, b);
    const ang = (angleDeg(a, b) * 4 * Math.PI) / 180;
    sx += Math.cos(ang) * w;
    sy += Math.sin(ang) * w;
    angleErr = Math.max(angleErr, Math.abs(interiorAngle(quad[(i + 3) % 4], a, b) - 90));
  }
  let rotation = normAxis((Math.atan2(sy, sx) * 180) / Math.PI / 4);
  if (Math.abs(rotation) < AXIS_SNAP_DEG) rotation = 0;
  const c = centroid(quad);
  const us: number[] = [];
  const vs: number[] = [];
  for (const p of loop) {
    const q = rotate(p, c, -rotation);
    us.push(q.x);
    vs.push(q.y);
  }
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const u0 = percentile(us, 0.04);
  const u1 = percentile(us, 0.96);
  const v0 = percentile(vs, 0.04);
  const v1 = percentile(vs, 0.96);
  const mid = rotate({ x: (u0 + u1) / 2, y: (v0 + v1) / 2 }, c, rotation);
  return { cx: mid.x, cy: mid.y, w: u1 - u0, h: v1 - v0, rotation, angleErr };
}

interface EllipseFit {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  meanErr: number;
  maxErr: number;
}

function fitEllipse(loop: readonly Pt[]): EllipseFit {
  const c = centroid(loop);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of loop) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  const rot = loop.map((p) => rotate(p, c, -theta));
  for (const q of rot) {
    u0 = Math.min(u0, q.x);
    u1 = Math.max(u1, q.x);
    v0 = Math.min(v0, q.y);
    v1 = Math.max(v1, q.y);
  }
  const rx = Math.max(1, (u1 - u0) / 2);
  const ry = Math.max(1, (v1 - v0) / 2);
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  let sum = 0;
  let max = 0;
  for (const q of rot) {
    const r = Math.hypot((q.x - cu) / rx, (q.y - cv) / ry);
    const e = Math.abs(r - 1);
    sum += e;
    if (e > max) max = e;
  }
  const center = rotate({ x: cu, y: cv }, c, theta);
  return { cx: center.x, cy: center.y, rx, ry, rotation: theta, meanErr: sum / rot.length, maxErr: max };
}

function snapTriangle(tri: readonly Pt[]): [Pt, Pt, Pt] {
  const p = tri.map((q) => ({ ...q })) as [Pt, Pt, Pt];
  // find the edge closest to horizontal
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = p[i];
    const b = p[(i + 1) % 3];
    const d = Math.min(angleDiff(angleDeg(a, b), 0), angleDiff(angleDeg(a, b), 180));
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  if (bd <= ANGLE_SNAP_DEG) {
    const a = p[bi];
    const b = p[(bi + 1) % 3];
    const apex = p[(bi + 2) % 3];
    const y = (a.y + b.y) / 2;
    a.y = y;
    b.y = y;
    const mx = (a.x + b.x) / 2;
    if (Math.abs(apex.x - mx) < 0.08 * Math.abs(b.x - a.x)) apex.x = mx;
  }
  return p;
}

function recognizeClosed(loopRaw: readonly Pt[]): { geometry: ShapeGeometry; conf: number } | null {
  const loop = resample(loopRaw, 64);
  const box = bbox(loop);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 10) return null;
  const hull = convexHull(loop);
  const hullArea = Math.abs(polygonArea(hull));
  if (hullArea < 1 || hull.length < 3) return null;
  const convexity = Math.abs(polygonArea(loop)) / hullArea;
  if (convexity < 0.78) return null;

  const tri = fitPolygon(loop, hull, hullArea, 3, diag);
  if (tri.ratio > 0.84 && tri.meanErr < 0.035 && tri.maxErr < 0.12) {
    const conf = 0.55 + 0.45 * Math.min(clamp01((tri.ratio - 0.84) / 0.12), clamp01(1 - tri.meanErr / 0.035));
    return { geometry: { kind: 'triangle', points: snapTriangle(tri.poly) }, conf: Math.max(0.62, conf) };
  }
  const quad = fitPolygon(loop, hull, hullArea, 4, diag);
  if (quad.ratio > 0.86 && quad.meanErr < 0.035 && quad.maxErr < 0.12) {
    const q = quad.poly;
    const qb = bbox(q);
    const cx = qb.x + qb.w / 2;
    const cy = qb.y + qb.h / 2;
    const fitQ = 0.5 + 0.5 * Math.min(clamp01((quad.ratio - 0.86) / 0.1), clamp01(1 - quad.meanErr / 0.035));
    // diamond: one vertex near each bbox side midpoint
    const top = q.reduce((m, p) => (p.y < m.y ? p : m));
    const bottom = q.reduce((m, p) => (p.y > m.y ? p : m));
    const left = q.reduce((m, p) => (p.x < m.x ? p : m));
    const right = q.reduce((m, p) => (p.x > m.x ? p : m));
    const distinct = new Set([top, bottom, left, right]).size === 4;
    const tolX = 0.2 * qb.w;
    const tolY = 0.2 * qb.h;
    const isDiamond =
      distinct && Math.abs(top.x - cx) < tolX && Math.abs(bottom.x - cx) < tolX && Math.abs(left.y - cy) < tolY && Math.abs(right.y - cy) < tolY;
    const rect = fitRectangle(loop, q);
    const rectLike = rect.angleErr < 22;
    const nearAxis = rect.rotation === 0;
    if (isDiamond && (!rectLike || !nearAxis)) {
      const w = right.x - left.x;
      const h = bottom.y - top.y;
      return { geometry: { kind: 'diamond', cx: (left.x + right.x) / 2, cy: (top.y + bottom.y) / 2, w, h }, conf: Math.max(0.62, fitQ) };
    }
    if (rectLike) {
      const conf = fitQ * (1 - 0.3 * clamp01(rect.angleErr / 22));
      return { geometry: { kind: 'rectangle', cx: rect.cx, cy: rect.cy, w: rect.w, h: rect.h, rotation: rect.rotation }, conf: Math.max(0.62, conf) };
    }
  }
  const e = fitEllipse(loop);
  if (e.meanErr < 0.075 && e.maxErr < 0.25) {
    const conf = 0.6 + 0.4 * clamp01(1 - e.meanErr / 0.075);
    const ratio = Math.min(e.rx, e.ry) / Math.max(e.rx, e.ry);
    if (ratio > CIRCLE_RATIO) {
      const r = (e.rx + e.ry) / 2;
      return { geometry: { kind: 'circle', cx: e.cx, cy: e.cy, r }, conf };
    }
    let { rx, ry, rotation } = e;
    rotation = ((rotation % 180) + 180) % 180; // [0,180)
    if (rotation > 90) rotation -= 180; // (-90, 90]
    if (Math.abs(rotation) < AXIS_SNAP_DEG) rotation = 0;
    else if (Math.abs(Math.abs(rotation) - 90) < AXIS_SNAP_DEG) {
      rotation = 0;
      [rx, ry] = [ry, rx];
    }
    return { geometry: { kind: 'ellipse', cx: e.cx, cy: e.cy, rx, ry, rotation }, conf };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Polygon approximation of a shape's boundary (closed shapes) or its polyline (line/arrow). */
export function geometryOutline(g: ShapeGeometry, segments = 72): Pt[] {
  switch (g.kind) {
    case 'line':
    case 'arrow':
      return [g.a, g.b];
    case 'circle':
    case 'ellipse': {
      const rx = g.kind === 'circle' ? g.r : g.rx;
      const ry = g.kind === 'circle' ? g.r : g.ry;
      const rot = g.kind === 'ellipse' ? (g.rotation * Math.PI) / 180 : 0;
      const out: Pt[] = [];
      for (let i = 0; i < segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        const x = Math.cos(t) * rx;
        const y = Math.sin(t) * ry;
        out.push({ x: g.cx + x * Math.cos(rot) - y * Math.sin(rot), y: g.cy + x * Math.sin(rot) + y * Math.cos(rot) });
      }
      return out;
    }
    case 'rectangle': {
      const c = { x: g.cx, y: g.cy };
      return [
        { x: g.cx - g.w / 2, y: g.cy - g.h / 2 },
        { x: g.cx + g.w / 2, y: g.cy - g.h / 2 },
        { x: g.cx + g.w / 2, y: g.cy + g.h / 2 },
        { x: g.cx - g.w / 2, y: g.cy + g.h / 2 },
      ].map((p) => (g.rotation ? rotate(p, c, g.rotation) : p));
    }
    case 'diamond':
      return [
        { x: g.cx, y: g.cy - g.h / 2 },
        { x: g.cx + g.w / 2, y: g.cy },
        { x: g.cx, y: g.cy + g.h / 2 },
        { x: g.cx - g.w / 2, y: g.cy },
      ];
    case 'triangle':
      return g.points.map((p) => ({ ...p }));
    default:
      return [];
  }
}

/** Recognises a single polyline (logical coordinates). */
export function recognizePoints(input: readonly Pt[], strokeIds: string[] = []): Recognition {
  const raw = dedupe(input);
  if (raw.length < 2) return none(strokeIds);
  const L = pathLength(raw);
  const box = bbox(raw);
  const diag = Math.hypot(box.w, box.h);
  if (L < 12 || diag < 10) return none(strokeIds);
  const R = resample(raw, 96);

  const line = fitLine(R);
  if (line) {
    const [a, b] = snapSegment(line.a, line.b);
    return { kind: 'line', confidence: line.conf, geometry: { kind: 'line', a, b }, strokeIds };
  }

  const loop = closeLoop(R, L);
  if (loop) {
    const c = recognizeClosed(loop);
    if (!c) return none(strokeIds);
    // the parts outside the trimmed loop (overshoot) must follow the shape: rejects "a", "d", "9"…
    const outline = geometryOutline(c.geometry);
    let worst = 0;
    for (const p of R) worst = Math.max(worst, distToPolygon(p, outline));
    if (worst > 0.12 * diag) return none(strokeIds);
    return { kind: c.geometry.kind as ShapeKind, confidence: c.conf, geometry: c.geometry, strokeIds };
  }

  const arrow = fitArrowSingle(R);
  if (arrow) {
    const [a, b] = snapSegment(arrow.a, arrow.b);
    return { kind: 'arrow', confidence: arrow.conf, geometry: { kind: 'arrow', a, b, heads: 'end' }, strokeIds };
  }
  return none(strokeIds);
}

/** Recognises one stroke. */
export function recognizeStroke(stroke: Stroke): Recognition {
  return recognizePoints(strokePoints(stroke), [stroke.id]);
}

/**
 * Joins polylines whose endpoints meet (within `tol`) into one chain, reversing parts as needed.
 * Returns null when they don't form a single chain.
 */
export function chainPolylines(parts: readonly (readonly Pt[])[], tol: number): Pt[] | null {
  const rest = parts.filter((p) => p.length).map((p) => [...p]);
  if (!rest.length) return null;
  rest.sort((a, b) => pathLength(b) - pathLength(a));
  let chain = rest.shift()!;
  while (rest.length) {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    let best = -1;
    let bestD = Infinity;
    let mode = 0;
    rest.forEach((p, i) => {
      const s = p[0];
      const e = p[p.length - 1];
      const opts = [dist(tail, s), dist(tail, e), dist(head, e), dist(head, s)];
      opts.forEach((d, m) => {
        if (d < bestD) {
          bestD = d;
          best = i;
          mode = m;
        }
      });
    });
    if (best < 0 || bestD > tol) return null;
    const p = rest.splice(best, 1)[0];
    if (mode === 0) chain = chain.concat(p);
    else if (mode === 1) chain = chain.concat(p.reverse());
    else if (mode === 2) chain = p.concat(chain);
    else chain = p.reverse().concat(chain);
  }
  return chain;
}

/**
 * Recognises a small group of strokes as one shape:
 *  - a single stroke → `recognizeStroke`;
 *  - a straight shaft + short head strokes → arrow;
 *  - strokes whose endpoints chain together (a box drawn in 2–4 strokes) → closed shape / line.
 */
export function recognizeGroup(strokes: readonly Stroke[]): Recognition {
  const ids = strokes.map((s) => s.id);
  if (!strokes.length) return none(ids);
  if (strokes.length === 1) return recognizeStroke(strokes[0]);
  const polys = strokes.map((s) => strokePoints(s));
  // arrow: longest stroke as shaft
  const order = polys.map((p, i) => ({ p, i, len: pathLength(p) })).sort((a, b) => b.len - a.len);
  const shaft = order[0];
  if (order.slice(1).every((o) => o.len < 0.9 * shaft.len)) {
    const arrow = fitArrowGroup(
      shaft.p,
      order.slice(1).map((o) => o.p),
    );
    if (arrow) {
      const [a, b] = snapSegment(arrow.a, arrow.b);
      return { kind: 'arrow', confidence: arrow.conf, geometry: { kind: 'arrow', a, b, heads: arrow.heads }, strokeIds: ids };
    }
  }
  const all = polys.flat();
  const box = bbox(all);
  const tol = Math.max(14, 0.12 * Math.hypot(box.w, box.h));
  const chain = chainPolylines(polys, tol);
  if (chain) {
    const r = recognizePoints(chain, ids);
    if (r.kind !== 'none' && r.kind !== 'arrow') return { ...r, confidence: r.confidence * 0.97 };
  }
  return none(ids);
}
