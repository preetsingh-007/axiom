import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Vault } from '../vault';
import { cardId, syncCards, type FlashcardSource } from './cards';
import { answer } from './queue';
import type { ClozeAI } from './cloze';

let n = 0;
const open: Vault[] = [];
async function vault() {
  const v = await Vault.open(`test-srs-cards-${Date.now()}-${n++}`);
  open.push(v);
  return v;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const T0 = Date.UTC(2026, 2, 1, 12);
const src = (blockId: string, text: string, extra: Partial<FlashcardSource> = {}): FlashcardSource => ({
  pageId: 'p1',
  blockId,
  type: 'text',
  text,
  pageTitle: 'Physics',
  ...extra,
});

describe('syncCards', () => {
  it('creates deterministic cards for new flashcard blocks', async () => {
    const v = await vault();
    const r = await syncCards(v, [src('b1', '{{c1::Heat}} flows to {{c2::cold}} #flashcard')], { now: T0 });
    expect(r).toEqual({ created: 2, updated: 0, deleted: 0, unchanged: 0 });
    const c = v.cards.get(cardId('b1', 1))!;
    expect(c).toMatchObject({ id: 'b1:1', pageId: 'p1', blockId: 'b1', kind: 'cloze', clozeIndex: 1, state: 'new', due: T0, reps: 0 });
    expect(c.front).not.toContain('#flashcard');
    expect(v.cards.has('b1:2')).toBe(true);
  });

  it('is idempotent', async () => {
    const v = await vault();
    const sources = [src('b1', 'The **Carnot cycle** is ideal #flashcard'), src('b2', '$E=mc^2$', { type: 'math' })];
    await syncCards(v, sources, { now: T0 });
    const snapshot = JSON.stringify(v.cards.toJSON());
    let updates = 0;
    v.index.on('update', () => updates++);
    const r = await syncCards(v, sources, { now: T0 + 1000 });
    expect(r).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
    expect(JSON.stringify(v.cards.toJSON())).toBe(snapshot);
    expect(updates).toBe(0);
  });

  it('regenerates content on edit while preserving scheduling of surviving clozes', async () => {
    const v = await vault();
    await syncCards(v, [src('b1', '{{c1::Heat}} flows to {{c2::cold}} bodies')], { now: T0 });
    answer(v, 'b1:1', 3, T0 + 1000);
    answer(v, 'b1:1', 3, T0 + 700_000);
    const before = v.cards.get('b1:1')!;
    expect(before.state).toBe('review');

    const r = await syncCards(v, [src('b1', '{{c1::Heat}} always flows to {{c3::colder}} bodies')], { now: T0 + 10_000 });
    expect(r).toEqual({ created: 1, updated: 1, deleted: 1, unchanged: 0 });
    const after = v.cards.get('b1:1')!;
    expect(after.front).toContain('always');
    expect(after).toMatchObject({ state: before.state, due: before.due, stability: before.stability, reps: before.reps });
    expect(v.cards.has('b1:2')).toBe(false);
    expect(v.cards.get('b1:3')!.state).toBe('new');
  });

  it('deletes cards whose block lost the tag or was deleted', async () => {
    const v = await vault();
    await syncCards(v, [src('b1', '{{c1::a}}'), src('b2', '{{c1::b}}', { pageId: 'p2' })], { now: T0 });
    const r = await syncCards(v, [src('b1', '{{c1::a}}')], { now: T0 });
    expect(r.deleted).toBe(1);
    expect([...v.cards.keys()]).toEqual(['b1:1']);
  });

  it('scopePageIds limits deletion to the given pages', async () => {
    const v = await vault();
    await syncCards(v, [src('b1', '{{c1::a}}'), src('b2', '{{c1::b}}', { pageId: 'p2' })], { now: T0 });
    await syncCards(v, [], { now: T0, scopePageIds: ['p1'] });
    expect([...v.cards.keys()]).toEqual(['b2:1']);
  });

  it('follows a block that moved to another page', async () => {
    const v = await vault();
    await syncCards(v, [src('b1', '{{c1::a}}')], { now: T0 });
    await syncCards(v, [src('b1', '{{c1::a}}', { pageId: 'p9' })], { now: T0 });
    expect(v.cards.get('b1:1')!.pageId).toBe('p9');
  });

  it('writes everything in a single transaction', async () => {
    const v = await vault();
    let txns = 0;
    v.index.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.size) txns++;
    });
    await syncCards(v, [src('b1', '{{c1::a}} {{c2::b}}'), src('b2', '{{c1::c}}'), src('b3', 'x', { type: 'ink' })], { now: T0 });
    expect(txns).toBe(1);
    expect(v.cards.size).toBe(4);
  });

  it('two offline devices converge on the same card ids', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const va = await vault();
    const vb = await vault();
    const sources = [src('b1', 'The **Carnot cycle** is ideal #flashcard')];
    await syncCards(va, sources, { now: T0 });
    await syncCards(vb, sources, { now: T0 + 5 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(va.index));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(vb.index));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(vb.index));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(va.index));
    expect(a.getMap('cards').toJSON()).toEqual(b.getMap('cards').toJSON());
    expect(a.getMap('cards').size).toBe(1);
  });

  it('uses AI generation when given, only for changed blocks', async () => {
    const v = await vault();
    let calls = 0;
    const ai: ClozeAI = {
      async completeJSON(_req, validate) {
        calls++;
        return { value: validate([{ text: '{{c1::Entropy}} measures disorder' }])!, provider: 'gemini' };
      },
    };
    const sources = [src('b1', 'Entropy measures disorder #flashcard')];
    await syncCards(v, sources, { now: T0, ai });
    await syncCards(v, sources, { now: T0, ai });
    expect(calls).toBe(1);
    expect(v.cards.get('b1:1')!.front).toBe('{{c1::Entropy}} measures disorder');
  });
});
