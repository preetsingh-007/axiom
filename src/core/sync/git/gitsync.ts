/**
 * Git-backed persistence: silently commits the vault's CRDT state to the user's own GitHub /
 * GitLab repository and pulls other devices' commits back in.
 *
 * Repository layout (under `prefix`, default "axiom"):
 *   axiom/vault.json            format version + MIME types of files (stable JSON)
 *   axiom/docs/<docId>.yjs      full, merged Yjs state of each doc (binary v1 update)
 *   axiom/files/<blobId>        source files & images (content-addressed, uploaded once)
 *   axiom/markdown/**.md        human-readable mirror produced by `exporters` (write-only)
 *
 * Merging is conflict-free: pulled doc states go through `store.applyRemote(docId, update, 'git')`
 * (a CRDT merge), and a push only writes docs whose local state is NOT already contained in the
 * remote copy (checked with state vectors). Commits are fast-forward only; when another device
 * pushed first we get a ConflictError, pull (merge) again and retry.
 */
import * as Y from 'yjs';
import type { DocStore } from '../../storage/docstore';
import { Emitter } from '../../util/emitter';
import { ConflictError, GitRemoteError, gitBlobSha, mapLimit, type GitFileChange, type GitRemote } from './remote';

export const GIT_TRANSPORT = 'git';
export const VAULT_FORMAT = 1;

export interface GitSyncKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface GitSyncBlobs {
  list(): Promise<string[]>;
  get(id: string): Promise<Blob | undefined>;
  put(id: string, blob: Blob): Promise<void>;
  /** files larger than this are never uploaded. Default 50 MB. */
  maxBytes?: number;
}

export interface MarkdownFile {
  /** path relative to `<prefix>/markdown/`, e.g. "pages/Bellman equation.md" */
  path: string;
  content: string;
}

export interface GitSyncOptions {
  store: DocStore;
  remote: GitRemote;
  /** folder inside the repository. Default "axiom". */
  prefix?: string;
  /** local-only persistence for sync cursors (use vault.getLocal / vault.setLocal) */
  kv: GitSyncKV;
  /** source files & images; omit to not sync files */
  blobs?: GitSyncBlobs;
  /** human-readable markdown mirror, regenerated on pushes that change docs */
  exporters?: () => Promise<MarkdownFile[]>;
  /** shown in commit messages */
  deviceName?: string;
  /** docs + files per commit (the rest follows in the next round). Default 300. */
  maxFilesPerCommit?: number;
  /** payload bytes per commit (a single larger file still goes alone). Default 50 MB. */
  maxBytesPerCommit?: number;
  /** parallel downloads. Default 4. */
  concurrency?: number;
  /**
   * Updates arriving through these transports are edits made on THIS device (other tabs), so they
   * schedule a debounced push like local edits do. Default ['tabs'] (BroadcastTransport).
   */
  localTransports?: string[];
}

export type GitSyncState = 'idle' | 'pulling' | 'pushing' | 'error' | 'offline';

export interface GitSyncStatus {
  state: GitSyncState;
  lastSyncedAt?: number;
  lastError?: string;
  /** when rate limited: earliest time the background loop will retry */
  retryAt?: number;
  /** local changes not yet committed */
  dirty: boolean;
  headSha?: string | null;
}

export interface PullResult {
  headSha: string | null;
  unchanged: boolean;
  docsUpdated: number;
  filesDownloaded: number;
}

export interface PushResult {
  committed: boolean;
  headSha: string | null;
  docsPushed: number;
  filesPushed: number;
  markdownWritten: number;
  /** more changes remain (per-commit caps); run push again */
  more: boolean;
}

export interface SyncResult {
  pull: PullResult;
  push: PushResult;
  attempts: number;
}

export interface GitSyncStartOptions {
  /** periodic pull+push. Default 2 min. */
  intervalMs?: number;
  /** push after this much idle time following a local edit. Default 30 s. */
  debounceMs?: number;
  /** push at the latest this long after the first unpushed edit. Default 5 min. */
  maxDelayMs?: number;
  /** first sync after start(). Default 1.5 s. */
  initialDelayMs?: number;
  /**
   * Web Locks name: only the tab holding this lock runs background sync (others wait and take
   * over when it closes). Recommended: `axiom-git-${vault.name}`. Ignored where unsupported.
   */
  lockName?: string;
}

/** Thrown for problems that retrying will not fix (e.g. newer vault format on the remote). */
export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSyncError';
  }
}

interface DocEntry {
  /** state vector of the doc's copy on the remote (as of `headSha`) */
  sv: Uint8Array;
}

interface Persisted {
  v: 1;
  headSha: string | null;
  /** path → blob sha of every file under the prefix at `headSha` */
  paths: Record<string, string>;
  docs: Record<string, DocEntry>;
  /** MIME types of synced files (from vault.json) */
  fileTypes: Record<string, string>;
  /** blob ids skipped for being too large */
  tooBig: string[];
}

const emptyState = (): Persisted => ({ v: 1, headSha: null, paths: {}, docs: {}, fileTypes: {}, tooBig: [] });

const enc = new TextEncoder();
const dec = new TextDecoder();

export class GitSync {
  readonly onStatus = new Emitter<GitSyncStatus>();
  status: GitSyncStatus = { state: 'idle', dirty: false };

  private readonly prefix: string;
  private readonly kvKey: string;
  private state: Persisted | null = null;
  /** docId → change generation, for docs changed since they were last known to be on the remote */
  private dirty = new Map<string, number>();
  private gen = 0;
  private fullScanNeeded = true;
  private chain: Promise<unknown> = Promise.resolve();
  private running: Promise<SyncResult> | null = null;
  private offUpdate: () => void;
  private localTransports: Set<string>;
  private releaseLock: (() => void) | undefined;
  private startGen = 0;
  private bg: {
    opts: Required<Omit<GitSyncStartOptions, 'lockName'>>;
    interval: ReturnType<typeof setInterval>;
    debounce?: ReturnType<typeof setTimeout>;
    firstDirtyAt?: number;
    cleanup: (() => void)[];
  } | null = null;

  constructor(private opts: GitSyncOptions) {
    this.prefix = (opts.prefix ?? 'axiom').replace(/^\/+|\/+$/g, '');
    this.kvKey = `gitsync:${opts.remote.id}:${this.prefix}`;
    this.localTransports = new Set(opts.localTransports ?? ['tabs']);
    this.offUpdate = opts.store.onUpdate.on(({ docId, from }) => {
      if (from === GIT_TRANSPORT) return;
      this.dirty.set(docId, ++this.gen);
      if (!this.status.dirty) this.setStatus({ dirty: true });
      if (from === undefined || this.localTransports.has(from)) this.scheduleDebouncedSync();
    });
  }

  // ================================================================ public API

  /** Downloads and merges everything that changed on the remote since the last pull. */
  pull(): Promise<PullResult> {
    return this.exclusive(() => this.withStatus('pulling', () => this.doPull()));
  }

  /** Commits local changes the remote does not have yet. Throws ConflictError if the remote moved. */
  push(): Promise<PushResult> {
    return this.exclusive(() => this.withStatus('pushing', () => this.doPush()));
  }

  /** Pull then push, retrying up to 3 times when another device pushed in between. */
  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    const p = this.exclusive(async () => {
      try {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const pull = await this.withStatus('pulling', () => this.doPull(), false);
            const push = await this.withStatus('pushing', () => this.doPush(), false);
            this.setStatus({ state: 'idle', lastSyncedAt: Date.now(), lastError: undefined, retryAt: undefined });
            return { pull, push, attempts: attempt };
          } catch (e) {
            lastErr = e;
            if (!(e instanceof ConflictError)) break;
          }
        }
        this.fail(lastErr);
        throw lastErr;
      } finally {
        this.running = null;
      }
    });
    this.running = p;
    return p;
  }

  /** Starts background syncing: debounced pushes after local edits + periodic pull/push. */
  start(options: GitSyncStartOptions | number = {}): void {
    this.stop();
    const o = typeof options === 'number' ? { intervalMs: options } : options;
    const opts: Required<Omit<GitSyncStartOptions, 'lockName'>> = {
      intervalMs: o.intervalMs ?? 120_000,
      debounceMs: o.debounceMs ?? 30_000,
      maxDelayMs: o.maxDelayMs ?? 300_000,
      initialDelayMs: o.initialDelayMs ?? 1500,
    };
    const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
    if (o.lockName && locks) {
      const gen = ++this.startGen;
      void locks
        .request(o.lockName, () =>
          new Promise<void>((resolve) => {
            if (gen !== this.startGen) return resolve(); // stopped while waiting
            this.releaseLock = resolve;
            this.begin(opts);
          }),
        )
        .catch(() => undefined);
      return;
    }
    this.begin(opts);
  }

  private begin(opts: Required<Omit<GitSyncStartOptions, 'lockName'>>): void {
    const cleanup: (() => void)[] = [];
    const initial = setTimeout(() => void this.runBackground(), opts.initialDelayMs);
    cleanup.push(() => clearTimeout(initial));
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOnline = () => void this.runBackground();
      const onOffline = () => this.setStatus({ state: 'offline' });
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      cleanup.push(() => window.removeEventListener('online', onOnline), () => window.removeEventListener('offline', onOffline));
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVis = () => {
        // best effort: commit pending edits when the tab is hidden (the PWA may be killed)
        if (document.visibilityState === 'hidden' && this.dirty.size) void this.runBackground();
      };
      document.addEventListener('visibilitychange', onVis);
      cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    this.bg = { opts, interval: setInterval(() => void this.runBackground(), opts.intervalMs), cleanup };
  }

  stop(): void {
    this.startGen++;
    this.releaseLock?.();
    this.releaseLock = undefined;
    if (!this.bg) return;
    clearInterval(this.bg.interval);
    if (this.bg.debounce) clearTimeout(this.bg.debounce);
    this.bg.cleanup.forEach((f) => f());
    this.bg = null;
  }

  /** true while this instance runs background sync (false in tabs waiting for the Web Lock) */
  get isBackgroundActive(): boolean {
    return this.bg !== null;
  }

  /** stop() + detach from the store */
  destroy(): void {
    this.stop();
    this.offUpdate();
  }

  /** Forget all sync cursors (next sync re-downloads and re-checks everything). */
  async reset(): Promise<void> {
    await this.exclusive(async () => {
      this.state = emptyState();
      this.fullScanNeeded = true;
      await this.save();
    });
  }

  // ================================================================ background

  private scheduleDebouncedSync() {
    const bg = this.bg;
    if (!bg) return;
    const now = Date.now();
    bg.firstDirtyAt ??= now;
    if (bg.debounce) clearTimeout(bg.debounce);
    const wait = Math.max(0, Math.min(bg.opts.debounceMs, bg.firstDirtyAt + bg.opts.maxDelayMs - now));
    bg.debounce = setTimeout(() => {
      if (this.bg) this.bg.debounce = undefined;
      void this.runBackground();
    }, wait);
  }

  private async runBackground(): Promise<void> {
    if (!this.bg) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus({ state: 'offline' });
      return;
    }
    if (this.status.retryAt && this.status.retryAt > Date.now()) return;
    this.bg.firstDirtyAt = undefined;
    try {
      const r = await this.sync();
      if (r.push.more && this.bg) setTimeout(() => void this.runBackground(), 0);
    } catch {
      // status already reflects the error; the interval retries
    }
  }

  // ================================================================ pull

  private async doPull(): Promise<PullResult> {
    const st = await this.load();
    const { remote } = this.opts;
    const head = await remote.getHead();
    if (!head) {
      if (st.headSha !== null) {
        // the branch was deleted / repository reset: start over, everything gets re-uploaded
        Object.assign(st, emptyState());
        this.fullScanNeeded = true;
        await this.save();
      }
      return { headSha: null, unchanged: true, docsUpdated: 0, filesDownloaded: 0 };
    }
    if (head.commitSha === st.headSha) return { headSha: head.commitSha, unchanged: true, docsUpdated: 0, filesDownloaded: 0 };

    const tree = await remote.listTree(head.treeSha, this.prefix);
    const p = this.prefix + '/';
    const concurrency = this.opts.concurrency ?? 4;

    // vault.json first: refuse to touch a vault written by a newer format
    const vjPath = p + 'vault.json';
    const vjSha = tree.get(vjPath);
    if (vjSha && vjSha !== st.paths[vjPath]) {
      const meta = parseJson(dec.decode(await remote.getBlob(vjSha))) as { format?: number; fileTypes?: Record<string, string> } | null;
      if (meta && typeof meta.format === 'number' && meta.format > VAULT_FORMAT) {
        throw new GitSyncError(`The repository was written by a newer Axiom (format ${meta.format}). Update Axiom to sync.`);
      }
      if (meta?.fileTypes) Object.assign(st.fileTypes, meta.fileTypes);
      st.paths[vjPath] = vjSha;
    }

    const docJobs: [string, string, string][] = []; // [path, sha, docId]
    const fileJobs: [string, string, string][] = []; // [path, sha, blobId]
    for (const [path, sha] of tree) {
      if (st.paths[path] === sha) continue;
      const rel = path.slice(p.length);
      if (rel.startsWith('docs/') && rel.endsWith('.yjs')) {
        const docId = decodePathSegment(rel.slice(5, -4));
        if (docId !== null) docJobs.push([path, sha, docId]);
      } else if (rel.startsWith('files/') && !rel.slice(6).includes('/')) {
        const id = decodePathSegment(rel.slice(6));
        if (id !== null) fileJobs.push([path, sha, id]);
      } else if (rel !== 'vault.json') {
        st.paths[path] = sha; // markdown mirror & unknown files: just track
      }
    }

    let docsUpdated = 0;
    const CHUNK = 64;
    for (let i = 0; i < docJobs.length; i += CHUNK) {
      await mapLimit(docJobs.slice(i, i + CHUNK), concurrency, async ([path, sha, docId]) => {
        const bytes = await remote.getBlob(sha);
        let sv: Uint8Array;
        try {
          sv = Y.encodeStateVectorFromUpdate(bytes);
        } catch {
          console.warn('[axiom git] skipping corrupt doc file', path);
          st.paths[path] = sha; // will be overwritten by our next push (no `docs` entry)
          return;
        }
        await this.opts.store.applyRemote(docId, bytes, GIT_TRANSPORT);
        st.docs[docId] = { sv };
        st.paths[path] = sha;
        docsUpdated++;
      });
      await this.save(); // progress survives interruptions of big first pulls
    }

    let filesDownloaded = 0;
    const blobs = this.opts.blobs;
    if (blobs && fileJobs.length) {
      const have = new Set(await blobs.list());
      await mapLimit(fileJobs, concurrency, async ([path, sha, id]) => {
        if (!have.has(id)) {
          const bytes = await remote.getBlob(sha);
          await blobs.put(id, new Blob([bytes as BlobPart], { type: st.fileTypes[id] ?? 'application/octet-stream' }));
          filesDownloaded++;
        }
        st.paths[path] = sha;
      });
    }
    // (without a blob store, file paths stay untracked so enabling files later downloads them)

    // forget paths that no longer exist remotely
    for (const path of Object.keys(st.paths)) if (!tree.has(path)) delete st.paths[path];
    st.headSha = head.commitSha;
    await this.save();
    if (docsUpdated) await this.opts.store.flush();
    return { headSha: head.commitSha, unchanged: false, docsUpdated, filesDownloaded };
  }

  // ================================================================ push

  private async doPush(): Promise<PushResult> {
    const st = await this.load();
    const { store, remote } = this.opts;
    const p = this.prefix + '/';
    const maxFiles = this.opts.maxFilesPerCommit ?? 300;
    const maxBytes = this.opts.maxBytesPerCommit ?? 50 * 1024 * 1024;

    const changes: GitFileChange[] = [];
    const newShas = new Map<string, string | null>();
    const pushedDocs: { docId: string; gen: number; sv: Uint8Array }[] = [];
    const containedDocs: { docId: string; gen: number; sv?: Uint8Array }[] = [];
    let bytes = 0;
    let more = false;
    const budgetLeft = (size: number) => changes.length < maxFiles && (bytes + size <= maxBytes || changes.length === 0);

    // ---- docs
    const candidates = this.fullScanNeeded ? await store.listDocIds() : [...this.dirty.keys()];
    const scanWasFull = this.fullScanNeeded;
    candidates.sort((a, b) => (a === 'index' ? -1 : b === 'index' ? 1 : 0)); // the index doc first
    for (const docId of candidates) {
      const gen = this.dirty.get(docId) ?? 0;
      const state = await store.getState(docId);
      if (!state) {
        containedDocs.push({ docId, gen });
        continue;
      }
      const remoteSv = st.docs[docId]?.sv;
      if (remoteSv && isEmptyUpdate(Y.diffUpdate(state, remoteSv))) {
        containedDocs.push({ docId, gen });
        continue;
      }
      const content = compactState(state);
      if (!budgetLeft(content.length)) {
        more = true;
        continue;
      }
      const path = `${p}docs/${encodePathSegment(docId)}.yjs`;
      changes.push({ path, content });
      bytes += content.length;
      newShas.set(path, await gitBlobSha(content));
      pushedDocs.push({ docId, gen, sv: Y.encodeStateVectorFromUpdate(content) });
    }

    // ---- files (content-addressed: uploaded once, never re-uploaded)
    let filesPushed = 0;
    const fileTypes: Record<string, string> = { ...st.fileTypes };
    const blobs = this.opts.blobs;
    const newTooBig: string[] = [];
    if (blobs) {
      const limit = blobs.maxBytes ?? 50 * 1024 * 1024;
      const tooBig = new Set(st.tooBig);
      for (const id of await blobs.list()) {
        const path = `${p}files/${encodePathSegment(id)}`;
        if (st.paths[path] || tooBig.has(id)) continue;
        const blob = await blobs.get(id);
        if (!blob) continue;
        if (blob.size > limit) {
          newTooBig.push(id);
          continue;
        }
        if (!budgetLeft(blob.size)) {
          more = true;
          continue;
        }
        const content = new Uint8Array(await blob.arrayBuffer());
        changes.push({ path, content });
        bytes += content.length;
        newShas.set(path, await gitBlobSha(content));
        if (blob.type) fileTypes[id] = blob.type;
        filesPushed++;
      }
    }

    // ---- markdown mirror (regenerated whenever docs are pushed, or if never written)
    let markdownWritten = 0;
    const mdPrefix = `${p}markdown/`;
    const hasMarkdown = Object.keys(st.paths).some((k) => k.startsWith(mdPrefix));
    if (this.opts.exporters && (pushedDocs.length > 0 || !hasMarkdown)) {
      const files = await this.opts.exporters();
      const wanted = new Set<string>();
      for (const f of files) {
        const rel = sanitizeRelPath(f.path);
        if (!rel) continue;
        const path = mdPrefix + rel;
        if (wanted.has(path)) continue;
        wanted.add(path);
        const content = enc.encode(f.content);
        const sha = await gitBlobSha(content);
        if (st.paths[path] === sha) continue;
        changes.push({ path, content });
        newShas.set(path, sha);
        markdownWritten++;
      }
      for (const path of Object.keys(st.paths)) {
        if (path.startsWith(mdPrefix) && !wanted.has(path)) {
          changes.push({ path, content: null });
          newShas.set(path, null);
          markdownWritten++;
        }
      }
    }

    // ---- vault.json (stable content, so it only changes when file types do)
    const vjPath = `${p}vault.json`;
    const vj = enc.encode(
      stableStringify({
        app: 'axiom',
        format: VAULT_FORMAT,
        layout: { docs: 'docs/<docId>.yjs', files: 'files/<blobId>', markdown: 'markdown/' },
        fileTypes,
      }) + '\n',
    );
    const vjSha = await gitBlobSha(vj);
    const contentChanges = changes.length;
    if (st.paths[vjPath] !== vjSha && (contentChanges > 0 || st.headSha === null || st.paths[vjPath] === undefined)) {
      changes.unshift({ path: vjPath, content: vj });
      newShas.set(vjPath, vjSha);
    }

    const finishContained = () => {
      for (const d of containedDocs) this.clearDirty(d.docId, d.gen);
      if (scanWasFull) this.fullScanNeeded = false;
      st.tooBig.push(...newTooBig);
    };

    if (!changes.length) {
      finishContained();
      await this.save();
      this.setStatus({ dirty: this.dirty.size > 0 });
      return { committed: false, headSha: st.headSha, docsPushed: 0, filesPushed: 0, markdownWritten: 0, more: false };
    }

    const parts = [`${pushedDocs.length} doc${pushedDocs.length === 1 ? '' : 's'}`];
    if (filesPushed) parts.push(`${filesPushed} file${filesPushed === 1 ? '' : 's'}`);
    const message = `Axiom sync: ${parts.join(', ')}${this.opts.deviceName ? ` from ${this.opts.deviceName}` : ''}`;
    const head = await remote.commit(changes, message, st.headSha);

    // success: record what the remote now has
    st.headSha = head.commitSha;
    for (const [path, sha] of newShas) {
      if (sha === null) delete st.paths[path];
      else st.paths[path] = sha;
    }
    for (const d of pushedDocs) {
      st.docs[d.docId] = { sv: d.sv };
      this.clearDirty(d.docId, d.gen);
    }
    st.fileTypes = fileTypes;
    finishContained();
    if (more) this.fullScanNeeded = this.fullScanNeeded || scanWasFull;
    await this.save();
    this.setStatus({ dirty: this.dirty.size > 0 || more, headSha: head.commitSha });
    return { committed: true, headSha: head.commitSha, docsPushed: pushedDocs.length, filesPushed, markdownWritten, more };
  }

  // ================================================================ helpers

  private clearDirty(docId: string, gen: number) {
    // only if it did not change again while we were pushing
    if ((this.dirty.get(docId) ?? 0) <= gen) this.dirty.delete(docId);
  }

  private async load(): Promise<Persisted> {
    if (!this.state) {
      const saved = await this.opts.kv.get<Persisted>(this.kvKey);
      this.state = saved && saved.v === 1 ? { ...emptyState(), ...saved } : emptyState();
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await this.opts.kv.set(this.kvKey, this.state);
  }

  /** Serialises all remote operations: never two pulls/pushes at once. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withStatus<T>(state: GitSyncState, fn: () => Promise<T>, settle = true): Promise<T> {
    this.setStatus({ state });
    try {
      const r = await fn();
      if (settle) this.setStatus({ state: 'idle', lastSyncedAt: Date.now(), lastError: undefined, retryAt: undefined });
      return r;
    } catch (e) {
      if (settle) this.fail(e);
      throw e;
    }
  }

  private fail(e: unknown) {
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || e instanceof TypeError;
    this.setStatus({
      state: offline ? 'offline' : 'error',
      lastError: e instanceof Error ? e.message : String(e),
      retryAt: e instanceof GitRemoteError ? e.retryAt : undefined,
    });
  }

  private setStatus(patch: Partial<GitSyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus.emit(this.status);
  }
}

// ==================================================================== utilities

function isEmptyUpdate(u: Uint8Array): boolean {
  return u.length <= 2 && u.every((b) => b === 0);
}

/** Re-encodes a (possibly log-merged) state through a GC-enabled doc: smaller files in Git. */
function compactState(state: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Normalises an exporter path: '/'-separated, no leading slash, no '.'/'..' segments. */
function sanitizeRelPath(path: string): string | null {
  const segs = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (!segs.length || segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

/**
 * Reversible, filesystem-safe encoding of an id into one path segment. Safe on case-insensitive
 * file systems (a checkout on macOS/Windows): [a-z0-9-] stay, uppercase X → "_x", "_" → "__",
 * everything else → %XX (UTF-8).
 */
export function encodePathSegment(id: string): string {
  let out = '';
  for (const ch of id) {
    if (/[a-z0-9-]/.test(ch)) out += ch;
    else if (/[A-Z]/.test(ch)) out += '_' + ch.toLowerCase();
    else if (ch === '_') out += '__';
    else for (const b of enc.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out || '%';
}

/** Inverse of encodePathSegment; null for strings it could not have produced. */
export function decodePathSegment(seg: string): string | null {
  if (seg === '%') return '';
  let out = '';
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length) {
      out += dec.decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '%') {
      const hex = seg.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    flush();
    if (c === '_') {
      const n = seg[i + 1];
      if (n === '_') out += '_';
      else if (n && /[a-z]/.test(n)) out += n.toUpperCase();
      else return null;
      i++;
    } else if (/[a-z0-9-]/.test(c)) out += c;
    else return null;
  }
  flush();
  return out;
}
