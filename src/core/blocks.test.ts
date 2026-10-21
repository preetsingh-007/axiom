import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockDisplayWidth, blockIds, blockLabelList, putLabel, blockPlainText, convertBlock, deleteBlock, getBlock, insertBlock, insertBlockAfter, insertBlocks, moveBlock, setBlockText, snapshotBlock, snapshotPage, snapshotToNewBlock } from './blocks';
import type { InkLabel, Stroke } from './schema';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('blocks', () => {
  it('inserts, moves and deletes blocks', () => {
    const doc = new Y.Doc();
    const [a, b, c] = insertBlocks(doc, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
    expect(blockIds(doc)).toEqual([a, b, c]);
    moveBlock(doc, c, 0);
    expect(blockIds(doc)).toEqual([c, a, b]);
    const d = insertBlockAfter(doc, a, { type: 'math', text: 'x' });
    expect(blockIds(doc)).toEqual([c, a, d, b]);
    deleteBlock(doc, a);
    expect(blockIds(doc)).toEqual([c, d, b]);
    expect(getBlock(doc, a)).toBeUndefined();
  });

  it('dedupes concurrent moves of the same block', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const [a, b, c] = insertBlocks(d1, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
    sync(d1, d2);
    moveBlock(d1, a, 2);
    moveBlock(d2, a, 1);
    sync(d1, d2);
    const ids = blockIds(d1);
    expect(ids).toEqual(blockIds(d2));
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([a, b, c]));
  });

  it('setBlockText applies a minimal diff that preserves concurrent edits', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const id = insertBlock(d1, { type: 'text', text: 'The quick brown fox' });
    sync(d1, d2);
    setBlockText(getBlock(d1, id)!, 'The quick red fox');
    (getBlock(d2, id)!.get('text') as Y.Text).insert(19, ' jumps');
    sync(d1, d2);
    expect(blockPlainText(getBlock(d1, id)!)).toBe('The quick red fox jumps');
    expect(blockPlainText(getBlock(d2, id)!)).toBe('The quick red fox jumps');
  });

  it('converts between types keeping text and adding ink fields', () => {
    const doc = new Y.Doc();
    const id = insertBlock(doc, { type: 'text', text: 'E=mc^2' });
    convertBlock(doc, id, 'math');
    expect(snapshotPage(doc)[0]).toMatchObject({ type: 'math', text: 'E=mc^2' });
    convertBlock(doc, id, 'ink');
    expect(snapshotPage(doc)[0]).toMatchObject({ type: 'ink', height: 300, strokes: [] });
  });

  it('insert with index works against de-duplicated positions', () => {
    const doc = new Y.Doc();
    const [a, b] = insertBlocks(doc, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    const x = insertBlock(doc, { type: 'ink', height: 200 }, 1);
    expect(blockIds(doc)).toEqual([a, x, b]);
  });

  it('snapshots round-trip photo size, annotations, labels and beautified state', () => {
    const doc = new Y.Doc();
    const stroke: Stroke = { id: 's', pts: [1, 2, 0.5, 3, 4, 0.5], color: '#e5484d', size: 3, tool: 'pen' };
    const label: InkLabel = { id: 'L', x: 1, y: 2, w: 30, h: 10, kind: 'latex', content: 'x^2', size: 12, createdAt: 1 };
    const [img, ink] = insertBlocks(doc, [
      { type: 'image', image: { blobId: 'b', w: 400, h: 300 }, displayWidth: 0.5, strokes: [stroke], labels: [label], annotationsHidden: true },
      { type: 'ink', height: 300, strokes: [stroke], beautified: { active: true, createdAt: 0, items: [] }, labels: [label] },
    ]);
    const snapImg = snapshotBlock(getBlock(doc, img)!);
    expect(snapImg).toMatchObject({ displayWidth: 0.5, annotationsHidden: true, strokes: [stroke], labels: [label] });
    const copy = new Y.Doc();
    const [img2, ink2] = insertBlocks(copy, [snapshotToNewBlock(snapImg), snapshotToNewBlock(snapshotBlock(getBlock(doc, ink)!))]);
    const b2 = getBlock(copy, img2)!;
    expect(blockDisplayWidth(b2)).toBe(0.5);
    expect(b2.get('annotationsHidden')).toBe(true);
    expect(blockLabelList(b2)).toEqual([label]);
    expect(snapshotBlock(b2).strokes).toEqual([stroke]);
    const i2 = snapshotBlock(getBlock(copy, ink2)!);
    expect(i2.beautified).toEqual({ active: true, createdAt: 0, items: [] });
    expect(i2.labels).toEqual([label]);
    expect(snapshotToNewBlock(snapImg, { keepId: true }).id).toBe(img);
  });

  it('new image blocks get an empty annotation array up front (no size or labels)', () => {
    const doc = new Y.Doc();
    const [img] = insertBlocks(doc, [{ type: 'image', image: { blobId: 'b', w: 4, h: 3 } }]);
    const b = getBlock(doc, img)!;
    expect([...b.keys()].sort()).toEqual(['createdAt', 'id', 'image', 'strokes', 'type']);
    const snap = snapshotBlock(b);
    expect(snap.displayWidth).toBeUndefined();
    expect(snap.labels).toBeUndefined();
    expect(snap.strokes).toEqual([]);
  });

  it('first annotations and labels added on two devices at once both survive', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const [img] = insertBlocks(d1, [{ type: 'image', image: { blobId: 'b', w: 4, h: 3 } }]);
    sync(d1, d2);
    const s = (id: string): Stroke => ({ id, pts: [0, 0, 0.5, 1, 1, 0.5], color: '#e5484d', size: 3, tool: 'pen' });
    const l = (id: string): InkLabel => ({ id, x: 0, y: 0, w: 10, h: 10, kind: 'text', content: id, size: 12, createdAt: 0 });
    d1.transact(() => {
      (getBlock(d1, img)!.get('strokes') as Y.Array<Stroke>).push([s('a')]);
      putLabel(getBlock(d1, img)!, l('one'));
    });
    d2.transact(() => {
      (getBlock(d2, img)!.get('strokes') as Y.Array<Stroke>).push([s('b')]);
      putLabel(getBlock(d2, img)!, l('two'));
    });
    sync(d1, d2);
    for (const d of [d1, d2]) {
      const snap = snapshotBlock(getBlock(d, img)!);
      expect(snap.strokes!.map((x) => x.id).sort()).toEqual(['a', 'b']);
      expect(snap.labels!.map((x) => x.id).sort()).toEqual(['one', 'two']);
    }
  });
});
