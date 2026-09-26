/**
 * Synthetic, seeded "hand-drawn" strokes for recogniser tests and demos.
 * Deterministic: the same seed always yields the same jitter.
 */
import type { Stroke } from '../../schema';
import type { Pt } from '../geometry';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Densifies a polyline so consecutive points are ≤ `step` apart. */
export function densify(pts: readonly Pt[], step = 2): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      out.push({ ...pts[0] });
      continue;
    }
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/**
 * Adds hand-like noise: a smooth low-frequency wobble (amplitude `amp`) plus small
 * high-frequency jitter (amp / 4).
 */
export function jitter(pts: readonly Pt[], amp: number, rng: () => number): Pt[] {
  let wx = 0;
  let wy = 0;
  let vx = 0;
  let vy = 0;
  return pts.map((p) => {
    vx = vx * 0.9 + (rng() - 0.5) * amp * 0.08;
    vy = vy * 0.9 + (rng() - 0.5) * amp * 0.08;
    wx = Math.max(-amp, Math.min(amp, wx * 0.97 + vx));
    wy = Math.max(-amp, Math.min(amp, wy * 0.97 + vy));
    return { x: p.x + wx + (rng() - 0.5) * amp * 0.25, y: p.y + wy + (rng() - 0.5) * amp * 0.25 };
  });
}

let seq = 0;
export function toStroke(pts: readonly Pt[], opts: Partial<Omit<Stroke, 'pts'>> = {}): Stroke {
  const flat: number[] = [];
  for (const p of pts) flat.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, 0.5);
  return { id: opts.id ?? `s${++seq}`, pts: flat, color: opts.color ?? 'currentInk', size: opts.size ?? 3, tool: opts.tool ?? 'pen' };
}

export function arc(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number, rotDeg = 0, n = 120): Pt[] {
  const r = (rotDeg * Math.PI) / 180;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n;
    const x = Math.cos(t) * rx;
    const y = Math.sin(t) * ry;
    out.push({ x: cx + x * Math.cos(r) - y * Math.sin(r), y: cy + x * Math.sin(r) + y * Math.cos(r) });
  }
  return out;
}

export function rotatePts(pts: readonly Pt[], c: Pt, deg: number): Pt[] {
  const r = (deg * Math.PI) / 180;
  return pts.map((p) => ({
    x: c.x + (p.x - c.x) * Math.cos(r) - (p.y - c.y) * Math.sin(r),
    y: c.y + (p.x - c.x) * Math.sin(r) + (p.y - c.y) * Math.cos(r),
  }));
}

export function rectPath(x: number, y: number, w: number, h: number, rotDeg = 0, overshoot = 0.04): Pt[] {
  const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }, { x: x + w * overshoot, y }];
  return rotatePts(densify(pts), { x: x + w / 2, y: y + h / 2 }, rotDeg);
}

/** Single-stroke arrow: tail → tip → barb1 → tip → barb2. */
export function arrowPath(tail: Pt, tip: Pt, barbLen = 0.2, barbDeg = 30, sides = 2): Pt[] {
  const len = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  const bx = (tail.x - tip.x) / len;
  const by = (tail.y - tip.y) / len;
  const barb = (sgn: number) => {
    const r = (sgn * barbDeg * Math.PI) / 180;
    return { x: tip.x + (bx * Math.cos(r) - by * Math.sin(r)) * len * barbLen, y: tip.y + (bx * Math.sin(r) + by * Math.cos(r)) * len * barbLen };
  };
  const pts = [tail, tip, barb(1)];
  if (sides === 2) pts.push(tip, barb(-1));
  return densify(pts);
}

/** A "V" arrowhead as its own stroke at `tip`, pointing away from `from`. */
export function arrowHeadV(from: Pt, tip: Pt, size = 20, barbDeg = 30): Pt[] {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const bx = (from.x - tip.x) / len;
  const by = (from.y - tip.y) / len;
  const barb = (sgn: number) => {
    const r = (sgn * barbDeg * Math.PI) / 180;
    return { x: tip.x + (bx * Math.cos(r) - by * Math.sin(r)) * size, y: tip.y + (bx * Math.sin(r) + by * Math.cos(r)) * size };
  };
  return densify([barb(1), tip, barb(-1)]);
}

/** Crude cursive letters, `h` = x-height, starting at (x, y) = top-left of the x-height box. */
export function letter(ch: string, x: number, y: number, h = 30): Pt[] {
  const P = (px: number, py: number) => ({ x: x + px * h, y: y + py * h });
  switch (ch) {
    case 'e': {
      // horizontal bar then a counter-clockwise loop that stays open
      const loop = arc(x + 0.4 * h, y + 0.5 * h, 0.4 * h, 0.5 * h, 0, -Math.PI * 1.75, 0, 60);
      return densify([P(0, 0.5), P(0.8, 0.5), ...loop]);
    }
    case 's': {
      const pts: Pt[] = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        pts.push(P(0.4 + 0.35 * Math.cos(t * Math.PI * 2 + Math.PI / 2) * (1 - 2 * t) * -1, t));
      }
      return densify(pts);
    }
    case 'm': {
      const pts: Pt[] = [P(0, 1), P(0, 0.2)];
      pts.push(...arc(x + 0.25 * h, y + 0.3 * h, 0.25 * h, 0.3 * h, Math.PI, Math.PI, 0, 20));
      pts.push(P(0.5, 1), P(0.5, 0.3));
      pts.push(...arc(x + 0.75 * h, y + 0.3 * h, 0.25 * h, 0.3 * h, Math.PI, Math.PI, 0, 20));
      pts.push(P(1, 1));
      return densify(pts);
    }
    case 'a': {
      const loop = arc(x + 0.35 * h, y + 0.5 * h, 0.35 * h, 0.45 * h, -Math.PI * 0.2, -Math.PI * 2, 0, 60);
      return densify([...loop, P(0.7, 0.1), P(0.72, 0.95), P(0.85, 1)]);
    }
    case 'z':
      return densify([P(0, 0), P(0.8, 0), P(0, 1), P(0.85, 1)]);
    case 'l': {
      // cursive l: up-stroke loop
      const pts: Pt[] = [P(0, 1)];
      pts.push(...arc(x + 0.25 * h, y - 0.3 * h, 0.2 * h, 0.9 * h, Math.PI * 0.35, -Math.PI * 1.3, 0, 40));
      pts.push(P(0.35, 1));
      return densify(pts);
    }
    case '2':
      return densify([...arc(x + 0.4 * h, y + 0.3 * h, 0.35 * h, 0.3 * h, Math.PI * 1.1, Math.PI * 1.2, 0, 30), P(0, 1), P(0.85, 1)]);
    case '3':
      return densify([
        ...arc(x + 0.4 * h, y + 0.25 * h, 0.35 * h, 0.25 * h, Math.PI * 1.1, Math.PI * 1.4, 0, 30),
        ...arc(x + 0.4 * h, y + 0.75 * h, 0.4 * h, 0.25 * h, -Math.PI * 0.6, Math.PI * 1.5, 0, 30),
      ]);
    case 'x':
      return densify([P(0, 0), P(0.8, 1)]);
    case 'o':
      return arc(x + 0.4 * h, y + 0.5 * h, 0.4 * h, 0.5 * h, -Math.PI / 2, -Math.PI * 2.05, 0, 60);
    default:
      return densify([P(0, 0), P(0.5, 1)]);
  }
}

/** A handwritten word as separate strokes (one per letter), spaced along x. */
export function word(text: string, x: number, y: number, h = 30, rng?: () => number): Stroke[] {
  const out: Stroke[] = [];
  let cx = x;
  for (const ch of text) {
    if (ch === ' ') {
      cx += h * 0.8;
      continue;
    }
    let pts = letter(ch, cx, y, h);
    if (rng) pts = jitter(pts, h * 0.03, rng);
    out.push(toStroke(pts));
    cx += h * 1.05;
  }
  return out;
}
