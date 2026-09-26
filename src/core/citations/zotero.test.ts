import { describe, expect, it, vi } from 'vitest';
import {
  ZoteroClient,
  emptyZoteroState,
  metaToZotero,
  metaToZoteroPatch,
  syncZotero,
  twoWaySync,
  zoteroToMeta,
  type ZoteroItem,
} from './zotero';

const item = (key: string, version: number, data: Partial<ZoteroItem['data']>): ZoteroItem => ({
  key,
  version,
  data: { key, version, itemType: 'journalArticle', ...data },
});

describe('mapping', () => {
  it('zoteroToMeta reads creators, date, venue, DOI (also from Extra), arXiv and citation key', () => {
    const m = zoteroToMeta(
      item('ABCD1234', 7, {
        title: 'Local-First Software',
        creators: [
          { creatorType: 'author', firstName: 'Martin', lastName: 'Kleppmann' },
          { creatorType: 'author', name: 'Ink & Switch' },
          { creatorType: 'editor', firstName: 'E', lastName: 'Ditor' },
        ],
        date: 'October 2019',
        publicationTitle: 'Onward!',
        extra: 'Citation Key: kleppmann2019localfirst\nDOI: 10.1145/3359591.3359737',
        url: 'https://example.org',
        abstractNote: 'Cloud apps…',
      }),
    );
    expect(m).toEqual({
      title: 'Local-First Software',
      authors: ['Martin Kleppmann', 'Ink & Switch'],
      year: 2019,
      venue: 'Onward!',
      doi: '10.1145/3359591.3359737',
      url: 'https://example.org',
      abstract: 'Cloud apps…',
      entryType: 'article',
      bibKey: 'kleppmann2019localfirst',
      zoteroKey: 'ABCD1234',
    });
    expect(zoteroToMeta(item('P', 1, { itemType: 'preprint', title: 'x', archiveID: 'arXiv:2101.00001' })).arxiv).toBe('2101.00001');
  });

  it('metaToZotero only uses fields valid for the item type', () => {
    expect(
      metaToZotero({ title: 'T', authors: ['Ada Lovelace', 'Plato'], year: 1843, venue: 'J', doi: '10.1/x', entryType: 'article', bibKey: 'k' }),
    ).toEqual({
      itemType: 'journalArticle',
      title: 'T',
      creators: [
        { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
        { creatorType: 'author', name: 'Plato' },
      ],
      date: '1843',
      DOI: '10.1/x',
      publicationTitle: 'J',
      extra: 'Citation Key: k',
    });
    const doc = metaToZotero({ title: 'T', doi: '10.1/y', entryType: 'misc', publisher: 'P' });
    expect(doc.itemType).toBe('document');
    expect(doc.DOI).toBeUndefined();
    expect(doc.extra).toBe('DOI: 10.1/y');
    expect(doc.publisher).toBe('P');
    const pre = metaToZotero({ title: 'T', arxiv: '2101.00001' });
    expect(pre).toMatchObject({ itemType: 'preprint', archiveID: 'arXiv:2101.00001', repository: 'arXiv' });
    expect(metaToZoteroPatch({ doi: '10.1/z' }, { itemType: 'document', extra: 'Citation Key: k' })).toEqual({ extra: 'Citation Key: k\nDOI: 10.1/z' });
  });
});

describe('twoWaySync (planning)', () => {
  const remote = [
    item('AAAA', 10, { title: 'Attention Is All You Need', date: '2017', DOI: '10.48550/arXiv.1706.03762', creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }] }),
    item('BBBB', 11, { title: 'Literate Programming', date: '1984', publicationTitle: 'The Computer Journal' }),
    item('CCCC', 12, { title: 'Only In Zotero', date: '2000' }),
  ];

  it('first sync: matches by DOI and title+year, plans creates, updates and remote gap fills', () => {
    const local = [
      { id: 's-1', bib: { title: 'attention is all you need', doi: '10.48550/ARXIV.1706.03762', bibKey: 'vaswani2017attention', abstract: 'Seq2seq.' } },
      { id: 's-2', bib: { title: 'Literate programming!', year: 1984, doi: '10.1093/comjnl/27.2.97' } },
      { id: 's-3', bib: { title: 'Brand New Local Paper', year: 2024 } },
      { id: 's-4', title: 'Untitled scan' },
    ];
    const plan = twoWaySync(local, { remoteItems: remote, remoteVersion: 12, now: 1000 });
    expect(plan.newVersion).toBe(12);
    expect(plan.state.links).toEqual({ 's-1': 'AAAA', 's-2': 'BBBB' });
    const u1 = plan.toUpdateLocal.find((u) => u.sourceId === 's-1')!;
    expect(u1.bib).toMatchObject({ title: 'Attention Is All You Need', year: 2017, authors: ['Ashish Vaswani'], zoteroKey: 'AAAA', bibKey: 'vaswani2017attention', abstract: 'Seq2seq.' });
    expect(plan.toUpdateLocal.find((u) => u.sourceId === 's-2')!.bib).toMatchObject({ venue: 'The Computer Journal', zoteroKey: 'BBBB' });
    // local-only fields are pushed to Zotero
    expect(plan.toUpdateRemote).toEqual([
      { sourceId: 's-1', key: 'AAAA', version: 10, patch: { abstractNote: 'Seq2seq.' } },
      { sourceId: 's-2', key: 'BBBB', version: 11, patch: { DOI: '10.1093/comjnl/27.2.97' } },
    ]);
    expect(plan.toCreateRemote.map((c) => [c.sourceId, c.data.title])).toEqual([
      ['s-3', 'Brand New Local Paper'],
      ['s-4', 'Untitled scan'],
    ]);
    expect(plan.remoteOnly.map((m) => m.zoteroKey)).toEqual(['CCCC']);
    expect(plan.state.index.CCCC).toEqual({ doi: undefined, ty: 'onlyinzotero|2000', v: 12 });
  });

  it('incremental sync: uses the cached index (no duplicates), unlinks deletions, pushes local edits', () => {
    const first = twoWaySync([{ id: 's-2', bib: { title: 'Literate Programming', year: 1984 } }], { remoteItems: remote, remoteVersion: 12, now: 1000 });
    const state = first.state;
    // a new local source that matches an UNCHANGED remote item (not in remoteItems)
    const plan = twoWaySync(
      [
        { id: 's-2', bib: { title: 'Literate Programming', year: 1984, zoteroKey: 'BBBB', venue: 'Comput. J.' }, updatedAt: 2000 },
        { id: 's-9', bib: { title: 'Only in Zotero', year: 2000 } },
        { id: 's-7', bib: { title: 'Gone', zoteroKey: 'AAAA' } },
      ],
      { remoteItems: [], remoteVersion: 12, deletedKeys: ['AAAA'], now: 3000 },
      state,
    );
    expect(plan.toCreateRemote).toEqual([]);
    expect(plan.state.links['s-9']).toBe('CCCC');
    expect(plan.unlinked).toEqual(['s-7']);
    expect(plan.toUpdateLocal.find((u) => u.sourceId === 's-7')!.bib.zoteroKey).toBeUndefined();
    expect(plan.toUpdateLocal.find((u) => u.sourceId === 's-9')!.bib.zoteroKey).toBe('CCCC');
    const push = plan.toUpdateRemote.find((u) => u.sourceId === 's-2')!;
    expect(push).toMatchObject({ key: 'BBBB', version: 11, patch: { title: 'Literate Programming', date: '1984', publicationTitle: 'Comput. J.' } });
    expect(plan.state.index.AAAA).toBeUndefined();
    expect(plan.state.lastSyncAt).toBe(3000);
  });

  it('respects createRemote: false and never links one remote item twice', () => {
    const plan = twoWaySync(
      [
        { id: 'a', bib: { title: 'Literate Programming', year: 1984 } },
        { id: 'b', bib: { title: 'Literate Programming', year: 1984 } },
      ],
      { remoteItems: remote, remoteVersion: 12, createRemote: false },
    );
    expect(Object.values(plan.state.links)).toEqual(['BBBB']);
    expect(plan.toCreateRemote).toEqual([]);
  });
});

describe('ZoteroClient + syncZotero (mock fetch)', () => {
  function server() {
    const calls: { method: string; url: string; headers: Headers; body?: unknown }[] = [];
    const lib: ZoteroItem[] = Array.from({ length: 130 }, (_, i) => item(`K${i}`, 5, { title: `Paper number ${i}`, date: '2010' }));
    lib.push({ key: 'N1', version: 5, data: { itemType: 'note' } as ZoteroItem['data'] });
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const u = new URL(url);
      calls.push({ method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
      expect(headers.get('Zotero-API-Key')).toBe('secret');
      expect(headers.get('Zotero-API-Version')).toBe('3');
      if (u.pathname === '/users/42/items/top') {
        if (headers.get('If-Modified-Since-Version') === '99') return new Response(null, { status: 304 });
        const start = Number(u.searchParams.get('start'));
        const limit = Number(u.searchParams.get('limit'));
        return new Response(JSON.stringify(lib.slice(start, start + limit)), {
          status: 200,
          headers: { 'Last-Modified-Version': '99', 'Total-Results': String(lib.length) },
        });
      }
      if (u.pathname === '/users/42/deleted') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.pathname === '/users/42/items' && init.method === 'POST') {
        expect(headers.get('Zotero-Write-Token')).toMatch(/^[0-9a-f]{32}$/);
        const body = JSON.parse(String(init.body)) as unknown[];
        const successful: Record<string, unknown> = {};
        body.forEach((_, i) => (successful[String(i)] = { key: `NEW${i}`, version: 100 }));
        return new Response(JSON.stringify({ successful, success: {}, unchanged: {}, failed: {} }), { status: 200, headers: { 'Last-Modified-Version': '100' } });
      }
      if (u.pathname.startsWith('/users/42/items/') && init.method === 'PATCH') {
        if (headers.get('If-Unmodified-Since-Version') !== '5') return new Response(null, { status: 412 });
        return new Response(null, { status: 204, headers: { 'Last-Modified-Version': '101' } });
      }
      return new Response('not found', { status: 404 });
    });
    return { fetchMock, calls };
  }

  it('paginates, filters notes, handles 304', async () => {
    const { fetchMock } = server();
    const client = new ZoteroClient({ apiKey: 'secret', userId: 42, fetch: fetchMock as unknown as typeof fetch });
    const all = await client.listItems();
    expect(all.items).toHaveLength(130);
    expect(all.libraryVersion).toBe(99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const none = await client.listItems({ since: 99 });
    expect(none).toEqual({ items: [], libraryVersion: 99, notModified: true });
    expect(() => new ZoteroClient({ apiKey: '', userId: 1 })).toThrow();
  });

  it('runs a full sync: creates, patches, applies local updates, returns new state', async () => {
    const { fetchMock, calls } = server();
    const client = new ZoteroClient({ apiKey: 'secret', userId: 42, fetch: fetchMock as unknown as typeof fetch });
    const applied: { sourceId: string; zk?: string }[] = [];
    const res = await syncZotero(
      client,
      [
        { id: 's-a', bib: { title: 'Paper number 3', year: 2010, doi: '10.5555/p3' } },
        { id: 's-b', bib: { title: 'Fresh local', year: 2024 } },
      ],
      emptyZoteroState(),
      { applyLocal: (u) => void applied.push(...u.map((x) => ({ sourceId: x.sourceId, zk: x.bib.zoteroKey }))) },
    );
    expect(res.created).toBe(1);
    expect(res.updatedRemote).toBe(1);
    expect(res.conflicts).toBe(0);
    expect(res.errors).toEqual([]);
    expect(res.state.lastVersion).toBe(99);
    expect(res.state.links).toEqual({ 's-a': 'K3', 's-b': 'NEW0' });
    expect(applied).toEqual(
      expect.arrayContaining([
        { sourceId: 's-a', zk: 'K3' },
        { sourceId: 's-b', zk: 'NEW0' },
      ]),
    );
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toMatch(/\/items\/K3$/);
    expect(patch.body).toEqual({ DOI: '10.5555/p3' });
    expect(calls.some((c) => c.url.includes('/deleted'))).toBe(false); // first sync
  });
});
