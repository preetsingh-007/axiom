/**
 * Pure 2D geometry helpers for ink (logical coordinates, block width = 1000).
 * No DOM, no allocation-heavy abstractions: strokes stay flat number arrays until needed.
 */
import type { Stroke } from '../schema';

export interface Pt {
  x: number;
  y: number;
}

/** Axis-aligned box. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EMPTY_BBOX: BBox = { x: 0, y: 0, w: 0, h: 0 };

/** Converts a flattened [x, y, p, ...] array into points. */
export function strokePoints(stroke: Pick<Stroke, 'pts'> | number[]): Pt[] {
  const pts = Array.isArray(stroke) ? stroke : stroke.pts;
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1] });
  return out;
}

export function bbox(pts: readonly Pt[]): BBox {
  if (!pts.length) return { ...EMPTY_BBOX };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Bounding box of a stroke's centre-line (flat array, no allocation). */
export function strokeBBox(stroke: Pick<Stroke, 'pts'>): BBox {
  const pts = stroke.pts;
  if (pts.length < 2) return { ...EMPTY_BBOX };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 3) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBBox(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function strokesBBox(strokes: readonly Pick<Stroke, 'pts'>[]): BBox {
  let out: BBox | null = null;
  for (const s of strokes) {
    if (s.pts.length < 2) continue;
    const b = strokeBBox(s);
    out = out ? unionBBox(out, b) : b;
  }
  return out ?? { ...EMPTY_BBOX };
}

export function inflateBBox(b: BBox, d: number): BBox {
  return { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function bboxContains(b: BBox, p: Pt): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

/** Gap between two boxes (0 when they overlap). */
export function bboxDistance(a: BBox, b: BBox): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

export function bboxCenter(b: BBox): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(pts: readonly Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function strokeLength(stroke: Pick<Stroke, 'pts'>): number {
  const p = stroke.pts;
  let len = 0;
  for (let i = 3; i + 1 < p.length; i += 3) len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
  return len;
}

/** Resamples a polyline to exactly `n` points equally spaced by arc length. */
export function resample(pts: readonly Pt[], n: number): Pt[] {
  if (pts.length === 0) return [];
  if (n <= 1 || pts.length === 1) return Array.from({ length: Math.max(1, n) }, () => ({ ...pts[0] }));
  const total = pathLength(pts);
  if (total === 0) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const step = total / (n - 1);
  const out: Pt[] = [{ ...pts[0] }];
  let acc = 0;
  let prev = pts[0];
  let i = 1;
  while (i < pts.length && out.length < n - 1) {
    const cur = pts[i];
    const d = dist(prev, cur);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += d;
      prev = cur;
      i++;
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Distance from point p to segment ab. */
export function distPointSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Closest point to p on segment ab. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return { ...a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function rdp(pts: readonly Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push({ ...pts[i] });
  return out;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Fraction (0..1) of a stroke's points that lie inside the polygon. */
export function fractionInsidePolygon(stroke: Pick<Stroke, 'pts'>, poly: readonly Pt[], polyBox = bbox(poly)): number {
  const p = stroke.pts;
  const n = Math.floor(p.length / 3);
  if (!n || poly.length < 3) return 0;
  let inside = 0;
  const q = { x: 0, y: 0 };
  for (let i = 0; i + 1 < p.length; i += 3) {
    q.x = p[i];
    q.y = p[i + 1];
    if (bboxContains(polyBox, q) && pointInPolygon(q, poly)) inside++;
  }
  return inside / n;
}

/** True when at least `threshold` of the stroke lies inside the lasso polygon. */
export function strokeInPolygon(stroke: Pick<Stroke, 'pts'>, poly: readonly Pt[], threshold = 0.6, polyBox = bbox(poly)): boolean {
  if (!bboxIntersects(strokeBBox(stroke), polyBox)) return false;
  return fractionInsidePolygon(stroke, poly, polyBox) >= threshold;
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Proper or touching intersection of segments ab and cd. */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const eps = 1e-9;
  if (Math.abs(o1) < eps && distPointSegment(c, a, b) < eps) return true;
  if (Math.abs(o2) < eps && distPointSegment(d, a, b) < eps) return true;
  if (Math.abs(o3) < eps && distPointSegment(a, c, d) < eps) return true;
  if (Math.abs(o4) < eps && distPointSegment(b, c, d) < eps) return true;
  return false;
}

/** Minimum distance between segments ab and cd. */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(distPointSegment(a, c, d), distPointSegment(b, c, d), distPointSegment(c, a, b), distPointSegment(d, a, b));
}

/** Intersection point of lines (not segments) p1p2 and p3p4, or null when parallel. */
export function lineIntersection(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
}

/** Minimum distance between two polylines (with bbox early-out beyond `cutoff`). */
export function polylineDistance(a: readonly Pt[], b: readonly Pt[], cutoff = Infinity): number {
  if (!a.length || !b.length) return Infinity;
  if (cutoff !== Infinity && bboxDistance(bbox(a), bbox(b)) > cutoff) return Infinity;
  if (a.length === 1 && b.length === 1) return dist(a[0], b[0]);
  let best = Infinity;
  const segsA = a.length === 1 ? [[a[0], a[0]]] : a.slice(1).map((p, i) => [a[i], p]);
  const segsB = b.length === 1 ? [[b[0], b[0]]] : b.slice(1).map((p, i) => [b[i], p]);
  for (const [p, q] of segsA) {
    for (const [r, s] of segsB) {
      const d = segmentDistance(p, q, r, s);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

/** True when two strokes come within `tol` logical units of each other. */
export function strokesNear(s1: Pick<Stroke, 'pts'>, s2: Pick<Stroke, 'pts'>, tol: number): boolean {
  if (bboxDistance(strokeBBox(s1), strokeBBox(s2)) > tol) return false;
  return polylineDistance(strokePoints(s1), strokePoints(s2), tol) <= tol;
}

/**
 * Hit test for the stroke eraser: does the eraser segment (a→b, radius r) touch the stroke?
 * The stroke's own half-width is added to the radius.
 */
export function strokeHitBySegment(stroke: Stroke, a: Pt, b: Pt, r: number, box = strokeBBox(stroke)): boolean {
  const rr = r + stroke.size / 2;
  const segBox = inflateBBox(bbox([a, b]), rr);
  if (!bboxIntersects(box, segBox)) return false;
  const p = stroke.pts;
  if (p.length < 6) return p.length >= 2 && distPointSegment({ x: p[0], y: p[1] }, a, b) <= rr;
  const c = { x: 0, y: 0 };
  const d = { x: 0, y: 0 };
  for (let i = 3; i + 1 < p.length; i += 3) {
    c.x = p[i - 3];
    c.y = p[i - 2];
    d.x = p[i];
    d.y = p[i + 1];
    if (segmentDistance(a, b, c, d) <= rr) return true;
  }
  return false;
}

/** Hit test of a polygon/polyline path against a stroke (any segment within r). */
export function polygonHitsStroke(path: readonly Pt[], stroke: Stroke, r = 0): boolean {
  const box = strokeBBox(stroke);
  if (path.length === 1) return strokeHitBySegment(stroke, path[0], path[0], r, box);
  for (let i = 1; i < path.length; i++) if (strokeHitBySegment(stroke, path[i - 1], path[i], r, box)) return true;
  return false;
}

/** Signed shoelace area (positive = counter-clockwise in y-up; y-down canvases flip sign). */
export function polygonArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return a / 2;
}

export function centroid(pts: readonly Pt[]): Pt {
  if (!pts.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Andrew's monotone chain convex hull (counter-clockwise, no repeated first point). */
export function convexHull(pts: readonly Pt[]): Pt[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (s.length < 3) return s;
  const lower: Pt[] = [];
  for (const p of s) {
    while (lower.length >= 2 && orient(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && orient(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Angle of vector a→b in degrees, in (-180, 180]. y grows downwards. */
export function angleDeg(a: Pt, b: Pt): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Smallest absolute difference between two angles in degrees (0..180). */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Distance from p to the closest edge of a closed polygon. */
export function distToPolygon(p: Pt, poly: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, distPointSegment(p, poly[j], poly[i]));
  return best;
}

/** Rotates p around c by `deg` degrees. */
export function rotate(p: Pt, c: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Returns a copy of the stroke translated/scaled: p' = origin + (p - origin) * s + (dx, dy). */
export function transformStroke(stroke: Stroke, t: { dx: number; dy: number; s?: number; ox?: number; oy?: number }): Stroke {
  const s = t.s ?? 1;
  const ox = t.ox ?? 0;
  const oy = t.oy ?? 0;
  const pts = stroke.pts.slice();
  for (let i = 0; i + 1 < pts.length; i += 3) {
    pts[i] = Math.round((ox + (pts[i] - ox) * s + t.dx) * 10) / 10;
    pts[i + 1] = Math.round((oy + (pts[i + 1] - oy) * s + t.dy) * 10) / 10;
  }
  return { ...stroke, pts };
}
