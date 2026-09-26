import { describe, expect, it } from 'vitest';
import type { Rating } from '../schema';
import {
  DAY,
  DEFAULT_WEIGHTS,
  MINUTE,
  forgettingCurve,
  formatInterval,
  fuzzInterval,
  initDifficulty,
  initStability,
  newCardState,
  nextDifficulty,
  nextForgetStability,
  nextInterval,
  nextRecallStability,
  preview,
  retrievability,
  schedule,
  seededRandom,
  type SchedCard,
} from './fsrs';

const T0 = Date.UTC(2026, 0, 5, 12);
const w = DEFAULT_WEIGHTS;

function fresh(id = 'b1:1'): SchedCard {
  return { id, pageId: 'p', blockId: 'b1', kind: 'cloze', front: 'x', srcHash: 'h', createdAt: T0, ...newCardState(T0) };
}

/** Rates a card repeatedly at its due time. */
function run(card: SchedCard, ratings: Rating[], start = T0): SchedCard {
  let c = card;
  let now = start;
  for (const r of ratings) {
    c = schedule(c, r, now).card;
    now = c.due;
  }
  return c;
}

/** A graduated review card with the given stability, last reviewed at T0. */
function reviewCard(stability: number, difficulty = 5): SchedCard {
  return { ...fresh(), state: 'review', stability, difficulty, reps: 5, lastReview: T0, due: T0 + stability * DAY, scheduledDays: stability };
}

describe('FSRS-5 memory model', () => {
  it('has 19 default weights', () => {
    expect(w).toHaveLength(19);
  });

  it('forgetting curve is 0.9 at t = S and decreasing', () => {
    expect(forgettingCurve(10, 10)).toBeCloseTo(0.9, 6);
    expect(forgettingCurve(0, 10)).toBe(1);
    expect(forgettingCurve(20, 10)).toBeLessThan(forgettingCurve(10, 10));
  });

  it('initial stability is w[G-1] and initial difficulty decreases with rating', () => {
    expect(initStability(w, 1)).toBeCloseTo(0.40255);
    expect(initStability(w, 4)).toBeCloseTo(15.69105);
    const ds = ([1, 2, 3, 4] as Rating[]).map((g) => initDifficulty(w, g));
    expect(ds[0]).toBeGreaterThan(ds[1]);
    expect(ds[1]).toBeGreaterThan(ds[2]);
    expect(ds[2]).toBeGreaterThan(ds[3]);
    for (const d of ds) expect(d).toBeGreaterThanOrEqual(1);
    for (const d of ds) expect(d).toBeLessThanOrEqual(10);
    // D0(3) = w4 - e^(2·w5) + 1
    expect(initDifficulty(w, 3)).toBeCloseTo(w[4] - Math.exp(2 * w[5]) + 1, 6);
  });

  it('difficulty stays within [1, 10] under extreme sequences', () => {
    let d = 5;
    for (let i = 0; i < 100; i++) d = nextDifficulty(w, d, 1);
    expect(d).toBeLessThanOrEqual(10);
    expect(d).toBeGreaterThan(9);
    for (let i = 0; i < 100; i++) d = nextDifficulty(w, d, 4);
    expect(d).toBeGreaterThanOrEqual(1);
  });

  it('Again raises difficulty, Easy lowers it, Good barely moves it', () => {
    expect(nextDifficulty(w, 5, 1)).toBeGreaterThan(5);
    expect(nextDifficulty(w, 5, 4)).toBeLessThan(5);
    expect(Math.abs(nextDifficulty(w, 5, 3) - 5)).toBeLessThan(0.05);
  });

  it('recall stability grows (Hard < Good < Easy); forget stability shrinks', () => {
    const s = 10;
    const r = forgettingCurve(10, s);
    const hard = nextRecallStability(w, 5, s, r, 2);
    const good = nextRecallStability(w, 5, s, r, 3);
    const easy = nextRecallStability(w, 5, s, r, 4);
    expect(hard).toBeGreaterThan(s);
    expect(good).toBeGreaterThan(hard);
    expect(easy).toBeGreaterThan(good);
    expect(nextForgetStability(w, 5, s, r)).toBeLessThan(s);
  });

  it('stability gain is larger when recalled at lower retrievability (spacing effect)', () => {
    const early = nextRecallStability(w, 5, 10, forgettingCurve(2, 10), 3);
    const late = nextRecallStability(w, 5, 10, forgettingCurve(20, 10), 3);
    expect(late).toBeGreaterThan(early);
  });

  it('interval equals stability at 90 % retention and shrinks for higher retention', () => {
    expect(nextInterval(10)).toBe(10);
    expect(nextInterval(10, { requestRetention: 0.95 })).toBeLessThan(10);
    expect(nextInterval(10, { requestRetention: 0.8 })).toBeGreaterThan(10);
    expect(nextInterval(100000)).toBe(36500);
    expect(nextInterval(100, { maximumInterval: 30 })).toBe(30);
  });
});

describe('schedule: learning steps', () => {
  it('new card: Again 1m, Hard ~6m, Good 10m, Easy graduates', () => {
    const p = preview(fresh(), T0);
    expect(p[1].due - T0).toBe(1 * MINUTE);
    expect(p[2].due - T0).toBe(5.5 * MINUTE);
    expect(p[3].due - T0).toBe(10 * MINUTE);
    expect(p[4].state).toBe('review');
    expect(p[4].due - T0).toBeGreaterThanOrEqual(10 * DAY);
    expect(p[1].intervalLabel).toBe('1m');
    expect(p[2].intervalLabel).toBe('6m');
    expect(p[3].intervalLabel).toBe('10m');
  });

  it('first review initialises FSRS state and logs the pre-review state', () => {
    const { card, log } = schedule(fresh(), 3, T0);
    expect(card.state).toBe('learning');
    expect(card.stability).toBeCloseTo(w[2]);
    expect(card.difficulty).toBeCloseTo(initDifficulty(w, 3));
    expect(card.reps).toBe(1);
    expect(card.lastReview).toBe(T0);
    expect(card.learningStep).toBe(1);
    expect(log).toMatchObject({ cardId: 'b1:1', rating: 3, at: T0, state: 'new' });
  });

  it('Good, Good graduates to review with a multi-day interval', () => {
    const c = run(fresh(), [3, 3]);
    expect(c.state).toBe('review');
    expect(c.learningStep).toBeUndefined();
    expect(c.scheduledDays).toBeGreaterThanOrEqual(2);
    // same-day review uses short-term stability: S·e^(w17·w18)
    expect(c.stability).toBeCloseTo(w[2] * Math.exp(w[17] * w[18]), 4);
  });

  it('Again during learning resets to the first step', () => {
    const c = run(fresh(), [3, 1]);
    expect(c.state).toBe('learning');
    expect(c.learningStep).toBe(0);
    expect(c.due - c.lastReview!).toBe(MINUTE);
  });

  it('lapse enters relearning, increments lapses, and reduces stability', () => {
    const card = reviewCard(20);
    const { card: after } = schedule(card, 1, T0 + 20 * DAY);
    expect(after.state).toBe('relearning');
    expect(after.lapses).toBe(1);
    expect(after.stability).toBeLessThan(20);
    expect(after.due - (T0 + 20 * DAY)).toBe(10 * MINUTE);
    const back = schedule(after, 3, after.due).card;
    expect(back.state).toBe('review');
    expect(back.scheduledDays).toBeGreaterThanOrEqual(1);
  });

  it('empty learning steps graduate on the first answer', () => {
    const p = preview(fresh(), T0, { learningSteps: [] });
    for (const g of [1, 2, 3, 4] as Rating[]) expect(p[g].state).toBe('review');
  });
});

describe('schedule: review cards', () => {
  it('Good increases stability, Again decreases it', () => {
    const card = reviewCard(10);
    const now = T0 + 10 * DAY;
    expect(schedule(card, 3, now).card.stability).toBeGreaterThan(10);
    expect(schedule(card, 1, now).card.stability).toBeLessThan(10);
  });

  it('intervals are strictly monotonic Hard < Good < Easy (with fuzz)', () => {
    for (const s of [1, 3, 8, 30, 120, 400]) {
      for (let k = 0; k < 20; k++) {
        const card = { ...reviewCard(s), id: `c${k}` };
        const now = T0 + Math.round(s * DAY);
        const p = preview(card, now);
        expect(p[2].due).toBeLessThan(p[3].due);
        expect(p[3].due).toBeLessThan(p[4].due);
        expect(p[1].due).toBeLessThan(p[2].due);
      }
    }
  });

  it('preview matches schedule for every rating', () => {
    const card = reviewCard(15);
    const now = T0 + 16 * DAY;
    const p = preview(card, now);
    for (const g of [1, 2, 3, 4] as Rating[]) expect(schedule(card, g, now).card.due).toBe(p[g].due);
  });

  it('is deterministic (seeded fuzz)', () => {
    const card = reviewCard(30);
    const now = T0 + 30 * DAY;
    expect(schedule(card, 3, now)).toEqual(schedule(card, 3, now));
  });

  it('repeated Good answers grow intervals roughly exponentially', () => {
    let c = run(fresh(), [3, 3]);
    const intervals: number[] = [];
    for (let i = 0; i < 6; i++) {
      c = schedule(c, 3, c.due).card;
      intervals.push(c.scheduledDays);
    }
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
    expect(intervals.at(-1)!).toBeGreaterThan(60);
  });

  it('respects maximumInterval', () => {
    const card = reviewCard(5000);
    const p = preview(card, T0 + 5000 * DAY, { maximumInterval: 365 });
    expect(p[4].due - (T0 + 5000 * DAY)).toBeLessThanOrEqual(366 * DAY);
  });

  it('retrievability is 1 for new cards and ~0.9 at the due date', () => {
    expect(retrievability(fresh(), T0)).toBe(1);
    const card = reviewCard(10);
    expect(retrievability(card, T0 + 10 * DAY)).toBeCloseTo(0.9, 5);
  });
});

describe('fuzz & labels', () => {
  it('does not fuzz short intervals and stays within the fuzz window', () => {
    expect(fuzzInterval(2, 0.99, 36500)).toBe(2);
    for (let i = 0; i < 50; i++) {
      const r = seededRandom(`s${i}`);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      const f = fuzzInterval(100, r, 36500);
      // delta = 1 + 0.15·4.5 + 0.1·13 + 0.05·80 ≈ 6.98 → [93, 107]
      expect(f).toBeGreaterThanOrEqual(93);
      expect(f).toBeLessThanOrEqual(107);
    }
  });

  it('formats interval labels', () => {
    expect(formatInterval(30_000)).toBe('1m');
    expect(formatInterval(10 * MINUTE)).toBe('10m');
    expect(formatInterval(5 * 60 * MINUTE)).toBe('5h');
    expect(formatInterval(DAY)).toBe('1d');
    expect(formatInterval(12 * DAY)).toBe('12d');
    expect(formatInterval(97 * DAY)).toBe('3.2mo');
    expect(formatInterval(60.875 * DAY)).toBe('2mo');
    expect(formatInterval(548 * DAY)).toBe('1.5y');
  });
});
