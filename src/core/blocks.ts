import * as Y from 'yjs';
import { uid } from './util/ids';
import type { Anchor, Beautified, BlockType, EmbedRef, ImageRef, Stroke } from './schema';
import { LOCAL_ORIGIN } from './storage/docstore';

/**
 * Page doc layout:
 *   order:  Y.Array<string>        block ids in display order
 *   blocks: Y.Map<Y.Map<unknown>>  block id -> block fields
 *
 * Block fields:
 *   id, type, createdAt
 *   text:    Y.Text            (text | math | code)
 *   strokes: Y.Array<Stroke>   (ink)
 *   height:  number            (ink; logical units, width = 1000)
 *   image:   ImageRef          (image | slide)
 *   anchor:  Anchor            (wormhole tether to a source location)
 *   beautified: Beautified     (ink)
 *   embed:   EmbedRef          (embed)
 *   lang:    string            (code)
 */

export type BlockMap = Y.Map<unknown>;

export function orderOf(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>('order');
}

export function blocksOf(doc: Y.Doc): Y.Map<BlockMap> {
  return doc.getMap<BlockMap>('blocks');
}

/** Block ids in order, de-duplicated (concurrent moves may duplicate an id) and filtered to existing blocks. */
export function blockIds(doc: Y.Doc): string[] {
  const seen = new Set<string>();
  const blocks = blocksOf(doc);
  const out: string[] = [];
  for (const id of orderOf(doc).toArray()) {
    if (seen.has(id) || !blocks.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getBlock(doc: Y.Doc, id: string): BlockMap | undefined {
  return blocksOf(doc).get(id);
}

export interface NewBlock {
  type: BlockType;
  text?: string;
  height?: number;
  strokes?: Stroke[];
  image?: ImageRef;
  anchor?: Anchor;
  embed?: EmbedRef;
  lang?: string;
  id?: string;
}

function buildBlock(spec: NewBlock): { id: string; map: BlockMap } {
  const id = spec.id ?? uid(10);
  const map = new Y.Map<unknown>();
  map.set('id', id);
  map.set('type', spec.type);
  map.set('createdAt', Date.now());
  if (spec.type === 'text' || spec.type === 'math' || spec.type === 'code') {
    const t = new Y.Text();
    if (spec.text) t.insert(0, spec.text);
    map.set('text', t);
  } else if (spec.text) {
    // caption / alt text for non-text blocks
    const t = new Y.Text();
    t.insert(0, spec.text);
    map.set('text', t);
  }
  if (spec.type === 'ink') {
    const arr = new Y.Array<Stroke>();
    if (spec.strokes?.length) arr.push(spec.strokes);
    map.set('strokes', arr);
    map.set('height', spec.height ?? 300);
  }
  if (spec.image) map.set('image', spec.image);
  if (spec.anchor) map.set('anchor', spec.anchor);
  if (spec.embed) map.set('embed', spec.embed);
  if (spec.lang) map.set('lang', spec.lang);
  return { id, map };
}

/** Inserts blocks at `index` (default: end). Returns their ids. */
export function insertBlocks(doc: Y.Doc, specs: NewBlock[], index?: number, origin: unknown = LOCAL_ORIGIN): string[] {
  const ids: string[] = [];
  doc.transact(() => {
    const order = orderOf(doc);
    const blocks = blocksOf(doc);
    const built = specs.map(buildBlock);
    for (const b of built) {
      blocks.set(b.id, b.map);
      ids.push(b.id);
    }
    const at = index === undefined ? order.length : orderIndexFor(doc, index);
    order.insert(at, ids);
  }, origin);
  return ids;
}

export function insertBlock(doc: Y.Doc, spec: NewBlock, index?: number, origin?: unknown): string {
  return insertBlocks(doc, [spec], index, origin)[0];
}

/** Insert right after an existing block (or at the start when afterId is null). */
export function insertBlockAfter(doc: Y.Doc, afterId: string | null, spec: NewBlock, origin?: unknown): string {
  const ids = blockIds(doc);
  const idx = afterId === null ? 0 : ids.indexOf(afterId) + 1;
  return insertBlock(doc, spec, idx <= 0 && afterId !== null ? ids.length : idx, origin);
}

/**
 * Converts a visible index (over de-duplicated blockIds) into a raw index in the order array.
 */
function orderIndexFor(doc: Y.Doc, visibleIndex: number): number {
  const raw = orderOf(doc).toArray();
  const blocks = blocksOf(doc);
  const seen = new Set<string>();
  let visible = 0;
  for (let i = 0; i < raw.length; i++) {
    const id = raw[i];
    if (seen.has(id) || !blocks.has(id)) continue;
    seen.add(id);
    if (visible === visibleIndex) return i;
    visible++;
  }
  return raw.length;
}

export function deleteBlock(doc: Y.Doc, id: string, origin: unknown = LOCAL_ORIGIN) {
  doc.transact(() => {
    const order = orderOf(doc);
    const raw = order.toArray();
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i] === id) order.delete(i, 1);
    blocksOf(doc).delete(id);
  }, origin);
}

export function moveBlock(doc: Y.Doc, id: string, toVisibleIndex: number, origin: unknown = LOCAL_ORIGIN) {
  doc.transact(() => {
    const order = orderOf(doc);
    const raw = order.toArray();
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i] === id) order.delete(i, 1);
    order.insert(orderIndexFor(doc, toVisibleIndex), [id]);
  }, origin);
}

export function blockType(b: BlockMap): BlockType {
  return b.get('type') as BlockType;
}

export function blockText(b: BlockMap): Y.Text | undefined {
  return b.get('text') as Y.Text | undefined;
}

export function blockPlainText(b: BlockMap): string {
  const t = blockText(b);
  return t ? t.toString() : '';
}

export function blockStrokes(b: BlockMap): Y.Array<Stroke> | undefined {
  return b.get('strokes') as Y.Array<Stroke> | undefined;
}

export function blockAnchor(b: BlockMap): Anchor | undefined {
  return b.get('anchor') as Anchor | undefined;
}

export function blockImage(b: BlockMap): ImageRef | undefined {
  return b.get('image') as ImageRef | undefined;
}

export function blockBeautified(b: BlockMap): Beautified | undefined {
  return b.get('beautified') as Beautified | undefined;
}

export function blockEmbed(b: BlockMap): EmbedRef | undefined {
  return b.get('embed') as EmbedRef | undefined;
}

export function setBlockText(b: BlockMap, value: string, origin: unknown = LOCAL_ORIGIN) {
  const t = blockText(b);
  if (!t) return;
  const doc = t.doc;
  const apply = () => {
    const cur = t.toString();
    if (cur === value) return;
    // minimal diff: common prefix/suffix keeps concurrent edits elsewhere intact
    let start = 0;
    while (start < cur.length && start < value.length && cur[start] === value[start]) start++;
    let endCur = cur.length;
    let endVal = value.length;
    while (endCur > start && endVal > start && cur[endCur - 1] === value[endVal - 1]) {
      endCur--;
      endVal--;
    }
    if (endCur > start) t.delete(start, endCur - start);
    if (endVal > start) t.insert(start, value.slice(start, endVal));
  };
  if (doc) doc.transact(apply, origin);
  else apply();
}

/** Changes a block's type in place, keeping its text (text <-> math <-> code). */
export function convertBlock(doc: Y.Doc, id: string, type: BlockType, origin: unknown = LOCAL_ORIGIN) {
  const b = getBlock(doc, id);
  if (!b) return;
  doc.transact(() => {
    b.set('type', type);
    if ((type === 'text' || type === 'math' || type === 'code') && !b.get('text')) b.set('text', new Y.Text());
    if (type === 'ink' && !b.get('strokes')) {
      b.set('strokes', new Y.Array<Stroke>());
      if (!b.get('height')) b.set('height', 300);
    }
  }, origin);
}

/** Plain JSON snapshot of a block (for export, drag-out, indexing). */
export interface BlockSnapshot {
  id: string;
  type: BlockType;
  text: string;
  strokes?: Stroke[];
  height?: number;
  image?: ImageRef;
  anchor?: Anchor;
  beautified?: Beautified;
  embed?: EmbedRef;
  lang?: string;
  createdAt?: number;
}

export function snapshotBlock(b: BlockMap): BlockSnapshot {
  const strokes = blockStrokes(b);
  return {
    id: b.get('id') as string,
    type: blockType(b),
    text: blockPlainText(b),
    strokes: strokes ? strokes.toArray() : undefined,
    height: b.get('height') as number | undefined,
    image: blockImage(b),
    anchor: blockAnchor(b),
    beautified: blockBeautified(b),
    embed: blockEmbed(b),
    lang: b.get('lang') as string | undefined,
    createdAt: b.get('createdAt') as number | undefined,
  };
}

export function snapshotPage(doc: Y.Doc): BlockSnapshot[] {
  const blocks = blocksOf(doc);
  return blockIds(doc).map((id) => snapshotBlock(blocks.get(id)!));
}
