import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Vault } from '../vault';
import { blockIds, blocksOf, blockText, getBlock, insertBlocks, setBlockText } from '../blocks';
import { GraphIndex } from './index';
import { addPage, openTestVault } from './testutil';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(build: (v: Vault) => Promise<void>) {
  const vault = await openTestVault();
  await build(vault);
  const index = new GraphIndex(vault, { debounceMs: 10, changeDebounceMs: 5 });
  await index.init();
  cleanups.push(async () => {
    await index.destroy();
    await vault.close();
  });
  return { vault, index };
}

describe('GraphIndex', () => {
  it('computes backlinks via title, alias, tag and embeds, excluding self', async () => {
    let rl = '';
    let a = '';
    let b = '';
    const { index } = await setup(async (v) => {
      rl = await addPage(v, 'Reinforcement Learning', ['Self ref [[Reinforcement Learning]]'], { kind: 'concept', aliases: ['RL'] });
      a = await addPage(v, 'Paper notes', ['We use [[reinforcement learning]] here', 'unrelated', 'Also #RL', 'and #[[Reinforcement Learning]]']);
      b = await addPage(v, 'Other', ['plain', { type: 'embed', embed: { pageId: rl } }]);
    });
    const hits = index.backlinks(rl);
    expect(hits.map((h) => h.pageId).sort()).toEqual([a, a, a, b].sort());
    expect(hits.find((h) => h.pageId === a)!.snippet).toContain('We use reinforcement learning');
    expect(index.pagesLinkingTo('RL').sort()).toEqual([a, b, rl].sort());
    expect(index.pagesLinkingTo('RL', { exact: true })).toEqual([a]);
    expect(index.resolvePageId('rl')).toBe(rl);
  });

  it('finds unlinked mentions not already linked', async () => {
    let target = '';
    let other = '';
    const { index } = await setup(async (v) => {
      target = await addPage(v, 'Policy Gradient', ['about it'], { kind: 'concept' });
      other = await addPage(v, 'Notes', ['Policy gradient methods are neat', 'linked [[Policy Gradient]] and policy gradient', 'policy of gradients', '`policy gradient` code']);
    });
    const m = index.unlinkedMentions(target);
    expect(m).toHaveLength(2); // the code span is plain text in the index; linkMention re-checks raw markdown
    expect(m[0]).toMatchObject({ pageId: other, phrase: 'Policy Gradient' });
    expect(m[0].snippet).toBe('Policy gradient methods are neat');
  });

  it('lists concepts, tags, outgoing refs, sources and graph', async () => {
    let p1 = '';
    let p2 = '';
    const { index } = await setup(async (v) => {
      p1 = await addPage(v, 'Day', ['[[Bellman Equation]] #rl', '#rl again', 'anchored', { type: 'text', text: 'quote', anchor: { sourceId: 's1', loc: { page: 3 }, createdAt: 1 } }], {
        kind: 'daily',
      });
      p2 = await addPage(v, 'Bellman Equation', ['see [[Day]] and #rl'], { kind: 'concept' });
    });
    const concepts = index.concepts();
    expect(concepts[0]).toMatchObject({ title: 'rl', normalized: 'rl', count: 3 });
    expect(concepts.find((c) => c.normalized === 'bellman equation')).toMatchObject({ title: 'Bellman Equation', count: 1, pageId: p2 });
    expect(index.blocksWithTag('RL')).toHaveLength(3);
    expect(index.outgoing(p1)).toEqual([
      { title: 'rl', normalized: 'rl', pageId: undefined, count: 2 },
      { title: 'Bellman Equation', normalized: 'bellman equation', pageId: p2, count: 1 },
    ]);
    expect(index.blocksForSource('s1').map((e) => e.text)).toEqual(['quote']);

    const g = index.graph();
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([p1, p2, 'concept:rl'].sort());
    expect(g.nodes.find((n) => n.id === p1)!.kind).toBe('daily');
    expect(g.links.find((l) => l.source === p1 && l.target === 'concept:rl')!.weight).toBe(2);
    expect(g.links.find((l) => l.source === p2 && l.target === p1)!.weight).toBe(1);
  });

  it('searches titles (boosted) and blocks with highlights', async () => {
    let p = '';
    const { index } = await setup(async (v) => {
      p = await addPage(v, 'Markov Decision Process', ['A formal model'], { kind: 'concept' });
      await addPage(v, 'Notes', ['An MDP is a Markov decision process with rewards', 'Schrödinger equation']);
    });
    const res = index.search('markov decision');
    expect(res[0]).toMatchObject({ pageId: p, title: 'Markov Decision Process' });
    expect(res[0].blockId).toBeUndefined();
    expect(res[1].blockId).toBeDefined();
    const [s, e] = res[1].highlights[0];
    expect(res[1].snippet.slice(s, e)).toBe('Markov');
    expect(index.search('schrodinger')[0].snippet).toBe('Schrödinger equation');
    expect(index.search('equat')).toHaveLength(1);
  });

  it('updates incrementally on edits, page changes and trash', async () => {
    let p = '';
    let q = '';
    const { vault, index } = await setup(async (v) => {
      p = await addPage(v, 'Target', ['x'], { kind: 'concept' });
      q = await addPage(v, 'Source', ['nothing yet']);
    });
    const events: string[][] = [];
    index.onChange.on((e) => events.push(e.pageIds));
    const { doc, release } = await vault.openPage(q);
    const id = blockIds(doc)[0];
    setBlockText(getBlock(doc, id)!, 'now links [[Target]]');
    await index.flush();
    expect(index.backlinks(p)).toHaveLength(1);
    expect(events.flat()).toContain(q);

    insertBlocks(doc, [{ type: 'text', text: 'second #target' }]);
    await index.flush();
    expect(index.backlinks(p)).toHaveLength(2);
    release();

    vault.updatePage(p, { title: 'Renamed Target' });
    await index.flush();
    expect(index.backlinks(p)).toHaveLength(0); // links still say [[Target]]
    expect(index.search('renamed')[0].pageId).toBe(p);

    vault.trashPage(q);
    await index.flush();
    expect(index.hasPage(q)).toBe(false);
    expect(index.search('second')).toEqual([]);

    vault.updatePage(q, { trashed: undefined });
    await index.flush();
    expect(index.search('second')).toHaveLength(1);
  });

  it('indexes pages created after init and remote updates to unloaded docs', async () => {
    const { vault, index } = await setup(async () => {});
    const p = await addPage(vault, 'Late', ['late block #fresh']);
    await index.flush();
    expect(index.blocksWithTag('fresh')).toHaveLength(1);

    // remote update to an unloaded page doc
    const remote = new Y.Doc();
    const other = vault.createPage({ title: 'Remote' });
    insertBlocks(remote, [{ type: 'text', text: 'from a peer [[Late]]' }]);
    await vault.store.applyRemote(other, Y.encodeStateAsUpdate(remote), 'test');
    await index.flush();
    expect(index.backlinks(p).map((h) => h.pageId)).toEqual([other]);
  });

  it('folds merged-tag aliases from tagMeta', async () => {
    let rl = '';
    const { vault, index } = await setup(async (v) => {
      rl = await addPage(v, 'Reinforcement Learning', ['x'], { kind: 'concept' });
      await addPage(v, 'Notes', ['old style #rl', 'new style [[Reinforcement Learning]]']);
    });
    expect(index.backlinks(rl)).toHaveLength(1);
    vault.transact(() => vault.tagMeta.set('alias:rl', 'Reinforcement Learning'));
    await index.flush();
    expect(index.backlinks(rl)).toHaveLength(2);
    expect(index.resolvePageId('RL')).toBe(rl);
    expect(index.concepts().find((c) => c.pageId === rl)!.count).toBe(2);
  });

  it('returns flashcard sources with raw markdown and context', async () => {
    let p = '';
    const { index } = await setup(async (v) => {
      p = await addPage(v, 'Cards', ['Context line about [[MDP]]', 'The **Bellman** equation is $V = R + \\gamma V$ #flashcard', 'plain', 'Cloze {{c1::answer}}']);
    });
    const cards = await index.flashcardBlocks();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      pageId: p,
      type: 'text',
      text: 'The **Bellman** equation is $V = R + \\gamma V$ #flashcard',
      pageTitle: 'Cards',
      contextText: 'Context line about MDP',
    });
    expect(cards[1].text).toBe('Cloze {{c1::answer}}');
  });

  it('persists a snapshot and only re-parses changed pages on restart', async () => {
    const vault = await openTestVault();
    const name = vault.name;
    const keep = await addPage(vault, 'Keep', ['unchanged content']);
    const change = await addPage(vault, 'Change', ['before edit']);
    const idx1 = new GraphIndex(vault, { debounceMs: 10 });
    await idx1.init();
    await idx1.persistNow();
    await idx1.destroy();

    // Tamper with the snapshot of the unchanged page: if it is reused, the marker shows up.
    for (let i = 0; i < 32; i++) {
      const part = await vault.db.get<Record<string, { v: string; b: unknown[][] }>>(`graph-index-v1:${i}`);
      if (part?.[keep]) {
        part[keep].b[0][3] = 'snapshot marker';
        await vault.db.set(`graph-index-v1:${i}`, part);
      }
    }
    // Edit the other page while no index is running.
    const { doc, release } = await vault.openPage(change);
    const t = blockText(blocksOf(doc).get(blockIds(doc)[0])!)!;
    t.insert(t.length, ' and after');
    release();
    await vault.close();

    const v2 = await Vault.open(name);
    const idx2 = new GraphIndex(v2);
    await idx2.init();
    expect(idx2.search('marker')[0]?.pageId).toBe(keep);
    expect(idx2.search('after')[0]?.pageId).toBe(change);
    await idx2.destroy();
    await v2.close();
  });
});

describe('GraphIndex performance', () => {
  it('indexes 20k blocks and searches quickly', async () => {
    const vault = await openTestVault();
    const words = ['policy', 'gradient', 'value', 'bellman', 'markov', 'reward', 'agent', 'environment', 'transformer', 'attention', 'kernel', 'bayesian'];
    for (let p = 0; p < 200; p++) {
      const id = vault.createPage({ title: `Page ${p} ${words[p % words.length]}` });
      const { doc, release } = await vault.openPage(id);
      const specs = [];
      for (let b = 0; b < 100; b++) {
        const w = (k: number) => words[(p * 7 + b * 3 + k) % words.length];
        specs.push({ type: 'text' as const, text: `Block ${b} on ${w(0)} ${w(1)} with [[${w(2)}]] and #${w(3)} term${p}x${b}` });
      }
      insertBlocks(doc, specs);
      release();
    }
    await vault.store.flush();
    const index = new GraphIndex(vault, { persist: false });
    const t0 = performance.now();
    await index.init();
    const initMs = performance.now() - t0;
    expect([...index.allBlocks()]).toHaveLength(20_000);

    const times: number[] = [];
    for (const q of ['policy gradient', 'bellm', 'term7x42', 'attention kernel', 'markv']) {
      index.search(q);
      const s = performance.now();
      const res = index.search(q, { limit: 20 });
      times.push(performance.now() - s);
      expect(res.length).toBeGreaterThan(0);
    }
    const s = performance.now();
    const bl = index.blocksReferencing('bellman');
    const refMs = performance.now() - s;
    expect(bl.length).toBeGreaterThan(1000);
    console.info(`[perf] GraphIndex 20k blocks: init ${initMs.toFixed(0)} ms, search max ${Math.max(...times).toFixed(2)} ms, refs ${refMs.toFixed(2)} ms`);
    expect(Math.max(...times)).toBeLessThan(50);
    await index.destroy();
    await vault.close();
  }, 120_000);
});
