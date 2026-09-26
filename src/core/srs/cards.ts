/**
 * Keeps `vault.cards` in sync with the `#flashcard` blocks found by the indexer.
 *
 * Card ids are deterministic (`${blockId}:${clozeIndex}`, 0 for basic cards), so two
 * devices generating cards offline converge on the same records. Editing a block regenerates
 * its card content but preserves scheduling state for every cloze index that still exists.
 */
import type { CardRecord } from '../schema';
import type { Vault } from '../vault';
import {
  flashcardSourceHash,
  generateCards,
  generateCardsAI,
  type ClozeAI,
  type FlashcardInput,
  type GeneratedCard,
} from './cloze';
import { newCardState } from './fsrs';

/** A block containing `#flashcard`, as supplied by the indexer. */
export interface FlashcardSource extends FlashcardInput {
  pageId: string;
  blockId: string;
}

export interface SyncOptions {
  now?: number;
  /**
   * When set, `sources` is the complete flashcard set of only these pages: cards of other
   * pages are left alone (incremental, per-page indexing). Otherwise `sources` is the whole vault.
   */
  scopePageIds?: string[];
  /** generate clozes with AI (falls back to heuristics per block) */
  ai?: ClozeAI;
  /** max generated cloze cards per block (default 3) */
  max?: number;
  signal?: AbortSignal;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export function cardId(blockId: string, clozeIndex: number): string {
  return `${blockId}:${clozeIndex}`;
}

/** Drops undefined fields (Y.Map values are stored as plain JSON). */
function compact<T extends object>(obj: T): T {
  const out = { ...obj };
  for (const k of Object.keys(out) as (keyof T)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Diffs flashcard blocks against `vault.cards`: creates cards for new blocks, regenerates
 * content for changed blocks (keeping scheduling), deletes cards whose block lost its tag or
 * was deleted. All writes happen in one transaction; running it twice is a no-op.
 */
export async function syncCards(vault: Vault, sources: FlashcardSource[], opts: SyncOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

  const bySource = new Map<string, FlashcardSource>();
  for (const s of sources) bySource.set(s.blockId, s);

  const existingByBlock = new Map<string, CardRecord[]>();
  for (const c of vault.cards.values()) {
    const list = existingByBlock.get(c.blockId);
    if (list) list.push(c);
    else existingByBlock.set(c.blockId, [c]);
  }

  // 1. decide which blocks need (re)generation, and generate outside the transaction
  const generated = new Map<string, { hash: string; cards: GeneratedCard[] }>();
  for (const src of bySource.values()) {
    const hash = flashcardSourceHash(src);
    const existing = existingByBlock.get(src.blockId) ?? [];
    if (existing.length && existing.every((c) => c.srcHash === hash)) continue;
    const cards = opts.ai
      ? await generateCardsAI(src, opts.ai, { max: opts.max, signal: opts.signal })
      : generateCards(src, { max: opts.max });
    generated.set(src.blockId, { hash, cards });
  }
  opts.signal?.throwIfAborted();

  const scope = opts.scopePageIds ? new Set(opts.scopePageIds) : null;

  // 2. apply everything in one transaction, against the current state
  vault.transact(() => {
    const cards = vault.cards;
    const current = new Map<string, CardRecord[]>();
    for (const c of cards.values()) {
      const list = current.get(c.blockId);
      if (list) list.push(c);
      else current.set(c.blockId, [c]);
    }

    for (const src of bySource.values()) {
      const gen = generated.get(src.blockId);
      const existing = current.get(src.blockId) ?? [];
      if (!gen) {
        // content unchanged; follow the block if it moved to another page
        for (const c of existing) if (c.pageId !== src.pageId) cards.set(c.id, { ...c, pageId: src.pageId });
        result.unchanged++;
        continue;
      }
      const keep = new Set<string>();
      for (const g of gen.cards) {
        const id = cardId(src.blockId, g.clozeIndex);
        keep.add(id);
        const prev = cards.get(id);
        const content = { pageId: src.pageId, blockId: src.blockId, kind: g.kind, front: g.front, back: g.back, clozeIndex: g.clozeIndex, srcHash: gen.hash };
        if (prev) {
          const same =
            prev.pageId === content.pageId && prev.kind === content.kind && prev.front === content.front &&
            prev.back === content.back && prev.clozeIndex === content.clozeIndex && prev.srcHash === content.srcHash;
          if (same) continue;
          const next: CardRecord = compact({ ...prev, ...content });
          if (content.back === undefined) delete next.back;
          cards.set(id, next);
          result.updated++;
        } else {
          cards.set(id, compact({ id, ...content, ...newCardState(now), createdAt: now }));
          result.created++;
        }
      }
      for (const c of existing) {
        if (!keep.has(c.id)) {
          cards.delete(c.id);
          result.deleted++;
        }
      }
    }

    for (const [blockId, list] of current) {
      if (bySource.has(blockId)) continue;
      for (const c of list) {
        if (scope && !scope.has(c.pageId)) continue;
        cards.delete(c.id);
        result.deleted++;
      }
    }
  });
  return result;
}
