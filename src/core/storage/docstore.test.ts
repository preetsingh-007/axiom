import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AxiomDB } from './idb';
import { DocStore } from './docstore';

let n = 0;
async function store() {
  return new DocStore(await AxiomDB.open(`ds-${Date.now()}-${n++}`));
}

/** A chain of dependent updates (each insert references the previous one). */
function chain(count: number): { updates: Uint8Array[]; text: string } {
  const src = new Y.Doc();
  const updates: Uint8Array[] = [];
  src.on('update', (u: Uint8Array) => updates.push(u));
  const t = src.getText('t');
  for (let i = 0; i < count; i++) t.insert(t.length, String(i % 10));
  return { updates, text: t.toString() };
}

describe('DocStore races', () => {
  it('a doc opened while remote updates are being persisted sees all of them', async () => {
    const s = await store();
    const { updates, text } = chain(60);
    for (let round = 0; round < 6; round++) {
      const slice = updates.slice(round * 10, round * 10 + 10);
      // interleave: apply, force a flush, and open concurrently
      await Promise.all(slice.map((u) => s.applyRemote('d', u, 'relay')));
      void s.flush();
    }
    const doc = await s.open('d');
    await s.flush();
    expect(doc.getText('t').toString()).toBe(text);
  });

  it('updates racing with open() reach the live doc', async () => {
    for (let trial = 0; trial < 10; trial++) {
      const s = await store();
      const { updates, text } = chain(20);
      const opening = s.open('x');
      await Promise.all(updates.map((u) => s.applyRemote('x', u, 'relay')));
      const doc = await opening;
      expect(doc.getText('t').toString()).toBe(text);
    }
  });

  it('state for unloaded docs includes in-flight writes', async () => {
    const s = await store();
    const { updates, text } = chain(15);
    for (const u of updates) await s.applyRemote('y', u, 'relay');
    void s.flush(); // do not await: the write is in flight
    const state = await s.getState('y');
    const d = new Y.Doc();
    Y.applyUpdate(d, state!);
    expect(d.getText('t').toString()).toBe(text);
  });
});

describe('DocStore persistence failures', () => {
  it('keeps updates when IndexedDB writes fail and retries them', async () => {
    const s = await store();
    const { updates, text } = chain(10);
    const real = s.db.putUpdate.bind(s.db);
    let failures = 2;
    s.db.putUpdate = async (docId, data) => {
      if (failures-- > 0) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return real(docId, data);
    };
    const errors: Error[] = [];
    s.onError.on((e) => errors.push(e));
    for (const u of updates) await s.applyRemote('q', u, 'relay');
    await s.flush();
    expect(errors.length).toBeGreaterThan(0);
    // retried automatically with backoff
    await new Promise((r) => setTimeout(r, 2500));
    await s.flush();
    const fresh = new DocStore(s.db);
    const doc = await fresh.open('q');
    expect(doc.getText('t').toString()).toBe(text);
  });
});
