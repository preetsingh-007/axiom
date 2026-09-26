import * as Y from 'yjs';
import { AxiomDB } from './storage/idb';
import { DocStore, LOCAL_ORIGIN } from './storage/docstore';
import {
  INDEX_DOC_ID,
  type CardRecord,
  type Highlight,
  type Lens,
  type PageKind,
  type PageMeta,
  type SourceMeta,
  type ViewState,
} from './schema';
import { conceptPageId, dailyPageId, isoDate, normalizeTitle, uid, bytesHash } from './util/ids';
import { insertBlock } from './blocks';

export type YMeta = Y.Map<unknown>;

/**
 * The vault facade: typed access to the index doc, page lifecycle and blob storage.
 * Everything else (sync, indexing, SRS, AI) hangs off a Vault instance.
 */
export class Vault {
  private constructor(
    readonly name: string,
    readonly db: AxiomDB,
    readonly store: DocStore,
    readonly index: Y.Doc,
  ) {}

  static async open(name = 'axiom-default'): Promise<Vault> {
    const db = await AxiomDB.open(name);
    const store = new DocStore(db);
    const index = await store.open(INDEX_DOC_ID);
    store.retain(INDEX_DOC_ID);
    return new Vault(name, db, store, index);
  }

  async close() {
    await this.store.destroy();
    this.db.close();
  }

  // ---------- index doc collections ----------

  get pages(): Y.Map<YMeta> {
    return this.index.getMap<YMeta>('pages');
  }
  get sources(): Y.Map<YMeta> {
    return this.index.getMap<YMeta>('sources');
  }
  get viewStates(): Y.Map<ViewState> {
    return this.index.getMap<ViewState>('viewStates');
  }
  /**
   * Highlights, flat: key `${sourceId}|${highlightId}`. (A nested Y.Array per source would be
   * created independently on two offline devices opening the same PDF, and Yjs would keep only
   * one of them.)
   */
  get highlights(): Y.Map<Highlight> {
    return this.index.getMap<Highlight>('hl');
  }
  get cards(): Y.Map<CardRecord> {
    return this.index.getMap<CardRecord>('cards');
  }
  get reviewLog(): Y.Array<unknown> {
    return this.index.getArray('reviewLog');
  }
  get lenses(): Y.Map<Lens> {
    return this.index.getMap<Lens>('lenses');
  }
  /** tag aliases (merged tag -> canonical) and dismissed merge suggestions */
  get tagMeta(): Y.Map<unknown> {
    return this.index.getMap('tagMeta');
  }
  /** synced, non-secret settings */
  get settings(): Y.Map<unknown> {
    return this.index.getMap('settings');
  }

  transact(fn: () => void) {
    this.index.transact(fn, LOCAL_ORIGIN);
  }

  // ---------- pages ----------

  getPage(id: string): PageMeta | undefined {
    const m = this.pages.get(id);
    return m ? (m.toJSON() as PageMeta) : undefined;
  }

  listPages(includeTrashed = false): PageMeta[] {
    const out: PageMeta[] = [];
    for (const m of this.pages.values()) {
      const p = m.toJSON() as PageMeta;
      if (!includeTrashed && p.trashed) continue;
      out.push(p);
    }
    return out;
  }

  findPageByTitle(title: string): PageMeta | undefined {
    const key = normalizeTitle(title);
    const direct = this.getPage(conceptPageId(title));
    if (direct && !direct.trashed) return direct;
    for (const m of this.pages.values()) {
      const t = m.get('title') as string;
      if (normalizeTitle(t) === key && !m.get('trashed')) return m.toJSON() as PageMeta;
      const aliases = m.get('aliases') as string[] | undefined;
      if (aliases?.some((a) => normalizeTitle(a) === key) && !m.get('trashed')) return m.toJSON() as PageMeta;
    }
    return undefined;
  }

  createPage(opts: { title: string; kind?: PageKind; id?: string; date?: string; sourceId?: string }): string {
    const id = opts.id ?? 'p-' + uid(10);
    if (this.pages.has(id)) {
      const m = this.pages.get(id)!;
      if (m.get('trashed')) this.transact(() => m.delete('trashed'));
      return id;
    }
    const now = Date.now();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('title', opts.title);
      m.set('kind', opts.kind ?? 'note');
      m.set('createdAt', now);
      m.set('updatedAt', now);
      if (opts.date) m.set('date', opts.date);
      if (opts.sourceId) m.set('sourceId', opts.sourceId);
      this.pages.set(id, m);
    });
    return id;
  }

  /** Daily pages have deterministic ids so offline devices converge on the same page. */
  ensureDaily(date = isoDate()): string {
    return this.createPage({ id: dailyPageId(date), title: date, kind: 'daily', date });
  }

  /** Resolves a [[link]] target, creating a concept page (deterministic id) if needed. */
  ensureConcept(title: string): string {
    const existing = this.findPageByTitle(title);
    if (existing) return existing.id;
    return this.createPage({ id: conceptPageId(title), title: title.trim(), kind: 'concept' });
  }

  updatePage(id: string, patch: Partial<Omit<PageMeta, 'id'>>) {
    const m = this.pages.get(id);
    if (!m) return;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) m.delete(k);
        else m.set(k, v);
      }
      m.set('updatedAt', Date.now());
    });
  }

  touchPage(id: string) {
    const m = this.pages.get(id);
    if (!m) return;
    const now = Date.now();
    // avoid flooding the index doc: at most one touch per 30s per page
    if (now - ((m.get('updatedAt') as number) ?? 0) < 30_000) return;
    this.transact(() => m.set('updatedAt', now));
  }

  trashPage(id: string) {
    this.updatePage(id, { trashed: true });
  }

  /** Opens a page doc and pins it in memory. Call the returned release() when done. */
  async openPage(id: string): Promise<{ doc: Y.Doc; release: () => void }> {
    const doc = await this.store.open(id);
    this.store.retain(id);
    let released = false;
    return {
      doc,
      release: () => {
        if (released) return;
        released = true;
        this.store.release(id);
      },
    };
  }

  /** Makes sure a page has at least one block (an empty text block) so it is editable. */
  ensureNonEmpty(doc: Y.Doc) {
    if (doc.getArray('order').length === 0) insertBlock(doc, { type: 'text', text: '' });
  }

  // ---------- sources ----------

  getSource(id: string): SourceMeta | undefined {
    const m = this.sources.get(id);
    return m ? (m.toJSON() as SourceMeta) : undefined;
  }

  listSources(): SourceMeta[] {
    return [...this.sources.values()].map((m) => m.toJSON() as SourceMeta);
  }

  putSource(meta: SourceMeta) {
    this.transact(() => {
      let m = this.sources.get(meta.id);
      if (!m) {
        m = new Y.Map<unknown>();
        this.sources.set(meta.id, m);
      }
      for (const [k, v] of Object.entries(meta)) if (v !== undefined) m.set(k, v);
    });
  }

  updateSource(id: string, patch: Partial<SourceMeta>) {
    const m = this.sources.get(id);
    if (!m) return;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) m.delete(k);
        else m.set(k, v);
      }
    });
  }

  /** Removes a source; returns what is needed to undo it (metadata, reading state, highlights). */
  removeSource(id: string): { meta?: SourceMeta; view?: ViewState; highlights: Highlight[] } {
    const snapshot = { meta: this.getSource(id), view: this.viewStates.get(id), highlights: this.highlightsFor(id) };
    this.transact(() => {
      this.sources.delete(id);
      this.viewStates.delete(id);
      for (const h of snapshot.highlights) this.highlights.delete(`${id}|${h.id}`);
    });
    return snapshot;
  }

  restoreSource(snapshot: { meta?: SourceMeta; view?: ViewState; highlights: Highlight[] }) {
    if (!snapshot.meta) return;
    const id = snapshot.meta.id;
    this.putSource(snapshot.meta);
    this.transact(() => {
      if (snapshot.view) this.viewStates.set(id, snapshot.view);
      for (const h of snapshot.highlights) this.highlights.set(`${id}|${h.id}`, h);
    });
  }

  getViewState(sourceId: string): ViewState | undefined {
    return this.viewStates.get(sourceId);
  }

  setViewState(sourceId: string, vs: ViewState) {
    this.transact(() => this.viewStates.set(sourceId, vs));
  }

  /** Highlights of one source (read-only; never writes to the CRDT). */
  highlightsFor(sourceId: string): Highlight[] {
    const out: Highlight[] = [];
    const prefix = sourceId + '|';
    for (const [k, h] of this.highlights) if (k.startsWith(prefix)) out.push(h);
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  addHighlight(h: Highlight) {
    this.transact(() => this.highlights.set(`${h.sourceId}|${h.id}`, h));
  }

  removeHighlight(sourceId: string, id: string) {
    this.transact(() => this.highlights.delete(`${sourceId}|${id}`));
  }

  // ---------- blobs ----------

  /** Stores a blob content-addressed; returns its id. */
  async putBlob(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = 'b-' + bytesHash(bytes);
    if (!(await this.db.hasBlob(id))) await this.db.putBlob(id, blob);
    return id;
  }

  getBlob(id: string): Promise<Blob | undefined> {
    return this.db.getBlob(id);
  }

  private urlCache = new Map<string, Promise<string | undefined>>();

  /** Object URL for a blob (cached for the session). */
  blobUrl(id: string): Promise<string | undefined> {
    let p = this.urlCache.get(id);
    if (!p) {
      p = this.getBlob(id).then((b) => (b ? URL.createObjectURL(b) : undefined));
      this.urlCache.set(id, p);
      p.then((u) => {
        if (!u) this.urlCache.delete(id);
      });
    }
    return p;
  }

  // ---------- local-only settings (never synced / committed) ----------

  getLocal<T>(key: string): Promise<T | undefined> {
    return this.db.get<T>('local:' + key);
  }

  setLocal(key: string, value: unknown): Promise<void> {
    return this.db.set('local:' + key, value);
  }
}
