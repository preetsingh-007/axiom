/**
 * Handwriting → typed text, decided once.
 *
 * Beautify / auto-convert produce *pending conversions* (recognised text or LaTeX for a set of
 * strokes). They are only previews: nothing is stored until the owner chooses.
 *
 *   acceptConversion(doc, blockId, conv)  the typed text replaces the ink:
 *     - writing that stands on its own line of a whiteboard becomes real note blocks (text or
 *       math) at that spot: the whiteboard is split around it, ink above stays, ink below moves
 *       into a new whiteboard after the text, and an emptied whiteboard is removed;
 *     - writing beside a drawing (or on a photo) becomes a typed label on the canvas, so the
 *       diagram keeps its layout.
 *   Keeping the ink is simply dropping the preview.
 *
 * Everything happens in one transaction with the local origin, so page undo restores the ink.
 */
import * as Y from 'yjs';
import type { Beautified, InkLabel, Stroke } from '../schema';
import { blockIds, blockType, deleteBlock, getBlock, insertBlocks, type NewBlock } from '../blocks';
import { LOCAL_ORIGIN } from '../storage/docstore';
import { uid } from '../util/ids';
import { inflateBBox, strokeBBox, strokesBBox, type BBox } from './geometry';
import { itemBBox } from './render';
import { removeStrokesFromBeautified, transformBeautified } from './beautify';

export interface PendingConversion {
  id: string;
  kind: 'text' | 'latex';
  content: string;
  strokeIds: string[];
}

export type AcceptResult =
  | { mode: 'blocks'; textBlockId: string; movedTo: string | null; movedStrokeIds: string[]; dy: number; removedBlock: boolean }
  | { mode: 'label'; labelId: string }
  | { mode: 'none' };

/** Smallest whiteboard left behind after a split (logical units). */
export const MIN_SPLIT_HEIGHT = 160;
/** Gap kept around the cut when splitting a whiteboard. */
const SPLIT_PAD = 24;
/** Vertical slack when deciding whether other ink shares the writing's line. */
const LINE_SLACK = 6;

/** Bounding box of the writing (including stroke width), in logical units. */
export function conversionBox(strokes: readonly Stroke[]): BBox {
  const maxSize = strokes.reduce((a, s) => Math.max(a, s.size), 0);
  return inflateBBox(strokesBBox(strokes), maxSize / 2);
}

/** Font size (logical units) that makes typed text about as tall as the handwriting. */
export function labelFontSize(kind: 'text' | 'latex', content: string, box: BBox): number {
  const lines = kind === 'text' ? Math.max(1, content.split('\n').length) : Math.max(1, content.split(/\\\\/).length);
  return Math.round(Math.max(12, Math.min(96, (box.h / lines) * 0.62)) * 10) / 10;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function strokeBox(s: Stroke): BBox {
  return inflateBBox(strokeBBox(s), s.size / 2);
}

interface Obstacle {
  box: BBox;
  strokeIds: string[];
  labelId?: string;
}

/**
 * Accepts a conversion on a whiteboard or photo block. `opts.label` forces a label (photos
 * always use labels).
 */
export function acceptConversion(doc: Y.Doc, blockId: string, conv: PendingConversion, opts: { label?: boolean; now?: number } = {}): AcceptResult {
  const block = getBlock(doc, blockId);
  if (!block) return { mode: 'none' };
  const arr = block.get('strokes') as Y.Array<Stroke> | undefined;
  if (!arr) return { mode: 'none' };
  const all = arr.toArray();
  const convIds = new Set(conv.strokeIds);
  const mine = all.filter((s) => convIds.has(s.id));
  if (!mine.length || !conv.content.trim()) return { mode: 'none' };
  const region = conversionBox(mine);
  const now = opts.now ?? Date.now();
  const isInk = blockType(block) === 'ink';

  // everything else on the canvas, grouped like the user sees it (beautified shapes are one thing)
  const beautified = block.get('beautified') as Beautified | undefined;
  const others: Obstacle[] = [];
  const grouped = new Set<string>();
  if (beautified?.active) {
    for (const it of beautified.items) {
      const ids = it.strokeIds.filter((id) => !convIds.has(id));
      if (!ids.length) continue;
      for (const id of ids) grouped.add(id);
      others.push({ box: itemBBox(it), strokeIds: ids });
    }
  }
  for (const s of all) if (!convIds.has(s.id) && !grouped.has(s.id)) others.push({ box: strokeBox(s), strokeIds: [s.id] });
  const labelsMap = block.get('labels') as Y.Map<InkLabel> | undefined;
  for (const l of labelsMap?.values() ?? []) others.push({ box: { x: l.x, y: l.y, w: l.w, h: l.h }, strokeIds: [], labelId: l.id });

  const top = region.y - LINE_SLACK;
  const bottom = region.y + region.h + LINE_SLACK;
  const sharesLine = others.some((o) => o.box.y < bottom && o.box.y + o.box.h > top);
  const asLabel = opts.label || !isInk || sharesLine;

  if (asLabel) {
    const label: InkLabel = {
      id: uid(10),
      x: round(region.x),
      y: round(region.y),
      w: round(Math.max(region.w, 20)),
      h: round(Math.max(region.h, 16)),
      kind: conv.kind,
      content: conv.content,
      size: labelFontSize(conv.kind, conv.content, region),
      color: dominantColor(mine),
      createdAt: now,
    };
    doc.transact(() => {
      removeStrokes(block, arr, convIds);
      let m = block.get('labels') as Y.Map<InkLabel> | undefined;
      if (!m) {
        m = new Y.Map<InkLabel>();
        block.set('labels', m);
      }
      m.set(label.id, label);
    }, LOCAL_ORIGIN);
    return { mode: 'label', labelId: label.id };
  }

  // ---- split the whiteboard around the writing
  const below = others.filter((o) => o.box.y >= region.y + region.h - LINE_SLACK);
  const above = others.filter((o) => !below.includes(o));
  const height = Number(block.get('height')) || 300;
  const cut = Math.max(0, Math.floor(region.y + region.h - SPLIT_PAD));
  const belowStrokeIds = new Set(below.flatMap((o) => o.strokeIds));
  const belowLabelIds = new Set(below.map((o) => o.labelId).filter((x): x is string => !!x));
  const aboveBottom = above.reduce((a, o) => Math.max(a, o.box.y + o.box.h), 0);

  const textSpec: NewBlock = conv.kind === 'latex' ? { type: 'math', text: conv.content.trim() } : { type: 'text', text: conv.content.trim() };
  let textBlockId = '';
  let movedTo: string | null = null;
  let removedBlock = false;
  doc.transact(() => {
    const specs: NewBlock[] = [textSpec];
    if (below.length) {
      const dy = -cut;
      const moved = all.filter((s) => belowStrokeIds.has(s.id)).map((s) => ({ ...s, pts: shiftPts(s.pts, dy) }));
      const movedLabels = [...(labelsMap?.values() ?? [])].filter((l) => belowLabelIds.has(l.id)).map((l) => ({ ...l, y: round(l.y + dy) }));
      const movedBeautified = beautified ? pickBeautified(beautified, belowStrokeIds, dy) : null;
      const bottomOfBelow = below.reduce((a, o) => Math.max(a, o.box.y + o.box.h), 0) + dy;
      specs.push({
        type: 'ink',
        height: Math.max(MIN_SPLIT_HEIGHT, Math.ceil(Math.max(height - cut, bottomOfBelow + SPLIT_PAD))),
        strokes: moved,
        labels: movedLabels.length ? movedLabels : undefined,
        beautified: movedBeautified ?? undefined,
      });
    }
    // remove the writing and whatever moved below
    const gone = new Set([...convIds, ...belowStrokeIds]);
    removeStrokes(block, arr, gone);
    if (labelsMap) for (const id of belowLabelIds) labelsMap.delete(id);

    const idx = blockIds(doc).indexOf(blockId);
    const ids = insertBlocks(doc, specs, idx + 1, LOCAL_ORIGIN);
    textBlockId = ids[0];
    movedTo = ids[1] ?? null;
    if (!above.length) {
      deleteBlock(doc, blockId, LOCAL_ORIGIN);
      removedBlock = true;
    } else {
      const next = Math.max(MIN_SPLIT_HEIGHT, Math.ceil(Math.min(height, Math.max(aboveBottom + SPLIT_PAD, region.y - SPLIT_PAD / 2))));
      if (next !== height) block.set('height', next);
    }
  }, LOCAL_ORIGIN);
  return { mode: 'blocks', textBlockId, movedTo, movedStrokeIds: [...belowStrokeIds], dy: -cut, removedBlock };
}

function shiftPts(pts: number[], dy: number): number[] {
  const out = pts.slice();
  for (let i = 1; i < out.length; i += 3) out[i] = round(out[i] + dy);
  return out;
}

/** The beautified items made only of `ids`, shifted by dy (for strokes moving to a new block). */
function pickBeautified(b: Beautified, ids: Set<string>, dy: number): Beautified | null {
  const items = b.items.filter((it) => it.strokeIds.length && it.strokeIds.every((id) => ids.has(id)));
  if (!items.length) return null;
  return transformBeautified({ ...b, items }, ids, { dx: 0, dy }) ?? null;
}

/** Deletes strokes (and beautified items that lose all their strokes). Call inside a transaction. */
function removeStrokes(block: Y.Map<unknown>, arr: Y.Array<Stroke>, ids: Set<string>) {
  const list = arr.toArray();
  for (let i = list.length - 1; i >= 0; i--) {
    if (!ids.has(list[i].id)) continue;
    let j = i;
    while (j - 1 >= 0 && ids.has(list[j - 1].id)) j--;
    arr.delete(j, i - j + 1);
    i = j;
  }
  const b = block.get('beautified') as Beautified | undefined;
  if (b && b.items.some((it) => it.strokeIds.some((id) => ids.has(id)))) {
    const nb = removeStrokesFromBeautified(b, ids);
    if (nb) block.set('beautified', nb);
    else block.delete('beautified');
  }
}

/** The colour most of the writing used (labels keep it). */
function dominantColor(strokes: readonly Stroke[]): string | undefined {
  const counts = new Map<string, number>();
  for (const s of strokes) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [c, k] of counts) {
    if (k > n) {
      best = c;
      n = k;
    }
  }
  return best;
}

/** Updates a label's text (one label is a single CRDT value: last writer wins). */
export function updateLabel(block: Y.Map<unknown>, id: string, patch: Partial<Pick<InkLabel, 'content' | 'kind'>>): boolean {
  const m = block.get('labels') as Y.Map<InkLabel> | undefined;
  const cur = m?.get(id);
  if (!m || !cur) return false;
  const next = { ...cur, ...patch };
  const apply = () => {
    if (!next.content.trim()) m.delete(id);
    else m.set(id, next);
  };
  if (block.doc) block.doc.transact(apply, LOCAL_ORIGIN);
  else apply();
  return true;
}

export function deleteLabel(block: Y.Map<unknown>, id: string) {
  const m = block.get('labels') as Y.Map<InkLabel> | undefined;
  if (!m?.has(id)) return;
  if (block.doc) block.doc.transact(() => m.delete(id), LOCAL_ORIGIN);
  else m.delete(id);
}
