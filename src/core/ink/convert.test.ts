import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockIds, blockLabelList, blockPlainText, blockStrokes, blockType, getBlock, insertBlocks, snapshotPage } from '../blocks';
import type { Beautified, InkLabel, Stroke } from '../schema';
import { LOCAL_ORIGIN } from '../storage/docstore';
import { acceptConversion, conversionBox, deleteLabel, labelFontSize, updateLabel, type PendingConversion } from './convert';

/** A wavy "word" of handwriting at (x, y), w wide, ~h tall. */
function word(id: string, x: number, y: number, w = 120, h = 30): Stroke {
  const pts: number[] = [];
  for (let i = 0; i <= 24; i++) pts.push(x + (w * i) / 24, y + h / 2 + Math.sin(i) * (h / 2), 0.5);
  return { id, pts, color: 'currentInk', size: 3, tool: 'pen' };
}

function setup(strokes: Stroke[], extra: { height?: number; beautified?: Beautified; labels?: InkLabel[] } = {}) {
  const doc = new Y.Doc();
  const [before, ink, after] = insertBlocks(doc, [
    { type: 'text', text: 'before' },
    { type: 'ink', height: extra.height ?? 600, strokes, beautified: extra.beautified, labels: extra.labels },
    { type: 'text', text: 'after' },
  ]);
  return { doc, before, ink, after };
}

const conv = (strokeIds: string[], content = 'hello world', kind: 'text' | 'latex' = 'text'): PendingConversion => ({ id: 'c1', kind, content, strokeIds });

const types = (doc: Y.Doc) => blockIds(doc).map((id) => blockType(getBlock(doc, id)!));

describe('acceptConversion', () => {
  it('writing alone on a whiteboard becomes a text block in its place (the empty whiteboard goes)', () => {
    const { doc, before, after } = setup([word('a', 100, 100), word('b', 240, 100)]);
    const res = acceptConversion(doc, blockIds(doc)[1], conv(['a', 'b']));
    expect(res.mode).toBe('blocks');
    expect(types(doc)).toEqual(['text', 'text', 'text']);
    const ids = blockIds(doc);
    expect(ids[0]).toBe(before);
    expect(blockPlainText(getBlock(doc, ids[1])!)).toBe('hello world');
    expect(ids[2]).toBe(after);
    expect(res.mode === 'blocks' && res.removedBlock).toBe(true);
  });

  it('LaTeX becomes a math block', () => {
    const { doc } = setup([word('a', 100, 100)]);
    acceptConversion(doc, blockIds(doc)[1], conv(['a'], '\\frac{a}{b}', 'latex'));
    const b = getBlock(doc, blockIds(doc)[1])!;
    expect(blockType(b)).toBe('math');
    expect(blockPlainText(b)).toBe('\\frac{a}{b}');
  });

  it('splits the whiteboard: ink above stays, the text follows, ink below moves to a new whiteboard', () => {
    const top = word('top', 100, 40);
    const line = word('w', 100, 250);
    const bottom = word('bot', 100, 420);
    const { doc, ink } = setup([top, line, bottom], { height: 600 });
    const res = acceptConversion(doc, ink, conv(['w']));
    expect(types(doc)).toEqual(['text', 'ink', 'text', 'ink', 'text']);
    const ids = blockIds(doc);
    expect(ids[1]).toBe(ink);
    const upper = getBlock(doc, ink)!;
    expect(blockStrokes(upper)!.toArray().map((s) => s.id)).toEqual(['top']);
    expect(Number(upper.get('height'))).toBeLessThan(600);
    expect(blockPlainText(getBlock(doc, ids[2])!)).toBe('hello world');
    const lower = getBlock(doc, ids[3])!;
    const moved = blockStrokes(lower)!.toArray();
    expect(moved.map((s) => s.id)).toEqual(['bot']);
    // shifted up by the cut, keeping its shape
    expect(moved[0].pts[1]).toBeLessThan(bottom.pts[1]);
    expect(moved[0].pts[1] - moved[0].pts[4]).toBeCloseTo(bottom.pts[1] - bottom.pts[4], 0);
    expect(res.mode === 'blocks' && res.movedTo).toBe(ids[3]);
    expect(res.mode === 'blocks' && res.movedStrokeIds).toEqual(['bot']);
  });

  it('writing beside a drawing becomes a typed label on the whiteboard', () => {
    const shape = word('box', 500, 90, 200, 80);
    const { doc, ink } = setup([word('w', 100, 100), shape]);
    const res = acceptConversion(doc, ink, conv(['w'], 'force'));
    expect(res.mode).toBe('label');
    expect(types(doc)).toEqual(['text', 'ink', 'text']);
    const b = getBlock(doc, ink)!;
    expect(blockStrokes(b)!.toArray().map((s) => s.id)).toEqual(['box']);
    const labels = blockLabelList(b);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ kind: 'text', content: 'force', color: 'currentInk' });
    const box = conversionBox([word('w', 100, 100)]);
    expect(labels[0].x).toBeCloseTo(box.x, 0);
    expect(labels[0].y).toBeCloseTo(box.y, 0);
  });

  it('photos always get labels', () => {
    const doc = new Y.Doc();
    const [img] = insertBlocks(doc, [{ type: 'image', image: { blobId: 'x', w: 100, h: 100 }, strokes: [word('w', 100, 100)] }]);
    expect(acceptConversion(doc, img, conv(['w'])).mode).toBe('label');
    expect(blockLabelList(getBlock(doc, img)!)[0].content).toBe('hello world');
    expect(blockStrokes(getBlock(doc, img)!)!.length).toBe(0);
  });

  it('moves beautified shapes and labels below the cut with their strokes', () => {
    const shapeStroke = word('circ', 300, 450, 100, 100);
    const beautified: Beautified = {
      active: true,
      createdAt: 0,
      items: [{ kind: 'shape', shape: 'circle', svg: '<circle cx="350" cy="500" r="50"/>', bbox: [300, 450, 100, 100], color: '#30a46c', strokeIds: ['circ'] }],
    };
    const label: InkLabel = { id: 'L', x: 100, y: 470, w: 80, h: 20, kind: 'text', content: 'label', size: 14, createdAt: 0 };
    const { doc, ink } = setup([word('w', 100, 200), shapeStroke], { beautified, labels: [label] });
    acceptConversion(doc, ink, conv(['w']));
    // nothing above the writing: the original whiteboard is replaced
    expect(types(doc)).toEqual(['text', 'text', 'ink', 'text']);
    const lower = getBlock(doc, blockIds(doc)[2])!;
    const b = lower.get('beautified') as Beautified;
    expect(b.items).toHaveLength(1);
    expect(b.items[0].kind === 'shape' && b.items[0].bbox[1]).toBeLessThan(450);
    expect(b.items[0].kind === 'shape' && b.items[0].svg).toContain('matrix');
    const moved = blockLabelList(lower);
    expect(moved).toHaveLength(1);
    expect(moved[0].y).toBeLessThan(470);
  });

  it('accepting bottom-most first keeps every line in reading order', () => {
    const { doc, ink } = setup([word('l1', 100, 60), word('l2', 100, 200), word('l3', 100, 340)]);
    for (const [id, text] of [
      ['l3', 'three'],
      ['l2', 'two'],
      ['l1', 'one'],
    ] as const) {
      acceptConversion(doc, ink, { id, kind: 'text', content: text, strokeIds: [id] });
    }
    const texts = snapshotPage(doc).map((b) => `${b.type}:${b.text}`);
    expect(texts).toEqual(['text:before', 'text:one', 'text:two', 'text:three', 'text:after']);
  });

  it('is a single undo step', () => {
    const { doc, ink } = setup([word('top', 100, 40), word('w', 100, 250), word('bot', 100, 420)]);
    const um = new Y.UndoManager([doc.getArray('order'), doc.getMap('blocks')], { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    const before = JSON.stringify(snapshotPage(doc).map((b) => [b.type, b.strokes?.map((s) => s.id)]));
    acceptConversion(doc, ink, conv(['w']));
    expect(types(doc)).toHaveLength(5);
    um.undo();
    expect(JSON.stringify(snapshotPage(doc).map((b) => [b.type, b.strokes?.map((s) => s.id)]))).toBe(before);
  });

  it('does nothing when the ink is gone or the text is empty', () => {
    const { doc, ink } = setup([word('w', 100, 100)]);
    expect(acceptConversion(doc, ink, conv(['missing'])).mode).toBe('none');
    expect(acceptConversion(doc, ink, conv(['w'], '   ')).mode).toBe('none');
    expect(acceptConversion(doc, 'nope', conv(['w'])).mode).toBe('none');
    expect(types(doc)).toEqual(['text', 'ink', 'text']);
  });
});

describe('labels', () => {
  it('sizes typed text like the handwriting', () => {
    expect(labelFontSize('text', 'one line', { x: 0, y: 0, w: 100, h: 40 })).toBeCloseTo(24.8, 1);
    expect(labelFontSize('text', 'a\nb', { x: 0, y: 0, w: 100, h: 80 })).toBeCloseTo(24.8, 1);
    expect(labelFontSize('latex', 'x', { x: 0, y: 0, w: 100, h: 5 })).toBe(12);
  });

  it('updates and deletes labels; emptying the text removes it', () => {
    const label: InkLabel = { id: 'L', x: 0, y: 0, w: 80, h: 20, kind: 'text', content: 'a', size: 14, createdAt: 0 };
    const { doc, ink } = setup([], { labels: [label] });
    const b = getBlock(doc, ink)!;
    expect(updateLabel(b, 'L', { content: 'b', kind: 'latex' })).toBe(true);
    expect(blockLabelList(b)[0]).toMatchObject({ content: 'b', kind: 'latex' });
    updateLabel(b, 'L', { content: '  ' });
    expect(blockLabelList(b)).toHaveLength(0);
    expect(updateLabel(b, 'L', { content: 'x' })).toBe(false);
    const { doc: d2, ink: i2 } = setup([], { labels: [label] });
    deleteLabel(getBlock(d2, i2)!, 'L');
    expect(blockLabelList(getBlock(d2, i2)!)).toHaveLength(0);
  });
});
