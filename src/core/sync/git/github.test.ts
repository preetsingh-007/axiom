import { describe, expect, it } from 'vitest';
import { GitHubRemote } from './github';
import { ConflictError, GitRemoteError, base64ToBytes, bytesToBase64 } from './remote';
import { mockFetch, type MockReply } from './testFetch';

const bytes = (s: string) => new TextEncoder().encode(s);
const R = '/repos/me/vault';

describe('GitHubRemote', () => {
  it('reads head, tree and blobs with the right headers (custom base URL)', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/api/v3/repos/me/vault/git/ref/heads/main', () => ({ json: { object: { sha: 'c1' } } })],
      ['GET', '/api/v3/repos/me/vault/git/commits/c1', () => ({ json: { tree: { sha: 't1' } } })],
      ['GET', '/api/v3/repos/me/vault/git/trees/t1', () => ({ json: { tree: [{ path: 'axiom', type: 'tree', sha: 'ta', mode: '040000' }, { path: 'README.md', type: 'blob', sha: 'r', mode: '100644' }] } })],
      ['GET', '/api/v3/repos/me/vault/git/trees/ta?recursive=1', () => ({ json: { truncated: false, tree: [{ path: 'docs', type: 'tree', sha: 'td' }, { path: 'docs/index.yjs', type: 'blob', sha: 'b1' }, { path: 'vault.json', type: 'blob', sha: 'b2' }] } })],
      ['GET', '/api/v3/repos/me/vault/git/blobs/b1', () => ({ json: { encoding: 'base64', content: bytesToBase64(bytes('hello')).replace(/(.{2})/g, '$1\n') } })],
    ]);
    const gh = new GitHubRemote({ token: 'ghp_TOKEN', repo: 'me/vault', branch: 'main', baseUrl: 'https://ghe.example/api/v3/', fetch });
    const head = await gh.getHead();
    expect(head).toEqual({ commitSha: 'c1', treeSha: 't1' });
    expect(calls[0].url).toBe('https://ghe.example/api/v3/repos/me/vault/git/ref/heads/main');
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer ghp_TOKEN', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    const tree = await gh.listTree('t1', 'axiom');
    expect([...tree]).toEqual([
      ['axiom/docs/index.yjs', 'b1'],
      ['axiom/vault.json', 'b2'],
    ]);
    expect(new TextDecoder().decode(await gh.getBlob('b1'))).toBe('hello');
    expect(gh.id).toBe('github:https://ghe.example/api/v3/me/vault#main');
  });

  it('walks subtrees when the recursive listing is truncated', async () => {
    const { fetch } = mockFetch([
      ['GET', `${R}/git/trees/root?recursive=1`, () => ({ json: { truncated: true, tree: [] } })],
      ['GET', `${R}/git/trees/root`, () => ({ json: { tree: [{ path: 'a', type: 'tree', sha: 'A' }, { path: 'x.md', type: 'blob', sha: 'X' }] } })],
      ['GET', `${R}/git/trees/A`, () => ({ json: { tree: [{ path: 'b', type: 'tree', sha: 'B' }, { path: 'y', type: 'blob', sha: 'Y' }] } })],
      ['GET', `${R}/git/trees/B`, () => ({ json: { tree: [{ path: 'z', type: 'blob', sha: 'Z' }] } })],
    ]);
    const gh = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'main', fetch });
    const tree = await gh.listTree('root');
    expect(Object.fromEntries(tree)).toEqual({ 'x.md': 'X', 'a/y': 'Y', 'a/b/z': 'Z' });
  });

  it('commits on top of a parent: blobs → tree(base_tree) → commit → ref (force: false)', async () => {
    let blobN = 0;
    const { fetch, calls } = mockFetch([
      ['GET', `${R}/git/commits/p1`, () => ({ json: { tree: { sha: 'pt1' } } })],
      ['POST', `${R}/git/blobs`, () => ({ status: 201, json: { sha: 'blob' + ++blobN } })],
      ['POST', `${R}/git/trees`, () => ({ status: 201, json: { sha: 'nt' } })],
      ['POST', `${R}/git/commits`, () => ({ status: 201, json: { sha: 'nc' } })],
      ['PATCH', `${R}/git/refs/heads/feature/notes`, () => ({ json: { object: { sha: 'nc' } } })],
    ]);
    const gh = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'feature/notes', fetch });
    const head = await gh.commit(
      [
        { path: 'axiom/docs/a.yjs', content: new Uint8Array([0, 1, 255]) },
        { path: 'axiom/markdown/old.md', content: null },
      ],
      'Axiom sync',
      'p1',
    );
    expect(head).toEqual({ commitSha: 'nc', treeSha: 'nt' });
    const blob = calls.find((c) => c.url.endsWith('/git/blobs'))!;
    expect(blob.body).toEqual({ content: bytesToBase64(new Uint8Array([0, 1, 255])), encoding: 'base64' });
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))!;
    expect(tree.body).toEqual({
      base_tree: 'pt1',
      tree: [
        { path: 'axiom/docs/a.yjs', mode: '100644', type: 'blob', sha: 'blob1' },
        { path: 'axiom/markdown/old.md', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))!.body).toEqual({ message: 'Axiom sync', tree: 'nt', parents: ['p1'] });
    expect(calls.at(-1)!.body).toEqual({ sha: 'nc', force: false });
  });

  it('maps a rejected (non-fast-forward) ref update to ConflictError', async () => {
    const { fetch } = mockFetch([
      ['GET', `${R}/git/commits/p1`, () => ({ json: { tree: { sha: 'pt1' } } })],
      ['POST', `${R}/git/blobs`, () => ({ status: 201, json: { sha: 'b' } })],
      ['POST', `${R}/git/trees`, () => ({ status: 201, json: { sha: 'nt' } })],
      ['POST', `${R}/git/commits`, () => ({ status: 201, json: { sha: 'nc' } })],
      ['PATCH', `${R}/git/refs/heads/main`, () => ({ status: 422, json: { message: 'Update is not a fast forward' } })],
    ]);
    const gh = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'main', fetch });
    await expect(gh.commit([{ path: 'f', content: bytes('x') }], 'm', 'p1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('bootstraps an empty repository through the Contents API', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', `${R}/git/ref/heads/main`, () => ({ status: 409, json: { message: 'Git Repository is empty.' } })],
      ['PUT', `${R}/contents/axiom/vault.json`, () => ({ status: 201, json: { commit: { sha: 'c0', tree: { sha: 't0' } } } })],
      ['POST', `${R}/git/blobs`, () => ({ status: 201, json: { sha: 'b1' } })],
      ['POST', `${R}/git/trees`, () => ({ status: 201, json: { sha: 't1' } })],
      ['POST', `${R}/git/commits`, () => ({ status: 201, json: { sha: 'c1' } })],
      ['PATCH', `${R}/git/refs/heads/main`, () => ({ json: {} })],
    ]);
    const gh = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'main', fetch });
    expect(await gh.getHead()).toBeNull();
    const head = await gh.commit(
      [
        { path: 'axiom/vault.json', content: bytes('{"format":1}') },
        { path: 'axiom/docs/index.yjs', content: new Uint8Array([1, 2]) },
      ],
      'init',
      null,
    );
    expect(head).toEqual({ commitSha: 'c1', treeSha: 't1' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ message: 'init', content: bytesToBase64(bytes('{"format":1}')), branch: 'main' });
    expect(calls.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith('/git/trees'))!.body.base_tree).toBe('t0');
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))!.body.parents).toEqual(['c0']);
  });

  it('creates a missing repository, then an orphan branch in a non-empty repo', async () => {
    let repoExists = false;
    const { fetch, calls } = mockFetch([
      ['GET', `${R}/git/ref/heads/main`, () => ({ status: 404, json: { message: 'Not Found' } })],
      ['GET', R, () => (repoExists ? { json: { size: 1 } } : { status: 404, json: { message: 'Not Found' } })],
      ['GET', '/user', () => ({ json: { login: 'Me' } })],
      [
        'POST',
        '/user/repos',
        () => {
          repoExists = true;
          return { status: 201, json: {} };
        },
      ],
    ]);
    const gh = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'main', fetch });
    expect(await gh.getHead()).toBeNull();
    const create = calls.find((c) => c.url.endsWith('/user/repos'))!;
    expect(create.body).toMatchObject({ name: 'vault', private: true });

    // existing, non-empty repo without the branch: orphan commit + create ref
    const { fetch: f2, calls: c2 } = mockFetch([
      ['GET', `${R}/git/ref/heads/axiom`, () => ({ status: 404, json: {} })],
      ['GET', R, () => ({ json: { size: 10 } })],
      ['POST', `${R}/git/blobs`, () => ({ status: 201, json: { sha: 'b' } })],
      ['POST', `${R}/git/trees`, () => ({ status: 201, json: { sha: 't' } })],
      ['POST', `${R}/git/commits`, () => ({ status: 201, json: { sha: 'c' } })],
      ['POST', `${R}/git/refs`, () => ({ status: 201, json: {} })],
    ]);
    const gh2 = new GitHubRemote({ token: 't', repo: 'me/vault', branch: 'axiom', fetch: f2 });
    expect(await gh2.commit([{ path: 'a', content: bytes('a') }], 'm', null)).toEqual({ commitSha: 'c', treeSha: 't' });
    expect(c2.find((c) => c.url.endsWith('/git/trees'))!.body.base_tree).toBeUndefined();
    expect(c2.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))!.body.parents).toEqual([]);
    expect(c2.at(-1)!.body).toEqual({ ref: 'refs/heads/axiom', sha: 'c' });
  });

  it('backs off on rate limits and surfaces auth errors', async () => {
    let n = 0;
    const slept: number[] = [];
    const reset = Math.floor(Date.now() / 1000) + 5;
    const { fetch } = mockFetch([
      [
        'GET',
        `${R}/git/blobs/b`,
        (): MockReply =>
          ++n === 1
            ? { status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }
            : n === 2
              ? { status: 429, json: {}, headers: { 'retry-after': '2' } }
              : { json: { encoding: 'base64', content: bytesToBase64(bytes('ok')) }, headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(reset) } },
      ],
      ['GET', `${R}/git/blobs/denied`, () => ({ status: 401, json: { message: 'Bad credentials' } })],
      ['GET', `${R}/git/blobs/slow`, () => ({ status: 429, json: {}, headers: { 'retry-after': '3600' } })],
    ]);
    const gh = new GitHubRemote({ token: 'ghp_SECRET_TOKEN', repo: 'me/vault', branch: 'main', fetch, sleep: async (ms) => void slept.push(ms) });
    expect(new TextDecoder().decode(await gh.getBlob('b'))).toBe('ok');
    expect(slept).toHaveLength(2);
    expect(slept[0]).toBeGreaterThan(3000);
    expect(slept[0]).toBeLessThanOrEqual(7000);
    expect(slept[1]).toBe(2000);
    expect(gh.rateLimit?.remaining).toBe(4999);

    const err = await gh.getBlob('denied').catch((e) => e);
    expect(err).toBeInstanceOf(GitRemoteError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain('ghp_SECRET_TOKEN');

    const slow = await gh.getBlob('slow').catch((e) => e);
    expect(slow).toBeInstanceOf(GitRemoteError);
    expect(slow.retryAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('base64 helpers handle large binary payloads', () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 31) & 255);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});
