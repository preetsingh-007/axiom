import { ConflictError, gitBlobSha, type GitFileChange, type GitHead, type GitRemote } from './remote';

interface MemCommit {
  sha: string;
  treeSha: string;
  parent: string | null;
  message: string;
}

/**
 * Deterministic in-memory Git remote with real fast-forward semantics, for tests and demos.
 * Several GitSync instances can share one MemoryGitRemote to simulate devices.
 */
export class MemoryGitRemote implements GitRemote {
  readonly id: string;
  private blobs = new Map<string, Uint8Array>();
  private trees = new Map<string, Map<string, string>>();
  private commits = new Map<string, MemCommit>();
  private head: string | null = null;
  private counter = 0;
  /** call counters, handy for asserting "not re-uploaded" */
  readonly stats = { getHead: 0, listTree: 0, getBlob: 0, commits: 0, filesWritten: 0, conflicts: 0 };
  /**
   * Hook run at the start of every commit() (before the fast-forward check). Use it to simulate
   * another device pushing concurrently. Return value is ignored.
   */
  beforeCommit: ((remote: MemoryGitRemote) => Promise<void> | void) | undefined;
  /** make the next N commits fail with ConflictError regardless of state */
  failNextCommits = 0;

  constructor(id = 'memory') {
    this.id = id;
  }

  async getHead(): Promise<GitHead | null> {
    this.stats.getHead++;
    if (!this.head) return null;
    const c = this.commits.get(this.head)!;
    return { commitSha: c.sha, treeSha: c.treeSha };
  }

  async listTree(treeSha: string, prefix?: string): Promise<Map<string, string>> {
    this.stats.listTree++;
    const tree = this.trees.get(treeSha);
    if (!tree) throw new Error('unknown tree ' + treeSha);
    if (!prefix) return new Map(tree);
    const p = prefix.replace(/\/+$/, '') + '/';
    const out = new Map<string, string>();
    for (const [k, v] of tree) if (k.startsWith(p)) out.set(k, v);
    return out;
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    this.stats.getBlob++;
    const b = this.blobs.get(sha);
    if (!b) throw new Error('unknown blob ' + sha);
    return b.slice();
  }

  async commit(files: GitFileChange[], message: string, parentSha: string | null): Promise<GitHead> {
    if (this.beforeCommit) {
      const hook = this.beforeCommit;
      this.beforeCommit = undefined; // one-shot, so the hook can itself commit
      await hook(this);
    }
    if (this.failNextCommits > 0) {
      this.failNextCommits--;
      this.stats.conflicts++;
      throw new ConflictError();
    }
    if (parentSha !== this.head) {
      this.stats.conflicts++;
      throw new ConflictError();
    }
    const base = parentSha ? this.trees.get(this.commits.get(parentSha)!.treeSha)! : new Map<string, string>();
    const tree = new Map(base);
    for (const f of files) {
      if (f.content === null) {
        tree.delete(f.path);
        continue;
      }
      const sha = await gitBlobSha(f.content);
      this.blobs.set(sha, f.content.slice());
      tree.set(f.path, sha);
      this.stats.filesWritten++;
    }
    const treeSha = 'tree-' + ++this.counter;
    this.trees.set(treeSha, tree);
    const sha = 'commit-' + this.counter;
    this.commits.set(sha, { sha, treeSha, parent: parentSha, message });
    this.head = sha;
    this.stats.commits++;
    return { commitSha: sha, treeSha };
  }

  // ---------- test helpers ----------

  /** Commit directly (e.g. to simulate another client) on top of the current head. */
  async pushDirect(files: GitFileChange[], message = 'external'): Promise<GitHead> {
    return this.commit(files, message, this.head);
  }

  /** Current files as path → bytes. */
  snapshot(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    if (!this.head) return out;
    const tree = this.trees.get(this.commits.get(this.head)!.treeSha)!;
    for (const [p, sha] of tree) out.set(p, this.blobs.get(sha)!);
    return out;
  }

  /** Commit messages from head to root. */
  log(): string[] {
    const out: string[] = [];
    for (let c = this.head ? this.commits.get(this.head) : undefined; c; c = c.parent ? this.commits.get(c.parent) : undefined) {
      out.push(c.message);
    }
    return out;
  }
}
