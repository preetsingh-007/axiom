// A small in-memory stand-in for the GitHub REST API (git data endpoints), installed with
// Playwright routing so the real app's Git backup runs unmodified during the recording without
// touching anyone's GitHub account. Everything the app pushes can be read back afterwards
// (files + commit log) to draw the repository view in the video.
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha1').update(s).digest('hex');

export function createGitHubSim({ owner = 'maya-okafor', repo = 'axiom-vault', branch = 'main', latencyMs = 120 } = {}) {
  const blobs = new Map(); // sha -> base64
  const trees = new Map(); // sha -> Map(path -> blobSha) (flat, full paths)
  const commits = new Map(); // sha -> { tree, parents, message, date }
  const refs = new Map();
  const log = [];

  const putTree = (files) => {
    const key = sha('tree' + [...files].sort().map(([p, s]) => p + ':' + s).join('\n'));
    trees.set(key, new Map(files));
    return key;
  };
  // the repository starts with a README commit
  const readme = Buffer.from(`# ${repo}\n\nMy research notes, backed up by Axiom.\n`).toString('base64');
  const readmeSha = sha('blob' + readme);
  blobs.set(readmeSha, readme);
  const t0 = putTree([['README.md', readmeSha]]);
  const c0 = sha('commit0');
  commits.set(c0, { tree: t0, parents: [], message: 'Initial commit', date: new Date(Date.now() - 86400e3 * 3).toISOString() });
  refs.set(branch, c0);

  const entriesOf = (treeSha, recursive) => {
    const files = trees.get(treeSha.split(':')[0]);
    const prefix = treeSha.includes(':') ? treeSha.split(':')[1] + '/' : '';
    const out = [];
    const dirs = new Set();
    for (const [p, s] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!recursive && rest.includes('/')) {
        const d = rest.split('/')[0];
        if (!dirs.has(d)) dirs.add(d), out.push({ path: d, mode: '040000', type: 'tree', sha: `${treeSha.split(':')[0]}:${prefix}${d}` });
        continue;
      }
      out.push({ path: rest, mode: '100644', type: 'blob', sha: s });
    }
    return out;
  };

  const base = `/repos/${owner}/${repo}`;
  async function handle(method, path, body) {
    const p = path.split('?')[0];
    if (method === 'GET' && p === '/user') return [200, { login: owner }];
    if (method === 'GET' && p === base) return [200, { full_name: `${owner}/${repo}`, private: true, size: 1 }];
    if (method === 'GET' && p.startsWith(`${base}/git/ref/heads/`)) {
      const b = decodeURIComponent(p.slice(`${base}/git/ref/heads/`.length));
      return refs.has(b) ? [200, { ref: `refs/heads/${b}`, object: { sha: refs.get(b), type: 'commit' } }] : [404, { message: 'Not Found' }];
    }
    if (method === 'GET' && p.startsWith(`${base}/git/commits/`)) {
      const c = commits.get(p.split('/').pop());
      return c ? [200, { sha: p.split('/').pop(), tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message }] : [404, {}];
    }
    if (method === 'GET' && p.startsWith(`${base}/git/trees/`)) {
      const id = decodeURIComponent(p.slice(`${base}/git/trees/`.length));
      if (!trees.has(id.split(':')[0])) return [404, {}];
      return [200, { sha: id, tree: entriesOf(id, path.includes('recursive=1')), truncated: false }];
    }
    if (method === 'GET' && p.startsWith(`${base}/git/blobs/`)) {
      const b = blobs.get(p.split('/').pop());
      return b ? [200, { content: b, encoding: 'base64' }] : [404, {}];
    }
    if (method === 'POST' && p === `${base}/git/blobs`) {
      const s = sha('blob' + body.content);
      blobs.set(s, body.content);
      return [201, { sha: s }];
    }
    if (method === 'POST' && p === `${base}/git/trees`) {
      const files = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const e of body.tree) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, e.sha);
      }
      return [201, { sha: putTree([...files]) }];
    }
    if (method === 'POST' && p === `${base}/git/commits`) {
      const s = sha('commit' + body.tree + body.parents.join() + body.message + Math.random());
      commits.set(s, { tree: body.tree, parents: body.parents, message: body.message, date: new Date().toISOString() });
      return [201, { sha: s }];
    }
    if (method === 'PATCH' && p.startsWith(`${base}/git/refs/heads/`)) {
      const b = decodeURIComponent(p.slice(`${base}/git/refs/heads/`.length));
      const head = refs.get(b);
      if (!body.force && head && !isAncestor(head, body.sha)) return [422, { message: 'Update is not a fast forward' }];
      refs.set(b, body.sha);
      return [200, { object: { sha: body.sha } }];
    }
    if (method === 'POST' && p === `${base}/git/refs`) {
      const b = body.ref.replace('refs/heads/', '');
      if (refs.has(b)) return [422, { message: 'Reference already exists' }];
      refs.set(b, body.sha);
      return [201, { object: { sha: body.sha } }];
    }
    return [404, { message: `sim: ${method} ${p} not implemented` }];
  }

  function isAncestor(a, b) {
    const seen = new Set([b]);
    const q = [b];
    while (q.length) {
      const c = q.shift();
      if (c === a) return true;
      for (const p of commits.get(c)?.parents ?? []) if (!seen.has(p)) seen.add(p), q.push(p);
    }
    return false;
  }

  return {
    owner,
    repo,
    log,
    async install(context) {
      await context.route('https://api.github.com/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const body = req.postData() ? JSON.parse(req.postData()) : undefined;
        await new Promise((r) => setTimeout(r, latencyMs));
        const [status, json] = await handle(req.method(), url.pathname + url.search, body);
        log.push(`${req.method()} ${url.pathname} → ${status}`);
        await route.fulfill({
          status,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
          body: JSON.stringify(json),
        });
      });
    },
    /** Files on the branch head and the commit log (newest first). */
    snapshot() {
      const head = refs.get(branch);
      const files = [...trees.get(commits.get(head).tree)].map(([path, s]) => ({ path, content: Buffer.from(blobs.get(s), 'base64').toString('utf8') }));
      const history = [];
      for (let c = head; c; c = commits.get(c).parents[0]) history.push({ sha: c, message: commits.get(c).message, date: commits.get(c).date });
      return { owner, repo, branch, files, history };
    },
  };
}
