/**
 * Input conditioning for ink capture: quantisation (keeps CRDT updates small), a
 * one-euro filter for jittery mouse/finger input, and velocity-based pressure
 * simulation for devices that report no pressure.
 */

/** Rounds a coordinate to 0.1 logical units. */
export function quantize(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Rounds pressure to 0.01. */
export function quantizePressure(p: number): number {
  return Math.round(Math.min(1, Math.max(0, p)) * 100) / 100;
}

/**
 * Quantises a flat [x, y, p, ...] array and drops consecutive duplicate points
 * (after quantisation). Always keeps at least one point.
 */
export function quantizePoints(pts: readonly number[]): number[] {
  const out: number[] = [];
  let lx = NaN;
  let ly = NaN;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const x = quantize(pts[i]);
    const y = quantize(pts[i + 1]);
    const p = quantizePressure(pts[i + 2]);
    if (x === lx && y === ly) {
      // keep the max pressure of duplicates
      if (p > out[out.length - 1]) out[out.length - 1] = p;
      continue;
    }
    out.push(x, y, p);
    lx = x;
    ly = y;
  }
  return out;
}

class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset() {
    this.y = null;
  }
}

function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * One-euro filter (Casiez et al. 2012): strong smoothing at low speed (removes jitter),
 * little smoothing at high speed (no lag). Time in milliseconds.
 */
export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;

  constructor(
    private minCutoff = 2.5,
    private beta = 0.04,
    private dCutoff = 1.0,
  ) {}

  filter(value: number, tMs: number): number {
    const prevT = this.lastT;
    this.lastT = tMs;
    if (prevT === null || tMs <= prevT) {
      const prev = this.x.last();
      if (prev === null) {
        this.dx.filter(0, 1);
        return this.x.filter(value, 1);
      }
      return this.x.filter(value, 0.5);
    }
    // clamp dt: bogus/too-close timestamps would otherwise freeze the filter (≥ 4 ms ≈ 250 Hz)
    const dt = Math.max(4, tMs - prevT) / 1000;
    const prevX = this.x.last() ?? value;
    const dValue = (value - prevX) / dt;
    const edx = this.dx.filter(dValue, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}

/** 2D wrapper around two one-euro filters. */
export class PointSmoother {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  constructor(minCutoff?: number, beta?: number) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }
  filter(x: number, y: number, tMs: number): [number, number] {
    return [this.fx.filter(x, tMs), this.fy.filter(y, tMs)];
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}

/**
 * Simulates pen pressure from drawing speed: slow strokes are thicker, fast strokes thinner,
 * with easing so width changes smoothly. Speeds are in logical units per millisecond.
 */
export class PressureSimulator {
  private p = 0.5;
  private lastX: number | null = null;
  private lastY = 0;
  private lastT = 0;

  next(x: number, y: number, tMs: number): number {
    if (this.lastX === null) {
      this.lastX = x;
      this.lastY = y;
      this.lastT = tMs;
      this.p = 0.55;
      return this.p;
    }
    const d = Math.hypot(x - this.lastX, y - this.lastY);
    const dt = Math.max(1, tMs - this.lastT);
    this.lastX = x;
    this.lastY = y;
    this.lastT = tMs;
    const v = d / dt;
    const target = simulatedPressure(v);
    this.p += (target - this.p) * 0.35;
    return this.p;
  }

  reset() {
    this.lastX = null;
    this.p = 0.5;
  }
}

/** Maps speed (logical units / ms) to a pressure in [0.25, 0.8]. */
export function simulatedPressure(speed: number): number {
  const p = 0.8 - Math.min(1, speed / 3) * 0.55;
  return Math.max(0.25, Math.min(0.8, p));
}
