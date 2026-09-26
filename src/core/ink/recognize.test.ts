import { describe, expect, it } from 'vitest';
import { recognizeGroup, recognizePoints, recognizeStroke, snapSegment, SHAPE_CONFIDENCE } from './recognize';
import { arc, arrowHeadV, arrowPath, densify, jitter, letter, mulberry32, rectPath, rotatePts, toStroke } from './testing/synth';
import type { Pt } from './geometry';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function each(fn: (rng: () => number, seed: number) => void) {
  for (const s of SEEDS) fn(mulberry32(s), s);
}

describe('recognizer: lines', () => {
  it('recognises noisy lines and snaps near-horizontal ones', () => {
    each((rng) => {
      const pts = jitter(densify([{ x: 100, y: 200 }, { x: 500, y: 214 }]), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('line');
      expect(r.confidence).toBeGreaterThan(SHAPE_CONFIDENCE);
      if (r.geometry.kind !== 'line') throw new Error();
      expect(Math.abs(r.geometry.a.y - r.geometry.b.y)).toBeLessThan(0.5);
    });
  });

  it('snaps 45° and 90° but leaves 25° alone', () => {
    const [a, b] = snapSegment({ x: 0, y: 0 }, { x: 100, y: 95 });
    expect(Math.abs(Math.abs(b.x - a.x) - Math.abs(b.y - a.y))).toBeLessThan(0.3);
    const [c, d] = snapSegment({ x: 0, y: 0 }, { x: 6, y: 100 });
    expect(Math.abs(c.x - d.x)).toBeLessThan(0.3);
    const [e, f] = snapSegment({ x: 0, y: 0 }, { x: 100, y: 47 });
    expect(f.y - e.y).toBeCloseTo(47, 0);
  });
});

describe('recognizer: arrows', () => {
  it('single-stroke arrows with a V head', () => {
    each((rng) => {
      const pts = jitter(arrowPath({ x: 100, y: 100 }, { x: 420, y: 130 }, 0.18, 32, 2), 2.5, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('arrow');
      expect(r.confidence).toBeGreaterThan(0.75);
      if (r.geometry.kind !== 'arrow') throw new Error();
      expect(r.geometry.b.x).toBeGreaterThan(r.geometry.a.x); // tip on the right
    });
  });

  it('single-stroke arrows with a hook (one barb)', () => {
    each((rng) => {
      const pts = jitter(arrowPath({ x: 300, y: 400 }, { x: 300, y: 120 }, 0.2, 35, 1), 2, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('arrow');
      expect(r.confidence).toBeGreaterThanOrEqual(SHAPE_CONFIDENCE);
      if (r.geometry.kind !== 'arrow') throw new Error();
      expect(r.geometry.b.y).toBeLessThan(r.geometry.a.y);
      expect(Math.abs(r.geometry.a.x - r.geometry.b.x)).toBeLessThan(0.5); // snapped vertical
    });
  });

  it('arrow drawn as shaft + separate V stroke', () => {
    each((rng) => {
      const tail = { x: 80, y: 300 };
      const tip = { x: 380, y: 310 };
      const shaft = toStroke(jitter(densify([tail, tip]), 2, rng));
      const head = toStroke(jitter(arrowHeadV(tail, { x: tip.x + 2, y: tip.y + 1 }, 28), 1.5, rng));
      const r = recognizeGroup([shaft, head]);
      expect(r.kind).toBe('arrow');
      expect(r.strokeIds).toEqual([shaft.id, head.id]);
      if (r.geometry.kind !== 'arrow') throw new Error();
      expect(r.geometry.b.x).toBeGreaterThan(370);
      expect(r.geometry.heads).toBe('end');
    });
  });

  it('double-headed arrow from separate strokes', () => {
    const rng = mulberry32(9);
    const a = { x: 100, y: 100 };
    const b = { x: 400, y: 100 };
    const r = recognizeGroup([
      toStroke(jitter(densify([a, b]), 2, rng)),
      toStroke(arrowHeadV(b, a, 25)),
      toStroke(arrowHeadV(a, b, 25)),
    ]);
    expect(r.kind).toBe('arrow');
    if (r.geometry.kind !== 'arrow') throw new Error();
    expect(r.geometry.heads).toBe('both');
  });
});

describe('recognizer: closed shapes', () => {
  it('circles (with gap or overshoot)', () => {
    each((rng, seed) => {
      const sweep = Math.PI * 2 * (seed % 2 ? 1.08 : 0.95);
      const pts = jitter(arc(300, 300, 80, 78, seed, sweep), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('circle');
      expect(r.confidence).toBeGreaterThan(SHAPE_CONFIDENCE);
      if (r.geometry.kind !== 'circle') throw new Error();
      expect(r.geometry.r).toBeGreaterThan(70);
      expect(r.geometry.r).toBeLessThan(92);
      expect(Math.abs(r.geometry.cx - 300)).toBeLessThan(8);
    });
  });

  it('ellipses, snapped axis-aligned when near', () => {
    each((rng, seed) => {
      const pts = jitter(arc(400, 250, 150, 70, seed * 0.3, Math.PI * 2.04, 5), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('ellipse');
      if (r.geometry.kind !== 'ellipse') throw new Error();
      expect(r.geometry.rotation).toBe(0);
      expect(r.geometry.rx).toBeGreaterThan(r.geometry.ry);
    });
  });

  it('rotated ellipse keeps its rotation', () => {
    const pts = jitter(arc(400, 250, 150, 60, 0, Math.PI * 2.04, 35), 2, mulberry32(3));
    const r = recognizePoints(pts);
    expect(r.kind).toBe('ellipse');
    if (r.geometry.kind !== 'ellipse') throw new Error();
    expect(Math.abs(Math.abs(r.geometry.rotation) - 35)).toBeLessThan(8);
  });

  it('rectangles (axis-snapped)', () => {
    each((rng, seed) => {
      const pts = jitter(rectPath(100, 100, 240, 130, (seed % 5) - 2), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('rectangle');
      expect(r.confidence).toBeGreaterThan(SHAPE_CONFIDENCE);
      if (r.geometry.kind !== 'rectangle') throw new Error();
      expect(r.geometry.rotation).toBe(0);
      expect(Math.abs(r.geometry.w - 240)).toBeLessThan(16);
      expect(Math.abs(r.geometry.h - 130)).toBeLessThan(16);
      expect(Math.abs(r.geometry.cx - 220)).toBeLessThan(8);
    });
  });

  it('rectangles drawn as 4 separate strokes', () => {
    const rng = mulberry32(11);
    const c = [
      { x: 100, y: 100 },
      { x: 300, y: 102 },
      { x: 302, y: 220 },
      { x: 98, y: 218 },
    ];
    const strokes = [0, 1, 2, 3].map((i) => toStroke(jitter(densify([c[i], c[(i + 1) % 4]]), 1.5, rng)));
    const r = recognizeGroup(strokes);
    expect(r.kind).toBe('rectangle');
    expect(r.strokeIds.length).toBe(4);
  });

  it('triangles', () => {
    each((rng) => {
      const pts = jitter(densify([{ x: 200, y: 100 }, { x: 320, y: 300 }, { x: 80, y: 305 }, { x: 200, y: 100 }, { x: 206, y: 110 }]), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('triangle');
      if (r.geometry.kind !== 'triangle') throw new Error();
      const ys = r.geometry.points.map((p) => p.y).sort((a, b) => a - b);
      expect(Math.abs(ys[1] - ys[2])).toBeLessThan(0.01); // base snapped horizontal
    });
  });

  it('diamonds', () => {
    each((rng) => {
      const pts = jitter(densify([{ x: 300, y: 100 }, { x: 420, y: 180 }, { x: 300, y: 260 }, { x: 180, y: 180 }, { x: 300, y: 100 }, { x: 310, y: 107 }]), 3, rng);
      const r = recognizePoints(pts);
      expect(r.kind).toBe('diamond');
      if (r.geometry.kind !== 'diamond') throw new Error();
      expect(Math.abs(r.geometry.w - 240)).toBeLessThan(20);
      expect(Math.abs(r.geometry.cy - 180)).toBeLessThan(8);
    });
  });

  it('a 45°-rotated square is a diamond', () => {
    const pts = jitter(rotatePts(rectPath(200, 200, 150, 150, 0), { x: 275, y: 275 }, 45), 2, mulberry32(4));
    expect(recognizePoints(pts).kind).toBe('diamond');
  });
});

describe('recognizer: negatives', () => {
  const letters = ['e', 's', 'm', 'a', 'z', 'l', '2', '3'];
  it.each(letters)('handwritten "%s" is not a shape', (ch) => {
    each((rng) => {
      const pts = jitter(letter(ch, 100, 100, 40), 1, rng);
      const r = recognizePoints(pts);
      if (r.kind !== 'none') {
        // tolerate only low-confidence guesses
        expect(r.confidence, `${ch} → ${r.kind}`).toBeLessThan(SHAPE_CONFIDENCE);
      }
    });
  });

  it('a figure-eight scribble is not a shape', () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI * 2;
      pts.push({ x: 300 + Math.sin(t) * 60, y: 300 + Math.sin(2 * t) * 40 });
    }
    expect(recognizePoints(pts).kind).toBe('none');
  });

  it('tiny marks and dots are none', () => {
    expect(recognizeStroke(toStroke([{ x: 10, y: 10 }])).kind).toBe('none');
    expect(recognizeStroke(toStroke(densify([{ x: 10, y: 10 }, { x: 14, y: 12 }]))).kind).toBe('none');
  });

  it('an L-shaped corner is not an arrow', () => {
    const pts = densify([{ x: 100, y: 100 }, { x: 100, y: 300 }, { x: 180, y: 300 }]);
    expect(recognizePoints(pts).kind).toBe('none');
  });
});
