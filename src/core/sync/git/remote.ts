/**
 * Minimal abstraction over a Git hosting API, enough to persist a vault as files on one branch.
 * Implementations: GitHub (github.ts), GitLab (gitlab.ts), in-memory (memoryRemote.ts).
 */

export interface GitHead {
  commitSha: string;
  /**
   * Opaque token to pass to `listTree`. For GitHub/memory this is the root tree sha; GitLab has
   * no tree-sha API, so it is the commit sha there.
   */
  treeSha: string;
}

export interface GitFileChange {
  /** repository-relative path, '/'-separated, no leading slash */
  path: string;
  /** new content, or null to delete the file */
  content: Uint8Array | null;
}

export interface GitRemote {
  /** stable identity (provider + repo + branch), used to key local sync state */
  readonly id: string;
  /** Current head of the configured branch, or null when the branch (or repo) has no commits. */
  getHead(): Promise<GitHead | null>;
  /**
   * All blobs reachable from `treeSha`, as path → git blob sha (sha1 of "blob <len>\0<bytes>",
   * see `gitBlobSha`). When `prefix` is given only paths under `prefix/` are returned.
   */
  listTree(treeSha: string, prefix?: string): Promise<Map<string, string>>;
  getBlob(sha: string): Promise<Uint8Array>;
  /**
   * Commits `files` on top of `parentSha` (null = the branch is expected not to exist yet) and
   * fast-forwards the branch. Throws ConflictError when the branch moved in the meantime.
   */
  commit(files: GitFileChange[], message: string, parentSha: string | null): Promise<GitHead>;
}

/** The branch moved (non-fast-forward) — pull and retry. */
export class ConflictError extends Error {
  constructor(message = 'remote branch moved (not a fast-forward)') {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Any other HTTP failure. `status` 401/403 → token problem; 404 → repo not found / no access. */
export class GitRemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** when rate-limited: epoch ms at which it is worth retrying */
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'GitRemoteError';
  }
}

const enc = new TextEncoder();

/** Git's blob object id: SHA-1 over "blob <byteLength>\0" + content, hex. */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
  const header = enc.encode(`blob ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header);
  buf.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf as BufferSource));
  let s = '';
  for (const b of digest) s += b.toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------------------
// helpers shared by the HTTP implementations
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
