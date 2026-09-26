import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Vault } from '../../vault';
import { blockIds, blockPlainText, blockText, getBlock, insertBlock } from '../../blocks';
import { GitSync, GitSyncError, decodePathSegment, encodePathSegment, type GitSyncBlobs, type MarkdownFile } from './gitsync';
import { MemoryGitRemote } from './memoryRemote';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeout = 4000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(10);
  }
}

let n = 0;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function memBlobs(maxBytes?: number): GitSyncBlobs & { m: Map<string, Blob> } {
  const m = new Map<string, Blob>();
  return {
    m,
    maxBytes,
    list: async () => [...m.keys()],
    get: async (id) => m.get(id),
    put: async (id, b) => void m.set(id, b),
  };
}

interface Device {
  vault: Vault;
  git: GitSync;
  blobs: ReturnType<typeof memBlobs>;
}

async function device(
  remote: MemoryGitRemote,
  opts: { exporters?: () => Promise<MarkdownFile[]>; maxBytes?: number; maxFilesPerCommit?: number } = {},
): Promise<Device> {
  const vault = await Vault.open(`test-git-${Date.now()}-${n++}`);
  const blobs = memBlobs(opts.maxBytes);
  const git = new GitSync({
    store: vault.store,
    remote,
    kv: { get: (k) => vault.getLocal(k), set: (k, v) => vault.setLocal(k, v) },
    blobs,
    exporters: opts.exporters,
    deviceName: vault.name,
    maxFilesPerCommit: opts.maxFilesPerCommit,
  });
  cleanups.push(async () => {
    git.destroy();
    await vault.close();
  });
  return { vault, git, blobs };
}

async function pageText(v: Vault, pageId: string): Promise<string[]> {
  const { doc, release } = await v.openPage(pageId);
  const out = blockIds(doc).map((id) => blockPlainText(getBlock(doc, id)!));
  release();
  return out;
}

describe('path segment encoding', () => {
  it('is reversible and case-insensitive-filesystem safe', () => {
    for (const id of ['index', 'p-aB3xYz', 'd-2026-01-02', 'c-1x2y', 'weird/id with spaces', '_under_', 'ünï©ødé', '..', '.', 'A_b', '']) {
      const enc = encodePathSegment(id);
      // only lowercase, digits, '-', '_' and %XX escapes
      if (id) expect(enc.replace(/%[0-9A-F]{2}/g, '')).toMatch(/^[a-z0-9\-_]*$/);
      expect(decodePathSegment(enc)).toBe(id);
    }
    expect(encodePathSegment('p-aB')).not.toBe(encodePathSegment('p-Ab'));
    expect(encodePathSegment('p-aB').toLowerCase()).not.toBe(encodePathSegment('p-Ab').toLowerCase());
    expect(decodePathSegment('bad!')).toBeNull();
    expect(decodePathSegment('_')).toBeNull();
  });
});

describe('GitSync', () => {
  it('pushes a vault and a second device pulls it; unchanged docs are not re-uploaded', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    const pid = a.vault.createPage({ title: 'Dynamic programming' });
    const { doc } = await a.vault.openPage(pid);
    insertBlock(doc, { type: 'text', text: 'Bellman equation' });

    const r1 = await a.git.sync();
    expect(r1.push.committed).toBe(true);
    expect(r1.push.docsPushed).toBe(2); // index + page
    const snap = remote.snapshot();
    expect([...snap.keys()].sort()).toEqual(['axiom/docs/index.yjs', `axiom/docs/${encodePathSegment(pid)}.yjs`, 'axiom/vault.json'].sort());
    expect(JSON.parse(new TextDecoder().decode(snap.get('axiom/vault.json')!))).toMatchObject({ app: 'axiom', format: 1 });

    // nothing changed → no commit, no uploads
    const written = remote.stats.filesWritten;
    const r2 = await a.git.sync();
    expect(r2.push.committed).toBe(false);
    expect(remote.stats.filesWritten).toBe(written);
    expect(r2.pull.unchanged).toBe(true);

    // second device pulls everything; its own push is a no-op (its state is contained in the remote)
    const b = await device(remote);
    const rb = await b.git.sync();
    expect(rb.pull.docsUpdated).toBe(2);
    expect(rb.push.committed).toBe(false);
    expect(b.vault.getPage(pid)?.title).toBe('Dynamic programming');
    expect(await pageText(b.vault, pid)).toEqual(['Bellman equation']);

    // editing one page uploads only that page
    const before = remote.stats.filesWritten;
    const bid = blockIds(doc)[0];
    blockText(getBlock(doc, bid)!)!.insert(0, 'The ');
    const r3 = await a.git.sync();
    expect(r3.push.docsPushed).toBe(1);
    expect(remote.stats.filesWritten - before).toBe(1);
    // the pushing device does not re-download its own commit
    const gets = remote.stats.getBlob;
    await a.git.pull();
    expect(remote.stats.getBlob).toBe(gets);
  });

  it('converges concurrent offline edits from two devices', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    const pid = a.vault.createPage({ title: 'Shared' });
    const { doc: da } = await a.vault.openPage(pid);
    const bid = insertBlock(da, { type: 'text', text: 'alpha' });
    await a.git.sync();

    const b = await device(remote);
    await b.git.sync();
    const { doc: db } = await b.vault.openPage(pid);
    expect(blockPlainText(getBlock(db, bid)!)).toBe('alpha');

    // offline: both edit the same block and create pages
    blockText(getBlock(da, bid)!)!.insert(5, ' [A]');
    blockText(getBlock(db, bid)!)!.insert(0, '[B] ');
    const pa = a.vault.createPage({ title: 'Only on A' });
    const pb = b.vault.createPage({ title: 'Only on B' });

    await a.git.sync();
    const rb = await b.git.sync(); // pulls A's commit, merges, pushes the merge
    expect(rb.push.committed).toBe(true);
    await a.git.sync();

    const ta = blockPlainText(getBlock(da, bid)!);
    expect(ta).toBe(blockPlainText(getBlock(db, bid)!));
    expect(ta).toBe('[B] alpha [A]');
    for (const v of [a.vault, b.vault]) {
      expect(v.getPage(pa)?.title).toBe('Only on A');
      expect(v.getPage(pb)?.title).toBe('Only on B');
    }
    // and the remote copy itself contains the merged state
    const remoteIndex = new Y.Doc();
    Y.applyUpdate(remoteIndex, remote.snapshot().get('axiom/docs/index.yjs')!);
    expect(remoteIndex.getMap('pages').has(pa) && remoteIndex.getMap('pages').has(pb)).toBe(true);
    // a further round is quiet on both
    expect((await a.git.sync()).push.committed).toBe(false);
    expect((await b.git.sync()).push.committed).toBe(false);
  });

  it('retries after a concurrent push (non-fast-forward)', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    const b = await device(remote);
    a.vault.createPage({ title: 'A1' });
    await a.git.sync();
    await b.git.sync();

    const pa = a.vault.createPage({ title: 'A2' });
    const pb = b.vault.createPage({ title: 'B2' });
    // while A is committing, B pushes first
    remote.beforeCommit = async () => {
      await b.git.sync();
    };
    const r = await a.git.sync();
    expect(r.attempts).toBe(2);
    expect(remote.stats.conflicts).toBe(1);
    expect(a.vault.getPage(pb)?.title).toBe('B2');
    await b.git.sync();
    expect(b.vault.getPage(pa)?.title).toBe('A2');
    expect(a.git.status.state).toBe('idle');
  });

  it('gives up after 3 conflicts and reports an error status', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    a.vault.createPage({ title: 'x' });
    remote.failNextCommits = 3;
    await expect(a.git.sync()).rejects.toThrow(/fast-forward/);
    expect(a.git.status.state).toBe('error');
    expect(a.git.status.lastError).toMatch(/fast-forward/);
    const r = await a.git.sync();
    expect(r.push.committed).toBe(true);
    expect(a.git.status.state).toBe('idle');
    expect(a.git.status.lastError).toBeUndefined();
  });

  it('never runs two syncs concurrently', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    a.vault.createPage({ title: 'x' });
    let inFlight = 0;
    let maxInFlight = 0;
    const orig = remote.getHead.bind(remote);
    remote.getHead = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait(20);
      inFlight--;
      return orig();
    };
    const [r1, r2] = await Promise.all([a.git.sync(), a.git.sync(), a.git.pull(), a.git.push()]);
    expect(r1).toBe(r2); // joined the running sync
    expect(maxInFlight).toBe(1);
    expect(remote.stats.commits).toBe(1);
  });

  it('uploads files once, skips oversized ones, restores MIME types on other devices', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote, { maxBytes: 1000 });
    await a.blobs.put('b-small', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }));
    await a.blobs.put('b-huge', new Blob([new Uint8Array(5000)], { type: 'image/png' }));
    const r1 = await a.git.sync();
    expect(r1.push.filesPushed).toBe(1);
    expect(remote.snapshot().has('axiom/files/b-small')).toBe(true);
    expect(remote.snapshot().has('axiom/files/b-huge')).toBe(false);

    const written = remote.stats.filesWritten;
    const r2 = await a.git.sync();
    expect(r2.push.filesPushed).toBe(0);
    expect(remote.stats.filesWritten).toBe(written);

    const b = await device(remote);
    const rb = await b.git.sync();
    expect(rb.pull.filesDownloaded).toBe(1);
    const got = b.blobs.m.get('b-small')!;
    expect(got.type).toBe('application/pdf');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(rb.push.filesPushed).toBe(0); // not re-uploaded by the downloader
  });

  it('writes the markdown mirror and removes stale files', async () => {
    const remote = new MemoryGitRemote();
    let files: MarkdownFile[] = [
      { path: 'pages/Dynamic programming.md', content: '# Dynamic programming\n' },
      { path: '/daily/2026-01-02.md', content: '# 2026-01-02\n' },
      { path: '../escape.md', content: 'nope' },
    ];
    let calls = 0;
    const a = await device(remote, {
      exporters: async () => {
        calls++;
        return files;
      },
    });
    a.vault.createPage({ title: 'Dynamic programming' });
    const r1 = await a.git.sync();
    expect(r1.push.markdownWritten).toBe(2);
    const snap = remote.snapshot();
    expect(new TextDecoder().decode(snap.get('axiom/markdown/pages/Dynamic programming.md')!)).toBe('# Dynamic programming\n');
    expect(snap.has('axiom/markdown/daily/2026-01-02.md')).toBe(true);
    expect([...snap.keys()].some((k) => k.includes('escape'))).toBe(false);

    // no doc changes → exporters not even called
    await a.git.sync();
    expect(calls).toBe(1);

    files = [{ path: 'pages/Dynamic programming.md', content: '# Dynamic programming\n\nBellman\n' }];
    a.vault.createPage({ title: 'Other' });
    const r3 = await a.git.sync();
    expect(r3.push.markdownWritten).toBe(2); // one update + one delete
    const snap2 = remote.snapshot();
    expect(snap2.has('axiom/markdown/daily/2026-01-02.md')).toBe(false);
    expect(new TextDecoder().decode(snap2.get('axiom/markdown/pages/Dynamic programming.md')!)).toContain('Bellman');
  });

  it('splits big pushes across commits (maxFilesPerCommit)', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote, { maxFilesPerCommit: 2 });
    for (let i = 0; i < 4; i++) a.vault.createPage({ title: 'p' + i });
    // each page has only index metadata; give them docs
    for (const p of a.vault.listPages()) insertBlock((await a.vault.openPage(p.id)).doc, { type: 'text', text: p.title });
    let r = await a.git.sync();
    expect(r.push.more).toBe(true);
    let rounds = 1;
    while (r.push.more) {
      r = await a.git.sync();
      rounds++;
    }
    expect(rounds).toBe(3); // 5 docs, 2 per commit
    expect([...remote.snapshot().keys()].filter((k) => k.includes('/docs/'))).toHaveLength(5);
  });

  it('re-uploads everything when the remote branch was reset', async () => {
    let remote = new MemoryGitRemote('same-id');
    const vault = await Vault.open(`test-git-reset-${Date.now()}`);
    cleanups.push(() => vault.close());
    const kv = { get: <T,>(k: string) => vault.getLocal<T>(k), set: (k: string, v: unknown) => vault.setLocal(k, v) };
    vault.createPage({ title: 'keep me' });
    const g1 = new GitSync({ store: vault.store, remote, kv });
    await g1.sync();
    g1.destroy();
    remote = new MemoryGitRemote('same-id'); // wiped
    const g2 = new GitSync({ store: vault.store, remote, kv });
    const r = await g2.sync();
    expect(r.push.docsPushed).toBe(1);
    expect(remote.snapshot().has('axiom/docs/index.yjs')).toBe(true);
    g2.destroy();
  });

  it('refuses a repository written by a newer format', async () => {
    const remote = new MemoryGitRemote();
    await remote.pushDirect([{ path: 'axiom/vault.json', content: new TextEncoder().encode('{"format":99}') }]);
    const a = await device(remote);
    await expect(a.git.sync()).rejects.toBeInstanceOf(GitSyncError);
    expect(a.git.status.state).toBe('error');
  });

  it('background: debounced push after local edits', async () => {
    const remote = new MemoryGitRemote();
    const a = await device(remote);
    const statuses: string[] = [];
    a.git.onStatus.on((s) => statuses.push(s.state));
    a.git.start({ intervalMs: 60_000, debounceMs: 50, initialDelayMs: 10 });
    await until(() => remote.stats.commits === 1); // initial sync pushes the index
    const pid = a.vault.createPage({ title: 'typed' });
    expect(a.git.status.dirty).toBe(true);
    await until(() => remote.stats.commits === 2);
    await until(() => a.git.status.state === 'idle' && !a.git.status.dirty);
    const idx = new Y.Doc();
    Y.applyUpdate(idx, remote.snapshot().get('axiom/docs/index.yjs')!);
    expect(idx.getMap('pages').has(pid)).toBe(true);
    expect(statuses).toContain('pushing');
    a.git.stop();
  });
});
