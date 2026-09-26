import { describe, expect, it } from 'vitest';
import {
  bbox,
  convexHull,
  distPointSegment,
  pathLength,
  pointInPolygon,
  polygonArea,
  polygonHitsStroke,
  polylineDistance,
  rdp,
  resample,
  strokeBBox,
  strokeInPolygon,
  strokeLength,
  strokesNear,
  transformStroke,
} from './geometry';
import { OneEuroFilter, PressureSimulator, quantize, quantizePoints, simulatedPressure } from './smoothing';
import { toStroke, densify } from './testing/synth';

describe('geometry', () => {
  it('bbox / length', () => {
    expect(bbox([{ x: 1, y: 2 }, { x: 5, y: -1 }])).toEqual({ x: 1, y: -1, w: 4, h: 3 });
    const s = toStroke([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }]);
    expect(strokeLength(s)).toBeCloseTo(11);
    expect(strokeBBox(s)).toEqual({ x: 0, y: 0, w: 3, h: 10 });
  });

  it('resamples to exactly n equally spaced points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const r = resample(pts, 5);
    expect(r).toHaveLength(5);
    expect(r[2].x).toBeCloseTo(10);
    expect(r[2].y).toBeCloseTo(0);
    expect(r[4]).toEqual({ x: 10, y: 10 });
    expect(pathLength(r)).toBeCloseTo(20);
  });

  it('RDP keeps corners and drops collinear points', () => {
    const pts = densify([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 5);
    const s = rdp(pts, 1);
    expect(s).toHaveLength(3);
    expect(s[1]).toEqual({ x: 100, y: 0 });
  });

  it('point in polygon / lasso selection', () => {
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(pointInPolygon({ x: 50, y: 50 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, sq)).toBe(false);
    const inside = toStroke(densify([{ x: 10, y: 10 }, { x: 90, y: 90 }]));
    const half = toStroke(densify([{ x: 50, y: 50 }, { x: 150, y: 50 }]));
    expect(strokeInPolygon(inside, sq)).toBe(true);
    expect(strokeInPolygon(half, sq, 0.6)).toBe(false);
    expect(strokeInPolygon(half, sq, 0.4)).toBe(true);
  });

  it('distances and proximity', () => {
    expect(distPointSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    expect(distPointSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const b = [{ x: 5, y: -5 }, { x: 5, y: 5 }];
    expect(polylineDistance(a, b)).toBe(0);
    expect(polylineDistance(a, [{ x: 0, y: 3 }, { x: 10, y: 3 }])).toBeCloseTo(3);
    const s1 = toStroke(a);
    const s2 = toStroke([{ x: 0, y: 8 }, { x: 10, y: 8 }]);
    expect(strokesNear(s1, s2, 10)).toBe(true);
    expect(strokesNear(s1, s2, 5)).toBe(false);
  });

  it('eraser hit testing includes stroke width', () => {
    const s = toStroke(densify([{ x: 0, y: 0 }, { x: 100, y: 0 }]), { size: 4 });
    expect(polygonHitsStroke([{ x: 50, y: -20 }, { x: 50, y: 20 }], s)).toBe(true);
    expect(polygonHitsStroke([{ x: 50, y: 3.5 }, { x: 60, y: 3.5 }], s, 2)).toBe(true);
    expect(polygonHitsStroke([{ x: 50, y: 9 }, { x: 60, y: 9 }], s, 2)).toBe(false);
  });

  it('hull and area', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const h = convexHull(pts);
    expect(h).toHaveLength(4);
    expect(Math.abs(polygonArea(h))).toBeCloseTo(100);
  });

  it('transformStroke moves and scales around an origin', () => {
    const s = toStroke([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    const t = transformStroke(s, { dx: 5, dy: 0, s: 2, ox: 10, oy: 10 });
    expect(t.pts).toEqual([15, 10, 0.5, 35, 30, 0.5]);
    expect(t.id).toBe(s.id);
    expect(s.pts[0]).toBe(10); // original untouched
  });
});

describe('smoothing', () => {
  it('quantises to 0.1 and drops duplicates', () => {
    expect(quantize(1.234)).toBe(1.2);
    expect(quantizePoints([1.01, 2.02, 0.5, 1.04, 2.01, 0.7, 3, 3, 0.333])).toEqual([1, 2, 0.7, 3, 3, 0.33]);
  });

  it('one-euro filter damps jitter at low speed', () => {
    const f = new OneEuroFilter();
    let maxDev = 0;
    for (let i = 0; i < 100; i++) {
      const noisy = 100 + (i % 2 ? 1 : -1);
      maxDev = Math.max(maxDev, Math.abs(f.filter(noisy, i * 8) - 100));
    }
    expect(maxDev).toBeLessThanOrEqual(1);
    const f2 = new OneEuroFilter();
    f2.filter(0, 0);
    let v = 0;
    for (let i = 1; i <= 20; i++) v = f2.filter(i * 20, i * 8);
    expect(400 - v).toBeLessThan(60); // follows fast motion with little lag
  });

  it('simulated pressure: slow is thicker than fast', () => {
    expect(simulatedPressure(0)).toBeGreaterThan(simulatedPressure(3));
    const sim = new PressureSimulator();
    sim.next(0, 0, 0);
    let slow = 0;
    for (let i = 1; i < 20; i++) slow = sim.next(i * 0.2, 0, i * 16);
    const sim2 = new PressureSimulator();
    sim2.next(0, 0, 0);
    let fast = 0;
    for (let i = 1; i < 20; i++) fast = sim2.next(i * 60, 0, i * 16);
    expect(slow).toBeGreaterThan(fast);
  });
});
