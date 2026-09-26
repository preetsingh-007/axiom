import { describe, expect, it } from 'vitest';
import { SearchIndex, type SearchPayload } from './search';
import { indexTerms, terms, withinOneEdit } from './tokenize';

interface P extends SearchPayload {
  name: string;
}

function build(texts: string[]) {
  const idx = new SearchIndex<P>();
  const payloads = texts.map((t, i) => {
    const p: P = { doc: -1, name: 'd' + i };
    idx.add(t, p);
    return p;
  });
  return { idx, payloads };
}

describe('tokenizer', () => {
  it('folds case and diacritics, keeps LaTeX command words, bigrams CJK', () => {
    expect(terms('Schrödinger’s Équation $\\frac{a}{b}$')).toEqual(['schrodinger', 's', 'equation', 'frac', 'a', 'b']);
    expect(indexTerms('The value of a policy')).toEqual(['value', 'policy']);
    expect(terms('强化学习')).toEqual(['强化', '化学', '学习']);
  });

  it('detects single edits', () => {
    expect(withinOneEdit('policy', 'polcy')).toBe(true);
    expect(withinOneEdit('policy', 'poilcy')).toBe(true);
    expect(withinOneEdit('policy', 'policies')).toBe(false);
    expect(withinOneEdit('reward', 'rewards')).toBe(true);
  });
});

describe('SearchIndex', () => {
  const texts = [
    'Bellman equation for the value function',
    'Policy gradient methods optimise the expected return',
    'Q-learning is an off-policy temporal difference method',
    'The reward hypothesis',
    'Actor-critic combines policy gradient with a value baseline',
  ];

  it('ranks by BM25 with AND semantics', () => {
    const { idx } = build(texts);
    const hits = idx.search('policy gradient');
    expect(hits.map((h) => h.payload.name)).toEqual(['d1', 'd4']);
    expect(hits[0].terms.has('policy')).toBe(true);
  });

  it('matches the last token as a prefix', () => {
    const { idx } = build(texts);
    expect(idx.search('bellman equ').map((h) => h.payload.name)).toEqual(['d0']);
    expect(idx.search('rew').map((h) => h.payload.name)).toEqual(['d3']);
    expect(idx.search('rew ').map((h) => h.payload.name)).toEqual([]);
  });

  it('falls back to fuzzy matching for long tokens', () => {
    const { idx } = build(texts);
    expect(idx.search('bellmann equation').map((h) => h.payload.name)).toEqual(['d0']);
    expect(idx.search('temporl').map((h) => h.payload.name)).toEqual(['d2']);
  });

  it('returns partial matches when no document matches every token', () => {
    const { idx } = build(texts);
    const hits = idx.search('reward zebra');
    expect(hits.map((h) => h.payload.name)).toEqual(['d3']);
  });

  it('supports removal and compaction with renumbering', () => {
    const idx = new SearchIndex<P>();
    const ps: P[] = [];
    for (let i = 0; i < 5000; i++) {
      const p: P = { doc: -1, name: 'n' + i };
      idx.add(`common token${i % 50} unique${i}`, p);
      ps.push(p);
    }
    for (let i = 0; i < 4000; i++) idx.remove(ps[i]);
    expect(idx.size).toBe(1000);
    expect(ps[4500].doc).toBeLessThan(4500); // renumbered by compaction
    expect(idx.search('unique4500').map((h) => h.payload.name)).toEqual(['n4500']);
    expect(idx.search('unique10')).toEqual([]);
    expect(idx.matchAll('common token7').length).toBe(20);
  });

  it('boosts documents', () => {
    const idx = new SearchIndex<P>();
    idx.add('graph theory', { doc: -1, name: 'block' });
    idx.add('graph theory', { doc: -1, name: 'title' }, 3);
    expect(idx.search('graph')[0].payload.name).toBe('title');
  });
});

// ---------------------------------------------------------------------------
// Performance: synthetic corpus with a Zipf-like vocabulary
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function syntheticCorpus(n: number, seed = 42): string[] {
  const rand = rng(seed);
  const syl = ['ra', 'po', 'li', 'cy', 'val', 'ue', 'gra', 'di', 'ent', 'mar', 'kov', 'bell', 'man', 'q', 'ler', 'ning', 'ten', 'sor', 'flow', 'net'];
  const vocab: string[] = ['reinforcement', 'learning', 'policy', 'gradient', 'bellman', 'equation', 'reward', 'value', 'markov', 'decision'];
  while (vocab.length < 30000) {
    let w = '';
    const len = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < len; i++) w += syl[Math.floor(rand() * syl.length)];
    vocab.push(w + vocab.length.toString(36));
  }
  const out: string[] = [];
  for (let d = 0; d < n; d++) {
    const len = 8 + Math.floor(rand() * 40);
    const words: string[] = [];
    for (let i = 0; i < len; i++) {
      // Zipf-ish: small indices are much more frequent
      const r = rand();
      words.push(vocab[Math.floor(vocab.length * r * r * r)]);
    }
    out.push(words.join(' '));
  }
  return out;
}

describe('SearchIndex performance', () => {
  it('answers queries over 100k blocks within budget', () => {
    const corpus = syntheticCorpus(100_000);
    const t0 = performance.now();
    const { idx } = build(corpus);
    idx.optimize();
    const buildMs = performance.now() - t0;

    const queries = ['reinforcement learning', 'policy grad', 'bellman', 'markov decision proc', 'valu', 'reinforcemnt', 'r', 'gradient reward value'];
    // warm-up (JIT)
    for (const q of queries) idx.search(q, 20);
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const s = performance.now();
        const hits = idx.search(q, 20);
        times.push(performance.now() - s);
        expect(hits.length).toBeGreaterThan(0);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.info(`[perf] 100k docs: build ${buildMs.toFixed(0)} ms, query median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms`);
    // generous thresholds for slow CI machines; target is < 20 ms
    expect(median).toBeLessThan(40);
    expect(p95).toBeLessThan(120);
  }, 60_000);
});
