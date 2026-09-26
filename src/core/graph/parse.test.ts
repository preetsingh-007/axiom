import { describe, expect, it } from 'vitest';
import {
  conceptEdits,
  findMentions,
  formatTag,
  parseRefs,
  plainText,
  renameConceptInText,
  renameLinkInText,
  renameTagInText,
} from './parse';

describe('parseRefs', () => {
  it('extracts links with aliases, tags, embeds and block refs', () => {
    const r = parseRefs('See [[Bellman Equation]] and [[Q-Learning|Q learning]] #rl #[[Deep RL]] ![[Paper A#^abc123]] ![[Notes]] ((blk_01-x))');
    expect(r.links).toEqual(['Bellman Equation', 'Q-Learning']);
    expect(r.tags).toEqual(['rl', 'Deep RL']);
    expect(r.embeds).toEqual([{ page: 'Paper A', block: 'abc123' }, { page: 'Notes' }]);
    expect(r.blockRefs).toEqual(['blk_01-x']);
    expect(r.clozes).toBe(0);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    const r = parseRefs('[[Policy Gradient]] then [[policy  gradient]] #RL #rl');
    expect(r.links).toEqual(['Policy Gradient']);
    expect(r.tags).toEqual(['RL']);
  });

  it('ignores refs inside inline code, fences and math', () => {
    const md = [
      'Use `[[not a link]]` and `#notag` here',
      '```ts',
      'const c = "#fff"; // [[nope]]',
      '```',
      'Math $a_{[[x]]} \\# y$ and $$\\sum #k$$ but [[Yes]] #ok',
    ].join('\n');
    const r = parseRefs(md);
    expect(r.links).toEqual(['Yes']);
    expect(r.tags).toEqual(['ok']);
  });

  it('does not treat URLs, headings, hex colors or numbers as tags', () => {
    const r = parseRefs('# Title\n## Sub\nvisit http://x.org/page#frag and https://a.b/#/route, color #3d5bd9, issue #42, C# and a#b but #real-tag.');
    expect(r.tags).toEqual(['real-tag']);
  });

  it('supports hierarchical and unicode tags, trailing punctuation excluded', () => {
    const r = parseRefs('(#area/ml, #théorie!) **#bold** #v1.2.');
    expect(r.tags).toEqual(['area/ml', 'théorie', 'bold', 'v1.2']);
  });

  it('does not treat dollar amounts as math', () => {
    const r = parseRefs('It cost $5 and $10 for [[Books]]');
    expect(r.links).toEqual(['Books']);
  });

  it('counts distinct cloze indices, including clozes around math', () => {
    expect(parseRefs('{{c1::Bellman}} optimality {{c2::$V^*$}} and {{c1::again}}').clozes).toBe(2);
    expect(parseRefs('`{{c1::code}}`').clozes).toBe(0);
  });

  it('handles empty and unterminated input', () => {
    expect(parseRefs('')).toEqual({ links: [], tags: [], embeds: [], blockRefs: [], clozes: 0 });
    expect(parseRefs('[[open and `code').links).toEqual([]);
  });
});

describe('plainText', () => {
  it('strips markup but keeps readable words', () => {
    const md = '## Heading\n- [[Q-Learning|Q learning]] is **off-policy** (see ![[Sutton]] and ((abc123))) #rl #[[Deep RL]]\n> quote with `code` and $\\alpha$ {{c1::answer::hint}} [link](http://x.y)';
    expect(plainText(md)).toBe('Heading Q learning is off-policy (see Sutton and ) rl Deep RL quote with code and \\alpha answer link');
  });

  it('keeps snake_case and math underscores', () => {
    expect(plainText('use snake_case_name and $x_1$')).toBe('use snake_case_name and x_1');
  });
});

describe('rename helpers', () => {
  it('renames links preserving aliases, embeds and fragments', () => {
    const t = 'A [[Old Name]], [[old name|alias]], ![[OLD NAME#^b1]] and #[[Old Name]] `[[Old Name]]`';
    expect(renameLinkInText(t, 'old name', 'New Title')).toBe(
      'A [[New Title]], [[New Title|alias]], ![[New Title#^b1]] and #[[Old Name]] `[[Old Name]]`',
    );
  });

  it('renames tags using the shortest valid form', () => {
    expect(renameTagInText('x #rl and #[[RL]] and [[RL]]', 'RL', 'Reinforcement Learning')).toBe(
      'x #[[Reinforcement Learning]] and #[[Reinforcement Learning]] and [[RL]]',
    );
    expect(renameTagInText('x #[[deep rl]] #deep', 'deep', 'shallow')).toBe('x #[[deep rl]] #shallow');
    expect(formatTag('ml')).toBe('#ml');
    expect(formatTag('machine learning')).toBe('#[[machine learning]]');
  });

  it('renames both and leaves unrelated text untouched', () => {
    const t = 'Keep Case [[RL]] here, #rl there, RL plain.';
    expect(renameConceptInText(t, 'rl', 'Reinforcement Learning')).toBe(
      'Keep Case [[Reinforcement Learning]] here, #[[Reinforcement Learning]] there, RL plain.',
    );
  });

  it('produces minimal non-overlapping edits', () => {
    const edits = conceptEdits('[[a]] [[b]] [[a|x]]', 'a', 'c');
    expect(edits).toEqual([
      { index: 2, deleteCount: 1, insert: 'c' },
      { index: 14, deleteCount: 1, insert: 'c' },
    ]);
    expect(conceptEdits('[[Same]]', 'same', 'Same')).toEqual([]);
  });
});

describe('findMentions', () => {
  it('finds whole-word unlinked mentions outside code and refs', () => {
    const t = 'Reinforcement learning is fun; [[Reinforcement Learning]] linked; `reinforcement learning`; reinforcement  Learning again; preinforcement learning';
    const found = findMentions(t, 'Reinforcement Learning');
    expect(found.map((m) => t.slice(m.start, m.end))).toEqual(['Reinforcement learning', 'reinforcement  Learning']);
  });
});
