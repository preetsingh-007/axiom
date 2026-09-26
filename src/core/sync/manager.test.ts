import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Vault } from '../vault';
import { SyncManager } from './manager';
import { memoryTransportPair } from './broadcast';
import { blockIds, blockPlainText, getBlock, insertBlock, blockText } from '../blocks';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeout = 4000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(10);
  }
}

let n = 0;
const vaultName = () => `test-sync-${Date.now()}-${n++}`;

describe('DocStore persistence', () => {
  it('persists and reloads page docs', async () => {
    const name = vaultName();
    const v1 = await Vault.open(name);
    const pid = v1.createPage({ title: 'Hello' });
    const { doc } = await v1.openPage(pid);
    insertBlock(doc, { type: 'text', text: 'Bellman equation' });
    await v1.close();

    const v2 = await Vault.open(name);
    expect(v2.getPage(pid)?.title).toBe('Hello');
    const { doc: d2 } = await v2.openPage(pid);
    const ids = blockIds(d2);
    expect(ids).toHaveLength(1);
    expect(blockPlainText(getBlock(d2, ids[0])!)).toBe('Bellman equation');
    await v2.close();
  });

  it('compacts long update logs without losing data', async () => {
    const name = vaultName();
    const v = await Vault.open(name);
    const pid = v.createPage({ title: 'Big' });
    const { doc } = await v.openPage(pid);
    const id = insertBlock(doc, { type: 'text', text: '' });
    const t = blockText(getBlock(doc, id)!)!;
    for (let i = 0; i < 300; i++) {
      t.insert(t.length, 'x');
      await v.store.flush();
    }
    await v.store.compact(pid);
    expect(await v.db.countUpdates(pid)).toBe(1);
    await v.close();
    const v2 = await Vault.open(name);
    const { doc: d2 } = await v2.openPage(pid);
    expect(blockPlainText(getBlock(d2, id)!)).toHaveLength(300);
    await v2.close();
  });

  it('deterministic concept and daily ids converge', async () => {
    const a = await Vault.open(vaultName());
    const b = await Vault.open(vaultName());
    expect(a.ensureConcept('Reinforcement Learning')).toBe(b.ensureConcept('reinforcement  learning'));
    expect(a.ensureDaily('2026-01-02')).toBe(b.ensureDaily('2026-01-02'));
    await a.close();
    await b.close();
  });
});

describe('SyncManager', () => {
  it('reconciles offline edits and streams live updates between devices', async () => {
    const a = await Vault.open(vaultName());
    const b = await Vault.open(vaultName());

    // offline edits on both devices
    const pa = a.createPage({ title: 'From A' });
    const { doc: da } = await a.openPage(pa);
    insertBlock(da, { type: 'text', text: 'alpha' });
    const pb = b.createPage({ title: 'From B' });
    const { doc: db } = await b.openPage(pb);
    insertBlock(db, { type: 'text', text: 'beta' });
    await a.store.flush();
    await b.store.flush();

    const sa = new SyncManager(a.store, { id: 'A', name: 'A' });
    const sb = new SyncManager(b.store, { id: 'B', name: 'B' });
    const [ta, tb] = memoryTransportPair();
    sa.add(ta);
    sb.add(tb);

    await until(() => !!b.getPage(pa) && !!a.getPage(pb));
    // page doc content arrives even though B never opened page A
    await until(async () => {
      const s = await b.store.getState(pa);
      if (!s) return false;
      const d = new Y.Doc();
      Y.applyUpdate(d, s);
      return blockIds(d).length === 1;
    });

    // live: B opens A's page and edits; A sees it
    const { doc: dba } = await b.openPage(pa);
    const bid = blockIds(dba)[0];
    blockText(getBlock(dba, bid)!)!.insert(5, ' + gamma');
    await until(() => blockPlainText(getBlock(da, bid)!) === 'alpha + gamma');

    // concurrent edits merge deterministically
    blockText(getBlock(da, bid)!)!.insert(0, '[A]');
    blockText(getBlock(dba, bid)!)!.insert(0, '[B]');
    await until(() => blockPlainText(getBlock(da, bid)!) === blockPlainText(getBlock(dba, bid)!) && blockPlainText(getBlock(da, bid)!).length > 16);
    expect(blockPlainText(getBlock(da, bid)!)).toMatch(/^\[[AB]\]\[[AB]\]alpha \+ gamma$/);

    sa.destroy();
    sb.destroy();
    await a.close();
    await b.close();
  });
});

describe('SyncManager: offline deletions', () => {
  it('propagates deletions made while disconnected (state vector unchanged)', async () => {
    const a = await Vault.open(vaultName());
    const b = await Vault.open(vaultName());
    const sa = new SyncManager(a.store, { id: 'A', name: 'A' });
    const sb = new SyncManager(b.store, { id: 'B', name: 'B' });
    let [ta, tb] = memoryTransportPair('relay', 'relay');
    sa.add(ta);
    sb.add(tb);
    const pid = a.createPage({ title: 'Del' });
    const { doc: da } = await a.openPage(pid);
    const keep = insertBlock(da, { type: 'text', text: 'keep' });
    const gone = insertBlock(da, { type: 'text', text: 'delete me' });
    await until(async () => {
      const s = await b.store.getState(pid);
      if (!s) return false;
      const d = new Y.Doc();
      Y.applyUpdate(d, s);
      return blockIds(d).length === 2;
    });
    // disconnect, delete (pure deletion: no new structs), reconnect
    sa.remove('relay');
    sb.remove('relay');
    const { deleteBlock } = await import('../blocks');
    deleteBlock(da, gone);
    blockText(getBlock(da, keep)!)!.delete(0, 1); // "eep"
    await a.store.flush();
    [ta, tb] = memoryTransportPair('relay', 'relay');
    sa.add(ta);
    sb.add(tb);
    await until(async () => {
      const s = await b.store.getState(pid);
      const d = new Y.Doc();
      Y.applyUpdate(d, s!);
      const ids = blockIds(d);
      return ids.length === 1 && blockPlainText(getBlock(d, ids[0])!) === 'eep';
    });
    sa.destroy();
    sb.destroy();
    await a.close();
    await b.close();
  });
});
