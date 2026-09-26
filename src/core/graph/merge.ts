/**
 * Graph maintenance operations that rewrite page content: concept merge, page rename,
 * dismissing merge suggestions and converting unlinked mentions into links.
 *
 * Text edits are minimal (only the reference spans change) and applied inside one
 * transaction per page, so concurrent edits elsewhere in a block survive the CRDT merge.
 */

import type * as Y from 'yjs';
import type { Vault } from '../vault';
import { LOCAL_ORIGIN } from '../storage/docstore';
import { blockIds, blocksOf, blockText, insertBlocks, snapshotPage, type NewBlock } from '../blocks';
import { normalizeTitle } from '../util/ids';
import type { GraphIndex } from './index';
import { conceptEdits, findMentions, type TextEdit } from './parse';
import { pairKey } from './similarity';

export interface RewriteResult {
  /** pages whose text changed */
  pages: string[];
  /** number of references rewritten */
  occurrences: number;
}

const ALIAS_PREFIX = 'alias:';
const DISMISS_PREFIX = 'dismiss:';

function applyToYText(t: Y.Text, edits: TextEdit[]) {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.deleteCount) t.delete(e.index, e.deleteCount);
    if (e.insert) t.insert(e.index, e.insert);
  }
}

/** Rewrites references to `from` into `into` on the given pages. */
async function rewritePages(vault: Vault, pageIds: string[], from: string, into: string): Promise<RewriteResult> {
  const changed: string[] = [];
  let occurrences = 0;
  for (const pageId of pageIds) {
    const { doc, release } = await vault.openPage(pageId);
    try {
      let n = 0;
      doc.transact(() => {
        const blocks = blocksOf(doc);
        for (const id of blockIds(doc)) {
          const t = blockText(blocks.get(id)!);
          if (!t) continue;
          const edits = conceptEdits(t.toString(), from, into);
          if (!edits.length) continue;
          applyToYText(t, edits);
          n += edits.length;
        }
      }, LOCAL_ORIGIN);
      if (n) {
        changed.push(pageId);
        occurrences += n;
        vault.touchPage(pageId);
      }
    } finally {
      release();
    }
  }
  return { pages: changed, occurrences };
}

function hasContent(doc: Y.Doc): boolean {
  return snapshotPage(doc).some((b) => b.type !== 'text' || b.text.trim() !== '');
}

/** Throws when `title` cannot be used inside `[[…]]`. */
function assertValidTitle(title: string) {
  if (!title.trim() || /[\[\]|\n]/.test(title)) throw new Error(`Invalid title "${title}"`);
}

/** Canonical title for a concept name, following merged-tag aliases recorded in `tagMeta`. */
export function resolveConceptAlias(vault: Vault, title: string): string {
  let current = title;
  const seen = new Set<string>();
  for (;;) {
    const key = normalizeTitle(current);
    if (seen.has(key)) return current;
    seen.add(key);
    const next = vault.tagMeta.get(ALIAS_PREFIX + key);
    if (typeof next !== 'string' || !next.trim()) return current;
    current = next;
  }
}

/**
 * Page id a typed `[[title]]` / `#tag` should resolve to: follows merged-tag aliases, then
 * page titles and page aliases. Returns undefined when no page exists yet.
 */
export function resolveLinkTarget(vault: Vault, title: string): string | undefined {
  return vault.findPageByTitle(resolveConceptAlias(vault, title))?.id ?? vault.findPageByTitle(title)?.id;
}

/**
 * Merges concept `from` into `into`:
 *  - rewrites `[[from]]`, `[[from|alias]]`, `![[from]]`, `#from` and `#[[from]]` everywhere;
 *  - makes sure a page for `into` exists and adds `from` (and the old page's aliases) as aliases;
 *  - moves the content of a separate `from` page (if any) to the end of the target, then trashes it;
 *  - records `alias:<from>` → `into` in `tagMeta` so future `[[from]]` resolves to the target;
 *  - replaces `from` in source tag lists.
 */
export async function mergeConcepts(vault: Vault, index: GraphIndex, from: string, into: string): Promise<RewriteResult & { targetPageId: string }> {
  assertValidTitle(into);
  const fromNorm = normalizeTitle(from);
  const intoNorm = normalizeTitle(into);
  if (!fromNorm) throw new Error('Nothing to merge');
  await index.flush();

  const intoPageExisting = vault.findPageByTitle(into);
  const fromMatch = vault.findPageByTitle(from);
  // `from` may be its own page (title match) or an alias of some other page
  const fromPage = fromMatch && normalizeTitle(fromMatch.title) === fromNorm ? fromMatch : undefined;
  const sameAsTarget = !!fromMatch && fromMatch.id === intoPageExisting?.id;
  if (fromMatch && !fromPage && !sameAsTarget) {
    vault.updatePage(fromMatch.id, { aliases: (fromMatch.aliases ?? []).filter((a) => normalizeTitle(a) !== fromNorm) });
  }

  // 1. rewrite references (exact spelling of `from`, not its aliases)
  const affected = fromNorm === intoNorm ? [] : index.pagesLinkingTo(from, { exact: true });
  const result = await rewritePages(vault, affected, from, into);

  // 2. target page + aliases
  const targetId = intoPageExisting?.id ?? vault.ensureConcept(into);
  const target = vault.getPage(targetId)!;
  const aliases = [...(target.aliases ?? [])];
  const addAlias = (a: string) => {
    const n = normalizeTitle(a);
    if (!n || n === normalizeTitle(target.title) || aliases.some((x) => normalizeTitle(x) === n)) return;
    aliases.push(a.trim());
  };
  if (fromNorm !== intoNorm) addAlias(from);

  // 3. fold a separate `from` page into the target
  if (fromPage && !sameAsTarget) {
    for (const a of fromPage.aliases ?? []) addAlias(a);
    if (normalizeTitle(fromPage.title) !== fromNorm) addAlias(fromPage.title);
    const src = await vault.openPage(fromPage.id);
    try {
      if (hasContent(src.doc)) {
        const specs: NewBlock[] = snapshotPage(src.doc)
          .filter((b) => b.type !== 'text' || b.text.trim() !== '')
          .map((b) => ({
            id: b.id,
            type: b.type,
            text: b.text,
            height: b.height,
            strokes: b.strokes,
            image: b.image,
            anchor: b.anchor,
            embed: b.embed,
            lang: b.lang,
          }));
        const dst = await vault.openPage(targetId);
        try {
          const existing = new Set(blockIds(dst.doc));
          insertBlocks(
            dst.doc,
            specs.map((s) => (existing.has(s.id!) ? { ...s, id: undefined } : s)),
          );
        } finally {
          dst.release();
        }
      }
    } finally {
      src.release();
    }
    vault.trashPage(fromPage.id);
  }
  vault.updatePage(targetId, { aliases });

  // 4. alias bookkeeping + source tags
  vault.transact(() => {
    if (fromNorm !== intoNorm) vault.tagMeta.set(ALIAS_PREFIX + fromNorm, target.title);
    vault.tagMeta.delete(ALIAS_PREFIX + normalizeTitle(target.title));
    for (const [key, value] of vault.tagMeta.entries()) {
      if (key.startsWith(ALIAS_PREFIX) && typeof value === 'string' && normalizeTitle(value) === fromNorm) {
        vault.tagMeta.set(key, target.title);
      }
    }
    for (const m of vault.sources.values()) {
      for (const field of ['tags', 'ghostTags'] as const) {
        const list = m.get(field) as string[] | undefined;
        if (!list?.some((t) => normalizeTitle(t) === fromNorm)) continue;
        const next: string[] = [];
        for (const t of list) {
          const v = normalizeTitle(t) === fromNorm ? target.title : t;
          if (!next.some((x) => normalizeTitle(x) === normalizeTitle(v))) next.push(v);
        }
        m.set(field, next);
      }
    }
  });
  return { ...result, targetPageId: targetId };
}

/** Renames a page and rewrites every `[[old]]` / `#old` reference to the new title. */
export async function renamePage(vault: Vault, index: GraphIndex, pageId: string, newTitle: string): Promise<RewriteResult> {
  assertValidTitle(newTitle);
  const page = vault.getPage(pageId);
  if (!page) throw new Error(`Unknown page ${pageId}`);
  const oldTitle = page.title;
  if (oldTitle === newTitle.trim()) return { pages: [], occurrences: 0 };
  await index.flush();
  const affected = index.pagesLinkingTo(oldTitle, { exact: true });
  vault.updatePage(pageId, { title: newTitle.trim() });
  return rewritePages(vault, affected, oldTitle, newTitle.trim());
}

/** Persists a dismissed merge suggestion (synced via the index doc). */
export function dismissMerge(vault: Vault, a: string, b: string): void {
  vault.transact(() => vault.tagMeta.set(DISMISS_PREFIX + pairKey(a, b), Date.now()));
}

/** Pair keys of dismissed merge suggestions, for {@link findMergeCandidates}. */
export function dismissedPairs(vault: Vault): Set<string> {
  const out = new Set<string>();
  for (const key of vault.tagMeta.keys()) if (key.startsWith(DISMISS_PREFIX)) out.add(key.slice(DISMISS_PREFIX.length));
  return out;
}

/**
 * Converts the first unlinked mention of `phrase` in a block into `[[…]]` (keeping the text as
 * written, which resolves case-insensitively / via aliases). Returns false when none was found.
 */
export async function linkMention(vault: Vault, pageId: string, blockId: string, phrase: string): Promise<boolean> {
  const { doc, release } = await vault.openPage(pageId);
  try {
    const b = blocksOf(doc).get(blockId);
    const t = b && blockText(b);
    if (!t) return false;
    const [first] = findMentions(t.toString(), phrase);
    if (!first) return false;
    doc.transact(() => {
      t.insert(first.end, ']]');
      t.insert(first.start, '[[');
    }, LOCAL_ORIGIN);
    vault.touchPage(pageId);
    return true;
  } finally {
    release();
  }
}
