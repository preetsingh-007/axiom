/**
 * Pending handwriting conversions, per block, on this device only.
 *
 * A preview is not a decision: it is never written to the CRDT (so other devices, exports and
 * Git never see half-made choices). Both the block in the note and the same block open in the
 * focus view read this store, so a preview made in one shows in the other. Strokes the owner
 * chose to keep as ink are remembered so auto-convert does not offer them again.
 */
import { useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { PendingConversion } from '../../core/ink/convert';

type Block = Y.Map<unknown>;

const pending = new WeakMap<Block, PendingConversion[]>();
const kept = new WeakMap<Block, Set<string>>();
const listeners = new Set<() => void>();
const EMPTY: PendingConversion[] = [];

function emit() {
  for (const fn of listeners) fn();
}

export function listPending(block: Block): PendingConversion[] {
  return pending.get(block) ?? EMPTY;
}

/** Adds previews, replacing any earlier preview that shares strokes with a new one. */
export function addPending(block: Block, items: PendingConversion[]) {
  if (!items.length) return;
  const taken = new Set(items.flatMap((c) => c.strokeIds));
  const cur = listPending(block).filter((c) => !c.strokeIds.some((id) => taken.has(id)));
  pending.set(block, [...cur, ...items]);
  emit();
}

export function removePending(block: Block, ids: Iterable<string>) {
  const gone = new Set(ids);
  const cur = listPending(block);
  const next = cur.filter((c) => !gone.has(c.id));
  if (next.length === cur.length) return;
  if (next.length) pending.set(block, next);
  else pending.delete(block);
  emit();
}

export function updatePending(block: Block, id: string, patch: Partial<Pick<PendingConversion, 'content' | 'kind'>>) {
  const cur = listPending(block);
  const i = cur.findIndex((c) => c.id === id);
  if (i < 0) return;
  const next = cur.slice();
  next[i] = { ...cur[i], ...patch };
  pending.set(block, next);
  emit();
}

/** Moves previews whose strokes now live in another block (after a whiteboard split). */
export function movePending(from: Block, to: Block, strokeIds: Iterable<string>) {
  const ids = new Set(strokeIds);
  const cur = listPending(from);
  const moving = cur.filter((c) => c.strokeIds.every((id) => ids.has(id)));
  if (!moving.length) return;
  const stay = cur.filter((c) => !moving.includes(c));
  if (stay.length) pending.set(from, stay);
  else pending.delete(from);
  pending.set(to, [...listPending(to), ...moving]);
  emit();
}

/** Remembers strokes kept as ink (auto-convert skips them). */
export function keepAsInk(block: Block, strokeIds: Iterable<string>) {
  let s = kept.get(block);
  if (!s) {
    s = new Set();
    kept.set(block, s);
  }
  for (const id of strokeIds) s.add(id);
}

export function isKeptAsInk(block: Block, strokeId: string): boolean {
  return kept.get(block)?.has(strokeId) ?? false;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders when this block's previews change. */
export function usePending(block: Block): PendingConversion[] {
  return useSyncExternalStore(
    subscribe,
    () => listPending(block),
    () => listPending(block),
  );
}
