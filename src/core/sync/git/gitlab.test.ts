import { describe, expect, it } from 'vitest';
import { GitLabRemote } from './gitlab';
import { ConflictError, GitRemoteError, bytesToBase64, gitBlobSha } from './remote';
import { mockFetch } from './testFetch';

const P = '/api/v4/projects/grp%2Fsub%2Fvault';
const bytes = (s: string) => new TextEncoder().encode(s);

describe('GitLabRemote', () => {
  it('reads head, paginated recursive tree (with prefix) and raw blobs', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ json: { name: 'main', commit: { id: 'c1' } } })],
      [
        'GET',
        /\/repository\/tree\?/,
        (c) => {
          const page = new URL(c.url).searchParams.get('page');
          return page === '1'
            ? { json: [{ id: 'd', name: 'docs', type: 'tree', path: 'axiom/docs' }, { id: 'b1', name: 'index.yjs', type: 'blob', path: 'axiom/docs/index.yjs' }], headers: { 'x-next-page': '2' } }
            : { json: [{ id: 'b2', name: 'vault.json', type: 'blob', path: 'axiom/vault.json' }], headers: { 'x-next-page': '' } };
        },
      ],
      ['GET', `${P}/repository/blobs/b1/raw`, () => ({ raw: new Uint8Array([0, 200, 7]) })],
    ]);
    const gl = new GitLabRemote({ token: 'glpat-TOKEN', project: 'grp/sub/vault', branch: 'main', baseUrl: 'https://git.example/', fetch });
    expect(await gl.getHead()).toEqual({ commitSha: 'c1', treeSha: 'c1' });
    expect(calls[0].url).toBe('https://git.example/api/v4/projects/grp%2Fsub%2Fvault/repository/branches/main');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('glpat-TOKEN');
    expect(calls[0].headers.Authorization).toBeUndefined();

    const tree = await gl.listTree('c1', 'axiom');
    expect(Object.fromEntries(tree)).toEqual({ 'axiom/docs/index.yjs': 'b1', 'axiom/vault.json': 'b2' });
    const q = new URL(calls[1].url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ ref: 'c1', recursive: 'true', per_page: '100', page: '1', path: 'axiom' });
    expect(calls.filter((c) => c.path.includes('/repository/tree'))).toHaveLength(2);

    expect([...(await gl.getBlob('b1'))]).toEqual([0, 200, 7]);
  });

  it('commits with create/update/delete actions after checking the head', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ json: { commit: { id: 'p1' } } })],
      ['GET', /\/repository\/tree\?/, () => ({ json: [{ id: 'x', type: 'blob', path: 'axiom/docs/a.yjs', name: 'a.yjs' }, { id: 'y', type: 'blob', path: 'axiom/markdown/old.md', name: 'old.md' }] })],
      ['POST', `${P}/repository/commits`, () => ({ status: 201, json: { id: 'c2', parent_ids: ['p1'] } })],
    ]);
    const gl = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch });
    const head = await gl.commit(
      [
        { path: 'axiom/docs/a.yjs', content: new Uint8Array([1, 2, 3]) },
        { path: 'axiom/docs/b.yjs', content: new Uint8Array([4]) },
        { path: 'axiom/markdown/old.md', content: null },
        { path: 'axiom/markdown/never-existed.md', content: null },
      ],
      'Axiom sync',
      'p1',
    );
    expect(head).toEqual({ commitSha: 'c2', treeSha: 'c2' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      branch: 'main',
      commit_message: 'Axiom sync',
      actions: [
        { action: 'update', file_path: 'axiom/docs/a.yjs', content: bytesToBase64(new Uint8Array([1, 2, 3])), encoding: 'base64' },
        { action: 'create', file_path: 'axiom/docs/b.yjs', content: bytesToBase64(new Uint8Array([4])), encoding: 'base64' },
        { action: 'delete', file_path: 'axiom/markdown/old.md' },
      ],
    });

    // the next commit on top of c2 needs no tree listing (listing derived locally)
    const listings = calls.filter((c) => c.path.includes('/repository/tree')).length;
    const cached = await gl.listTree('c2', 'axiom');
    expect(calls.filter((c) => c.path.includes('/repository/tree')).length).toBe(listings);
    expect(cached.get('axiom/docs/b.yjs')).toBe(await gitBlobSha(new Uint8Array([4])));
    expect(cached.has('axiom/markdown/old.md')).toBe(false);
  });

  it('detects conflicts: moved head, 400 file errors, raced parent', async () => {
    const moved = mockFetch([['GET', `${P}/repository/branches/main`, () => ({ json: { commit: { id: 'other' } } })]]);
    const gl1 = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch: moved.fetch });
    await expect(gl1.commit([{ path: 'a/b', content: bytes('x') }], 'm', 'p1')).rejects.toBeInstanceOf(ConflictError);
    expect(moved.calls.some((c) => c.method === 'POST')).toBe(false);

    const rejected = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ json: { commit: { id: 'p1' } } })],
      ['GET', /\/repository\/tree\?/, () => ({ json: [] })],
      ['POST', `${P}/repository/commits`, () => ({ status: 400, json: { message: 'A file with this name already exists' } })],
    ]);
    const gl2 = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch: rejected.fetch });
    await expect(gl2.commit([{ path: 'a/b', content: bytes('x') }], 'm', 'p1')).rejects.toThrow(/already exists/);

    const raced = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ json: { commit: { id: 'p1' } } })],
      ['GET', /\/repository\/tree\?/, () => ({ json: [] })],
      ['POST', `${P}/repository/commits`, () => ({ status: 201, json: { id: 'c9', parent_ids: ['someone-else'] } })],
    ]);
    const gl3 = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch: raced.fetch });
    await expect(gl3.commit([{ path: 'a/b', content: bytes('x') }], 'm', 'p1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('creates the first commit of an empty project, and branches off the default branch otherwise', async () => {
    const empty = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ status: 404, json: { message: '404 Branch Not Found' } })],
      ['GET', P, () => ({ json: { id: 1, empty_repo: true, default_branch: null } })],
      ['POST', `${P}/repository/commits`, () => ({ status: 201, json: { id: 'c0', parent_ids: [] } })],
    ]);
    const gl = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch: empty.fetch });
    expect(await gl.getHead()).toBeNull();
    expect(await gl.commit([{ path: 'axiom/vault.json', content: bytes('{}') }], 'init', null)).toEqual({ commitSha: 'c0', treeSha: 'c0' });
    const post = empty.calls.find((c) => c.method === 'POST')!;
    expect(post.body.start_branch).toBeUndefined();
    expect(post.body.actions[0].action).toBe('create');

    const nonEmpty = mockFetch([
      ['GET', `${P}/repository/branches/axiom`, () => ({ status: 404, json: {} })],
      ['GET', P, () => ({ json: { id: 1, empty_repo: false, default_branch: 'main' } })],
      ['POST', `${P}/repository/commits`, () => ({ status: 201, json: { id: 'c0', parent_ids: ['m'] } })],
    ]);
    const gl2 = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'axiom', fetch: nonEmpty.fetch });
    await gl2.commit([{ path: 'axiom/vault.json', content: bytes('{}') }], 'init', null);
    expect(nonEmpty.calls.find((c) => c.method === 'POST')!.body.start_branch).toBe('main');
  });

  it('surfaces a missing project / bad token and retries 429', async () => {
    const { fetch } = mockFetch([
      ['GET', `${P}/repository/branches/main`, () => ({ status: 404, json: {} })],
      ['GET', P, () => ({ status: 404, json: { message: '404 Project Not Found' } })],
    ]);
    const gl = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch });
    const err = await gl.getHead().catch((e) => e);
    expect(err).toBeInstanceOf(GitRemoteError);
    expect(err.status).toBe(404);

    let n = 0;
    const slept: number[] = [];
    const r = mockFetch([
      ['GET', `${P}/repository/blobs/b/raw`, () => (++n === 1 ? { status: 429, json: {}, headers: { 'retry-after': '1' } } : { raw: bytes('ok') })],
      ['GET', `${P}/repository/blobs/x/raw`, () => ({ status: 401, json: { message: '401 Unauthorized' } })],
    ]);
    const gl2 = new GitLabRemote({ token: 't', project: 'grp/sub/vault', branch: 'main', fetch: r.fetch, sleep: async (ms) => void slept.push(ms) });
    expect(new TextDecoder().decode(await gl2.getBlob('b'))).toBe('ok');
    expect(slept).toEqual([1000]);
    expect((await gl2.getBlob('x').catch((e) => e)).status).toBe(401);
  });
});
