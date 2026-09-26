/**
 * Review queue, answering (with undo and leech detection) and statistics.
 * Days roll over at `rolloverHour` local time (default 4 am, like Anki) so late-night
 * sessions count toward the day they started.
 */
import type { CardRecord, CardStateName, Rating, ReviewLogEntry } from '../schema';
import type { Vault } from '../vault';
import { schedule, type FSRSParams, type SchedCard } from './fsrs';

export const DEFAULT_ROLLOVER_HOUR = 4;

/** Start (ms) of the review day containing `ts`. */
export function dayStart(ts: number, rolloverHour = DEFAULT_ROLLOVER_HOUR): number {
  const d = new Date(ts);
  if (d.getHours() < rolloverHour) d.setDate(d.getDate() - 1);
  d.setHours(rolloverHour, 0, 0, 0);
  return d.getTime();
}

/** Start of the review day `days` after the one containing `ts` (DST-safe). */
export function addReviewDays(ts: number, days: number, rolloverHour = DEFAULT_ROLLOVER_HOUR): number {
  const d = new Date(dayStart(ts, rolloverHour));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** The review log as typed entries (malformed entries from other clients are skipped). */
export function readLog(vault: Vault): ReviewLogEntry[] {
  return vault.reviewLog
    .toArray()
    .filter((e): e is ReviewLogEntry => !!e && typeof (e as ReviewLogEntry).at === 'number' && typeof (e as ReviewLogEntry).cardId === 'string');
}

// ---------------------------------------------------------------- queue

export interface QueueOptions {
  /** new cards introduced per review day (default 20) */
  newPerDay?: number;
  /** cap on review cards in the queue (default 200) */
  maxReviews?: number;
  /** learning cards due within this window are shown when nothing else is left (default 20 min) */
  learnAheadMs?: number;
  rolloverHour?: number;
}

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
}

export interface ReviewQueue {
  /** cards to study, in order */
  cards: CardRecord[];
  counts: QueueCounts;
  /** when the next card outside the queue becomes due (null when there is none) */
  nextDue: number | null;
  /** new cards already introduced today */
  newToday: number;
}

const byDue = (a: CardRecord, b: CardRecord) => a.due - b.due || a.id.localeCompare(b.id);

/**
 * Due cards in study order: learning/relearning due now (by due), then reviews due today
 * (most overdue first), then new cards within today's allowance, then learning cards due
 * within the learn-ahead window.
 */
export function buildQueue(vault: Vault, now: number, opts: QueueOptions = {}): ReviewQueue {
  const newPerDay = opts.newPerDay ?? 20;
  const maxReviews = opts.maxReviews ?? 200;
  const learnAhead = opts.learnAheadMs ?? 20 * 60_000;
  const rollover = opts.rolloverHour ?? DEFAULT_ROLLOVER_HOUR;
  const today = dayStart(now, rollover);
  const tomorrow = addReviewDays(now, 1, rollover);

  const introduced = new Set<string>();
  for (const e of readLog(vault)) if (e.at >= today && e.state === 'new') introduced.add(e.cardId);
  const newAllowance = Math.max(0, newPerDay - introduced.size);

  const learningNow: CardRecord[] = [];
  const learningSoon: CardRecord[] = [];
  const reviews: CardRecord[] = [];
  const fresh: CardRecord[] = [];
  let nextDue: number | null = null;
  const later = (t: number) => (nextDue = nextDue === null ? t : Math.min(nextDue, t));

  for (const c of vault.cards.values()) {
    if (c.suspended) continue;
    if (c.state === 'new') fresh.push(c);
    else if (c.state === 'learning' || c.state === 'relearning') {
      if (c.due <= now) learningNow.push(c);
      else if (c.due <= now + learnAhead) learningSoon.push(c);
      else later(c.due);
    } else if (c.due < tomorrow) reviews.push(c);
    else later(c.due);
  }

  learningNow.sort(byDue);
  learningSoon.sort(byDue);
  reviews.sort(byDue);
  fresh.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const reviewsIn = reviews.slice(0, maxReviews);
  const newIn = fresh.slice(0, newAllowance);
  if (fresh.length > newIn.length) later(tomorrow);
  if (reviews.length > reviewsIn.length) later(reviews[reviewsIn.length].due);

  return {
    cards: [...learningNow, ...reviewsIn, ...newIn, ...learningSoon],
    counts: { new: newIn.length, learning: learningNow.length + learningSoon.length, review: reviewsIn.length },
    nextDue,
    newToday: introduced.size,
  };
}

// ---------------------------------------------------------------- answering

export interface AnswerOptions {
  /** lapses at which a card becomes a leech (default 4) */
  leechThreshold?: number;
  /** 'flag' (default) marks the card; 'suspend' also removes it from the queue */
  leechAction?: 'flag' | 'suspend';
  /** keep at most this many review-log entries (default 5000) */
  logCap?: number;
  params?: Partial<FSRSParams>;
}

export interface AnswerResult {
  card: CardRecord;
  log: ReviewLogEntry;
  /** the card before this answer (for undo) */
  previous: CardRecord;
  /** true when this answer turned the card into a leech */
  becameLeech: boolean;
}

/** Applies a rating with FSRS, appends to the review log and flags leeches. */
export function answer(vault: Vault, cardId: string, rating: Rating, now: number, opts: AnswerOptions = {}): AnswerResult | null {
  const previous = vault.cards.get(cardId);
  if (!previous) return null;
  const { card, log } = schedule(previous as SchedCard, rating, now, opts.params);
  const threshold = opts.leechThreshold ?? 4;
  const lapsed = card.lapses > previous.lapses;
  const becameLeech = lapsed && card.lapses >= threshold && !previous.leech;
  if (lapsed && card.lapses >= threshold) {
    card.leech = true;
    if (opts.leechAction === 'suspend') card.suspended = true;
  }
  const cap = opts.logCap ?? 5000;
  vault.transact(() => {
    vault.cards.set(cardId, card);
    const arr = vault.reviewLog;
    arr.push([log]);
    if (arr.length > cap) arr.delete(0, arr.length - cap);
  });
  return { card, log, previous, becameLeech };
}

/** Reverts an answer: restores the previous card state and removes its log entry. */
export function undoAnswer(vault: Vault, result: Pick<AnswerResult, 'previous' | 'log'>): void {
  vault.transact(() => {
    vault.cards.set(result.previous.id, result.previous);
    const arr = vault.reviewLog;
    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 200); i--) {
      const e = arr.get(i) as ReviewLogEntry | undefined;
      if (e && e.cardId === result.log.cardId && e.at === result.log.at) {
        arr.delete(i, 1);
        break;
      }
    }
  });
}

/** Clears or sets the leech / suspended flags of a card. */
export function setCardFlags(vault: Vault, cardId: string, flags: { leech?: boolean; suspended?: boolean }): void {
  const c = vault.cards.get(cardId);
  if (!c) return;
  const next: CardRecord = { ...c };
  for (const k of ['leech', 'suspended'] as const) {
    if (flags[k] === undefined) continue;
    if (flags[k]) next[k] = true;
    else delete next[k];
  }
  vault.transact(() => vault.cards.set(cardId, next));
}

// ---------------------------------------------------------------- stats

export interface ReviewStats {
  total: number;
  byState: Record<CardStateName, number>;
  suspended: number;
  leeches: number;
  reviewsToday: number;
  /** share of review-state answers in the last 30 days that were not "Again" (null: no data) */
  retention: number | null;
  /** consecutive review days ending today (or yesterday, if nothing was reviewed yet today) */
  streak: number;
  /** cards due on each of the next 7 review days; index 0 = today, including overdue */
  forecast: number[];
}

export function stats(vault: Vault, now = Date.now(), opts: { rolloverHour?: number } = {}): ReviewStats {
  const rollover = opts.rolloverHour ?? DEFAULT_ROLLOVER_HOUR;
  const today = dayStart(now, rollover);
  const byState: Record<CardStateName, number> = { new: 0, learning: 0, review: 0, relearning: 0 };
  const bounds = Array.from({ length: 8 }, (_, i) => addReviewDays(now, i, rollover));
  const forecast = new Array<number>(7).fill(0);
  let total = 0;
  let suspended = 0;
  let leeches = 0;
  for (const c of vault.cards.values()) {
    total++;
    byState[c.state]++;
    if (c.leech) leeches++;
    if (c.suspended) {
      suspended++;
      continue;
    }
    if (c.state === 'new') continue;
    for (let d = 0; d < 7; d++) {
      if (c.due < bounds[d + 1]) {
        forecast[d]++;
        break;
      }
    }
  }

  const log = readLog(vault);
  const monthAgo = now - 30 * 86_400_000;
  let judged = 0;
  let recalled = 0;
  let reviewsToday = 0;
  const days = new Set<number>();
  for (const e of log) {
    if (e.at >= today) reviewsToday++;
    if (e.at >= monthAgo && e.state === 'review') {
      judged++;
      if (e.rating > 1) recalled++;
    }
    days.add(dayStart(e.at, rollover));
  }
  let streak = 0;
  let day = days.has(today) ? today : addReviewDays(today, -1, rollover);
  while (days.has(day)) {
    streak++;
    day = addReviewDays(day, -1, rollover);
  }
  return {
    total,
    byState,
    suspended,
    leeches,
    reviewsToday,
    retention: judged ? recalled / judged : null,
    streak,
    forecast,
  };
}
