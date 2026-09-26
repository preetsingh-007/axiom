import { afterEach, describe, expect, it } from 'vitest';
import type { Vault } from '../vault';
import type { SourceMeta } from '../schema';
import { GraphIndex } from './index';
import { evaluateLens, LENS_HELP, parseLens, runLens } from './lens';
import { addPage, openTestVault } from './testutil';

describe('parseLens', () => {
  it('parses fields, refs, negation and OR groups', () => {
    const { ast, errors } = parseLens('[[Reinforcement Learning]] OR source:"Paper A" -tag:draft type:math');
    expect(errors).toEqual([]);
    expect(ast).toEqual({
      op: 'or',
      negated: false,
      children: [
        { op: 'term', negated: false, term: { kind: 'ref', value: 'Reinforcement Learning' } },
        {
          op: 'and',
          negated: false,
          children: [
            { op: 'term', negated: false, term: { kind: 'source', value: 'Paper A' } },
            { op: 'term', negated: true, term: { kind: 'tag', value: 'draft' } },
            { op: 'term', negated: false, term: { kind: 'type', value: 'math' } },
          ],
        },
      ],
    });
  });

  it('supports parentheses, #tags, phrases and dates', () => {
    const { ast, errors } = parseLens('(#rl OR #[[deep rl]]) "value function" after:2026-01-01 -(is:flashcard has:anchor)');
    expect(errors).toEqual([]);
    expect(ast?.op).toBe('and');
    if (ast?.op !== 'and') return;
    expect(ast.children[0]).toMatchObject({ op: 'or', children: [{ term: { kind: 'tag', value: 'rl' } }, { term: { kind: 'tag', value: 'deep rl' } }] });
    expect(ast.children[1]).toMatchObject({ term: { kind: 'text', value: 'value function', phrase: true } });
    expect(ast.children[2]).toMatchObject({ term: { kind: 'after', raw: '2026-01-01' } });
    expect(ast.children[3]).toMatchObject({ op: 'and', negated: true });
  });

  it('never throws and reports errors', () => {
    for (const q of ['', '(', ')', 'OR', '-', 'type:foo', 'before:yesterday', 'tag:', '"open', '[[open', 'foo:bar', '((a)']) {
      expect(() => parseLens(q)).not.toThrow();
    }
    expect(parseLens('').ast).toBeNull();
    expect(parseLens('type:foo').errors[0]).toMatch(/Unknown block type/);
    expect(parseLens('before:yesterday').errors[0]).toMatch(/Invalid date/);
    expect(parseLens('(a').errors).toContain('Missing ")"');
    expect(parseLens('a)').errors).toContain('Unmatched ")"');
    const unknown = parseLens('foo:bar');
    expect(unknown.errors[0]).toMatch(/Unknown filter/);
    expect(unknown.ast).toMatchObject({ term: { kind: 'text', value: 'foo:bar' } });
    expect(LENS_HELP).toContain('source:');
  });
});

describe('evaluateLens', () => {
  let vault: Vault;
  let index: GraphIndex;
  afterEach(async () => {
    await index.destroy();
    await vault.close();
  });

  const source = (id: string, title: string, bibKey?: string): SourceMeta => ({
    id,
    kind: 'pdf',
    title,
    fileName: title + '.pdf',
    blobId: 'b-' + id,
    size: 1,
    addedAt: 0,
    bib: bibKey ? { title, bibKey } : undefined,
  });

  async function setup() {
    vault = await openTestVault();
    vault.putSource(source('src-a', 'Paper A', 'smith2024'));
    vault.putSource(source('src-b', 'Paper B'));
    vault.putSource(source('src-c', 'Paper C'));
    const anchor = (sourceId: string) => ({ sourceId, loc: { page: 1 }, createdAt: 0 });
    const old = await addPage(vault, 'Old page', ['RL intro #[[Reinforcement Learning]]', 'value function basics', { type: 'math', text: 'V(s) = \\max_a Q(s,a)' }]);
    const recent = await addPage(vault, 'Recent page', [
      { type: 'text', text: 'Paper A claim', anchor: anchor('src-a') },
      { type: 'text', text: 'Paper B claim #draft', anchor: anchor('src-b') },
      { type: 'text', text: 'Paper C claim', anchor: anchor('src-c') },
      'links [[reinforcement learning]] #flashcard',
    ]);
    // updatePage() always stamps Date.now(); set explicit times for a deterministic order
    vault.transact(() => {
      vault.pages.get(old)!.set('updatedAt', 1000);
      vault.pages.get(recent)!.set('updatedAt', 2000);
    });
    index = new GraphIndex(vault, { persist: false });
    await index.init();
    return { old, recent };
  }

  const texts = (q: string) => runLens(index, vault, q).results.map((r) => index.getBlock(r.pageId, r.blockId)!.text);

  it('expresses "blocks tagged [[Reinforcement Learning]] and these two papers"', async () => {
    await setup();
    const res = texts('[[Reinforcement Learning]] OR source:"Paper A" OR source:"Paper B"');
    // most recently updated page first, then block order
    expect(res).toEqual(['Paper A claim', 'Paper B claim draft', 'links reinforcement learning flashcard', 'RL intro Reinforcement Learning']);
  });

  it('filters by text, tags, types, flags, pages and negation', async () => {
    await setup();
    expect(texts('value func')).toEqual(['value function basics']);
    expect(texts('"function basics"')).toEqual(['value function basics']);
    expect(texts('"basics function"')).toEqual([]);
    expect(texts('tag:"reinforcement learning"')).toEqual(['RL intro Reinforcement Learning']);
    expect(texts('type:math')).toEqual(['V(s) = \\max_a Q(s,a)']);
    expect(texts('is:flashcard')).toEqual(['links reinforcement learning flashcard']);
    expect(texts('has:anchor -tag:draft')).toEqual(['Paper A claim', 'Paper C claim']);
    expect(texts('source:smith2024')).toEqual(['Paper A claim']);
    expect(texts('source:src-c')).toEqual(['Paper C claim']);
    expect(texts('page:"old page" -type:math')).toEqual(['RL intro Reinforcement Learning', 'value function basics']);
    expect(texts('claim (-source:"Paper A" -source:"Paper B")')).toEqual(['Paper C claim']);
    expect(texts('before:2000-01-01')).toEqual([]);
    expect(texts('after:2000-01-01').length).toBe(7);
    expect(texts('source:"Nope"')).toEqual([]);
  });

  it('accepts a ParsedLens or an AST', async () => {
    await setup();
    const parsed = parseLens('type:math');
    expect(evaluateLens(index, vault, parsed)).toEqual(evaluateLens(index, vault, parsed.ast));
    expect(evaluateLens(index, vault, null)).toEqual([]);
  });
});
