import { afterEach, describe, expect, it } from 'vitest';
import type { CardRecord, ReviewLogEntry } from '../schema';
import { Vault } from '../vault';
import { DAY, MINUTE, newCardState } from './fsrs';
import { addReviewDays, answer, buildQueue, dayStart, readLog, setCardFlags, stats, undoAnswer } from './queue';

let n = 0;
const open: Vault[] = [];
async function vault() {
  const v = await Vault.open(`test-srs-queue-${Date.now()}-${n++}`);
  open.push(v);
  return v;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

// noon local time, well away from the 4 am rollover
const NOW = new Date(2026, 2, 10, 12, 0, 0).getTime();

function card(id: string, patch: Partial<CardRecord> = {}): CardRecord {
  return {
    id,
    pageId: 'p',
    blockId: id.split(':')[0],
    kind: 'cloze',
    front: `{{c1::${id}}}`,
    clozeIndex: 1,
    srcHash: 'h',
    createdAt: NOW - DAY,
    ...newCardState(NOW - DAY),
    ...patch,
  };
}
const review = (id: string, due: number, patch: Partial<CardRecord> = {}) =>
  card(id, { state: 'review', due, stability: 10, difficulty: 5, reps: 4, lastReview: due - 10 * DAY, scheduledDays: 10, ...patch });

function put(v: Vault, ...cards: CardRecord[]) {
  v.transact(() => cards.forEach((c) => v.cards.set(c.id, c)));
}

describe('day boundaries', () => {
  it('rolls over at 4 am local', () => {
    const lateNight = new Date(2026, 2, 11, 2, 0).getTime();
    expect(dayStart(lateNight)).toBe(new Date(2026, 2, 10, 4, 0).getTime());
    expect(dayStart(NOW)).toBe(new Date(2026, 2, 10, 4, 0).getTime());
    expect(addReviewDays(NOW, 1)).toBe(new Date(2026, 2, 11, 4, 0).getTime());
  });
});

describe('buildQueue', () => {
  it('orders learning, then reviews by due, then new; learn-ahead last', async () => {
    const v = await vault();
    put(
      v,
      card('n1:1', { createdAt: NOW - 5 }),
      card('n2:1', { createdAt: NOW - 10 }),
      review('r1:1', NOW - DAY),
      review('r2:1', NOW - 2 * DAY),
      review('r3:1', NOW + 3 * 3600_000), // later today → still due today
      review('future:1', NOW + 3 * DAY),
      card('l1:1', { state: 'learning', due: NOW - MINUTE, lastReview: NOW - 11 * MINUTE, stability: 3, difficulty: 5, reps: 1 }),
      card('l2:1', { state: 'relearning', due: NOW + 5 * MINUTE, lastReview: NOW - 5 * MINUTE, stability: 3, difficulty: 5, reps: 5 }),
      card('l3:1', { state: 'learning', due: NOW + 2 * 3600_000, lastReview: NOW, stability: 3, difficulty: 5, reps: 1 }),
      card('s1:1', { suspended: true }),
    );
    const q = buildQueue(v, NOW, { newPerDay: 10, maxReviews: 100 });
    expect(q.cards.map((c) => c.id)).toEqual(['l1:1', 'r2:1', 'r1:1', 'r3:1', 'n2:1', 'n1:1', 'l2:1']);
    expect(q.counts).toEqual({ new: 2, learning: 2, review: 3 });
    expect(q.nextDue).toBe(NOW + 2 * 3600_000);
  });

  it('limits new cards by those introduced today (from the review log)', async () => {
    const v = await vault();
    put(v, card('a:1', { createdAt: 1 }), card('b:1', { createdAt: 2 }), card('c:1', { createdAt: 3 }));
    answer(v, 'a:1', 3, NOW - 3600_000);
    const q = buildQueue(v, NOW, { newPerDay: 2 });
    expect(q.newToday).toBe(1);
    expect(q.counts.new).toBe(1);
    expect(q.cards.filter((c) => c.state === 'new').map((c) => c.id)).toEqual(['b:1']);
    // tomorrow the allowance resets
    const q2 = buildQueue(v, NOW + DAY, { newPerDay: 2 });
    expect(q2.counts.new).toBe(2);
  });

  it('caps reviews at maxReviews', async () => {
    const v = await vault();
    put(v, ...Array.from({ length: 5 }, (_, i) => review(`r${i}:1`, NOW - i * DAY)));
    const q = buildQueue(v, NOW, { maxReviews: 3 });
    expect(q.counts.review).toBe(3);
    expect(q.cards.map((c) => c.id)).toEqual(['r4:1', 'r3:1', 'r2:1']);
  });
});

describe('answer / undo', () => {
  it('schedules, logs and undoes', async () => {
    const v = await vault();
    put(v, card('a:1'));
    const res = answer(v, 'a:1', 3, NOW)!;
    expect(res.card.state).toBe('learning');
    expect(v.cards.get('a:1')!.reps).toBe(1);
    expect(readLog(v)).toEqual([{ cardId: 'a:1', rating: 3, at: NOW, state: 'new', scheduledDays: 0, elapsedDays: 0 }]);
    undoAnswer(v, res);
    expect(v.cards.get('a:1')).toEqual(card('a:1'));
    expect(readLog(v)).toEqual([]);
  });

  it('returns null for unknown cards', async () => {
    const v = await vault();
    expect(answer(v, 'nope', 3, NOW)).toBeNull();
  });

  it('caps the review log', async () => {
    const v = await vault();
    put(v, card('a:1'));
    for (let i = 0; i < 12; i++) answer(v, 'a:1', 3, NOW + i * DAY, { logCap: 5 });
    const log = readLog(v);
    expect(log).toHaveLength(5);
    expect(log.at(-1)!.at).toBe(NOW + 11 * DAY);
  });

  it('flags leeches after repeated lapses (and can suspend)', async () => {
    const v = await vault();
    put(v, review('a:1', NOW, { lapses: 2 }), review('b:1', NOW, { lapses: 3 }));
    const r1 = answer(v, 'a:1', 1, NOW, { leechThreshold: 3 })!;
    expect(r1.becameLeech).toBe(true);
    expect(v.cards.get('a:1')!.leech).toBe(true);
    expect(v.cards.get('a:1')!.suspended).toBeUndefined();

    const r2 = answer(v, 'b:1', 1, NOW, { leechAction: 'suspend' })!;
    expect(r2.becameLeech).toBe(true);
    expect(v.cards.get('b:1')).toMatchObject({ leech: true, suspended: true, lapses: 4 });
    expect(buildQueue(v, NOW + DAY).cards.find((c) => c.id === 'b:1')).toBeUndefined();

    setCardFlags(v, 'b:1', { leech: false, suspended: false });
    expect(v.cards.get('b:1')!.leech).toBeUndefined();
    expect(v.cards.get('b:1')!.suspended).toBeUndefined();
  });

  it('a lapse on a learning card is not a leech lapse', async () => {
    const v = await vault();
    put(v, card('a:1', { lapses: 10 }));
    const r = answer(v, 'a:1', 1, NOW)!;
    expect(r.becameLeech).toBe(false);
    expect(r.card.lapses).toBe(10);
  });
});

describe('stats', () => {
  it('computes retention, streak and a 7-day forecast', async () => {
    const v = await vault();
    put(
      v,
      review('over:1', NOW - DAY),
      review('today:1', NOW + 3600_000),
      review('d1:1', NOW + DAY),
      review('d3:1', NOW + 3 * DAY),
      review('d9:1', NOW + 9 * DAY),
      card('new:1'),
      card('susp:1', { state: 'review', due: NOW, suspended: true, leech: true }),
    );
    const log: ReviewLogEntry[] = [];
    for (let d = 1; d <= 3; d++) log.push({ cardId: 'x', rating: 3, at: NOW - d * DAY, state: 'review', scheduledDays: 1, elapsedDays: 1 });
    log.push({ cardId: 'x', rating: 1, at: NOW - 5 * DAY, state: 'review', scheduledDays: 1, elapsedDays: 1 });
    log.push({ cardId: 'y', rating: 3, at: NOW - 100, state: 'new', scheduledDays: 0, elapsedDays: 0 });
    v.transact(() => v.reviewLog.push(log));

    const s = stats(v, NOW);
    expect(s.total).toBe(7);
    expect(s.byState).toEqual({ new: 1, learning: 0, review: 6, relearning: 0 });
    expect(s.suspended).toBe(1);
    expect(s.leeches).toBe(1);
    expect(s.forecast).toEqual([2, 1, 0, 1, 0, 0, 0]);
    expect(s.retention).toBeCloseTo(3 / 4);
    expect(s.streak).toBe(4); // today + 3 previous days (day -4 missing)
    expect(s.reviewsToday).toBe(1);
  });

  it('handles an empty vault', async () => {
    const v = await vault();
    const s = stats(v, NOW);
    expect(s).toMatchObject({ total: 0, retention: null, streak: 0, forecast: [0, 0, 0, 0, 0, 0, 0] });
  });
});
