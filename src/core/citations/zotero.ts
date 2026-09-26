/**
 * Zotero Web API v3: client, item mapping and two-way sync.
 *
 * Sync model
 *  - `twoWaySync` is a PURE planner: given local sources, the remote items that
 *    changed since `state.lastVersion` and the persisted state, it returns what
 *    to write where. Remote edits win for fields Zotero has; fields only Axiom
 *    knows (DOI, abstract…) are pushed to Zotero to fill gaps; local sources
 *    edited since the last sync (`updatedAt > lastSyncAt`) whose remote item did
 *    not change push their fields to Zotero.
 *  - Matching: existing link (bib.zoteroKey / state.links) → DOI → normalised
 *    title + year. The state caches a small index (DOI / title-year per remote
 *    key) so incremental syncs can still match against unchanged remote items
 *    and never create duplicates.
 *  - `syncZotero` executes a plan against the API.
 */
import type { BibMeta } from '../schema';
import { fetchWithTimeout, HttpError, type HttpOptions } from './http';
import { bibEqual, mergeBib, missingFields, normalizeDoi, titleYearKey } from './match';

// ------------------------------------------------------------------ types

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItemData {
  key?: string;
  version?: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  publicationTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  bookTitle?: string;
  publisher?: string;
  university?: string;
  institution?: string;
  repository?: string;
  archiveID?: string;
  websiteTitle?: string;
  extra?: string;
  tags?: { tag: string; type?: number }[];
  collections?: string[];
  relations?: Record<string, string | string[]>;
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
}

export interface ZoteroConfig {
  apiKey: string;
  /** numeric user id (see zotero.org/settings/keys) — or groupId */
  userId?: string | number;
  groupId?: string | number;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// ------------------------------------------------------------------ mapping

const TYPE_TO_ZOTERO: Record<string, string> = {
  article: 'journalArticle',
  inproceedings: 'conferencePaper',
  conference: 'conferencePaper',
  proceedings: 'book',
  book: 'book',
  inbook: 'bookSection',
  incollection: 'bookSection',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  online: 'webpage',
  misc: 'document',
  unpublished: 'manuscript',
  manual: 'document',
  booklet: 'book',
};

const ZOTERO_TO_TYPE: Record<string, string> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  conferencePaper: 'inproceedings',
  book: 'book',
  bookSection: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  preprint: 'misc',
  webpage: 'online',
  blogPost: 'online',
  manuscript: 'unpublished',
  document: 'misc',
  presentation: 'misc',
  dataset: 'misc',
  computerProgram: 'misc',
};

/** item types that have a DOI field (others get "DOI: …" in Extra) */
const HAS_DOI = new Set(['journalArticle', 'conferencePaper', 'preprint', 'dataset', 'report', 'book', 'bookSection', 'thesis']);
const VENUE_FIELD: Record<string, string> = {
  journalArticle: 'publicationTitle',
  magazineArticle: 'publicationTitle',
  newspaperArticle: 'publicationTitle',
  conferencePaper: 'proceedingsTitle',
  bookSection: 'bookTitle',
  thesis: 'university',
  report: 'institution',
  preprint: 'repository',
  webpage: 'websiteTitle',
};
const HAS_PUBLISHER = new Set(['book', 'bookSection', 'conferencePaper', 'document', 'dataset']);

function extraField(extra: string | undefined, name: string): string | undefined {
  if (!extra) return undefined;
  const m = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'im').exec(extra);
  return m?.[1];
}

/** Zotero item → BibMeta (sets zoteroKey). */
export function zoteroToMeta(item: ZoteroItem | ZoteroItemData): BibMeta {
  const data: ZoteroItemData = 'data' in item && item.data ? (item as ZoteroItem).data : (item as ZoteroItemData);
  const key = 'data' in item && (item as ZoteroItem).key ? (item as ZoteroItem).key : data.key;
  const meta: BibMeta = {};
  if (data.title) meta.title = data.title.trim();
  const people = (data.creators ?? []).filter((c) => c.creatorType === 'author');
  const list = people.length ? people : (data.creators ?? []).filter((c) => c.creatorType === 'editor');
  const authors = list.map((c) => (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).trim()).filter(Boolean);
  if (authors.length) meta.authors = authors;
  const y = /(\d{4})/.exec(data.date ?? '');
  if (y) meta.year = Number(y[1]);
  const venue =
    data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.conferenceName || data.university || data.institution || data.websiteTitle || data.repository;
  if (venue) meta.venue = String(venue);
  const doi = normalizeDoi(data.DOI) ?? normalizeDoi(extraField(data.extra, 'DOI'));
  if (doi) meta.doi = doi;
  const arxiv =
    /arxiv:\s*(\S+)/i.exec(data.archiveID ?? '')?.[1] ??
    extraField(data.extra, 'arXiv') ??
    /arxiv\.org\/abs\/([^\s?#]+)/i.exec(data.url ?? '')?.[1];
  if (arxiv) meta.arxiv = arxiv;
  if (data.url) meta.url = data.url;
  if (data.publisher) meta.publisher = data.publisher;
  if (data.abstractNote) meta.abstract = data.abstractNote;
  meta.entryType = ZOTERO_TO_TYPE[data.itemType] ?? 'misc';
  const ck = extraField(data.extra, 'Citation Key');
  if (ck) meta.bibKey = ck;
  if (key) meta.zoteroKey = key;
  return meta;
}

function splitCreator(name: string): ZoteroCreator {
  const n = name.trim();
  if (n.includes(',')) {
    const [last, first] = n.split(/\s*,\s*/, 2);
    return { creatorType: 'author', firstName: first ?? '', lastName: last };
  }
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { creatorType: 'author', name: n };
  return { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** BibMeta → Zotero item data (only fields valid for the chosen item type). */
export function metaToZotero(meta: BibMeta, itemTypeOverride?: string): ZoteroItemData {
  const itemType = itemTypeOverride ?? (meta.arxiv && !meta.doi ? 'preprint' : (TYPE_TO_ZOTERO[(meta.entryType ?? '').toLowerCase()] ?? 'journalArticle'));
  const data: ZoteroItemData = { itemType };
  const extra: string[] = [];
  Object.assign(data, metaToZoteroFields(meta, itemType, extra));
  if (meta.bibKey) extra.push(`Citation Key: ${meta.bibKey}`);
  if (extra.length) data.extra = extra.join('\n');
  return data;
}

function metaToZoteroFields(meta: Partial<BibMeta>, itemType: string, extra: string[]): Partial<ZoteroItemData> {
  const d: Partial<ZoteroItemData> = {};
  if (meta.title) d.title = meta.title;
  if (meta.authors?.length) d.creators = meta.authors.map(splitCreator);
  if (meta.year) d.date = String(meta.year);
  if (meta.doi) {
    if (HAS_DOI.has(itemType)) d.DOI = meta.doi;
    else extra.push(`DOI: ${meta.doi}`);
  }
  if (meta.url) d.url = meta.url;
  if (meta.abstract) d.abstractNote = meta.abstract;
  if (meta.venue) {
    const f = VENUE_FIELD[itemType];
    if (f) d[f] = meta.venue;
  }
  if (meta.publisher && HAS_PUBLISHER.has(itemType)) d.publisher = meta.publisher;
  if (meta.arxiv) {
    if (itemType === 'preprint') {
      d.archiveID = `arXiv:${meta.arxiv}`;
      if (!d.repository) d.repository = 'arXiv';
    } else extra.push(`arXiv: ${meta.arxiv}`);
  }
  return d;
}

/** Patch for an existing item that only sets the given fields (appends to Extra, never clobbers it). */
export function metaToZoteroPatch(fields: Partial<BibMeta>, current: ZoteroItemData): Partial<ZoteroItemData> {
  const extra: string[] = [];
  const patch = metaToZoteroFields(fields, current.itemType, extra);
  const existing = current.extra ?? '';
  const fresh = extra.filter((line) => !existing.includes(line));
  if (fresh.length) patch.extra = [existing, ...fresh].filter(Boolean).join('\n');
  return patch;
}

// ------------------------------------------------------------------ client

function writeToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CreateResult {
  key?: string;
  version?: number;
  error?: string;
}

export class ZoteroClient {
  private readonly base: string;
  private readonly prefix: string;

  constructor(private readonly cfg: ZoteroConfig) {
    if (!cfg.apiKey) throw new Error('Zotero API key is required');
    if (cfg.userId == null && cfg.groupId == null) throw new Error('Zotero userId or groupId is required');
    this.base = (cfg.baseUrl ?? 'https://api.zotero.org').replace(/\/$/, '');
    this.prefix = cfg.groupId != null ? `/groups/${cfg.groupId}` : `/users/${cfg.userId}`;
  }

  private async request(path: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Zotero-API-Key', this.cfg.apiKey);
    headers.set('Zotero-API-Version', '3');
    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithTimeout(`${this.base}${this.prefix}${path}`, { ...init, headers }, {
        fetch: this.cfg.fetch,
        timeoutMs: this.cfg.timeoutMs,
        ...opts,
      });
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        const wait = Number(res.headers.get('Retry-After') ?? res.headers.get('Backoff') ?? 2);
        await sleep(Math.min(30, Number.isFinite(wait) ? wait : 2) * 1000);
        continue;
      }
      return res;
    }
  }

  /**
   * Top-level regular items (no notes/attachments), all pages. With `since`,
   * only items modified after that library version; `notModified` is true
   * when nothing changed (HTTP 304).
   */
  async listItems(opts: { since?: number; signal?: AbortSignal; pageSize?: number } = {}): Promise<{ items: ZoteroItem[]; libraryVersion: number; notModified: boolean }> {
    const limit = Math.min(100, opts.pageSize ?? 100);
    const items: ZoteroItem[] = [];
    let start = 0;
    let libraryVersion = opts.since ?? 0;
    for (;;) {
      const q = new URLSearchParams({ format: 'json', limit: String(limit), start: String(start) });
      if (opts.since) q.set('since', String(opts.since));
      const headers: Record<string, string> = {};
      if (opts.since && start === 0) headers['If-Modified-Since-Version'] = String(opts.since);
      const res = await this.request(`/items/top?${q.toString()}`, { headers }, { signal: opts.signal });
      if (res.status === 304) return { items: [], libraryVersion: opts.since ?? 0, notModified: true };
      if (!res.ok) throw new HttpError(res.status, `Zotero: listing items failed (${res.status})`, res);
      const v = Number(res.headers.get('Last-Modified-Version'));
      if (Number.isFinite(v) && v > 0) libraryVersion = v;
      const page = (await res.json()) as ZoteroItem[];
      for (const it of page) if (it.data && it.data.itemType !== 'note' && it.data.itemType !== 'attachment' && it.data.itemType !== 'annotation') items.push(it);
      start += page.length;
      const total = Number(res.headers.get('Total-Results'));
      if (page.length < limit || (Number.isFinite(total) && start >= total) || page.length === 0) break;
    }
    return { items, libraryVersion, notModified: false };
  }

  /** Keys of items deleted since a library version. */
  async getDeleted(since: number, signal?: AbortSignal): Promise<string[]> {
    const res = await this.request(`/deleted?since=${since}`, {}, { signal });
    if (!res.ok) throw new HttpError(res.status, `Zotero: deleted query failed (${res.status})`, res);
    const json = (await res.json()) as { items?: string[] };
    return json.items ?? [];
  }

  /** Creates items (batches of 50). Results align with the input. */
  async createItems(datas: ZoteroItemData[], signal?: AbortSignal): Promise<CreateResult[]> {
    const out: CreateResult[] = [];
    for (let i = 0; i < datas.length; i += 50) {
      const batch = datas.slice(i, i + 50);
      const res = await this.request(
        '/items',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Zotero-Write-Token': writeToken() }, body: JSON.stringify(batch) },
        { signal },
      );
      if (!res.ok) throw new HttpError(res.status, `Zotero: creating items failed (${res.status})`, res);
      const json = (await res.json()) as {
        successful?: Record<string, { key: string; version: number }>;
        success?: Record<string, string>;
        unchanged?: Record<string, string>;
        failed?: Record<string, { code?: number; message?: string }>;
      };
      batch.forEach((_, j) => {
        const k = String(j);
        const ok = json.successful?.[k];
        if (ok) out.push({ key: ok.key, version: ok.version });
        else if (json.success?.[k]) out.push({ key: json.success[k] });
        else if (json.unchanged?.[k]) out.push({ key: json.unchanged[k] });
        else out.push({ error: json.failed?.[k]?.message ?? 'unknown error' });
      });
    }
    return out;
  }

  /** PATCHes an item; resolves the new version, or null on a version conflict (412). */
  async updateItem(key: string, version: number, patch: Partial<ZoteroItemData>, signal?: AbortSignal): Promise<number | null> {
    const res = await this.request(
      `/items/${encodeURIComponent(key)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Unmodified-Since-Version': String(version) }, body: JSON.stringify(patch) },
      { signal },
    );
    if (res.status === 412) return null;
    if (!res.ok) throw new HttpError(res.status, `Zotero: updating ${key} failed (${res.status})`, res);
    const v = Number(res.headers.get('Last-Modified-Version'));
    return Number.isFinite(v) ? v : version;
  }
}

// ------------------------------------------------------------------ sync planning (pure)

export interface ZoteroIndexEntry {
  doi?: string;
  /** normalised title|year */
  ty?: string;
  /** item version */
  v?: number;
}

export interface ZoteroSyncState {
  /** library version of the last successful read */
  lastVersion: number;
  /** local source id → Zotero item key */
  links: Record<string, string>;
  /** cached remote matching index: key → identifiers */
  index: Record<string, ZoteroIndexEntry>;
  /** ms timestamp of the last sync */
  lastSyncAt?: number;
}

export const emptyZoteroState = (): ZoteroSyncState => ({ lastVersion: 0, links: {}, index: {} });

export interface LocalBibSource {
  id: string;
  bib?: BibMeta;
  /** fallback title when bib.title is missing */
  title?: string;
  /** ms timestamp of the last local metadata edit */
  updatedAt?: number;
}

export interface ZoteroSyncInput {
  /** items changed since state.lastVersion (all items on the first sync) */
  remoteItems: ZoteroItem[];
  /** Last-Modified-Version of that listing */
  remoteVersion: number;
  /** keys deleted remotely since state.lastVersion */
  deletedKeys?: string[];
  /** create Zotero items for unmatched local sources (default true) */
  createRemote?: boolean;
  now?: number;
}

export interface ZoteroSyncPlan {
  /** merged metadata to write into local sources */
  toUpdateLocal: { sourceId: string; bib: BibMeta }[];
  /** new Zotero items for local sources */
  toCreateRemote: { sourceId: string; data: ZoteroItemData }[];
  /** field patches for existing Zotero items */
  toUpdateRemote: { sourceId: string; key: string; version: number; patch: Partial<ZoteroItemData> }[];
  /** changed remote items not linked to any local source (references without files) */
  remoteOnly: BibMeta[];
  /** local sources whose Zotero item was deleted remotely */
  unlinked: string[];
  newVersion: number;
  /** state to persist once the plan has been applied */
  state: ZoteroSyncState;
}

const PUSH_FIELDS: (keyof BibMeta)[] = ['title', 'authors', 'year', 'venue', 'doi', 'arxiv', 'url', 'publisher', 'abstract'];

function localBib(s: LocalBibSource): BibMeta {
  const b = { ...(s.bib ?? {}) };
  if (!b.title && s.title) b.title = s.title;
  return b;
}

/** Pure two-way sync planner. */
export function twoWaySync(localSources: LocalBibSource[], input: ZoteroSyncInput, state: ZoteroSyncState = emptyZoteroState()): ZoteroSyncPlan {
  const deleted = new Set(input.deletedKeys ?? []);
  const links: Record<string, string> = {};
  for (const [sid, key] of Object.entries(state.links)) if (!deleted.has(key)) links[sid] = key;
  const index: Record<string, ZoteroIndexEntry> = {};
  for (const [k, v] of Object.entries(state.index)) if (!deleted.has(k)) index[k] = v;
  const remoteByKey = new Map<string, ZoteroItem>();
  const remoteMeta = new Map<string, BibMeta>();
  for (const it of input.remoteItems) {
    remoteByKey.set(it.key, it);
    const m = zoteroToMeta(it);
    remoteMeta.set(it.key, m);
    index[it.key] = { doi: normalizeDoi(m.doi), ty: titleYearKey(m), v: it.version };
  }
  const byDoi = new Map<string, string>();
  const byTy = new Map<string, string>();
  for (const [k, e] of Object.entries(index)) {
    if (e.doi && !byDoi.has(e.doi)) byDoi.set(e.doi, k);
    if (e.ty && !byTy.has(e.ty)) byTy.set(e.ty, k);
  }
  const claimed = new Set<string>();
  for (const s of localSources) {
    const k = s.bib?.zoteroKey ?? links[s.id];
    if (k && !deleted.has(k)) claimed.add(k);
  }

  const plan: ZoteroSyncPlan = {
    toUpdateLocal: [],
    toCreateRemote: [],
    toUpdateRemote: [],
    remoteOnly: [],
    unlinked: [],
    newVersion: Math.max(input.remoteVersion || 0, state.lastVersion || 0),
    state: { lastVersion: 0, links, index, lastSyncAt: input.now ?? Date.now() },
  };
  plan.state.lastVersion = plan.newVersion;

  for (const src of localSources) {
    const local = localBib(src);
    let key = src.bib?.zoteroKey ?? links[src.id];
    if (key && deleted.has(key)) {
      plan.unlinked.push(src.id);
      delete links[src.id];
      const cleared = { ...local };
      delete cleared.zoteroKey;
      if (src.bib?.zoteroKey) plan.toUpdateLocal.push({ sourceId: src.id, bib: cleared });
      continue;
    }
    if (!key) {
      const doi = normalizeDoi(local.doi);
      const ty = titleYearKey(local);
      const cand = (doi && byDoi.get(doi)) || (ty && byTy.get(ty)) || undefined;
      if (cand && !claimed.has(cand)) {
        key = cand;
        claimed.add(cand);
      }
    }
    if (!key) {
      if (input.createRemote !== false && local.title) plan.toCreateRemote.push({ sourceId: src.id, data: metaToZotero(local) });
      continue;
    }
    links[src.id] = key;
    const remote = remoteByKey.get(key);
    if (remote) {
      // remote changed since the last sync: remote wins for the fields it has
      const rm = remoteMeta.get(key)!;
      const merged = mergeBib(local, rm, 'incoming', ['bibKey', 'entryType']);
      merged.zoteroKey = key;
      if (!bibEqual(merged, src.bib)) plan.toUpdateLocal.push({ sourceId: src.id, bib: merged });
      const gaps = missingFields(local, rm, PUSH_FIELDS);
      if (Object.keys(gaps).length) {
        const patch = metaToZoteroPatch(gaps, remote.data);
        if (Object.keys(patch).length) plan.toUpdateRemote.push({ sourceId: src.id, key, version: remote.version, patch });
      }
    } else {
      const entry = index[key];
      const editedLocally = src.updatedAt !== undefined && state.lastSyncAt !== undefined && src.updatedAt > state.lastSyncAt;
      if (editedLocally && entry?.v !== undefined) {
        const fields: Partial<BibMeta> = {};
        for (const f of PUSH_FIELDS) if (local[f] !== undefined) (fields as Record<string, unknown>)[f] = local[f];
        const patch = metaToZoteroPatch(fields, { itemType: (TYPE_TO_ZOTERO[(local.entryType ?? '').toLowerCase()] ?? 'journalArticle') });
        delete patch.extra; // unknown current Extra: never overwrite it blindly
        if (Object.keys(patch).length) plan.toUpdateRemote.push({ sourceId: src.id, key, version: entry.v, patch });
      }
      if (src.bib?.zoteroKey !== key) plan.toUpdateLocal.push({ sourceId: src.id, bib: { ...local, zoteroKey: key } });
    }
  }
  const linkedKeys = new Set(Object.values(links));
  for (const it of input.remoteItems) if (!linkedKeys.has(it.key)) plan.remoteOnly.push(remoteMeta.get(it.key)!);
  return plan;
}

// ------------------------------------------------------------------ executor

export interface SyncZoteroOptions {
  /** write merged metadata into local sources (e.g. vault.updateSource(id, { bib })) */
  applyLocal: (updates: { sourceId: string; bib: BibMeta }[]) => void | Promise<void>;
  createRemote?: boolean;
  signal?: AbortSignal;
}

export interface SyncZoteroResult {
  state: ZoteroSyncState;
  plan: ZoteroSyncPlan;
  created: number;
  updatedRemote: number;
  conflicts: number;
  errors: string[];
}

/** Runs one incremental two-way sync. Persist `result.state` for the next run. */
export async function syncZotero(
  client: ZoteroClient,
  localSources: LocalBibSource[],
  state: ZoteroSyncState = emptyZoteroState(),
  opts: SyncZoteroOptions,
): Promise<SyncZoteroResult> {
  const { signal } = opts;
  const since = state.lastVersion || 0;
  const deletedKeys = since ? await client.getDeleted(since, signal) : [];
  const listing = await client.listItems({ since: since || undefined, signal });
  const plan = twoWaySync(
    localSources,
    { remoteItems: listing.items, remoteVersion: listing.libraryVersion, deletedKeys, createRemote: opts.createRemote },
    state,
  );
  const errors: string[] = [];
  const localUpdates = new Map(plan.toUpdateLocal.map((u) => [u.sourceId, u.bib]));

  let created = 0;
  if (plan.toCreateRemote.length) {
    const results = await client.createItems(
      plan.toCreateRemote.map((c) => c.data),
      signal,
    );
    results.forEach((r, i) => {
      const { sourceId, data } = plan.toCreateRemote[i];
      if (!r.key) {
        errors.push(`${sourceId}: ${r.error ?? 'create failed'}`);
        return;
      }
      created++;
      plan.state.links[sourceId] = r.key;
      const m = zoteroToMeta({ key: r.key, version: r.version ?? 0, data });
      plan.state.index[r.key] = { doi: normalizeDoi(m.doi), ty: titleYearKey(m), v: r.version };
      const src = localSources.find((s) => s.id === sourceId);
      const base = localUpdates.get(sourceId) ?? localBib(src ?? { id: sourceId });
      localUpdates.set(sourceId, { ...base, zoteroKey: r.key });
    });
  }

  let updatedRemote = 0;
  let conflicts = 0;
  for (const u of plan.toUpdateRemote) {
    try {
      const v = await client.updateItem(u.key, u.version, u.patch, signal);
      if (v === null) conflicts++;
      else {
        updatedRemote++;
        const e = plan.state.index[u.key];
        if (e) e.v = v;
      }
    } catch (e) {
      errors.push(`${u.sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const updates = [...localUpdates.entries()].map(([sourceId, bib]) => ({ sourceId, bib }));
  if (updates.length) await opts.applyLocal(updates);
  return { state: plan.state, plan, created, updatedRemote, conflicts, errors };
}
