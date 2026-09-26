import { describe, expect, it, vi } from 'vitest';
import type { AIRequest, AITask } from '../ai/types';
import type { Beautified, Stroke } from '../schema';
import { beautify, expandToItems, mergeBeautified, parseOcrResponse, removeStrokesFromBeautified, transformBeautified, transformSvgFragment, type InkAI } from './beautify';
import { clusterStrokes } from './cluster';
import { sanitizeSvgFragment } from './svgsafe';
import { arc, arrowHeadV, densify, jitter, mulberry32, rectPath, toStroke, word } from './testing/synth';

function scene() {
  const rng = mulberry32(42);
  const rectA = toStroke(jitter(rectPath(100, 100, 200, 100), 2, rng), { id: 'rectA' });
  const rectB = toStroke(jitter(rectPath(460, 106, 200, 92), 2, rng), { id: 'rectB' });
  const shaft = toStroke(jitter(densify([{ x: 312, y: 152 }, { x: 440, y: 156 }]), 1.5, rng), { id: 'shaft' });
  const head = toStroke(arrowHeadV({ x: 312, y: 152 }, { x: 442, y: 155 }, 22), { id: 'head' });
  const circle = toStroke(jitter(arc(820, 160, 60, 58, 0.3, Math.PI * 2.06), 2, rng), { id: 'circle', color: '#e5484d' });
  const text = word('lasso', 100, 420, 30, rng);
  const num = word('2', 610, 400, 26, rng);
  const bar = toStroke(densify([{ x: 595, y: 438 }, { x: 650, y: 439 }]), { id: 'bar' });
  const den = word('3', 610, 446, 26, rng);
  const x = word('x', 520, 425, 26, rng);
  const eq1 = toStroke(densify([{ x: 556, y: 432 }, { x: 576, y: 432 }]), { id: 'eq1' });
  const eq2 = toStroke(densify([{ x: 556, y: 442 }, { x: 576, y: 442 }]), { id: 'eq2' });
  const math = [...x, eq1, eq2, ...num, bar, ...den];
  return { rectA, rectB, shaft, head, circle, text, math, all: [rectA, rectB, shaft, head, circle, ...text, ...math] };
}

class FakeAI implements InkAI {
  calls: AIRequest[] = [];
  constructor(private tasks: AITask[] = ['handwriting', 'math-ocr']) {}
  canHandle(task: AITask) {
    return this.tasks.includes(task);
  }
  async complete(req: AIRequest) {
    this.calls.push(req);
    if (req.task === 'math-ocr') return { text: '```json\n{"kind":"math","content":"$x = \\\\frac{2}{3}$"}\n```' };
    return { text: '{"kind":"text","content":"lasso"}' };
  }
}

const rasterize = vi.fn(async (strokes: Stroke[]) => ({ mime: 'image/png', data: `png:${strokes.length}` }));

describe('clusterStrokes', () => {
  it('separates shapes, writing lines and math blocks', () => {
    const s = scene();
    const r = clusterStrokes(s.all);
    const kinds = r.shapes.map((c) => c.recognition.kind).sort();
    expect(kinds).toEqual(['arrow', 'circle', 'rectangle', 'rectangle']);
    const arrow = r.shapes.find((c) => c.recognition.kind === 'arrow')!;
    expect(arrow.strokes.map((x) => x.id).sort()).toEqual(['head', 'shaft']);
    expect(r.writing).toHaveLength(2);
    const [word, math] = [...r.writing].sort((a, b) => a.bbox.x - b.bbox.x);
    expect(word.strokes).toHaveLength(5); // the "o" stays a letter
    expect(word.mathy).toBe(false);
    expect(math.strokes.map((x) => x.id)).toEqual(expect.arrayContaining(['bar', 'eq1', 'eq2']));
    expect(math.mathy).toBe(true);
    expect(r.leftovers).toHaveLength(0);
  });

  it('a curved arrow (unrecognised) keeps its head as ink instead of OCR-ing it', () => {
    const curve = toStroke(arc(300, 400, 200, 120, Math.PI, Math.PI * 0.8, 0, 80), { id: 'curve' });
    const p = curve.pts;
    const end = { x: p[p.length - 3], y: p[p.length - 2] };
    const prev = { x: p[p.length - 9], y: p[p.length - 8] };
    const head = toStroke(arrowHeadV(prev, end, 22), { id: 'vhead' });
    const r = clusterStrokes([curve, head]);
    expect(r.writing).toHaveLength(0);
    expect(r.leftovers.map((s) => s.id).sort()).toEqual(['curve', 'vhead']);
  });

  it('a lone small circle is still a shape', () => {
    const c = toStroke(arc(100, 100, 18, 18, 0, Math.PI * 2.05));
    expect(clusterStrokes([c]).shapes).toHaveLength(1);
  });
});

describe('beautify', () => {
  it('turns shapes into aligned, colour-coded SVG and writing into text/LaTeX', async () => {
    const s = scene();
    const ai = new FakeAI();
    const res = await beautify(s.all, { ai, rasterize });
    expect(res.errors).toEqual([]);
    expect(res.needsAI).toBe(false);
    expect(res.stats).toEqual({ shapes: 4, text: 1, latex: 1 });
    expect(res.unrecognizedStrokeIds).toEqual([]);

    const rects = res.items.filter((i) => i.kind === 'shape' && i.shape === 'rectangle');
    expect(rects).toHaveLength(2);
    const [a, b] = rects.map((r) => (r.kind === 'shape' ? r.bbox : [0, 0, 0, 0]));
    // aligned: same centre line and height
    expect(a[1] + a[3] / 2).toBeCloseTo(b[1] + b[3] / 2, 0);
    expect(a[3]).toBeCloseTo(b[3], 0);
    // colour: default ink → palette; red ink kept
    expect(rects[0].kind === 'shape' && rects[0].color).toBe('#3e7bfa');
    const circle = res.items.find((i) => i.kind === 'shape' && i.shape === 'circle');
    expect(circle?.kind === 'shape' && circle.color).toBe('#e5484d');
    // the arrow is glued between the boxes
    const arrow = res.items.find((i) => i.kind === 'shape' && i.shape === 'arrow');
    if (arrow?.kind !== 'shape') throw new Error('no arrow');
    expect(arrow.bbox[0]).toBeGreaterThan(a[0] + a[2] - 8);
    expect(arrow.bbox[0] + arrow.bbox[2]).toBeLessThan(b[0] + 8);
    expect(sanitizeSvgFragment(arrow.svg)).toBe(arrow.svg); // generator output survives sanitising

    const text = res.items.find((i) => i.kind === 'text');
    expect(text?.kind === 'text' && text.text).toBe('lasso');
    const latex = res.items.find((i) => i.kind === 'latex');
    expect(latex?.kind === 'latex' && latex.latex).toBe('x = \\frac{2}{3}');
    expect(ai.calls.map((c) => c.task).sort()).toEqual(['handwriting', 'math-ocr']);
    expect(ai.calls[0].images?.[0].mime).toBe('image/png');
    expect(ai.calls[0].json).toBe(true);
  });

  it('without AI, writing stays as ink and needsAI is reported', async () => {
    const s = scene();
    const res = await beautify(s.all, { rasterize, ai: new FakeAI([]) });
    expect(res.needsAI).toBe(true);
    expect(res.stats.shapes).toBe(4);
    expect(res.items.every((i) => i.kind === 'shape')).toBe(true);
    expect(res.unrecognizedStrokeIds.length).toBe(s.text.length + s.math.length);
    const res2 = await beautify(s.text, { rasterize });
    expect(res2.needsAI).toBe(true);
    expect(res2.items).toEqual([]);
  });

  it('AI failures are collected, not thrown', async () => {
    const s = scene();
    const ai: InkAI = { canHandle: () => true, complete: async () => Promise.reject(new Error('quota')) };
    const res = await beautify(s.text, { ai, rasterize });
    expect(res.errors).toEqual(['quota']);
    expect(res.unrecognizedStrokeIds).toHaveLength(s.text.length);
  });
});

describe('parseOcrResponse', () => {
  it('handles fences, chatter, delimiters and plain text', () => {
    expect(parseOcrResponse('Sure! {"kind":"math","content":"\\\\[a^2\\\\]"} hope that helps', 'text')).toEqual({ kind: 'math', content: 'a^2' });
    expect(parseOcrResponse('{"kind":"text","content":""}', 'text')).toBeNull();
    expect(parseOcrResponse('E = mc^2', 'math')).toEqual({ kind: 'math', content: 'E = mc^2' });
    expect(parseOcrResponse('hello world', 'text')).toEqual({ kind: 'text', content: 'hello world' });
  });
});

describe('beautified maintenance', () => {
  const base: Beautified = {
    active: false,
    createdAt: 1,
    items: [
      { kind: 'shape', shape: 'circle', svg: '<circle cx="10" cy="10" r="5"/>', bbox: [5, 5, 10, 10], color: '#000', strokeIds: ['a'] },
      { kind: 'text', x: 0, y: 0, w: 10, h: 10, text: 'hi', strokeIds: ['b', 'c'] },
    ],
  };

  it('merge replaces overlapping items and activates', () => {
    const m = mergeBeautified(base, [{ kind: 'text', x: 0, y: 0, w: 1, h: 1, text: 'new', strokeIds: ['c', 'd'] }], ['c', 'd'], 5);
    expect(m.active).toBe(true);
    expect(m.createdAt).toBe(1);
    expect(m.items.map((i) => i.strokeIds)).toEqual([['a'], ['c', 'd']]);
  });

  it('expands selections to whole items', () => {
    expect([...expandToItems(['b'], base)].sort()).toEqual(['b', 'c']);
  });

  it('removes deleted strokes', () => {
    const r = removeStrokesFromBeautified(base, ['a', 'b']);
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0].strokeIds).toEqual(['c']);
    expect(removeStrokesFromBeautified(base, ['a', 'b', 'c'])).toBeNull();
  });

  it('moves and scales items with their strokes', () => {
    const t = transformBeautified(base, ['a'], { dx: 10, dy: 0 })!;
    expect(t.items[0].kind === 'shape' && t.items[0].bbox).toEqual([15, 5, 10, 10]);
    expect(t.items[0].kind === 'shape' && t.items[0].svg).toBe('<g transform="matrix(1 0 0 1 10 0)"><circle cx="10" cy="10" r="5"/></g>');
    expect(t.items[1]).toBe(base.items[1]); // not all strokes selected → untouched
    // composing transforms folds into one matrix, and identity unwraps
    const back = transformSvgFragment(transformSvgFragment('<path d="M0 0"/>', 2, 5, 5), 0.5, -2.5, -2.5);
    expect(back).toBe('<path d="M0 0"/>');
  });
});
