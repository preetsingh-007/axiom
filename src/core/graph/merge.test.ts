import { afterEach, describe, expect, it } from 'vitest';
import type { Vault } from '../vault';
import { blockIds, blockPlainText, blocksOf } from '../blocks';
import { GraphIndex } from './index';
import { dismissedPairs, dismissMerge, linkMention, mergeConcepts, renamePage, resolveConceptAlias, resolveLinkTarget } from './merge';
import { findMergeCandidates } from './similarity';
import { addPage, openTestVault } from './testutil';

let vault: Vault;
let index: GraphIndex;

afterEach(async () => {
  await index.destroy();
  await vault.close();
});

async function setup() {
  vault = await openTestVault();
  index = new GraphIndex(vault, { debounceMs: 5, changeDebounceMs: 5, persist: false });
}

async function texts(pageId: string): Promise<string[]> {
  const { doc, release } = await vault.openPage(pageId);
  const blocks = blocksOf(doc);
  const out = blockIds(doc).map((id) => blockPlainText(blocks.get(id)!));
  release();
  return out;
}

describe('mergeConcepts', () => {
  it('rewrites links and tags, adds an alias and records tagMeta', async () => {
    await setup();
    const rl = await addPage(vault, 'Reinforcement Learning', ['definition'], { kind: 'concept' });
    const a = await addPage(vault, 'Notes A', ['uses #RL and [[rl|RL methods]] and ![[RL#^x1]]', 'keeps `#RL` and RL words']);
    const b = await addPage(vault, 'Notes B', ['#[[rl]] only', 'nothing']);
    const untouched = await addPage(vault, 'Notes C', ['no refs here']);
    vault.putSource({ id: 's1', kind: 'pdf', title: 'P', fileName: 'p.pdf', blobId: 'b', size: 1, addedAt: 0, tags: ['RL', 'Reinforcement Learning', 'Other'] });
    await index.init();

    const res = await mergeConcepts(vault, index, 'RL', 'Reinforcement Learning');
    expect(res.pages.sort()).toEqual([a, b].sort());
    expect(res.occurrences).toBe(4);
    expect(res.targetPageId).toBe(rl);
    expect(await texts(a)).toEqual([
      'uses #[[Reinforcement Learning]] and [[Reinforcement Learning|RL methods]] and ![[Reinforcement Learning#^x1]]',
      'keeps `#RL` and RL words',
    ]);
    expect(await texts(b)).toEqual(['#[[Reinforcement Learning]] only', 'nothing']);
    expect(await texts(untouched)).toEqual(['no refs here']);
    expect(vault.getPage(rl)!.aliases).toEqual(['RL']);
    expect(vault.tagMeta.get('alias:rl')).toBe('Reinforcement Learning');
    expect(vault.getSource('s1')!.tags).toEqual(['Reinforcement Learning', 'Other']);
    expect(resolveConceptAlias(vault, 'rl')).toBe('Reinforcement Learning');
    expect(resolveLinkTarget(vault, 'RL')).toBe(rl);

    await index.flush();
    expect(index.backlinks(rl).map((h) => h.pageId).sort()).toEqual([a, b].sort());
    expect(index.concepts().find((c) => c.normalized === 'rl')).toBeUndefined();
  });

  it('moves content of a separate source page and trashes it', async () => {
    await setup();
    const from = await addPage(vault, 'Neural Networks', ['NN content', ''], { kind: 'concept', aliases: ['NNs'] });
    await addPage(vault, 'Refs', ['see [[Neural Networks]]']);
    await index.init();
    const res = await mergeConcepts(vault, index, 'Neural Networks', 'Neural Network');
    const target = vault.getPage(res.targetPageId)!;
    expect(target.title).toBe('Neural Network');
    expect(target.aliases).toEqual(['Neural Networks', 'NNs']);
    expect(vault.getPage(from)!.trashed).toBe(true);
    expect(await texts(res.targetPageId)).toEqual(['NN content']);
    expect(vault.findPageByTitle('Neural Networks')!.id).toBe(res.targetPageId);
  });

  it('dismisses merge suggestions persistently', async () => {
    await setup();
    await index.init();
    dismissMerge(vault, 'RL', 'Reinforcement Learning');
    const dismissed = dismissedPairs(vault);
    expect(dismissed.size).toBe(1);
    expect(findMergeCandidates([{ title: 'RL' }, { title: 'Reinforcement Learning' }], dismissed)).toEqual([]);
  });
});

describe('renamePage', () => {
  it('renames the page and rewrites references', async () => {
    await setup();
    const p = await addPage(vault, 'Old Title', ['body']);
    const q = await addPage(vault, 'Refs', ['[[Old Title]] and #[[old title]] and [[Old Title|alias]]']);
    await index.init();
    const res = await renamePage(vault, index, p, 'New Title');
    expect(res).toEqual({ pages: [q], occurrences: 3 });
    expect(vault.getPage(p)!.title).toBe('New Title');
    expect(await texts(q)).toEqual(['[[New Title]] and #[[New Title]] and [[New Title|alias]]']);
    await index.flush();
    expect(index.backlinks(p)).toHaveLength(1);
    await expect(renamePage(vault, index, p, 'bad [[title')).rejects.toThrow();
  });
});

describe('linkMention', () => {
  it('converts the first unlinked mention into a link', async () => {
    await setup();
    const target = await addPage(vault, 'Policy Gradient', ['x'], { kind: 'concept' });
    const src = await addPage(vault, 'Notes', ['`policy gradient` then policy gradient methods']);
    await index.init();
    const [m] = index.unlinkedMentions(target);
    expect(await linkMention(vault, m.pageId, m.blockId, m.phrase)).toBe(true);
    expect(await texts(src)).toEqual(['`policy gradient` then [[policy gradient]] methods']);
    await index.flush();
    expect(index.unlinkedMentions(target)).toEqual([]);
    expect(index.backlinks(target)).toHaveLength(1);
    expect(await linkMention(vault, m.pageId, m.blockId, m.phrase)).toBe(false);
  });
});
