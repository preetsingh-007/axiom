import { describe, expect, it } from 'vitest';
import { LocalProvider, extractKeyphrases, splitSentences, summarizeText, unicodeToLatex } from './local';
import { AIUnavailableError } from './errors';
import { clozeRequest, summarizeRequest, tagsRequest, latexRequest } from './prompts';
import { parseClozes } from '../srs/cloze';

describe('unicodeToLatex', () => {
  it.each([
    ['α + β = γ', '\\alpha + \\beta = \\gamma'],
    ['αx', '\\alpha x'],
    ['x² + y³', 'x^2 + y^3'],
    ['xⁿ⁺¹', 'x^{n+1}'],
    ['a₀ + aᵢⱼ', 'a_0 + a_{ij}'],
    ['∑ᵢ xᵢ ≤ ∞', '\\sum_i x_i \\leq \\infty'],
    ['∫ f(x) dx', '\\int f(x) dx'],
    ['∀x ∈ ℝ ∃y', '\\forall x \\in \\mathbb{R} \\exists y'],
    ['A ⊆ B ∪ C ∩ D', 'A \\subseteq B \\cup C \\cap D'],
    ['p ⇒ q ⇔ r → s', 'p \\Rightarrow q \\Leftrightarrow r \\to s'],
    ['x ≠ y ≈ z ≥ 0', 'x \\neq y \\approx z \\geq 0'],
    ['√x + √(a+b)', '\\sqrt{x} + \\sqrt{a+b}'],
    ['a/b', '\\frac{a}{b}'],
    ['(x+1)/(x-1)', '\\frac{x+1}{x-1}'],
    ['∂f/∂x', '\\frac{\\partial f}{\\partial x}'],
    ['∇·F', '\\nabla\\cdot F'],
    ['sin(θ)/cos(θ)', '\\frac{\\sin(\\theta)}{\\cos(\\theta)}'],
    ['e^(iπ) + 1 = 0', 'e^{i\\pi} + 1 = 0'],
    ['x ∉ ∏ A', 'x \\notin \\prod A'],
  ])('%s → %s', (input, expected) => {
    expect(unicodeToLatex(input)).toBe(expected);
  });

  it('leaves existing LaTeX commands alone', () => {
    expect(unicodeToLatex('\\sin x + \\log y')).toBe('\\sin x + \\log y');
  });
});

describe('summarizeText', () => {
  const text =
    'Reinforcement learning studies how agents learn from reward. Agents interact with an environment. ' +
    'The weather was pleasant during the conference. Value functions estimate future reward for agents. ' +
    'Reward signals drive agents to learn value functions.';
  it('picks the most central sentences in document order', () => {
    const s = summarizeText(text, 2);
    expect(splitSentences(s)).toHaveLength(2);
    expect(s).not.toContain('weather');
    expect(s.indexOf('Reinforcement')).toBe(0);
  });
  it('returns short texts unchanged', () => {
    expect(summarizeText('One sentence.', 3)).toBe('One sentence.');
  });
});

describe('extractKeyphrases', () => {
  it('ranks links, existing tags and repeated phrases', () => {
    const tags = extractKeyphrases(
      'The Bellman equation underpins dynamic programming. See [[Q-learning]]. Dynamic programming solves the Bellman equation exactly #rl',
      5,
      ['Dynamic Programming', 'Biology'],
    );
    expect(tags.slice(0, 3)).toEqual(['Q-learning', 'rl', 'Dynamic Programming']);
    expect(tags).toContain('bellman equation');
    expect(tags).not.toContain('Biology');
  });
});

describe('LocalProvider', () => {
  const local = new LocalProvider();
  it('handles summarize, tags, cloze and latex using the raw input', async () => {
    expect(await local.complete(summarizeRequest('Short text.'))).toBe('Short text.');
    expect(JSON.parse(await local.complete(tagsRequest('Markov chains and Markov chains', [], 3)))).toContain('markov chains');
    const items = JSON.parse(await local.complete(clozeRequest('The **Carnot cycle** is ideal, invented in 1824.')));
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(parseClozes(it.text).every((s) => s.index === 1)).toBe(true);
    expect(await local.complete(latexRequest('α²'))).toBe('\\alpha^2');
  });

  it('refuses image tasks with a typed error', async () => {
    expect(local.supportsTask('handwriting')).toBe(false);
    await expect(local.complete({ task: 'handwriting', prompt: 'x' })).rejects.toBeInstanceOf(AIUnavailableError);
    await expect(local.complete({ task: 'math-ocr', prompt: 'x' })).rejects.toThrow(/Gemini/);
  });
});
