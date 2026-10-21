import { describe, expect, it } from 'vitest';
import { blockToLatex, blockToMarkdown, cleanMarkdown, markdownToLatex, pageToLatex, escapeLatex } from './markdown';
import type { BlockSnapshot } from '../blocks';

const text = (t: string, extra: Partial<BlockSnapshot> = {}): BlockSnapshot => ({ id: 'b', type: 'text', text: t, ...extra });

describe('markdown export', () => {
  it('strips Axiom-only syntax', () => {
    expect(cleanMarkdown('See [[Bellman equation]] and [[MDP|Markov chains]] #flashcard')).toBe('See Bellman equation and Markov chains');
    expect(cleanMarkdown('The {{c1::KL divergence}} is ≥ 0')).toBe('The KL divergence is ≥ 0');
    expect(cleanMarkdown('tag #[[Deep Learning]] here')).toBe('tag Deep Learning here');
  });

  it('adds a pandoc citation for anchored blocks', () => {
    const md = blockToMarkdown(text('A quote', { anchor: { sourceId: 's1', loc: { page: 4 }, createdAt: 0 } }), {
      source: () => ({ id: 's1', kind: 'pdf', title: 'P', fileName: 'p.pdf', blobId: 'b', size: 1, addedAt: 0, bib: { bibKey: 'sutton2018reinforcement' } }),
    });
    expect(md).toBe('A quote [@sutton2018reinforcement, p. 4]');
  });

  it('exports math blocks as display math', () => {
    expect(blockToMarkdown({ id: 'm', type: 'math', text: 'x^2' })).toBe('$$\nx^2\n$$');
  });
});

describe('latex export', () => {
  it('escapes special characters', () => {
    expect(escapeLatex('50% of $5 & #1_a')).toBe('50\\% of \\$5 \\& \\#1\\_a');
  });

  it('converts headings, emphasis, lists and keeps inline math verbatim', () => {
    const tex = markdownToLatex('# Results\nThe **value** of $V^\\pi(s)$ is *bounded*.\n- one\n- two\n\n1. first');
    expect(tex).toContain('\\section{Results}');
    expect(tex).toContain('\\textbf{value}');
    expect(tex).toContain('$V^\\pi(s)$');
    expect(tex).toContain('\\emph{bounded}');
    expect(tex).toContain('\\begin{itemize}\n  \\item one\n  \\item two\n\\end{itemize}');
    expect(tex).toContain('\\begin{enumerate}\n  \\item first\n\\end{enumerate}');
  });

  it('handles display math and code fences', () => {
    const tex = markdownToLatex('$$\n\\sum_i x_i\n$$\n```\na_b\n```');
    expect(tex).toContain('\\begin{equation*}\n\\sum_i x_i\n\\end{equation*}');
    expect(tex).toContain('\\begin{verbatim}\na_b\n\\end{verbatim}');
  });

  it('links become \\href and citations \\cite', () => {
    expect(markdownToLatex('see [docs](https://example.com/a_b)')).toBe('see \\href{https://example.com/a_b}{docs}');
    const b = blockToLatex(text('claim', { anchor: { sourceId: 's', loc: { page: 1 }, createdAt: 0 } }), {
      source: () => ({ id: 's', kind: 'pdf', title: 'T', fileName: 'f', blobId: 'b', size: 1, addedAt: 0, bib: { bibKey: 'doe2020' } }),
    });
    expect(b).toBe('claim~\\cite{doe2020}');
  });

  it('builds a compilable document skeleton', () => {
    const doc = pageToLatex('My Notes', [text('Hello'), { id: 'm', type: 'math', text: 'a+b' }]);
    expect(doc.startsWith('\\documentclass{article}')).toBe(true);
    expect(doc).toContain('\\begin{equation}\na+b\n\\end{equation}');
    expect(doc.trim().endsWith('\\end{document}')).toBe(true);
  });

  it('exports typed labels of whiteboards and photos', () => {
    const labels = [
      { id: 'a', x: 0, y: 0, w: 10, h: 10, kind: 'text' as const, content: 'see [[Bellman]]', size: 12, createdAt: 0 },
      { id: 'b', x: 0, y: 20, w: 10, h: 10, kind: 'latex' as const, content: 'x^2', size: 12, createdAt: 0 },
    ];
    const ink: BlockSnapshot = { id: 'i', type: 'ink', text: '', strokes: [], height: 100, labels };
    expect(blockToMarkdown(ink)).toBe('see Bellman\n\n$$\nx^2\n$$');
    expect(blockToLatex(ink)).toBe('see Bellman\n\n\\[\nx^2\n\\]');
    const img: BlockSnapshot = { id: 'p', type: 'image', text: '', image: { blobId: 'z', w: 1, h: 1, alt: 'pic' }, labels };
    expect(blockToMarkdown(img)).toBe('![pic](figure.png)\n\nsee Bellman\n\n$$\nx^2\n$$');
    expect(blockToLatex(img)).toContain('\\end{figure}\n\nsee Bellman');
    // without labels nothing changes
    expect(blockToLatex({ id: 'i', type: 'ink', text: '', strokes: [] })).toBe('% (hand-drawn figure — export as SVG)');
  });
});
