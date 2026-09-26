/**
 * Groups a selection of strokes into semantic clusters:
 *  - shape clusters (one confident single-stroke shape, a multi-stroke arrow, or a box drawn in
 *    several strokes);
 *  - writing clusters (handwriting / math: many small strokes arranged in lines; lines that
 *    stack closely are merged into one block, so fractions and multi-line derivations stay whole);
 *  - leftover ink (large unrecognised strokes such as curved connectors or doodles), which is
 *    never sent to OCR.
 *
 * Context matters: a small circle next to letters is an "o", a short dash between symbols is a
 * minus sign and a horizontal bar with symbols above and below is a fraction bar.
 */
import type { Stroke } from '../schema';
import { bboxDistance, strokeBBox, strokeLength, strokePoints, unionBBox, type BBox, dist } from './geometry';
import { recognizeGroup, recognizeStroke, SHAPE_CONFIDENCE, type Recognition } from './recognize';
import { isClosedKind } from './shapes';

export interface StrokeInfo {
  stroke: Stroke;
  box: BBox;
  len: number;
  maxDim: number;
  rec: Recognition;
}

export interface ShapeCluster {
  kind: 'shape';
  strokes: Stroke[];
  recognition: Recognition;
  bbox: BBox;
}

export interface WritingCluster {
  kind: 'writing';
  strokes: Stroke[];
  bbox: BBox;
  /** number of text lines in the block */
  lines: number;
  /** heuristic "looks like math" score and verdict */
  mathScore: number;
  mathy: boolean;
}

export interface ClusterResult {
  shapes: ShapeCluster[];
  writing: WritingCluster[];
  /** big unrecognised strokes: stay as ink */
  leftovers: Stroke[];
  /** estimated handwriting x-height (logical units), 0 when there is no writing */
  xHeight: number;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function vOverlap(a: BBox, b: BBox, minH: number): number {
  const ah = Math.max(a.h, minH);
  const bh = Math.max(b.h, minH);
  const ay = a.y + a.h / 2 - ah / 2;
  const by = b.y + b.h / 2 - bh / 2;
  const ov = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return ov / Math.min(ah, bh);
}

function hGap(a: BBox, b: BBox): number {
  return Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
}

function isHorizontalLine(i: StrokeInfo): boolean {
  if (i.rec.kind !== 'line' || i.rec.geometry.kind !== 'line') return false;
  const { a, b } = i.rec.geometry;
  return Math.abs(b.y - a.y) <= Math.abs(b.x - a.x) * 0.2;
}

class DSU {
  p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
  groups(): number[][] {
    const m = new Map<number, number[]>();
    this.p.forEach((_, i) => {
      const r = this.find(i);
      m.set(r, [...(m.get(r) ?? []), i]);
    });
    return [...m.values()];
  }
}

export function strokeInfo(stroke: Stroke): StrokeInfo {
  const box = strokeBBox(stroke);
  return { stroke, box, len: strokeLength(stroke), maxDim: Math.max(box.w, box.h), rec: recognizeStroke(stroke) };
}

/** Heuristic score for "this writing cluster is mathematics". */
export function mathScore(members: StrokeInfo[], xh: number): number {
  if (!members.length) return 0;
  let score = 0;
  const h = Math.max(xh, 8);
  // fraction bars: horizontal straight strokes with ink above and below
  let bars = 0;
  let dashes = 0;
  for (const m of members) {
    if (!isHorizontalLine(m)) continue;
    const above = members.some((o) => o !== m && o.box.y + o.box.h <= m.box.y + 2 && hGap(o.box, m.box) === 0 && m.box.y - (o.box.y + o.box.h) < h * 1.2);
    const below = members.some((o) => o !== m && o.box.y >= m.box.y + m.box.h - 2 && hGap(o.box, m.box) === 0 && o.box.y - (m.box.y + m.box.h) < h * 1.2);
    if (above && below && m.box.w >= h * 0.9) bars++;
    else if (m.box.w < h * 2) dashes++;
  }
  score += bars * 3 + Math.min(2, dashes);
  // crosses (+): a short horizontal and a short vertical line intersecting
  const verticals = members.filter((m) => m.rec.kind === 'line' && m.box.h > m.box.w * 3 && m.box.h < h * 1.6);
  for (const v of verticals) {
    if (members.some((o) => isHorizontalLine(o) && o.box.w < h * 1.6 && bboxDistance(o.box, v.box) === 0)) {
      score += 1;
      break;
    }
  }
  // superscripts / subscripts: markedly smaller strokes sitting high or low next to a bigger one
  const heights = members.map((m) => m.box.h).filter((v) => v > 2);
  const med = median(heights);
  let scripts = 0;
  for (const m of members) {
    if (m.box.h > med * 0.6 || m.box.h < 3) continue;
    const host = members.find((o) => o !== m && o.box.h >= med * 0.8 && hGap(o.box, m.box) < h * 0.6 && o.box.x < m.box.x);
    if (!host) continue;
    const cy = m.box.y + m.box.h / 2;
    if (cy < host.box.y + host.box.h * 0.3 || cy > host.box.y + host.box.h * 0.8) scripts++;
  }
  score += Math.min(2, scripts);
  // strong height variation (tall integrals / parentheses vs small symbols)
  if (heights.length >= 3) {
    const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
    const sd = Math.sqrt(heights.reduce((a, b) => a + (b - mean) ** 2, 0) / heights.length);
    if (sd / mean > 0.55) score += 1;
  }
  // discrete symbols (short strokes) rather than long cursive runs
  const avgLen = members.reduce((a, m) => a + m.len, 0) / members.length;
  if (members.length >= 3 && avgLen / h < 2.2) score += 1;
  return score;
}

/**
 * Clusters strokes. Deterministic; O(n²) in the selection size (selections are small).
 */
export function clusterStrokes(strokes: readonly Stroke[]): ClusterResult {
  const infos = strokes.filter((s) => s.pts.length >= 3).map(strokeInfo);
  const n = infos.length;
  const isShape = infos.map((i) => i.rec.kind !== 'none' && i.rec.confidence >= SHAPE_CONFIDENCE);
  const writingCandidates = infos.filter((_, k) => !isShape[k]);
  // handwriting scale: only writing-sized marks count (big doodles / curved connectors would skew it)
  const xh = median(
    writingCandidates
      .filter((i) => i.maxDim <= 150)
      .map((i) => Math.max(i.box.h, i.box.w * 0.5))
      .filter((v) => v > 3),
  );

  // 1. context: small "shapes" among writing are letters/symbols
  // (iterated so the decision propagates: "x = 2/3" → bar first, then "=", then "x")
  for (let pass = 0, changed = true; xh > 0 && changed && pass < 5; pass++) {
    changed = false;
    for (let k = 0; k < n; k++) {
      if (!isShape[k]) continue;
      const s = infos[k];
      const neighbours = infos.filter((o, j) => j !== k && !isShape[j] && bboxDistance(o.box, s.box) < Math.max(12, xh * 1.1));
      if (!neighbours.length) continue;
      if (isHorizontalLine(s)) {
        // minus / equals on the same line, or a fraction bar with symbols above and below
        const sameLine = s.box.w < xh * 3.5 && neighbours.some((o) => vOverlap(o.box, s.box, xh * 0.6) > 0.3);
        const above = neighbours.some((o) => o.box.y + o.box.h <= s.box.y + 3 && hGap(o.box, s.box) === 0);
        const below = neighbours.some((o) => o.box.y >= s.box.y + s.box.h - 3 && hGap(o.box, s.box) === 0);
        if (sameLine || (above && below)) {
          isShape[k] = false;
          changed = true;
        }
      } else if (s.maxDim < xh * 2.2) {
        if (neighbours.some((o) => vOverlap(o.box, s.box, xh * 0.5) > 0.3)) {
          isShape[k] = false;
          changed = true;
        }
      }
    }
  }

  const consumed = new Array<boolean>(n).fill(false);
  const shapes: ShapeCluster[] = [];
  const pushShape = (idx: number[], rec: Recognition) => {
    idx.forEach((i) => (consumed[i] = true));
    const members = idx.map((i) => infos[i]);
    shapes.push({ kind: 'shape', strokes: members.map((m) => m.stroke), recognition: rec, bbox: members.map((m) => m.box).reduce(unionBBox) });
  };

  // 2. multi-stroke arrows: a confident line + short head strokes at an end
  const lines = infos
    .map((i, k) => ({ i, k }))
    .filter(({ i, k }) => isShape[k] && i.rec.kind === 'line')
    .sort((a, b) => b.i.len - a.i.len);
  for (const { i: line, k } of lines) {
    if (consumed[k] || line.rec.geometry.kind !== 'line') continue;
    const { a, b } = line.rec.geometry;
    const L = dist(a, b);
    const heads: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === k || consumed[j]) continue;
      const o = infos[j];
      if (isShape[j] && isClosedKind(o.rec.kind)) continue;
      if (o.maxDim > L * 0.5) continue;
      const pts = strokePoints(o.stroke);
      const near = Math.min(...pts.map((p) => Math.min(dist(p, a), dist(p, b))));
      if (near <= L * 0.18) heads.push(j);
    }
    if (!heads.length) continue;
    const rec = recognizeGroup([line.stroke, ...heads.map((j) => infos[j].stroke)]);
    if (rec.kind === 'arrow' && rec.confidence >= SHAPE_CONFIDENCE) pushShape([k, ...heads], rec);
  }

  // 3. multi-stroke closed shapes: chains of strokes meeting at their endpoints
  const chainable = infos
    .map((i, k) => ({ i, k }))
    .filter(({ i, k }) => !consumed[k] && (!isShape[k] || i.rec.kind === 'line') && (xh === 0 || i.maxDim >= xh * 1.5));
  if (chainable.length >= 2) {
    const dsu = new DSU(chainable.length);
    const ends = chainable.map(({ i }) => {
      const p = i.stroke.pts;
      return [
        { x: p[0], y: p[1] },
        { x: p[p.length - 3], y: p[p.length - 2] },
      ];
    });
    for (let x = 0; x < chainable.length; x++) {
      for (let y = x + 1; y < chainable.length; y++) {
        const tol = Math.max(14, 0.15 * Math.min(chainable[x].i.maxDim, chainable[y].i.maxDim));
        const touch = ends[x].some((p) => ends[y].some((q) => dist(p, q) <= tol));
        if (touch) dsu.union(x, y);
      }
    }
    for (const g of dsu.groups()) {
      if (g.length < 2 || g.length > 6) continue;
      const idx = g.map((x) => chainable[x].k);
      const rec = recognizeGroup(idx.map((k) => infos[k].stroke));
      if (isClosedKind(rec.kind) && rec.confidence >= SHAPE_CONFIDENCE) pushShape(idx, rec);
    }
  }

  // 4. remaining confident single-stroke shapes
  for (let k = 0; k < n; k++) if (!consumed[k] && isShape[k]) pushShape([k], infos[k].rec);

  // 5. leftovers vs writing
  const leftovers: Stroke[] = [];
  const writingIdx: number[] = [];
  const bigLimit = Math.max(150, xh * 4.5);
  for (let k = 0; k < n; k++) {
    if (consumed[k]) continue;
    const s = infos[k];
    const isolated = !infos.some((o, j) => j !== k && !consumed[j] && bboxDistance(o.box, s.box) < Math.max(12, xh));
    if (s.maxDim > bigLimit && (xh === 0 || isolated || s.maxDim > xh * 8)) leftovers.push(s.stroke);
    else writingIdx.push(k);
  }
  // a lone small mark at the end of a big unrecognised stroke (e.g. the head of a curved arrow)
  // belongs with it, not with the handwriting
  if (leftovers.length) {
    const bigs = leftovers.map((st) => {
      const p = st.pts;
      const b = strokeBBox(st);
      return { ends: [{ x: p[0], y: p[1] }, { x: p[p.length - 3], y: p[p.length - 2] }], maxDim: Math.max(b.w, b.h) };
    });
    for (let i = writingIdx.length - 1; i >= 0; i--) {
      const s = infos[writingIdx[i]];
      const lonely = !writingIdx.some((j) => j !== writingIdx[i] && bboxDistance(infos[j].box, s.box) < Math.max(12, xh));
      if (!lonely) continue;
      const pts = strokePoints(s.stroke);
      const attached = bigs.some(
        (L) => s.maxDim < 0.4 * L.maxDim && L.ends.some((e) => Math.min(...pts.map((q) => dist(q, e))) < Math.max(15, 0.15 * L.maxDim)),
      );
      if (attached) {
        leftovers.push(s.stroke);
        writingIdx.splice(i, 1);
      }
    }
  }

  // 6. writing lines (y-overlap + small horizontal gap), then blocks (stacked lines)
  const w = writingIdx.map((k) => infos[k]);
  const lh = Math.max(xh, 10);
  const lineDsu = new DSU(w.length);
  for (let x = 0; x < w.length; x++) {
    for (let y = x + 1; y < w.length; y++) {
      const a = w[x].box;
      const b = w[y].box;
      if (vOverlap(a, b, lh * 0.5) >= 0.3 && hGap(a, b) <= Math.max(20, lh * 1.3)) lineDsu.union(x, y);
    }
  }
  const lineGroups = lineDsu.groups().map((g) => ({ idx: g, box: g.map((i) => w[i].box).reduce(unionBBox) }));
  const blockDsu = new DSU(lineGroups.length);
  for (let x = 0; x < lineGroups.length; x++) {
    for (let y = x + 1; y < lineGroups.length; y++) {
      const a = lineGroups[x].box;
      const b = lineGroups[y].box;
      const vGap = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
      const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (vGap <= lh * 0.9 && xOverlap > -lh * 0.5) blockDsu.union(x, y);
    }
  }
  const writing: WritingCluster[] = blockDsu
    .groups()
    .map((g) => {
      const members = g.flatMap((li) => lineGroups[li].idx.map((i) => w[i]));
      members.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      const localXh = median(members.map((m) => Math.max(m.box.h, m.box.w * 0.5)).filter((v) => v > 3)) || xh;
      const score = mathScore(members, localXh);
      return {
        kind: 'writing' as const,
        strokes: members.map((m) => m.stroke),
        bbox: members.map((m) => m.box).reduce(unionBBox),
        lines: g.length,
        mathScore: score,
        mathy: score >= 2,
      };
    })
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  shapes.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  return { shapes, writing, leftovers, xHeight: xh };
}
