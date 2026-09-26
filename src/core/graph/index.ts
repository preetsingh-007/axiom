/**
 * GraphIndex — the derived, local-only knowledge-graph index of a vault.
 *
 * It is NOT stored in the CRDT: it is rebuilt from page docs and cached in IndexedDB
 * (`graph-index-v1*` keys) with a per-page version (hash of the page's state vector), so a
 * restart only re-parses pages that changed. It stays live by listening to
 * `DocStore.onDocChanged` (debounced per page) and to the pages registry / tag metadata.
 */

import * as Y from 'yjs';
import type { Vault } from '../vault';
import type { BlockType, EmbedRef, PageKind } from '../schema';
import { INDEX_DOC_ID } from '../schema';
import { blockAnchor, blockEmbed, blockIds, blockPlainText, blocksOf, blockType } from '../blocks';
import { Emitter } from '../util/emitter';
import { bytesHash, hash32, normalizeTitle } from '../util/ids';
import { parseRefs, plainText, type EmbedTarget } from './parse';
import { SearchIndex, type SearchPayload } from './search';
import { scanTerms } from './tokenize';

export type { EmbedTarget } from './parse';

/** A block as seen by the graph index. `text` is plain text, truncated. */
export interface BlockEntry {
  readonly pageId: string;
  readonly blockId: string;
  readonly type: BlockType;
  /** plain text (markup stripped), truncated to {@link MAX_TEXT} chars */
  readonly text: string;
  /** normalized link targets, including `![[embed]]` targets */
  readonly links: readonly string[];
  /** normalized tags */
  readonly tags: readonly string[];
  readonly embeds: readonly EmbedTarget[];
  readonly blockRefs: readonly string[];
  /** has a `#flashcard` tag or cloze markers (`{{c1::…}}`) */
  readonly hasFlashcard: boolean;
  readonly anchorSourceId?: string;
  /** set for `embed` blocks (transclusion by page id) */
  readonly embedRef?: EmbedRef;
  readonly createdAt: number;
  /** position of the block in its page */
  readonly order: number;
}

export interface BlockHit {
  pageId: string;
  blockId: string;
  snippet: string;
}

export interface MentionHit extends BlockHit {
  /** the title or alias that was found in the block */
  phrase: string;
}

export interface ConceptInfo {
  /** display title (page title when a page exists) */
  title: string;
  normalized: string;
  /** number of blocks referencing the concept (links, tags or embeds) */
  count: number;
  pageId?: string;
}

export interface OutgoingRef {
  title: string;
  normalized: string;
  pageId?: string;
  count: number;
}

export interface FlashcardSource {
  pageId: string;
  blockId: string;
  type: BlockType;
  /** raw block markdown (not truncated) */
  text: string;
  pageTitle: string;
  /** anchor quote or the preceding block's plain text, for card context */
  contextText?: string;
}

export type GraphNodeKind = 'page' | 'concept' | 'daily';

export interface GraphNode {
  /** page id, or `concept:<normalized>` for concepts without a page */
  id: string;
  title: string;
  kind: GraphNodeKind;
  /** weighted degree + 1 */
  weight: number;
  pageId?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface SearchResult {
  pageId: string;
  /** undefined for page-title matches */
  blockId?: string;
  title: string;
  snippet: string;
  score: number;
  /** [start, end) ranges of matched words inside `snippet` */
  highlights: [number, number][];
}

export interface GraphIndexOptions {
  /** per-page re-index debounce (ms) */
  debounceMs?: number;
  /** onChange debounce (ms) */
  changeDebounceMs?: number;
  /** persist the derived index to IndexedDB (default true) */
  persist?: boolean;
}

/** Plain text kept per block. */
export const MAX_TEXT = 2000;
const SNIPPET = 180;
const TITLE_BOOST = 3;
const PERSIST_KEY = 'graph-index-v1';
const PERSIST_FMT = 1;
const BUCKETS = 32;
const PERSIST_MS = 2500;
const SLICE_MS = 12;
const READ_BATCH = 16;

interface PageInfo {
  id: string;
  title: string;
  norm: string;
  aliases: string[];
  kind: PageKind;
  updatedAt: number;
  sourceId?: string;
}

interface MutableEntry {
  pageId: string;
  blockId: string;
  type: BlockType;
  text: string;
  links: string[];
  tags: string[];
  embeds: EmbedTarget[];
  blockRefs: string[];
  hasFlashcard: boolean;
  anchorSourceId?: string;
  embedRef?: EmbedRef;
  createdAt: number;
  order: number;
}

/** Search payload: a block or a page title. */
interface Doc extends SearchPayload {
  pageId: string;
  entry?: MutableEntry;
}

interface BlockRec {
  entry: MutableEntry;
  sig: string;
  /** link / tag spellings as written (for display names and persistence) */
  linksRaw: string[];
  tagsRaw: string[];
  doc: Doc;
}

interface PageRec {
  version: string;
  blocks: Map<string, BlockRec>;
  titleDoc?: Doc;
  titleKey?: string;
}

/** Block extracted from a page doc (or restored from the snapshot). */
interface RawBlock {
  id: string;
  type: BlockType;
  sig: string;
  text: string;
  linksRaw: string[];
  tagsRaw: string[];
  embeds: EmbedTarget[];
  blockRefs: string[];
  hasFlashcard: boolean;
  anchorSourceId?: string;
  embedRef?: EmbedRef;
  createdAt: number;
}

/** Persisted block tuple. */
type SnapBlock = [
  id: string,
  type: BlockType,
  sig: string,
  text: string,
  links: string[],
  tags: string[],
  embeds: [string, string?][],
  blockRefs: string[],
  flags: number,
  anchorSourceId: string | 0,
  createdAt: number,
  embedRef: [string, string?] | 0,
];

interface SnapPage {
  v: string;
  b: SnapBlock[];
}

interface SnapManifest {
  fmt: number;
  buckets: number;
}

const REFS_TYPES: ReadonlySet<BlockType> = new Set<BlockType>(['text', 'image', 'slide', 'ink', 'embed']);

function extractBlock(b: Y.Map<unknown>, id: string): RawBlock {
  const type = blockType(b) ?? 'text';
  const raw = blockPlainText(b);
  const anchor = blockAnchor(b);
  const embed = blockEmbed(b);
  const createdAt = (b.get('createdAt') as number | undefined) ?? 0;
  const parseable = REFS_TYPES.has(type);
  const refs = parseable && raw ? parseRefs(raw) : null;
  const text = (parseable ? plainText(raw) : raw).slice(0, MAX_TEXT);
  const tagsRaw = refs?.tags ?? [];
  return {
    id,
    type,
    sig: hash32(`${type}\u0001${raw}\u0001${anchor?.sourceId ?? ''}\u0001${embed ? embed.pageId + '#' + (embed.blockId ?? '') : ''}`),
    text,
    linksRaw: refs ? [...refs.links, ...refs.embeds.map((e) => e.page)] : [],
    tagsRaw,
    embeds: refs?.embeds ?? [],
    blockRefs: refs?.blockRefs ?? [],
    hasFlashcard: !!refs && (refs.clozes > 0 || tagsRaw.some((t) => normalizeTitle(t) === 'flashcard')),
    anchorSourceId: anchor?.sourceId,
    embedRef: embed ? { ...embed } : undefined,
    createdAt,
  };
}

/** Per-block memo: re-parsing markdown for every block on each keystroke is O(page). */
const extractMemo = new WeakMap<Y.Map<unknown>, { key: string; raw: RawBlock }>();

function memoExtract(b: Y.Map<unknown>, id: string): RawBlock {
  const anchor = blockAnchor(b);
  const embed = blockEmbed(b);
  const key = `${blockType(b)}\u0001${blockPlainText(b)}\u0001${anchor?.sourceId ?? ''}\u0001${embed ? embed.pageId + '#' + (embed.blockId ?? '') : ''}\u0001${b.get('createdAt') ?? ''}`;
  const hit = extractMemo.get(b);
  if (hit && hit.key === key && hit.raw.id === id) return hit.raw;
  const raw = extractBlock(b, id);
  extractMemo.set(b, { key, raw });
  return raw;
}

function extractPage(doc: Y.Doc): RawBlock[] {
  const blocks = blocksOf(doc);
  return blockIds(doc).map((id) => memoExtract(blocks.get(id)!, id));
}

function toSnap(r: BlockRec): SnapBlock {
  const e = r.entry;
  return [
    e.blockId,
    e.type,
    r.sig,
    e.text,
    r.linksRaw,
    r.tagsRaw,
    e.embeds.map((x) => (x.block ? [x.page, x.block] : [x.page])),
    e.blockRefs,
    e.hasFlashcard ? 1 : 0,
    e.anchorSourceId ?? 0,
    e.createdAt,
    e.embedRef ? (e.embedRef.blockId ? [e.embedRef.pageId, e.embedRef.blockId] : [e.embedRef.pageId]) : 0,
  ];
}

function fromSnap(s: SnapBlock): RawBlock {
  return {
    id: s[0],
    type: s[1],
    sig: s[2],
    text: s[3],
    linksRaw: s[4],
    tagsRaw: s[5],
    embeds: s[6].map(([page, block]) => (block ? { page, block } : { page })),
    blockRefs: s[7],
    hasFlashcard: (s[8] & 1) === 1,
    anchorSourceId: s[9] || undefined,
    createdAt: s[10],
    embedRef: s[11] ? (s[11][1] ? { pageId: s[11][0], blockId: s[11][1] } : { pageId: s[11][0] }) : undefined,
  };
}

function bucketOf(pageId: string): number {
  return parseInt(hash32(pageId), 36) % BUCKETS;
}

function versionOf(sv: Uint8Array): string {
  return bytesHash(sv);
}

function uniqNorm(list: string[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    const n = normalizeTitle(s);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function yieldToMain(): Promise<void> {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  return new Promise((resolve) => (ric ? ric(() => resolve(), { timeout: 50 }) : setTimeout(resolve, 0)));
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const s = map.get(key);
  if (!s) return;
  s.delete(value);
  if (!s.size) map.delete(key);
}

/** Snippet of `text` around the first occurrence of any of `terms`, with highlight ranges. */
export function makeSnippet(text: string, terms: Set<string>, width = SNIPPET): { snippet: string; highlights: [number, number][] } {
  const hits: [number, number][] = [];
  if (terms.size) {
    scanTerms(text, (t, s, e) => {
      if (terms.has(t)) hits.push([s, e]);
    });
  }
  let start = 0;
  if (hits.length && hits[0][0] > width / 3) {
    start = hits[0][0] - Math.floor(width / 3);
    const sp = text.lastIndexOf(' ', start);
    if (sp > start - 20 && sp >= 0) start = sp + 1;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > start + width / 2) end = sp;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = prefix + text.slice(start, end) + suffix;
  const highlights: [number, number][] = [];
  for (const [s, e] of hits) {
    if (s >= start && e <= end) highlights.push([s - start + prefix.length, e - start + prefix.length]);
  }
  return { snippet, highlights };
}

/**
 * The derived knowledge-graph index. Create one per vault, call {@link init} once, and
 * {@link destroy} when the vault closes.
 */
export class GraphIndex {
  /** Fires (debounced) after pages were (re)indexed or names changed. */
  readonly onChange = new Emitter<{ pageIds: string[] }>();

  private readonly debounceMs: number;
  private readonly changeDebounceMs: number;
  private readonly persist: boolean;

  private pages = new Map<string, PageRec>();
  private meta = new Map<string, PageInfo>();
  /** normalized name (title / alias / tagMeta alias) → page id */
  private nameToPage = new Map<string, string>();
  /** normalized alias → canonical normalized name */
  private canonOf = new Map<string, string>();
  /** canonical normalized name → all normalized names folding into it */
  private members = new Map<string, Set<string>>();

  private linkRefs = new Map<string, Set<MutableEntry>>();
  private tagRefs = new Map<string, Set<MutableEntry>>();
  private embedRefs = new Map<string, Set<MutableEntry>>();
  private sourceRefs = new Map<string, Set<MutableEntry>>();
  private blockRefIdx = new Map<string, Set<MutableEntry>>();
  private flashcards = new Set<MutableEntry>();
  private display = new Map<string, string>();
  private search_ = new SearchIndex<Doc>();

  private gen = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Set<Promise<unknown>>();
  private changed = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private dirtyBuckets = new Set<number>();
  private snapshot = new Map<string, SnapPage>();
  private conceptsCache: ConceptInfo[] | null = null;
  private graphCache: GraphData | null = null;
  private unsubs: (() => void)[] = [];
  private initPromise: Promise<void> | null = null;
  private ready_ = false;
  private destroyed = false;

  constructor(
    readonly vault: Vault,
    opts: GraphIndexOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.changeDebounceMs = opts.changeDebounceMs ?? 150;
    this.persist = opts.persist ?? true;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Indexes every page (incrementally, yielding to the UI). Safe to call more than once. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    this.rebuildNames();
    this.subscribe();
    if (this.persist) await this.loadSnapshot();
    const ids = [...this.meta.keys()];
    let deadline = performance.now() + SLICE_MS;
    for (let i = 0; i < ids.length && !this.destroyed; i += READ_BATCH) {
      const batch = ids.slice(i, i + READ_BATCH);
      const gens = batch.map((id) => this.bump(id));
      const states = await Promise.all(batch.map((id) => (this.vault.store.isLoaded(id) ? null : this.vault.store.getState(id))));
      for (let j = 0; j < batch.length; j++) {
        const id = batch[j];
        if (this.gen.get(id) !== gens[j] || !this.meta.has(id)) continue;
        this.indexFromSource(id, states[j], this.snapshot.get(id));
        if (performance.now() > deadline) {
          await yieldToMain();
          deadline = performance.now() + SLICE_MS;
        }
      }
    }
    this.snapshot.clear();
    this.search_.optimize();
    this.ready_ = true;
    this.syncPages();
    this.markChanged(ids);
    if (this.persist) this.schedulePersist(true);
  }

  /** True once {@link init} has indexed every page. */
  get ready(): boolean {
    return this.ready_;
  }

  /** Unsubscribes and persists pending changes. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.changeTimer);
    clearTimeout(this.syncTimer);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persistNow();
    }
  }

  /** Runs pending debounced work (re-indexing, name sync, change events) and waits for it. */
  async flush(): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
      this.syncPages();
    }
    for (const [id, t] of [...this.timers]) {
      clearTimeout(t);
      this.timers.delete(id);
      this.track(this.reindexPage(id));
    }
    while (this.inflight.size) await Promise.all([...this.inflight]);
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
      this.emitChange();
    }
  }

  private track(p: Promise<unknown>) {
    const q: Promise<unknown> = p
      .catch((err) => {
        if (!this.destroyed) console.warn('[axiom] graph index update failed', err);
      })
      .finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  private subscribe() {
    this.unsubs.push(
      this.vault.store.onDocChanged.on(({ docId }) => {
        if (docId === INDEX_DOC_ID || this.destroyed) return;
        this.scheduleReindex(docId);
      }),
    );
    const onPages = () => {
      if (this.destroyed) return;
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        this.syncTimer = undefined;
        this.syncPages();
      }, 60);
    };
    this.vault.pages.observeDeep(onPages);
    this.vault.tagMeta.observe(onPages);
    this.unsubs.push(() => this.vault.pages.unobserveDeep(onPages));
    this.unsubs.push(() => this.vault.tagMeta.unobserve(onPages));
    if (typeof window !== 'undefined') {
      const onHide = () => {
        if (this.persistTimer) void this.persistNow();
      };
      window.addEventListener('pagehide', onHide);
      this.unsubs.push(() => window.removeEventListener('pagehide', onHide));
    }
  }

  private scheduleReindex(pageId: string) {
    const prev = this.timers.get(pageId);
    if (prev) clearTimeout(prev);
    this.timers.set(
      pageId,
      setTimeout(() => {
        this.timers.delete(pageId);
        this.track(this.reindexPage(pageId));
      }, this.debounceMs),
    );
  }

  private bump(id: string): number {
    const g = (this.gen.get(id) ?? 0) + 1;
    this.gen.set(id, g);
    return g;
  }

  /** Re-reads one page from the doc store and updates the index. */
  private async reindexPage(pageId: string): Promise<void> {
    if (this.destroyed) return;
    if (!this.meta.has(pageId)) {
      if (this.pages.has(pageId)) this.removePage(pageId);
      return;
    }
    const g = this.bump(pageId);
    const state = this.vault.store.isLoaded(pageId) ? null : await this.vault.store.getState(pageId);
    if (this.gen.get(pageId) !== g || this.destroyed || !this.meta.has(pageId)) return;
    this.indexFromSource(pageId, state);
    this.markChanged([pageId]);
  }

  /**
   * Indexes a page from its live doc (when loaded), else from `state`. When the version matches
   * `snap`, the snapshot is used instead of parsing the doc.
   */
  private indexFromSource(pageId: string, state: Uint8Array | null, snap?: SnapPage) {
    const live = this.vault.store.getLoaded(pageId);
    if (live) {
      const v = versionOf(Y.encodeStateVector(live));
      if (snap && snap.v === v) this.applyPage(pageId, v, snap.b.map(fromSnap));
      else this.applyPage(pageId, v, extractPage(live));
      return;
    }
    if (!state) {
      this.applyPage(pageId, 'empty', []);
      return;
    }
    const v = versionOf(Y.encodeStateVectorFromUpdate(state));
    if (snap && snap.v === v) {
      this.applyPage(pageId, v, snap.b.map(fromSnap));
      return;
    }
    const doc = new Y.Doc({ guid: pageId });
    try {
      Y.applyUpdate(doc, state);
      this.applyPage(pageId, v, extractPage(doc));
    } finally {
      doc.destroy();
    }
  }

  /** Diffs `blocks` against the indexed page and updates all derived structures. */
  private applyPage(pageId: string, version: string, blocks: RawBlock[]) {
    let rec = this.pages.get(pageId);
    if (!rec) {
      rec = { version, blocks: new Map() };
      this.pages.set(pageId, rec);
      this.updateTitleDoc(pageId, rec);
    }
    rec.version = version;
    const next = new Map<string, BlockRec>();
    blocks.forEach((raw, order) => {
      const old = rec!.blocks.get(raw.id);
      if (old && old.sig === raw.sig && !next.has(raw.id)) {
        old.entry.order = order;
        old.entry.createdAt = raw.createdAt;
        next.set(raw.id, old);
        rec!.blocks.delete(raw.id);
        return;
      }
      if (next.has(raw.id)) return;
      next.set(raw.id, this.addBlock(pageId, raw, order));
    });
    for (const old of rec.blocks.values()) this.removeBlock(old);
    rec.blocks = next;
    this.dirtyBuckets.add(bucketOf(pageId));
    this.invalidate();
    if (this.persist && this.ready_) this.schedulePersist();
  }

  private addBlock(pageId: string, raw: RawBlock, order: number): BlockRec {
    const entry: MutableEntry = {
      pageId,
      blockId: raw.id,
      type: raw.type,
      text: raw.text,
      links: uniqNorm(raw.linksRaw),
      tags: uniqNorm(raw.tagsRaw),
      embeds: raw.embeds,
      blockRefs: raw.blockRefs,
      hasFlashcard: raw.hasFlashcard,
      anchorSourceId: raw.anchorSourceId,
      embedRef: raw.embedRef,
      createdAt: raw.createdAt,
      order,
    };
    for (const s of raw.linksRaw) this.noteDisplay(s);
    for (const s of raw.tagsRaw) this.noteDisplay(s);
    for (const n of entry.links) addTo(this.linkRefs, n, entry);
    for (const n of entry.tags) addTo(this.tagRefs, n, entry);
    for (const b of entry.blockRefs) addTo(this.blockRefIdx, b, entry);
    for (const e of entry.embeds) if (e.block) addTo(this.blockRefIdx, e.block, entry);
    if (entry.embedRef) {
      addTo(this.embedRefs, entry.embedRef.pageId, entry);
      if (entry.embedRef.blockId) addTo(this.blockRefIdx, entry.embedRef.blockId, entry);
    }
    if (entry.anchorSourceId) addTo(this.sourceRefs, entry.anchorSourceId, entry);
    if (entry.hasFlashcard) this.flashcards.add(entry);
    const doc: Doc = { doc: -1, pageId, entry };
    this.search_.add(entry.text, doc);
    return { entry, sig: raw.sig, linksRaw: raw.linksRaw, tagsRaw: raw.tagsRaw, doc };
  }

  private removeBlock(rec: BlockRec) {
    const e = rec.entry;
    for (const n of e.links) removeFrom(this.linkRefs, n, e);
    for (const n of e.tags) removeFrom(this.tagRefs, n, e);
    for (const b of e.blockRefs) removeFrom(this.blockRefIdx, b, e);
    for (const x of e.embeds) if (x.block) removeFrom(this.blockRefIdx, x.block, e);
    if (e.embedRef) {
      removeFrom(this.embedRefs, e.embedRef.pageId, e);
      if (e.embedRef.blockId) removeFrom(this.blockRefIdx, e.embedRef.blockId, e);
    }
    if (e.anchorSourceId) removeFrom(this.sourceRefs, e.anchorSourceId, e);
    this.flashcards.delete(e);
    this.search_.remove(rec.doc);
  }

  private removePage(pageId: string) {
    const rec = this.pages.get(pageId);
    if (!rec) return;
    for (const b of rec.blocks.values()) this.removeBlock(b);
    if (rec.titleDoc) this.search_.remove(rec.titleDoc);
    this.pages.delete(pageId);
    this.dirtyBuckets.add(bucketOf(pageId));
    this.invalidate();
    this.markChanged([pageId]);
    if (this.persist) this.schedulePersist();
  }

  private noteDisplay(spelling: string) {
    const n = normalizeTitle(spelling);
    if (n && !this.display.has(n)) this.display.set(n, spelling.trim());
  }

  private updateTitleDoc(pageId: string, rec: PageRec) {
    const info = this.meta.get(pageId);
    if (!info) return;
    const key = [info.title, ...info.aliases].join('\u0001');
    if (rec.titleKey === key && rec.titleDoc) return;
    if (rec.titleDoc) this.search_.remove(rec.titleDoc);
    rec.titleKey = key;
    rec.titleDoc = { doc: -1, pageId };
    this.search_.add([info.title, ...info.aliases].join(' '), rec.titleDoc, TITLE_BOOST);
  }

  // ------------------------------------------------------------------ names

  /** Rebuilds page metadata and alias maps from the pages registry and tag metadata. */
  private rebuildNames() {
    this.meta.clear();
    this.nameToPage.clear();
    this.canonOf.clear();
    this.members.clear();
    for (const m of this.vault.pages.values()) {
      if (m.get('trashed')) continue;
      const id = m.get('id') as string;
      const title = (m.get('title') as string) ?? '';
      const aliases = ((m.get('aliases') as string[] | undefined) ?? []).filter((a) => typeof a === 'string' && a.trim());
      const info: PageInfo = {
        id,
        title,
        norm: normalizeTitle(title),
        aliases,
        kind: (m.get('kind') as PageKind) ?? 'note',
        updatedAt: (m.get('updatedAt') as number) ?? 0,
        sourceId: m.get('sourceId') as string | undefined,
      };
      this.meta.set(id, info);
      if (info.norm && !this.nameToPage.has(info.norm)) this.nameToPage.set(info.norm, id);
    }
    // aliases never shadow titles
    for (const info of this.meta.values()) {
      for (const a of info.aliases) {
        const n = normalizeTitle(a);
        if (!n || n === info.norm) continue;
        if (!this.nameToPage.has(n)) this.nameToPage.set(n, info.id);
        if (!this.canonOf.has(n)) this.canonOf.set(n, info.norm);
      }
    }
    for (const [key, value] of this.vault.tagMeta.entries()) {
      if (!key.startsWith('alias:') || typeof value !== 'string') continue;
      const from = key.slice(6);
      const target = normalizeTitle(value);
      if (!from || from === target) continue;
      const canon = this.canonOf.get(target) ?? target;
      if (!this.canonOf.has(from)) this.canonOf.set(from, canon);
      const pid = this.nameToPage.get(canon);
      if (pid && !this.nameToPage.has(from)) this.nameToPage.set(from, pid);
    }
    for (const [alias, canon] of this.canonOf) {
      addTo(this.members, canon, alias);
      addTo(this.members, canon, canon);
    }
  }

  /** Reconciles indexed pages with the registry after a pages / tagMeta change. */
  private syncPages() {
    if (this.destroyed) return;
    this.rebuildNames();
    const changed: string[] = [];
    for (const id of [...this.pages.keys()]) if (!this.meta.has(id)) this.removePage(id);
    for (const id of this.meta.keys()) {
      const rec = this.pages.get(id);
      if (!rec) {
        if (this.ready_ && !this.timers.has(id)) this.track(this.reindexPage(id));
        continue;
      }
      const before = rec.titleKey;
      this.updateTitleDoc(id, rec);
      if (before !== rec.titleKey) changed.push(id);
    }
    this.invalidate();
    this.markChanged(changed);
  }

  /** Canonical normalized form of a concept name (follows page aliases and merged-tag aliases). */
  canonical(name: string): string {
    const n = normalizeTitle(name);
    return this.canonOf.get(n) ?? n;
  }

  /** All normalized names that fold into the same concept as `name`. */
  private namesOf(name: string): Set<string> {
    const canon = this.canonical(name);
    return this.members.get(canon) ?? new Set([canon]);
  }

  /** Page id a `[[name]]` resolves to (title, alias or merged-tag alias), if any. */
  resolvePageId(name: string): string | undefined {
    const n = normalizeTitle(name);
    return this.nameToPage.get(n) ?? this.nameToPage.get(this.canonical(n));
  }

  /** Display title of a page (live). */
  pageTitle(pageId: string): string | undefined {
    return this.meta.get(pageId)?.title;
  }

  // ------------------------------------------------------------------ change events

  private invalidate() {
    this.conceptsCache = null;
    this.graphCache = null;
  }

  private markChanged(pageIds: string[]) {
    for (const id of pageIds) this.changed.add(id);
    if (this.destroyed) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.emitChange();
    }, this.changeDebounceMs);
  }

  private emitChange() {
    const pageIds = [...this.changed];
    this.changed.clear();
    this.onChange.emit({ pageIds });
  }

  // ------------------------------------------------------------------ persistence

  private async loadSnapshot() {
    try {
      const manifest = await this.vault.db.get<SnapManifest>(PERSIST_KEY);
      if (!manifest || manifest.fmt !== PERSIST_FMT || manifest.buckets !== BUCKETS) return;
      const parts = await Promise.all(
        Array.from({ length: BUCKETS }, (_, i) => this.vault.db.get<Record<string, SnapPage>>(`${PERSIST_KEY}:${i}`)),
      );
      for (const part of parts) if (part) for (const [id, p] of Object.entries(part)) this.snapshot.set(id, p);
    } catch (err) {
      console.warn('[axiom] graph index snapshot unreadable, rebuilding', err);
      this.snapshot.clear();
    }
  }

  private schedulePersist(all = false) {
    if (all) for (let i = 0; i < BUCKETS; i++) this.dirtyBuckets.add(i);
    if (this.persistTimer || this.destroyed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistNow();
    }, PERSIST_MS);
  }

  /** Writes dirty snapshot buckets to IndexedDB now. */
  async persistNow(): Promise<void> {
    if (!this.persist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    const dirty = [...this.dirtyBuckets];
    this.dirtyBuckets.clear();
    if (!dirty.length) return;
    const parts = new Map<number, Record<string, SnapPage>>();
    for (const b of dirty) parts.set(b, {});
    for (const [id, rec] of this.pages) {
      const part = parts.get(bucketOf(id));
      if (!part) continue;
      part[id] = { v: rec.version, b: [...rec.blocks.values()].sort((a, b) => a.entry.order - b.entry.order).map(toSnap) };
    }
    try {
      await this.vault.db.set(PERSIST_KEY, { fmt: PERSIST_FMT, buckets: BUCKETS } satisfies SnapManifest);
      for (const [b, part] of parts) await this.vault.db.set(`${PERSIST_KEY}:${b}`, part);
    } catch (err) {
      console.warn('[axiom] graph index persistence failed', err);
    }
  }

  // ------------------------------------------------------------------ queries

  private sortEntries(list: Iterable<MutableEntry>): MutableEntry[] {
    const out = [...list];
    out.sort((a, b) => {
      if (a.pageId !== b.pageId) {
        const d = (this.meta.get(b.pageId)?.updatedAt ?? 0) - (this.meta.get(a.pageId)?.updatedAt ?? 0);
        return d || (a.pageId < b.pageId ? -1 : 1);
      }
      return a.order - b.order;
    });
    return out;
  }

  private collect(names: Set<string>, opts: { links?: boolean; tags?: boolean }): Set<MutableEntry> {
    const out = new Set<MutableEntry>();
    for (const n of names) {
      if (opts.links !== false) for (const e of this.linkRefs.get(n) ?? []) out.add(e);
      if (opts.tags !== false) for (const e of this.tagRefs.get(n) ?? []) out.add(e);
    }
    return out;
  }

  private hit(e: MutableEntry): BlockHit {
    return { pageId: e.pageId, blockId: e.blockId, snippet: e.text.length > 300 ? e.text.slice(0, 300) + '…' : e.text };
  }

  /** Whether the page is indexed (and not trashed). */
  hasPage(pageId: string): boolean {
    return this.pages.has(pageId) && this.meta.has(pageId);
  }

  /** Indexed blocks of a page, in order. */
  pageBlocks(pageId: string): BlockEntry[] {
    const rec = this.pages.get(pageId);
    if (!rec) return [];
    return [...rec.blocks.values()].map((r) => r.entry).sort((a, b) => a.order - b.order);
  }

  getBlock(pageId: string, blockId: string): BlockEntry | undefined {
    return this.pages.get(pageId)?.blocks.get(blockId)?.entry;
  }

  /** Every indexed block (unordered). */
  *allBlocks(): IterableIterator<BlockEntry> {
    for (const rec of this.pages.values()) for (const b of rec.blocks.values()) yield b.entry;
  }

  /** Orders blocks by page `updatedAt` desc, then block order. */
  sortBlocks(list: Iterable<BlockEntry>): BlockEntry[] {
    return this.sortEntries(list as Iterable<MutableEntry>);
  }

  /** Page `updatedAt` from the registry (0 when unknown). */
  pageUpdatedAt(pageId: string): number {
    return this.meta.get(pageId)?.updatedAt ?? 0;
  }

  /** Page ids whose title or aliases normalize to `title` (after alias folding). */
  pagesTitled(title: string): string[] {
    const names = this.namesOf(title);
    const out = new Set<string>();
    for (const n of names) {
      const id = this.nameToPage.get(n);
      if (id) out.add(id);
    }
    return [...out];
  }

  /**
   * Blocks referencing `name` by link, tag and/or embed, folding aliases.
   * With `exact`, only references spelled (normalized) exactly as `name` count.
   */
  blocksReferencing(name: string, opts: { links?: boolean; tags?: boolean; exact?: boolean } = {}): BlockEntry[] {
    const names = opts.exact ? new Set([normalizeTitle(name)]) : this.namesOf(name);
    const set = this.collect(names, opts);
    if (!opts.exact && opts.links !== false) {
      const pid = this.resolvePageId(name);
      if (pid) for (const e of this.embedRefs.get(pid) ?? []) set.add(e);
    }
    return this.sortEntries(set);
  }

  /** Linked references to a page: links / tags / embeds targeting its title or any alias (excluding itself). */
  backlinks(pageId: string): BlockHit[] {
    const info = this.meta.get(pageId);
    if (!info) return [];
    const names = new Set<string>();
    for (const n of [info.title, ...info.aliases]) for (const x of this.namesOf(n)) names.add(x);
    const set = this.collect(names, {});
    for (const e of this.embedRefs.get(pageId) ?? []) set.add(e);
    return this.sortEntries([...set].filter((e) => e.pageId !== pageId)).map((e) => this.hit(e));
  }

  /** Plain-text occurrences of the page title / aliases in blocks that do not already reference it. */
  unlinkedMentions(pageId: string): MentionHit[] {
    const info = this.meta.get(pageId);
    if (!info) return [];
    const linked = new Set(this.backlinks(pageId).map((h) => h.pageId + '\u0000' + h.blockId));
    const found = new Map<MutableEntry, string>();
    for (const phrase of [info.title, ...info.aliases]) {
      const p = phrase.trim();
      if (p.length < 2) continue;
      const words = p.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${words.join('\\s+')}(?![\\p{L}\\p{N}_])`, 'iu');
      for (const doc of this.search_.matchAll(p)) {
        const e = doc.entry;
        if (!e || e.pageId === pageId) continue;
        if (found.has(e) || linked.has(e.pageId + '\u0000' + e.blockId) || !re.test(e.text)) continue;
        found.set(e, p);
      }
    }
    return this.sortEntries(found.keys()).map((e) => ({ ...this.hit(e), phrase: found.get(e)! }));
  }

  /** Blocks carrying `#tag` (aliases folded). */
  blocksWithTag(tag: string): BlockEntry[] {
    return this.blocksReferencing(tag, { links: false });
  }

  /** Pages with at least one block referencing `name`, most recently updated first. */
  pagesLinkingTo(name: string, opts: { exact?: boolean } = {}): string[] {
    const ids = new Set(this.blocksReferencing(name, { exact: opts.exact }).map((e) => e.pageId));
    return [...ids];
  }

  /** Concepts / pages referenced from a page, with reference counts. */
  outgoing(pageId: string): OutgoingRef[] {
    const rec = this.pages.get(pageId);
    if (!rec) return [];
    const counts = new Map<string, number>();
    const bump = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
    const byId = new Map<string, number>();
    for (const { entry } of rec.blocks.values()) {
      for (const n of new Set([...entry.links, ...entry.tags].map((x) => this.canonical(x)))) bump(n);
      if (entry.embedRef) byId.set(entry.embedRef.pageId, (byId.get(entry.embedRef.pageId) ?? 0) + 1);
    }
    const out: OutgoingRef[] = [];
    for (const [n, count] of counts) {
      const pid = this.nameToPage.get(n);
      out.push({ title: (pid && this.meta.get(pid)?.title) || this.display.get(n) || n, normalized: n, pageId: pid, count });
    }
    for (const [pid, count] of byId) {
      const info = this.meta.get(pid);
      if (!info) continue;
      const existing = out.find((o) => o.pageId === pid);
      if (existing) existing.count += count;
      else out.push({ title: info.title, normalized: info.norm, pageId: pid, count });
    }
    return out.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  }

  /** Blocks anchored to a source (wormhole anchors). */
  blocksForSource(sourceId: string): BlockEntry[] {
    return this.sortEntries(this.sourceRefs.get(sourceId) ?? []);
  }

  /** Blocks referencing a block id via `((id))`, `![[Page#^id]]` or an embed block. */
  blockReferences(blockId: string): BlockEntry[] {
    return this.sortEntries(this.blockRefIdx.get(blockId) ?? []);
  }

  /** Blocks marked for spaced repetition, as indexed (plain text). */
  flashcardEntries(): BlockEntry[] {
    return this.sortEntries(this.flashcards);
  }

  /** Flashcard sources with raw (untruncated) markdown read from the page docs. */
  async flashcardBlocks(): Promise<FlashcardSource[]> {
    const byPage = new Map<string, MutableEntry[]>();
    for (const e of this.flashcards) {
      const list = byPage.get(e.pageId);
      if (list) list.push(e);
      else byPage.set(e.pageId, [e]);
    }
    const out: FlashcardSource[] = [];
    for (const [pageId, entries] of byPage) {
      const title = this.meta.get(pageId)?.title ?? '';
      await this.withDoc(pageId, (doc) => {
        const blocks = blocksOf(doc);
        const ids = blockIds(doc);
        for (const e of entries.sort((a, b) => a.order - b.order)) {
          const b = blocks.get(e.blockId);
          if (!b) continue;
          const anchor = blockAnchor(b);
          let contextText = anchor?.quote;
          if (!contextText) {
            const idx = ids.indexOf(e.blockId);
            for (let i = idx - 1; i >= 0 && !contextText; i--) {
              const prev = blocks.get(ids[i]);
              if (prev && blockType(prev) === 'text') contextText = plainText(blockPlainText(prev)).slice(0, 300) || undefined;
            }
          }
          out.push({ pageId, blockId: e.blockId, type: blockType(b), text: blockPlainText(b), pageTitle: title, contextText });
        }
      });
    }
    return out;
  }

  /** Runs `fn` with the page doc: the live doc if loaded, else a throwaway doc built from storage. */
  private async withDoc(pageId: string, fn: (doc: Y.Doc) => void): Promise<void> {
    const live = this.vault.store.getLoaded(pageId);
    if (live) return fn(live);
    const state = await this.vault.store.getState(pageId);
    if (!state) return;
    const doc = new Y.Doc({ guid: pageId });
    try {
      Y.applyUpdate(doc, state);
      fn(doc);
    } finally {
      doc.destroy();
    }
  }

  /** Every link / tag target with usage counts, plus concept pages (aliases folded). */
  concepts(): ConceptInfo[] {
    if (this.conceptsCache) return this.conceptsCache;
    const blocksBy = new Map<string, Set<MutableEntry>>();
    const fold = (map: Map<string, Set<MutableEntry>>) => {
      for (const [n, set] of map) {
        const c = this.canonOf.get(n) ?? n;
        let s = blocksBy.get(c);
        if (!s) blocksBy.set(c, (s = new Set()));
        for (const e of set) s.add(e);
      }
    };
    fold(this.linkRefs);
    fold(this.tagRefs);
    for (const [pid, set] of this.embedRefs) {
      const info = this.meta.get(pid);
      if (!info) continue;
      let s = blocksBy.get(info.norm);
      if (!s) blocksBy.set(info.norm, (s = new Set()));
      for (const e of set) s.add(e);
    }
    for (const info of this.meta.values()) if (info.kind === 'concept' && !blocksBy.has(info.norm)) blocksBy.set(info.norm, new Set());
    const out: ConceptInfo[] = [];
    for (const [n, set] of blocksBy) {
      const pageId = this.nameToPage.get(n);
      const title = (pageId && this.meta.get(pageId)?.title) || this.display.get(n) || n;
      out.push({ title, normalized: n, count: set.size, pageId });
    }
    out.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    this.conceptsCache = out;
    return out;
  }

  /** Graph of pages and concepts; edges are page → page/concept references, deduplicated and weighted. */
  graph(): GraphData {
    if (this.graphCache) return this.graphCache;
    const nodes = new Map<string, GraphNode>();
    for (const info of this.meta.values()) {
      const kind: GraphNodeKind = info.kind === 'daily' ? 'daily' : info.kind === 'concept' ? 'concept' : 'page';
      nodes.set(info.id, { id: info.id, title: info.title, kind, weight: 1, pageId: info.id });
    }
    const links = new Map<string, GraphLink>();
    const addLink = (source: string, target: string) => {
      if (source === target) return;
      const key = source + '\u0000' + target;
      const l = links.get(key);
      if (l) l.weight++;
      else links.set(key, { source, target, weight: 1 });
    };
    const targetOf = (n: string): string => {
      const c = this.canonOf.get(n) ?? n;
      const pid = this.nameToPage.get(c) ?? this.nameToPage.get(n);
      if (pid && nodes.has(pid)) return pid;
      const id = 'concept:' + c;
      if (!nodes.has(id)) nodes.set(id, { id, title: this.display.get(c) ?? this.display.get(n) ?? c, kind: 'concept', weight: 1 });
      return id;
    };
    for (const [pageId, rec] of this.pages) {
      if (!nodes.has(pageId)) continue;
      for (const { entry } of rec.blocks.values()) {
        const targets = new Set<string>();
        for (const n of entry.links) targets.add(targetOf(n));
        for (const n of entry.tags) targets.add(targetOf(n));
        if (entry.embedRef && nodes.has(entry.embedRef.pageId)) targets.add(entry.embedRef.pageId);
        for (const t of targets) addLink(pageId, t);
      }
    }
    for (const l of links.values()) {
      nodes.get(l.source)!.weight += l.weight;
      nodes.get(l.target)!.weight += l.weight;
    }
    this.graphCache = { nodes: [...nodes.values()], links: [...links.values()] };
    return this.graphCache;
  }

  /**
   * Full-text search over page titles/aliases (boosted) and block text. BM25 ranking,
   * prefix matching on the last token, one-edit fuzzy fallback for tokens ≥ 5 chars.
   */
  search(query: string, opts: { limit?: number } = {}): SearchResult[] {
    const hits = this.search_.search(query, opts.limit ?? 20);
    const out: SearchResult[] = [];
    for (const h of hits) {
      const info = this.meta.get(h.payload.pageId);
      if (!info) continue;
      const e = h.payload.entry;
      if (!e) {
        const titleText = [info.title, ...info.aliases].join(' · ');
        const { snippet, highlights } = makeSnippet(titleText, h.terms);
        const exact = normalizeTitle(query) === info.norm;
        out.push({ pageId: info.id, title: info.title, snippet, score: exact ? h.score * 2 : h.score, highlights });
      } else {
        const { snippet, highlights } = makeSnippet(e.text, h.terms);
        out.push({ pageId: e.pageId, blockId: e.blockId, title: info.title, snippet, score: h.score, highlights });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Blocks whose text contains every term of `text` (prefix match per term when `prefix`). */
  matchText(text: string, opts: { prefix?: boolean } = {}): BlockEntry[] {
    const out: BlockEntry[] = [];
    for (const d of this.search_.matchAll(text, opts)) if (d.entry) out.push(d.entry);
    return out;
  }
}
