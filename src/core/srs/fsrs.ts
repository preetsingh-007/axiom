/**
 * FSRS-5 scheduler (Free Spaced Repetition Scheduler, v5), as pure functions.
 *
 * Memory model (DSR): each card has Difficulty D ∈ [1, 10], Stability S (days until
 * retrievability drops to 90 %) and Retrievability R(t) = (1 + FACTOR·t/S)^DECAY.
 *
 * Formulas follow the reference implementation (fsrs-rs / ts-fsrs, FSRS-5):
 *  - S0(G)        = w[G-1]
 *  - D0(G)        = w4 − e^(w5·(G−1)) + 1
 *  - D'(D, G)     = w7·D0(4) + (1 − w7)·(D + ΔD·(10 − D)/9),  ΔD = −w6·(G − 3)
 *  - S'recall     = S·(e^w8·(11 − D)·S^−w9·(e^(w10·(1−R)) − 1)·hard(w15)·easy(w16) + 1)
 *  - S'forget     = min(w11·D^−w12·((S+1)^w13 − 1)·e^(w14·(1−R)), S / e^(w17·w18))
 *  - S'short-term = S·e^(w17·(G − 3 + w18))          (same-day reviews, FSRS-5)
 *  - interval     = S / FACTOR · (r^(1/DECAY) − 1)    (= S when r = 0.9)
 *
 * Learning steps (Anki / ts-fsrs v5 style, configurable):
 *  - new/learning cards walk `learningSteps` (default 1m, 10m): Again → first step,
 *    Hard → average of first two steps (first step) or repeat the current step,
 *    Good → next step or graduate, Easy → graduate immediately;
 *  - a lapse (Again on a review card) walks `relearningSteps` (default 10m);
 *  - reviews within the same day use the FSRS-5 short-term stability formula, so memory
 *    state keeps evolving during learning.
 * Graduated intervals are fuzzed deterministically (seeded by card id + review history) so
 * tests are stable, and Hard < Good < Easy is always enforced.
 */
import type { CardRecord, CardStateName, Rating, ReviewLogEntry } from '../schema';

/** FSRS-5 default parameters (19 weights). */
export const DEFAULT_WEIGHTS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
  2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

export const DECAY = -0.5;
/** chosen so that R(S, S) = 0.9 */
export const FACTOR = 19 / 81;

export const MINUTE = 60_000;
export const DAY = 86_400_000;
const S_MIN = 0.01;
const S_MAX = 36500;

export const Ratings = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const satisfies Record<string, Rating>;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export interface FSRSParams {
  w: readonly number[];
  /** desired probability of recall at the due date (0.7–0.99) */
  requestRetention: number;
  /** cap on any graduated interval, in days */
  maximumInterval: number;
  /** learning steps for new cards, in minutes; empty = graduate on the first answer */
  learningSteps: readonly number[];
  /** relearning steps after a lapse, in minutes; empty = straight back to review */
  relearningSteps: readonly number[];
  enableFuzz: boolean;
}

export const DEFAULT_PARAMS: FSRSParams = {
  w: DEFAULT_WEIGHTS,
  requestRetention: 0.9,
  maximumInterval: 36500,
  learningSteps: [1, 10],
  relearningSteps: [10],
  enableFuzz: true,
};

/**
 * A card as the scheduler sees it. `learningStep` is the index into the (re)learning steps
 * for cards in the learning/relearning state; it is stored alongside the CardRecord fields.
 */
export type SchedCard = CardRecord & { learningStep?: number };

export interface ScheduleResult {
  card: SchedCard;
  log: ReviewLogEntry;
}

export interface PreviewItem {
  due: number;
  /** compact label for buttons: "1m", "10m", "4h", "3d", "3.2mo", "1.5y" */
  intervalLabel: string;
  state: CardStateName;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function resolve(params?: Partial<FSRSParams>): FSRSParams {
  return params ? { ...DEFAULT_PARAMS, ...params } : DEFAULT_PARAMS;
}

// ---------------------------------------------------------------- memory model

/** Probability of recall after `elapsedDays` for a memory of stability `stability`. */
export function forgettingCurve(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / Math.max(stability, S_MIN), DECAY);
}

/** Current retrievability of a card (1 for new cards, 0..1 otherwise). */
export function retrievability(card: CardRecord, now: number): number {
  if (card.state === 'new' || !card.lastReview || card.stability <= 0) return card.state === 'new' ? 1 : 0;
  return forgettingCurve((now - card.lastReview) / DAY, card.stability);
}

export function initStability(w: readonly number[], g: Rating): number {
  return Math.max(w[g - 1], S_MIN);
}

/** Unclamped D0 (the mean-reversion target uses the raw value, as in the reference). */
function rawInitDifficulty(w: readonly number[], g: Rating): number {
  return w[4] - Math.exp(w[5] * (g - 1)) + 1;
}

export function initDifficulty(w: readonly number[], g: Rating): number {
  return clamp(rawInitDifficulty(w, g), 1, 10);
}

export function nextDifficulty(w: readonly number[], d: number, g: Rating): number {
  const delta = -w[6] * (g - 3);
  const damped = d + (delta * (10 - d)) / 9;
  const reverted = w[7] * rawInitDifficulty(w, 4) + (1 - w[7]) * damped;
  return clamp(reverted, 1, 10);
}

export function nextRecallStability(w: readonly number[], d: number, s: number, r: number, g: Rating): number {
  const hardPenalty = g === 2 ? w[15] : 1;
  const easyBonus = g === 4 ? w[16] : 1;
  const inc =
    Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hardPenalty * easyBonus;
  return clamp(s * (inc + 1), S_MIN, S_MAX);
}

export function nextForgetStability(w: readonly number[], d: number, s: number, r: number): number {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  return clamp(Math.min(sf, s / Math.exp(w[17] * w[18])), S_MIN, S_MAX);
}

export function nextShortTermStability(w: readonly number[], s: number, g: Rating): number {
  return clamp(s * Math.exp(w[17] * (g - 3 + w[18])), S_MIN, S_MAX);
}

/** Memory state after rating `g`, `elapsedDays` after the previous review. */
export function nextMemoryState(
  w: readonly number[],
  mem: { stability: number; difficulty: number } | null,
  elapsedDays: number,
  g: Rating,
): { stability: number; difficulty: number } {
  if (!mem || mem.stability <= 0) return { stability: initStability(w, g), difficulty: initDifficulty(w, g) };
  const { stability: s, difficulty: d } = mem;
  let ns: number;
  if (elapsedDays < 1) ns = nextShortTermStability(w, s, g);
  else {
    const r = forgettingCurve(elapsedDays, s);
    ns = g === 1 ? nextForgetStability(w, d, s, r) : nextRecallStability(w, d, s, r, g);
  }
  return { stability: ns, difficulty: nextDifficulty(w, d, g) };
}

/** Unfuzzed interval in whole days for a stability, honouring retention and the cap. */
export function nextInterval(stability: number, params?: Partial<FSRSParams>): number {
  const p = resolve(params);
  const ivl = (stability / FACTOR) * (Math.pow(p.requestRetention, 1 / DECAY) - 1);
  return clamp(Math.round(ivl), 1, p.maximumInterval);
}

// ---------------------------------------------------------------- fuzz

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

/** Deterministic PRNG in [0, 1) derived from a string seed (FNV-1a → mulberry32). */
export function seededRandom(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Anki/FSRS fuzz: spreads intervals ≥ 2.5 d over a small window to avoid review clumping. */
export function fuzzInterval(ivl: number, rand: number, maximumInterval: number): number {
  if (ivl < 2.5) return ivl;
  let delta = 1;
  for (const r of FUZZ_RANGES) delta += r.factor * Math.max(Math.min(ivl, r.end) - r.start, 0);
  let lo = Math.max(2, Math.round(ivl - delta));
  const hi = Math.min(Math.round(ivl + delta), maximumInterval);
  lo = Math.min(lo, hi);
  return Math.floor(rand * (hi - lo + 1) + lo);
}

// ---------------------------------------------------------------- scheduling

interface Outcome {
  state: CardStateName;
  stability: number;
  difficulty: number;
  /** ms from now until due */
  delay: number;
  /** interval in days (0 for (re)learning steps) */
  scheduledDays: number;
  learningStep?: number;
}

function hardStepDelay(steps: readonly number[], step: number): number {
  if (step === 0 && steps.length > 1) return ((steps[0] + steps[1]) / 2) * MINUTE;
  if (step === 0) return Math.min(steps[0] * 1.5, steps[0] + 1440) * MINUTE;
  return steps[step] * MINUTE;
}

/** Computes the outcome of every rating at once (so graduated intervals can be kept monotonic). */
function outcomes(card: SchedCard, now: number, p: FSRSParams): Record<Rating, Outcome> {
  const w = p.w;
  const elapsed = card.lastReview ? Math.max(0, (now - card.lastReview) / DAY) : 0;
  const mem = card.state === 'new' ? null : { stability: card.stability, difficulty: card.difficulty };
  const next = {} as Record<Rating, { stability: number; difficulty: number }>;
  for (const g of RATINGS) next[g] = nextMemoryState(w, mem, elapsed, g);

  // seeded by the card's own history (not the clock) so button previews match the actual answer
  const rand = seededRandom(`${card.id}|${card.reps}|${card.lastReview ?? card.createdAt}`);
  const graduated = (g: Rating) => {
    const base = nextInterval(next[g].stability, p);
    return p.enableFuzz ? fuzzInterval(base, rand, p.maximumInterval) : base;
  };
  const review = (g: Rating, days: number): Outcome => ({
    state: 'review',
    ...next[g],
    delay: days * DAY,
    scheduledDays: days,
  });
  const step = (g: Rating, state: CardStateName, idx: number, delay: number): Outcome => ({
    state,
    ...next[g],
    delay,
    scheduledDays: 0,
    learningStep: idx,
  });

  if (card.state === 'review') {
    let hard = graduated(2);
    let good = graduated(3);
    let easy = graduated(4);
    hard = Math.min(hard, good);
    good = Math.max(good, hard + 1);
    easy = Math.max(easy, good + 1);
    const again: Outcome = p.relearningSteps.length
      ? step(1, 'relearning', 0, p.relearningSteps[0] * MINUTE)
      : review(1, Math.min(graduated(1), hard));
    return { 1: again, 2: review(2, hard), 3: review(3, good), 4: review(4, easy) };
  }

  // new / learning / relearning: walk the steps
  const relearn = card.state === 'relearning';
  const steps = relearn ? p.relearningSteps : p.learningSteps;
  const learnState: CardStateName = relearn ? 'relearning' : 'learning';
  const cur = card.state === 'new' ? 0 : clamp(card.learningStep ?? 0, 0, Math.max(0, steps.length - 1));

  let good = graduated(3);
  let easy = graduated(4);
  easy = Math.max(easy, good + 1);
  if (!steps.length) {
    const hard = Math.min(graduated(2), good);
    good = Math.max(good, hard + 1);
    easy = Math.max(easy, good + 1);
    return { 1: review(1, Math.min(graduated(1), hard)), 2: review(2, hard), 3: review(3, good), 4: review(4, easy) };
  }
  return {
    1: step(1, learnState, 0, steps[0] * MINUTE),
    2: step(2, learnState, cur, hardStepDelay(steps, cur)),
    // Good advances one step, graduating after the last one
    3: cur + 1 < steps.length ? step(3, learnState, cur + 1, steps[cur + 1] * MINUTE) : review(3, good),
    4: review(4, easy),
  };
}

/**
 * Applies a rating to a card. Returns the updated card and a review-log entry
 * (the log records the state *before* the review, as FSRS optimisers expect).
 */
export function schedule(card: SchedCard, rating: Rating, now: number, params?: Partial<FSRSParams>): ScheduleResult {
  const p = resolve(params);
  const o = outcomes(card, now, p)[rating];
  const elapsedDays = card.lastReview ? Math.max(0, (now - card.lastReview) / DAY) : 0;
  const lapse = card.state === 'review' && rating === 1;
  const next: SchedCard = {
    ...card,
    state: o.state,
    stability: o.stability,
    difficulty: o.difficulty,
    due: now + o.delay,
    scheduledDays: o.scheduledDays,
    elapsedDays: Math.round(elapsedDays * 1000) / 1000,
    reps: card.reps + 1,
    lapses: card.lapses + (lapse ? 1 : 0),
    lastReview: now,
  };
  if (o.learningStep === undefined) delete next.learningStep;
  else next.learningStep = o.learningStep;
  return {
    card: next,
    log: {
      cardId: card.id,
      rating,
      at: now,
      state: card.state,
      scheduledDays: card.scheduledDays,
      elapsedDays: next.elapsedDays,
    },
  };
}

/** Due time and interval label for each button, without mutating anything. */
export function preview(card: SchedCard, now: number, params?: Partial<FSRSParams>): Record<Rating, PreviewItem> {
  const all = outcomes(card, now, resolve(params));
  const out = {} as Record<Rating, PreviewItem>;
  for (const g of RATINGS) {
    out[g] = { due: now + all[g].delay, intervalLabel: formatInterval(all[g].delay), state: all[g].state };
  }
  return out;
}

/** Compact human label for a duration in ms: "1m", "10m", "4h", "3d", "3.2mo", "1.5y". */
export function formatInterval(ms: number): string {
  const trim = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  const minutes = ms / MINUTE;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${trim(days / 30.4375)}mo`;
  return `${trim(days / 365.25)}y`;
}

/** A fresh, never-reviewed scheduling state (for card creation). */
export function newCardState(now: number): Pick<
  CardRecord,
  'state' | 'due' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'scheduledDays' | 'elapsedDays'
> {
  return { state: 'new', due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, scheduledDays: 0, elapsedDays: 0 };
}
