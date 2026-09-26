import { describe, expect, it } from 'vitest';
import type { AIRequest } from '../ai/types';
import { parseTagList, suggestGhostTags, suggestGhostTagsLocal, type GhostConcept } from './ghost';

const ABSTRACT = `Proximal Policy Optimization Algorithms.
We propose a new family of policy gradient methods for reinforcement learning, which alternate
between sampling data through interaction with the environment, and optimizing a "surrogate"
objective function using stochastic gradient ascent. Whereas standard policy gradient methods
perform one gradient update per data sample, we propose a novel objective function that enables
multiple epochs of minibatch updates. The new methods, which we call proximal policy optimization
(PPO), have some of the benefits of trust region policy optimization (TRPO), but they are much
simpler to implement, more general, and have better sample complexity (empirically). Our
experiments test PPO on a collection of benchmark tasks, including simulated robotic locomotion
and Atari game playing, and we show that PPO outperforms other online policy gradient methods,
and overall strikes a favorable balance between sample complexity, simplicity, and wall-time.
Unlike value-based RL, the policies are optimised directly.`;

const CONCEPTS: GhostConcept[] = [
  { title: 'Reinforcement Learning', count: 48, aliases: ['RL'] },
  { title: 'Policy Gradient', count: 21 },
  { title: 'PPO', count: 6 },
  { title: 'Trust Region Methods', count: 3 },
  { title: 'Sample Efficiency', count: 4 },
  { title: 'Sample Complexity', count: 2 },
  { title: 'Robotics', count: 9 },
  { title: 'Atari', count: 5 },
  { title: 'Stochastic Gradient Descent', count: 11 },
  { title: 'Transformers', count: 30 },
  { title: 'Bayesian Inference', count: 14 },
  { title: 'Graph Neural Networks', count: 8 },
  { title: 'Learning', count: 60 },
  { title: 'Paper', count: 200 },
  { title: 'flashcard', count: 90 },
  { title: 'Value Function', count: 7 },
  { title: 'Optimisation', count: 12 },
];

describe('suggestGhostTagsLocal', () => {
  it('suggests relevant existing concepts for an RL abstract', () => {
    const res = suggestGhostTagsLocal({ text: ABSTRACT, concepts: CONCEPTS, max: 8 });
    const tags = res.map((r) => r.tag);
    expect(tags.slice(0, 4)).toEqual(expect.arrayContaining(['Policy Gradient', 'Reinforcement Learning', 'PPO']));
    expect(tags).toContain('Sample Complexity');
    expect(tags).toContain('Atari');
    // "Learning" only occurs inside "reinforcement learning": heavily discounted
    expect(res.find((r) => r.tag === 'Learning')?.score ?? 0).toBeLessThan(res.find((r) => r.tag === 'Atari')!.score);
    // irrelevant or excluded concepts are not suggested
    for (const t of ['Transformers', 'Bayesian Inference', 'Graph Neural Networks', 'Paper', 'flashcard']) expect(tags).not.toContain(t);
    for (const r of res) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
      expect(r.existing).toBe(true);
    }
    for (let i = 1; i < res.length; i++) expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
  });

  it('matches plurals, diacritics and one-edit typos; respects exclude', () => {
    const concepts = [
      { title: 'Neural Network', count: 3 },
      { title: 'Schrödinger Equation', count: 2 },
      { title: 'Optimisation', count: 2 },
    ];
    const res = suggestGhostTagsLocal({ text: 'Deep neural networks solve the schrodinger equation via optimization.', concepts });
    expect(res.map((r) => r.tag).sort()).toEqual(['Neural Network', 'Optimisation', 'Schrödinger Equation']);
    const excluded = suggestGhostTagsLocal({ text: 'neural networks', concepts, exclude: ['neural networks'] });
    expect(excluded).toEqual([]);
  });

  it('is deterministic and handles empty input', () => {
    expect(suggestGhostTagsLocal({ text: ABSTRACT, concepts: CONCEPTS })).toEqual(suggestGhostTagsLocal({ text: ABSTRACT, concepts: CONCEPTS }));
    expect(suggestGhostTagsLocal({ text: '', concepts: CONCEPTS })).toEqual([]);
    expect(suggestGhostTagsLocal({ text: ABSTRACT, concepts: [] })).toEqual([]);
  });
});

describe('suggestGhostTags with AI', () => {
  it('merges AI tags, preferring existing spellings and boosting agreement', async () => {
    let seen: AIRequest | undefined;
    const ai = {
      complete: async (req: AIRequest) => {
        seen = req;
        return { text: 'Sure! ```json\n["policy gradients", "#Trust Region Methods", "Proximal Policy Optimization", "Paper"]\n```' };
      },
    };
    const res = await suggestGhostTags({ text: ABSTRACT, concepts: CONCEPTS, ai, max: 10, exclude: ['paper'] });
    expect(seen?.task).toBe('tags');
    expect(seen?.prompt).toContain('"Reinforcement Learning"');
    const pg = res.find((r) => r.tag === 'Policy Gradient')!;
    expect(pg.origin).toBe('both');
    expect(res.find((r) => r.tag === 'Trust Region Methods')).toMatchObject({ existing: true });
    expect(res.find((r) => r.tag === 'Proximal Policy Optimization')).toMatchObject({ origin: 'ai', existing: false });
    expect(res.some((r) => r.tag === 'Paper')).toBe(false);
    expect(res.filter((r) => r.tag.toLowerCase().startsWith('policy grad'))).toHaveLength(1);
  });

  it('falls back to the offline result when the AI fails', async () => {
    const ai = { complete: async () => Promise.reject(new Error('offline')) };
    const res = await suggestGhostTags({ text: ABSTRACT, concepts: CONCEPTS, ai, max: 5 });
    expect(res).toEqual(suggestGhostTagsLocal({ text: ABSTRACT, concepts: CONCEPTS, max: 5 }));
  });

  it('parses tag lists defensively', () => {
    expect(parseTagList('["a", "#b", "[[c]]", 3, {"tag": "d"}, "bad|x"]')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseTagList('no json')).toEqual([]);
    expect(parseTagList('[broken')).toEqual([]);
  });
});
