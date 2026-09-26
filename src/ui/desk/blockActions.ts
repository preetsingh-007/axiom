import * as Y from 'yjs';
import {
  blockIds,
  blockPlainText,
  blockText,
  blockType,
  convertBlock,
  deleteBlock,
  getBlock,
  insertBlock,
  insertBlockAfter,
  setBlockText,
  type NewBlock,
} from '../../core/blocks';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import type { BlockType } from '../../core/schema';
import type { PageEditorApi } from './editorContext';

const TEXTUAL: BlockType[] = ['text', 'math', 'code'];

export function isTextual(t: BlockType) {
  return TEXTUAL.includes(t);
}

function neighbour(doc: Y.Doc, id: string, dir: -1 | 1, textualOnly = true): string | null {
  const ids = blockIds(doc);
  let i = ids.indexOf(id) + dir;
  while (i >= 0 && i < ids.length) {
    const b = getBlock(doc, ids[i]);
    if (b && (!textualOnly || isTextual(blockType(b)))) return ids[i];
    i += dir;
  }
  return null;
}

const LIST_RE = /^(\s*)([-*+]|(\d+)[.)])(\s+)(\[[ xX]\]\s+)?/;

/**
 * Block-level editing operations shared by all textual blocks.
 */
export function blockActions(api: PageEditorApi, id: string) {
  const doc = api.doc;
  return {
    /** Enter: continues lists inside the block, otherwise splits into a new block. */
    split(before: string, after: string): boolean {
      const block = getBlock(doc, id);
      if (!block) return false;
      const ytext = blockText(block)!;
      const lastLine = before.slice(before.lastIndexOf('\n') + 1);
      const lm = LIST_RE.exec(lastLine);
      if (lm) {
        const itemBody = lastLine.slice(lm[0].length);
        if (!itemBody.trim()) {
          // empty list item: drop the marker and split out of the list
          const stripped = before.slice(0, before.length - lastLine.length).replace(/\n$/, '');
          doc.transact(() => setBlockText(block, stripped + (after ? '\n' + after : '')), LOCAL_ORIGIN);
          const newId = insertBlockAfter(doc, id, { type: 'text', text: '' });
          api.focus(newId, 'start');
          return true;
        }
        const next = lm[3] ? `${Number(lm[3]) + 1}${lm[2].slice(-1)}` : lm[2];
        const marker = `${lm[1]}${next}${lm[4]}${lm[5] ? '[ ] ' : ''}`;
        const insertAt = before.length;
        doc.transact(() => ytext.insert(insertAt, '\n' + marker), LOCAL_ORIGIN);
        api.focus(id, insertAt + 1 + marker.length);
        return true;
      }
      doc.transact(() => {
        setBlockText(block, before);
      }, LOCAL_ORIGIN);
      const newId = insertBlockAfter(doc, id, { type: 'text', text: after });
      api.focus(newId, 'start');
      return true;
    },

    /** Backspace at offset 0: delete an empty block or merge into the previous one. */
    backspaceAtStart(isEmpty: boolean) {
      const prev = neighbour(doc, id, -1, false);
      const block = getBlock(doc, id);
      if (!block) return;
      if (!prev) {
        if (isEmpty && blockType(block) !== 'text') convertBlock(doc, id, 'text');
        return;
      }
      const prevBlock = getBlock(doc, prev)!;
      if (isEmpty) {
        deleteBlock(doc, id);
        if (isTextual(blockType(prevBlock))) api.focus(prev, 'end');
        return;
      }
      if (blockType(prevBlock) === 'text' && blockType(block) === 'text') {
        const prevText = blockText(prevBlock)!;
        const joinAt = prevText.length;
        const moving = blockPlainText(block);
        doc.transact(() => {
          prevText.insert(joinAt, moving);
          deleteBlock(doc, id);
        }, LOCAL_ORIGIN);
        api.focus(prev, joinAt);
      } else if (isTextual(blockType(prevBlock))) {
        api.focus(prev, 'end');
      }
    },

    arrowOut(dir: 'up' | 'down') {
      const target = neighbour(doc, id, dir === 'up' ? -1 : 1);
      if (target) api.focus(target, dir === 'up' ? 'end' : 'start');
    },

    insertAfter(spec: NewBlock, focus = true): string {
      const newId = insertBlockAfter(doc, id, spec);
      if (focus && isTextual(spec.type)) api.focus(newId, 'start');
      return newId;
    },

    /** Replace this block if it's an empty text block, else insert after it. */
    replaceOrInsert(spec: NewBlock): string {
      const block = getBlock(doc, id);
      const empty = block && blockType(block) === 'text' && blockPlainText(block).trim() === '';
      if (empty) {
        const ids = blockIds(doc);
        const idx = ids.indexOf(id);
        let newId = '';
        doc.transact(() => {
          deleteBlock(doc, id);
          newId = insertBlock(doc, spec, idx);
        }, LOCAL_ORIGIN);
        if (isTextual(spec.type)) api.focus(newId, 'start');
        return newId;
      }
      return this.insertAfter(spec);
    },

    convert(type: BlockType) {
      convertBlock(doc, id, type);
      if (isTextual(type)) api.focus(id, 'end');
    },

    remove() {
      const prev = neighbour(doc, id, -1);
      deleteBlock(doc, id);
      if (prev) api.focus(prev, 'end');
      if (blockIds(doc).length === 0) {
        const nid = insertBlock(doc, { type: 'text', text: '' });
        api.focus(nid, 'start');
      }
    },

    appendText(suffix: string) {
      const block = getBlock(doc, id);
      const t = block && blockText(block);
      if (!t) return;
      doc.transact(() => t.insert(t.length, (t.length && !/\s$/.test(t.toString()) ? ' ' : '') + suffix), LOCAL_ORIGIN);
    },

    insertTextAt(pos: number, s: string) {
      const block = getBlock(doc, id);
      const t = block && blockText(block);
      if (!t) return;
      doc.transact(() => t.insert(Math.min(pos, t.length), s), LOCAL_ORIGIN);
    },
  };
}

export type BlockActions = ReturnType<typeof blockActions>;
