import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockIds, blockPlainText, convertBlock, deleteBlock, getBlock, insertBlock, insertBlockAfter, insertBlocks, moveBlock, setBlockText, snapshotPage } from './blocks';

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
});
