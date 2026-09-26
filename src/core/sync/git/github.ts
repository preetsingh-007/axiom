/**
 * GitHub (and GitHub Enterprise) implementation of GitRemote over the REST v3 Git Data API,
 * authenticated with a Personal Access Token (classic with `repo` scope, or fine-grained with
 * "Contents: read & write" — plus "Administration: write" only if the repo should be auto-created).
 */
import {
  ConflictError,
  GitRemoteError,
  base64ToBytes,
  bytesToBase64,
  defaultSleep,
  mapLimit,
  type FetchLike,
  type GitFileChange,
  type GitHead,
  type GitRemote,
} from './remote';

export interface GitHubRemoteOptions {
  token: string;
  /** "owner/name" */
  repo: string;
  branch: string;
  /** default https://api.github.com; GHE: https://ghe.example.com/api/v3 */
  baseUrl?: string;
  /** create the repository (private) when it does not exist. Default true. */
  createRepoIfMissing?: boolean;
  /** parallel blob uploads/downloads. Default 4. */
  concurrency?: number;
  /** retries for 5xx / rate limits. Default 4. */
  maxRetries?: number;
  /** longest rate-limit wait we sit through before failing with retryAt. Default 60s. */
  maxWaitMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

interface Res<T = unknown> {
  status: number;
  data: T;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

const BOOTSTRAP_MAX = 900 * 1024; // Contents API accepts up to 1 MB

export class GitHubRemote implements GitRemote {
  readonly id: string;
  /** last observed rate-limit budget (for the UI) */
  rateLimit: { remaining: number; resetAt: number } | undefined;
  private owner: string;
  private name: string;
  private base: string;
  private fetchFn: FetchLike;
  private sleep: (ms: number) => Promise<void>;
  private emptyRepo = false;
  private commitTrees = new Map<string, string>();

  constructor(private opts: GitHubRemoteOptions) {
    const [owner, name, ...rest] = opts.repo.replace(/\.git$/, '').split('/');
    if (!owner || !name || rest.length) throw new Error('GitHub repo must be "owner/name"');
    this.owner = owner;
    this.name = name;
    this.base = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.id = `github:${this.base}/${owner}/${name}#${opts.branch}`;
  }

  private get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
  }

  private get branchRef() {
    return this.opts.branch.split('/').map(encodeURIComponent).join('/');
  }

  // ---------------------------------------------------------------- http

  private async req<T = unknown>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<Res<T>> {
    const maxRetries = this.opts.maxRetries ?? 4;
    const maxWait = this.opts.maxWaitMs ?? 60_000;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(this.base + path, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.opts.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      this.observeRateLimit(res);
      const { status } = res;
      if (status >= 200 && status < 300) return { status, data: status === 204 ? (undefined as T) : ((await res.json()) as T) };
      const text = await res.text().catch(() => '');
      if (allow.includes(status)) return { status, data: safeJson(text) as T };

      const wait = retryDelay(res, text, attempt);
      if (wait !== null) {
        const retryAt = Date.now() + wait;
        if (attempt >= maxRetries || wait > maxWait) {
          throw new GitRemoteError(`GitHub rate limit or server error (${status})`, status, retryAt);
        }
        await this.sleep(wait);
        continue;
      }
      if (status === 401) throw new GitRemoteError('GitHub rejected the access token (401)', 401);
      if (status === 403) throw new GitRemoteError(`GitHub denied access (403): ${message(text)}`, 403);
      if (status === 404) throw new GitRemoteError(`GitHub: not found or no access (${method} ${stripQuery(path)})`, 404);
      throw new GitRemoteError(`GitHub ${method} ${stripQuery(path)} failed (${status}): ${message(text)}`, status);
    }
  }

  private observeRateLimit(res: Response) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null && reset !== null) {
      this.rateLimit = { remaining: Number(remaining), resetAt: Number(reset) * 1000 };
    }
  }

  // ---------------------------------------------------------------- GitRemote

  async getHead(): Promise<GitHead | null> {
    const r = await this.req<{ object: { sha: string } }>('GET', `${this.repoPath}/git/ref/heads/${this.branchRef}`, undefined, [404, 409]);
    if (r.status === 409) {
      this.emptyRepo = true; // "Git Repository is empty."
      return null;
    }
    if (r.status === 404) {
      await this.ensureRepo();
      return null;
    }
    // GitHub returns an array for a prefix match (ref "heads/main" vs "heads/main-2"); guard it
    if (Array.isArray(r.data)) return null;
    this.emptyRepo = false;
    const commitSha = r.data.object.sha;
    return { commitSha, treeSha: await this.treeOf(commitSha) };
  }

  async listTree(treeSha: string, prefix?: string): Promise<Map<string, string>> {
    let root = treeSha;
    let base = '';
    for (const seg of (prefix ?? '').split('/').filter(Boolean)) {
      const r = await this.req<{ tree: TreeEntry[] }>('GET', `${this.repoPath}/git/trees/${root}`);
      const e = r.data.tree.find((t) => t.path === seg && t.type === 'tree');
      if (!e) return new Map();
      root = e.sha;
      base += seg + '/';
    }
    const out = new Map<string, string>();
    const r = await this.req<{ tree: TreeEntry[]; truncated: boolean }>('GET', `${this.repoPath}/git/trees/${root}?recursive=1`);
    if (!r.data.truncated) {
      for (const e of r.data.tree) if (e.type === 'blob') out.set(base + e.path, e.sha);
      return out;
    }
    // Too large for one response: walk subtrees one level at a time.
    const walk = async (sha: string, dir: string): Promise<void> => {
      const t = await this.req<{ tree: TreeEntry[] }>('GET', `${this.repoPath}/git/trees/${sha}`);
      const subs: TreeEntry[] = [];
      for (const e of t.data.tree) {
        if (e.type === 'blob') out.set(dir + e.path, e.sha);
        else if (e.type === 'tree') subs.push(e);
      }
      await mapLimit(subs, this.opts.concurrency ?? 4, (e) => walk(e.sha, dir + e.path + '/'));
    };
    await walk(root, base);
    return out;
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const r = await this.req<{ content: string; encoding: string }>('GET', `${this.repoPath}/git/blobs/${sha}`);
    if (r.data.encoding === 'base64') return base64ToBytes(r.data.content);
    return new TextEncoder().encode(r.data.content);
  }

  async commit(files: GitFileChange[], message: string, parentSha: string | null): Promise<GitHead> {
    let parent = parentSha;
    let baseTree: string | undefined;
    let pending = files;

    if (parent) {
      baseTree = await this.treeOf(parent);
    } else {
      const head = await this.getHead();
      if (head) throw new ConflictError('branch already exists on the remote');
      if (this.emptyRepo) {
        // The Git Data API cannot create blobs in an empty repository: create the first commit
        // through the Contents API, then build on top of it.
        const idx = pending.findIndex((f) => f.content && f.content.length <= BOOTSTRAP_MAX);
        const first: GitFileChange =
          idx >= 0 ? pending[idx] : { path: '.axiom', content: new TextEncoder().encode('Axiom vault\n') };
        if (idx >= 0) pending = pending.filter((_, i) => i !== idx);
        const encPath = first.path.split('/').map(encodeURIComponent).join('/');
        const r = await this.req<{ commit: { sha: string; tree: { sha: string } } }>(
          'PUT',
          `${this.repoPath}/contents/${encPath}`,
          { message, content: bytesToBase64(first.content!), branch: this.opts.branch },
          [409, 422],
        );
        if (r.status === 409 || r.status === 422) throw new ConflictError('repository was initialised concurrently');
        this.emptyRepo = false;
        parent = r.data.commit.sha;
        baseTree = r.data.commit.tree.sha;
        this.commitTrees.set(parent, baseTree);
        if (!pending.length) return { commitSha: parent, treeSha: baseTree };
      }
    }

    const concurrency = this.opts.concurrency ?? 4;
    const entries = await mapLimit(pending, concurrency, async (f) => {
      if (f.content === null) return { path: f.path, mode: '100644', type: 'blob', sha: null };
      const b = await this.req<{ sha: string }>('POST', `${this.repoPath}/git/blobs`, {
        content: bytesToBase64(f.content),
        encoding: 'base64',
      });
      return { path: f.path, mode: '100644', type: 'blob', sha: b.data.sha };
    });

    const tree = await this.req<{ sha: string }>('POST', `${this.repoPath}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries,
    });
    const commit = await this.req<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
      message,
      tree: tree.data.sha,
      parents: parent ? [parent] : [],
    });
    const commitSha = commit.data.sha;

    if (parent) {
      const r = await this.req('PATCH', `${this.repoPath}/git/refs/heads/${this.branchRef}`, { sha: commitSha, force: false }, [409, 422]);
      if (r.status === 422 || r.status === 409) throw new ConflictError();
    } else {
      const r = await this.req('POST', `${this.repoPath}/git/refs`, { ref: `refs/heads/${this.opts.branch}`, sha: commitSha }, [409, 422]);
      if (r.status === 422 || r.status === 409) throw new ConflictError('branch was created concurrently');
    }
    this.commitTrees.set(commitSha, tree.data.sha);
    return { commitSha, treeSha: tree.data.sha };
  }

  // ---------------------------------------------------------------- helpers

  private async treeOf(commitSha: string): Promise<string> {
    const hit = this.commitTrees.get(commitSha);
    if (hit) return hit;
    const c = await this.req<{ tree: { sha: string } }>('GET', `${this.repoPath}/git/commits/${commitSha}`);
    if (this.commitTrees.size > 64) this.commitTrees.clear();
    this.commitTrees.set(commitSha, c.data.tree.sha);
    return c.data.tree.sha;
  }

  /** Called when the branch ref is missing: distinguishes "no branch" from "no repo". */
  private async ensureRepo(): Promise<void> {
    const r = await this.req<{ size?: number }>('GET', this.repoPath, undefined, [404]);
    if (r.status === 200) return; // repo exists, branch does not
    if (this.opts.createRepoIfMissing === false) {
      throw new GitRemoteError(`GitHub repository ${this.owner}/${this.name} not found or not accessible`, 404);
    }
    const me = await this.req<{ login: string }>('GET', '/user');
    const body = { name: this.name, private: true, auto_init: false, description: 'Axiom vault (created by Axiom sync)' };
    const path = me.data.login.toLowerCase() === this.owner.toLowerCase() ? '/user/repos' : `/orgs/${encodeURIComponent(this.owner)}/repos`;
    const c = await this.req('POST', path, body, [422]);
    if (c.status === 422) return; // created concurrently
    this.emptyRepo = true;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function message(text: string): string {
  const j = safeJson(text) as { message?: string } | string;
  return (typeof j === 'object' && j?.message) || String(text).slice(0, 200);
}

function stripQuery(p: string) {
  return p.split('?')[0];
}

/** ms to wait before retrying, or null when the response is not retryable. */
function retryDelay(res: Response, text: string, attempt: number): number | null {
  const status = res.status;
  const retryAfter = res.headers.get('retry-after');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  const rateLimited =
    status === 429 || (status === 403 && (remaining === '0' || retryAfter !== null || /rate limit/i.test(text)));
  if (rateLimited) {
    if (retryAfter !== null && Number.isFinite(Number(retryAfter))) return Number(retryAfter) * 1000;
    if (remaining === '0' && reset !== null) return Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
    return 60_000; // secondary rate limit without hints: GitHub asks for at least a minute
  }
  if (status >= 500) return Math.min(30_000, 1000 * 2 ** attempt);
  return null;
}
