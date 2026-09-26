import { describe, expect, it } from 'vitest';
import { acronymOf, conceptTokens, findMergeCandidates, jaroWinkler, normalizeConcept, pairKey, singularize } from './similarity';

describe('normalization', () => {
  it('handles case, punctuation, diacritics and plurals', () => {
    expect(normalizeConcept('Neural-Networks')).toBe('neural network');
    expect(normalizeConcept('  Policies ')).toBe('policy');
    expect(normalizeConcept('Processes')).toBe('process');
    expect(normalizeConcept('Théorie des Graphes')).toBe('theorie des graphe');
    expect(normalizeConcept('MDPs')).toBe('mdp');
    expect(normalizeConcept('Analysis')).toBe('analysis');
    expect(normalizeConcept('matrices')).toBe('matrix');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('bias')).toBe('bias');
    expect(conceptTokens('Q-Learning')).toEqual(['q', 'learning']);
    expect(acronymOf(['markov', 'decision', 'process'])).toBe('mdp');
    expect(acronymOf(['theory', 'of', 'mind'])).toBe('tm');
  });

  it('computes Jaro-Winkler', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });
});

describe('findMergeCandidates', () => {
  const concepts = [
    { title: 'Reinforcement Learning', count: 40 },
    { title: 'RL', count: 12 },
    { title: 'reinforcement-learning', count: 2 },
    { title: 'Markov Decision Process', count: 9 },
    { title: 'MDPs', count: 3 },
    { title: 'Neural Networks', count: 5 },
    { title: 'neural network', count: 7 },
    { title: 'Bayesian Optimisation', count: 4 },
    { title: 'Bayesian Optimization', count: 1 },
    { title: 'GPT-3', count: 2 },
    { title: 'GPT-4', count: 2 },
    { title: 'Deep Reinforcement Learning', count: 6 },
    { title: 'cat', count: 1 },
    { title: 'car', count: 1 },
    { title: 'Learning, Reinforcement', count: 1 },
  ];

  it('finds variants, acronyms, typos and word-order duplicates', () => {
    const res = findMergeCandidates(concepts);
    const pairs = res.map((c) => `${c.a} -> ${c.b} (${c.reason})`);
    expect(pairs).toContain('reinforcement-learning -> Reinforcement Learning (variant)');
    expect(pairs).toContain('RL -> Reinforcement Learning (acronym)');
    expect(pairs).toContain('MDPs -> Markov Decision Process (acronym)');
    expect(pairs).toContain('Neural Networks -> neural network (variant)');
    expect(pairs).toContain('Bayesian Optimization -> Bayesian Optimisation (typo)');
    expect(pairs).toContain('Learning, Reinforcement -> Reinforcement Learning (word-order)');
    // not duplicates
    const flat = res.flatMap((c) => [c.a, c.b].sort().join('|'));
    expect(flat).not.toContain('GPT-3|GPT-4');
    expect(flat).not.toContain('car|cat');
    expect(flat.some((p) => p.includes('Deep Reinforcement Learning'))).toBe(false);
    // ranked by score
    for (let i = 1; i < res.length; i++) expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
  });

  it('skips dismissed pairs', () => {
    const res = findMergeCandidates(concepts, new Set([pairKey('Reinforcement Learning', 'RL')]));
    expect(res.some((c) => c.a === 'RL' && c.b === 'Reinforcement Learning')).toBe(false);
    expect(res.some((c) => c.a === 'MDPs')).toBe(true);
  });

  it('scales to 5k concepts via blocking', () => {
    const words = ['graph', 'vector', 'kernel', 'policy', 'tensor', 'matrix', 'signal', 'neuron', 'spline', 'manifold', 'entropy', 'gradient'];
    const many: { title: string; count: number }[] = [];
    for (let i = 0; i < 5000; i++) {
      many.push({ title: `${words[i % 12]} ${words[Math.floor(i / 12) % 12]} topic${i}`, count: i % 7 });
    }
    many.push({ title: 'Graph-Vector Topic12s', count: 1 });
    const t0 = performance.now();
    const res = findMergeCandidates(many);
    const ms = performance.now() - t0;
    console.info(`[perf] findMergeCandidates 5k concepts: ${ms.toFixed(0)} ms, ${res.length} candidates`);
    expect(res).toContainEqual({ a: 'Graph-Vector Topic12s', b: 'graph vector topic12', score: 1, reason: 'variant' });
    expect(ms).toBeLessThan(3000);
  });
});
