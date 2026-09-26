/**
 * Recognised shape geometry → SVG fragments, plus layout refinement:
 * alignment of nearby shapes (rows/columns share centres and sizes) and connector
 * snapping (arrow/line endpoints glued to the boundaries of the shapes they touch).
 */
import { bbox, dist, distToPolygon, lineIntersection, pointInPolygon, closestOnSegment, type BBox, type Pt } from './geometry';
import { geometryOutline, type ShapeGeometry, type ShapeKind } from './recognize';

const f = (n: number) => String(Math.round(n * 10) / 10);

export function isClosedKind(kind: ShapeKind): boolean {
  return kind === 'circle' || kind === 'ellipse' || kind === 'rectangle' || kind === 'triangle' || kind === 'diamond';
}

/** Arrowhead size for an arrow of length `len` drawn with `sw`. */
export function arrowHeadSize(len: number, sw: number): number {
  return Math.min(Math.max(12, 9 + sw * 2.2), len * 0.35);
}

function arrowHead(from: Pt, tip: Pt, size: number): { base: Pt; path: string } {
  const len = dist(from, tip) || 1;
  const ux = (tip.x - from.x) / len;
  const uy = (tip.y - from.y) / len;
  const base = { x: tip.x - ux * size, y: tip.y - uy * size };
  const half = size * 0.42;
  const b1 = { x: base.x - uy * half, y: base.y + ux * half };
  const b2 = { x: base.x + uy * half, y: base.y - ux * half };
  return {
    base: { x: tip.x - ux * size * 0.8, y: tip.y - uy * size * 0.8 },
    path: `M${f(tip.x)} ${f(tip.y)}L${f(b1.x)} ${f(b1.y)}L${f(b2.x)} ${f(b2.y)}Z`,
  };
}

/** Bounding box of the rendered geometry (includes arrowheads, excludes stroke width). */
export function geometryBBox(g: ShapeGeometry, sw = 3): BBox {
  if (g.kind === 'none') return { x: 0, y: 0, w: 0, h: 0 };
  if (g.kind === 'arrow' || g.kind === 'line') {
    const b = bbox([g.a, g.b]);
    const pad = g.kind === 'arrow' ? arrowHeadSize(dist(g.a, g.b), sw) * 0.45 : 0;
    return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
  }
  return bbox(geometryOutline(g, 48));
}

/**
 * Standalone SVG fragment (logical coordinates) for a geometry. Colours use `currentColor`
 * so the renderer sets the item colour on a wrapper; closed shapes get a faint tint.
 */
export function geometryToSvg(g: ShapeGeometry, sw = 3): string {
  const stroke = `fill="none" stroke="currentColor" stroke-width="${f(sw)}" stroke-linecap="round" stroke-linejoin="round"`;
  const tint = `fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-width="${f(sw)}" stroke-linejoin="round"`;
  switch (g.kind) {
    case 'line':
      return `<path d="M${f(g.a.x)} ${f(g.a.y)}L${f(g.b.x)} ${f(g.b.y)}" ${stroke}/>`;
    case 'arrow': {
      const size = arrowHeadSize(dist(g.a, g.b), sw);
      const end = arrowHead(g.a, g.b, size);
      let a = g.a;
      let head2 = '';
      if (g.heads === 'both') {
        const start = arrowHead(g.b, g.a, size);
        a = start.base;
        head2 = `<path d="${start.path}" fill="currentColor" stroke="currentColor" stroke-width="${f(sw * 0.6)}" stroke-linejoin="round"/>`;
      }
      return (
        `<path d="M${f(a.x)} ${f(a.y)}L${f(end.base.x)} ${f(end.base.y)}" ${stroke}/>` +
        `<path d="${end.path}" fill="currentColor" stroke="currentColor" stroke-width="${f(sw * 0.6)}" stroke-linejoin="round"/>` +
        head2
      );
    }
    case 'circle':
      return `<circle cx="${f(g.cx)}" cy="${f(g.cy)}" r="${f(g.r)}" ${tint}/>`;
    case 'ellipse': {
      const rot = g.rotation ? ` transform="rotate(${f(g.rotation)} ${f(g.cx)} ${f(g.cy)})"` : '';
      return `<ellipse cx="${f(g.cx)}" cy="${f(g.cy)}" rx="${f(g.rx)}" ry="${f(g.ry)}"${rot} ${tint}/>`;
    }
    case 'rectangle': {
      const rot = g.rotation ? ` transform="rotate(${f(g.rotation)} ${f(g.cx)} ${f(g.cy)})"` : '';
      const rx = Math.min(6, Math.min(g.w, g.h) * 0.08);
      return `<rect x="${f(g.cx - g.w / 2)}" y="${f(g.cy - g.h / 2)}" width="${f(g.w)}" height="${f(g.h)}" rx="${f(rx)}"${rot} ${tint}/>`;
    }
    case 'triangle':
    case 'diamond': {
      const pts = geometryOutline(g);
      return `<path d="M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}Z" ${tint}/>`;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry transforms

function center(g: ShapeGeometry): Pt {
  switch (g.kind) {
    case 'circle':
    case 'ellipse':
    case 'rectangle':
    case 'diamond':
      return { x: g.cx, y: g.cy };
    case 'triangle': {
      const b = bbox(g.points);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    case 'line':
    case 'arrow':
      return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    default:
      return { x: 0, y: 0 };
  }
}

/** Axis-aligned size (w, h) of a closed geometry. */
function size(g: ShapeGeometry): { w: number; h: number } {
  const b = geometryBBox(g);
  return { w: b.w, h: b.h };
}

export function translateGeometry(g: ShapeGeometry, dx: number, dy: number): ShapeGeometry {
  const mv = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
  switch (g.kind) {
    case 'circle':
    case 'ellipse':
    case 'rectangle':
    case 'diamond':
      return { ...g, cx: g.cx + dx, cy: g.cy + dy };
    case 'triangle':
      return { ...g, points: g.points.map(mv) as [Pt, Pt, Pt] };
    case 'line':
      return { ...g, a: mv(g.a), b: mv(g.b) };
    case 'arrow':
      return { ...g, a: mv(g.a), b: mv(g.b) };
    default:
      return g;
  }
}

/** Sets the axis-aligned height (or width) of a closed geometry around its centre, when supported. */
function resizeAxis(g: ShapeGeometry, axis: 'w' | 'h', value: number): ShapeGeometry {
  switch (g.kind) {
    case 'rectangle':
      if (g.rotation) return g;
      return { ...g, [axis]: value };
    case 'diamond':
      return { ...g, [axis]: value };
    case 'ellipse':
      if (g.rotation) return g;
      return axis === 'w' ? { ...g, rx: value / 2 } : { ...g, ry: value / 2 };
    default:
      return g;
  }
}

export interface Placed {
  geometry: ShapeGeometry;
}

/** Groups indices whose values are within their pairwise tolerance (single-link, sorted sweep). */
function groupBy1D(items: { v: number; tol: number; i: number }[]): number[][] {
  const s = [...items].sort((a, b) => a.v - b.v);
  const groups: number[][] = [];
  let cur: typeof s = [];
  for (const it of s) {
    const last = cur[cur.length - 1];
    if (last && it.v - last.v <= Math.min(it.tol, last.tol)) cur.push(it);
    else {
      if (cur.length) groups.push(cur.map((c) => c.i));
      cur = [it];
    }
  }
  if (cur.length) groups.push(cur.map((c) => c.i));
  return groups.filter((g) => g.length > 1);
}

/**
 * Aligns closed shapes in place: shapes whose centres are nearly level share one centre line
 * (rows / columns), and same-kind shapes of nearly equal size in a row/column get equal sizes.
 */
export function alignShapes<T extends Placed>(shapes: T[], tolerance = 0.18): T[] {
  const closed = shapes.map((s, i) => ({ s, i })).filter(({ s }) => isClosedKind(s.geometry.kind as ShapeKind));
  if (closed.length < 2) return shapes;
  for (const axis of ['y', 'x'] as const) {
    const items = closed.map(({ s, i }) => {
      const c = center(s.geometry);
      const sz = size(s.geometry);
      const extent = axis === 'y' ? sz.h : sz.w;
      return { v: axis === 'y' ? c.y : c.x, tol: Math.max(4, Math.min(24, extent * tolerance)), i };
    });
    for (const group of groupBy1D(items)) {
      const vals = group.map((i) => center(shapes[i].geometry)[axis]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      for (const i of group) {
        const c = center(shapes[i].geometry);
        shapes[i].geometry = translateGeometry(shapes[i].geometry, axis === 'x' ? mean - c.x : 0, axis === 'y' ? mean - c.y : 0);
      }
      // equalise the cross size (heights in a row, widths in a column) for same-kind shapes
      const dim = axis === 'y' ? 'h' : 'w';
      const byKind = new Map<string, number[]>();
      for (const i of group) {
        const k = shapes[i].geometry.kind;
        byKind.set(k, [...(byKind.get(k) ?? []), i]);
      }
      for (const [kind, idx] of byKind) {
        if (idx.length < 2) continue;
        const sizes = idx.map((i) => size(shapes[i].geometry)[dim]);
        const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
        if (sizes.some((v) => Math.abs(v - avg) > avg * 0.15)) continue;
        for (const i of idx) {
          const g = shapes[i].geometry;
          if (kind === 'circle' && g.kind === 'circle') shapes[i].geometry = { ...g, r: avg / 2 };
          else shapes[i].geometry = resizeAxis(g, dim, avg);
        }
      }
    }
  }
  return shapes;
}

/** Where the line through (from → to) meets the outline, nearest to `near`; null if it misses. */
function lineHitOutline(outline: readonly Pt[], from: Pt, to: Pt, near: Pt): Pt | null {
  let best: Pt | null = null;
  let bestD = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const p = lineIntersection(from, to, a, b);
    if (!p) continue;
    // must lie on the outline edge
    const q = closestOnSegment(p, a, b);
    if (dist(p, q) > 1e-6) continue;
    const d = dist(p, near);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function closestOnOutline(outline: readonly Pt[], p: Pt): Pt {
  let best = outline[0];
  let bestD = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const q = closestOnSegment(p, outline[i], outline[(i + 1) % outline.length]);
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * Glues line/arrow endpoints to nearby closed shapes. When both ends attach and the
 * connector roughly follows the centre-to-centre direction, it is re-routed along that
 * line so connectors between aligned boxes come out perfectly straight.
 * Returns, per connector index, the indices of the shapes it attached to.
 */
export function snapConnectors<T extends Placed>(shapes: T[], gap = 2): Map<number, [number | null, number | null]> {
  const out = new Map<number, [number | null, number | null]>();
  const closed = shapes.map((s, i) => ({ s, i, outline: geometryOutline(s.geometry, 72) })).filter(({ s }) => isClosedKind(s.geometry.kind as ShapeKind));
  if (!closed.length) return out;
  shapes.forEach((s, ci) => {
    const g = s.geometry;
    if (g.kind !== 'line' && g.kind !== 'arrow') return;
    const len = dist(g.a, g.b);
    const tol = Math.max(18, len * 0.15);
    const attach = (p: Pt) => {
      let best: (typeof closed)[number] | null = null;
      let bestD = Infinity;
      for (const c of closed) {
        const inside = pointInPolygon(p, c.outline);
        const d = inside ? 0 : distToPolygon(p, c.outline);
        if (d <= tol && d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    };
    const A = attach(g.a);
    const B = attach(g.b);
    if (A && B && A.i === B.i) return; // both ends on the same shape: leave alone
    let a = g.a;
    let b = g.b;
    if (A && B) {
      const ca = center(A.s.geometry);
      const cb = center(B.s.geometry);
      const dirC = Math.atan2(cb.y - ca.y, cb.x - ca.x);
      const dirG = Math.atan2(b.y - a.y, b.x - a.x);
      let diff = Math.abs(dirC - dirG) % (2 * Math.PI);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < (15 * Math.PI) / 180) {
        a = lineHitOutline(A.outline, ca, cb, cb) ?? a;
        b = lineHitOutline(B.outline, ca, cb, ca) ?? b;
      } else {
        a = lineHitOutline(A.outline, g.b, g.a, g.a) ?? closestOnOutline(A.outline, g.a);
        b = lineHitOutline(B.outline, g.a, g.b, g.b) ?? closestOnOutline(B.outline, g.b);
      }
    } else if (A) {
      a = lineHitOutline(A.outline, g.b, g.a, g.a) ?? closestOnOutline(A.outline, g.a);
    } else if (B) {
      b = lineHitOutline(B.outline, g.a, g.b, g.b) ?? closestOnOutline(B.outline, g.b);
    } else return;
    // pull back slightly so strokes don't overlap the outline
    const L = dist(a, b);
    if (L > 4 * gap) {
      const ux = (b.x - a.x) / L;
      const uy = (b.y - a.y) / L;
      if (A) a = { x: a.x + ux * gap, y: a.y + uy * gap };
      if (B) b = { x: b.x - ux * gap, y: b.y - uy * gap };
    }
    const r = (p: Pt) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    s.geometry = { ...g, a: r(a), b: r(b) };
    out.set(ci, [A ? A.i : null, B ? B.i : null]);
  });
  return out;
}
