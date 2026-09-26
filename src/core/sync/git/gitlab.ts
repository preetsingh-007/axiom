/**
 * GitLab (gitlab.com or self-hosted) implementation of GitRemote over REST v4, authenticated
 * with a Personal/Project Access Token (`api` scope) sent as PRIVATE-TOKEN.
 *
 * GitLab has no tree-sha API, so `GitHead.treeSha` is the commit sha, and it has no
 * compare-and-swap ref update. Conflicts are detected by (1) checking the branch head right
 * before committing, (2) mapping GitLab's 400 "file already exists / does not exist / has changed"
 * errors to ConflictError, and (3) verifying the new commit's parent.
 */
import {
  ConflictError,
  GitRemoteError,
  bytesToBase64,
  gitBlobSha,
  defaultSleep,
  type FetchLike,
  type GitFileChange,
  type GitHead,
  type GitRemote,
} from './remote';

export interface GitLabRemoteOptions {
  token: string;
  /** project path "group/subgroup/name" or numeric id */
  project: string;
  branch: string;
  /** default https://gitlab.com */
  baseUrl?: string;
  maxRetries?: number;
  maxWaitMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

interface TreeItem {
  id: string;
  name: string;
  type: 'blob' | 'tree' | 'commit';
  path: string;
}

export class GitLabRemote implements GitRemote {
  readonly id: string;
  private api: string;
  private fetchFn: FetchLike;
  private sleep: (ms: number) => Promise<void>;
  /** `${commitSha}:${dir}` → tree listing (to choose create vs update actions) */
  private treeCache = new Map<string, Map<string, string>>();

  constructor(private opts: GitLabRemoteOptions) {
    const base = (opts.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.api = `${base}/api/v4/projects/${encodeURIComponent(opts.project.replace(/^\/+|\/+$/g, ''))}`;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.id = `gitlab:${base}/${opts.project}#${opts.branch}`;
  }

  // ---------------------------------------------------------------- http

  private async raw(method: string, path: string, body?: unknown, allow: number[] = []): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 4;
    const maxWait = this.opts.maxWaitMs ?? 60_000;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(this.api + path, {
        method,
        headers: {
          'PRIVATE-TOKEN': this.opts.token,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      if ((res.status >= 200 && res.status < 300) || allow.includes(res.status)) return res;
      const text = await res.text().catch(() => '');
      let wait: number | null = null;
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('ratelimit-reset'));
        wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) + 1000 : 60_000;
      } else if (res.status >= 500) {
        wait = Math.min(30_000, 1000 * 2 ** attempt);
      }
      if (wait !== null) {
        if (attempt >= maxRetries || wait > maxWait) {
          throw new GitRemoteError(`GitLab rate limit or server error (${res.status})`, res.status, Date.now() + wait);
        }
        await this.sleep(wait);
        continue;
      }
      if (res.status === 401) throw new GitRemoteError('GitLab rejected the access token (401)', 401);
      if (res.status === 403) throw new GitRemoteError('GitLab denied access (403): token needs the "api" scope', 403);
      if (res.status === 404) throw new GitRemoteError(`GitLab: not found or no access (${method} ${path.split('?')[0]})`, 404);
      throw new GitRemoteError(`GitLab ${method} ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T; res: Response }> {
    const res = await this.raw(method, path, body, allow);
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep text */
    }
    return { status: res.status, data: data as T, res };
  }

  // ---------------------------------------------------------------- GitRemote

  async getHead(): Promise<GitHead | null> {
    const r = await this.json<{ commit: { id: string } }>('GET', `/repository/branches/${encodeURIComponent(this.opts.branch)}`, undefined, [404]);
    if (r.status === 404) {
      // distinguish "no branch / empty repo" from "no project / no access"
      await this.json('GET', '', undefined);
      return null;
    }
    const sha = r.data.commit.id;
    return { commitSha: sha, treeSha: sha };
  }

  async listTree(treeSha: string, prefix?: string): Promise<Map<string, string>> {
    return new Map(await this.treeUnder(treeSha, (prefix ?? '').replace(/^\/+|\/+$/g, '')));
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const res = await this.raw('GET', `/repository/blobs/${sha}/raw`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async commit(files: GitFileChange[], message: string, parentSha: string | null): Promise<GitHead> {
    // (1) compare-before-write
    const head = await this.getHead();
    if ((head?.commitSha ?? null) !== parentSha) throw new ConflictError();

    const dirs = topDirs(files);
    const existing = new Map<string, string>();
    if (parentSha) for (const d of dirs) for (const [k, v] of await this.treeUnder(parentSha, d)) existing.set(k, v);
    const actions: Record<string, unknown>[] = [];
    for (const f of files) {
      if (f.content === null) {
        if (existing.has(f.path)) actions.push({ action: 'delete', file_path: f.path });
        continue;
      }
      actions.push({
        action: existing.has(f.path) ? 'update' : 'create',
        file_path: f.path,
        content: bytesToBase64(f.content),
        encoding: 'base64',
      });
    }
    if (!actions.length && head) return head;

    const body: Record<string, unknown> = { branch: this.opts.branch, commit_message: message, actions };
    if (!parentSha) {
      // new branch: in a non-empty project GitLab needs a starting point
      const proj = await this.json<{ empty_repo?: boolean; default_branch?: string }>('GET', '');
      if (!proj.data.empty_repo && proj.data.default_branch && proj.data.default_branch !== this.opts.branch) {
        body.start_branch = proj.data.default_branch;
      }
    }
    const r = await this.json<{ id: string; parent_ids?: string[]; message?: string }>('POST', '/repository/commits', body, [400, 409]);
    if (r.status === 400 || r.status === 409) {
      // (2) "A file with this name already exists", "A file with this name doesn't exist",
      // "You are attempting to update a file that has changed since you started editing it."
      throw new ConflictError(`GitLab rejected the commit: ${String((r.data as { message?: string })?.message ?? '').slice(0, 200)}`);
    }
    const commitSha = r.data.id;
    // (3) our commit must sit directly on the parent we pulled; otherwise someone raced us in the
    // tiny window above. The commit only rewrote whole files we meant to write (CRDT state that
    // already includes everything we pulled), and devices re-push whatever the remote lacks, so
    // this is not data loss — but report it so GitSync re-pulls before trusting its state.
    if (parentSha && r.data.parent_ids && r.data.parent_ids[0] !== parentSha) {
      throw new ConflictError('GitLab branch advanced during commit');
    }
    // remember the resulting listing (blob shas are computable locally), so the next commit on
    // top of this one needs no tree listing
    if (parentSha && dirs.length === 1) {
      const next = new Map(existing);
      for (const f of files) {
        if (f.content === null) next.delete(f.path);
        else next.set(f.path, await gitBlobSha(f.content));
      }
      this.remember(`${commitSha}:${dirs[0]}`, next);
    }
    return { commitSha, treeSha: commitSha };
  }

  // ---------------------------------------------------------------- helpers

  private remember(key: string, tree: Map<string, string>) {
    if (this.treeCache.size >= 8) this.treeCache.delete(this.treeCache.keys().next().value!);
    this.treeCache.set(key, tree);
  }

  /** Blobs under `dir` ('' = whole repo) at `ref`, as full path → blob sha. */
  private async treeUnder(ref: string, dir: string): Promise<Map<string, string>> {
    const key = `${ref}:${dir}`;
    const hit = this.treeCache.get(key);
    if (hit) return hit;
    const out = new Map<string, string>();
    let page: string | null = '1';
    while (page) {
      const qs =
        `?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}` + (dir ? `&path=${encodeURIComponent(dir)}` : '');
      const r: { status: number; data: TreeItem[]; res: Response } = await this.json<TreeItem[]>('GET', `/repository/tree${qs}`, undefined, [404]);
      if (r.status === 404) break; // path (or ref) does not exist
      for (const item of r.data) if (item.type === 'blob') out.set(item.path, item.id);
      const nextPage: string | null = r.res.headers.get('x-next-page');
      page = nextPage && nextPage !== page ? nextPage : null;
    }
    this.remember(key, out);
    return out;
  }
}

/** Distinct top-level directories of the changed paths; [''] when a root-level file is involved. */
function topDirs(files: GitFileChange[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const i = f.path.indexOf('/');
    if (i < 0) return [''];
    dirs.add(f.path.slice(0, i));
  }
  return [...dirs];
}
