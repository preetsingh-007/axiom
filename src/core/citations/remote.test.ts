import { describe, expect, it, vi } from 'vitest';
import { crossrefWorkToMeta, lookupDoi, searchCrossref } from './crossref';
import { lookupArxiv, parseArxivAtom } from './arxiv';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const WORK = {
  DOI: '10.1145/3290605.3300234',
  URL: 'http://dx.doi.org/10.1145/3290605.3300234',
  type: 'proceedings-article',
  title: ['Local-First Software'],
  subtitle: ['You Own Your Data, in spite of the Cloud'],
  author: [
    { given: 'Martin', family: 'Kleppmann', sequence: 'first' },
    { given: 'Adam', family: 'Wiggins' },
    { name: 'The Ink & Switch Collective' },
  ],
  issued: { 'date-parts': [[2019, 10]] },
  'container-title': ['Proceedings of the 2019 ACM SIGPLAN Onward!'],
  publisher: 'ACM',
  abstract: '<jats:title>Abstract</jats:title><jats:p>Cloud apps are popular &amp; convenient.</jats:p>',
};

describe('crossref', () => {
  it('maps a work to BibMeta', () => {
    expect(crossrefWorkToMeta(WORK)).toEqual({
      title: 'Local-First Software: You Own Your Data, in spite of the Cloud',
      authors: ['Martin Kleppmann', 'Adam Wiggins', 'The Ink & Switch Collective'],
      year: 2019,
      venue: 'Proceedings of the 2019 ACM SIGPLAN Onward!',
      doi: '10.1145/3290605.3300234',
      url: 'http://dx.doi.org/10.1145/3290605.3300234',
      publisher: 'ACM',
      abstract: 'Cloud apps are popular & convenient.',
      entryType: 'inproceedings',
    });
    expect(crossrefWorkToMeta({ type: 'journal-article', title: ['X'], created: { 'date-parts': [[2001]] } })).toMatchObject({ entryType: 'article', year: 2001 });
  });

  it('lookupDoi calls the works endpoint with mailto and handles 404', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('missing')) return new Response('Resource not found.', { status: 404 });
      return jsonResponse({ status: 'ok', message: WORK });
    });
    const meta = await lookupDoi('https://doi.org/10.1145/3290605.3300234', { fetch: fetchMock as unknown as typeof fetch, mailto: 'me@example.org' });
    expect(meta?.title).toMatch(/^Local-First Software/);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1145%2F3290605.3300234?mailto=me%40example.org');
    expect(await lookupDoi('10.1234/missing', { fetch: fetchMock as unknown as typeof fetch })).toBeNull();
    expect(await lookupDoi('not a doi', { fetch: fetchMock as unknown as typeof fetch })).toBeNull();
    const failing = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(lookupDoi('10.1234/x', { fetch: failing as unknown as typeof fetch })).rejects.toThrow(/500/);
  });

  it('lookupDoi times out', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    );
    await expect(lookupDoi('10.1234/x', { fetch: hanging as unknown as typeof fetch, timeoutMs: 20 })).rejects.toThrow();
  });

  it('searchCrossref sends bibliographic + author queries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: { items: [WORK, { title: ['Other'], type: 'book' }] } }));
    const res = await searchCrossref('local-first software', 'Kleppmann', { fetch: fetchMock as unknown as typeof fetch, rows: 2 });
    expect(res.map((r) => r.entryType)).toEqual(['inproceedings', 'book']);
    const url = new URL(fetchMock.mock.calls[0][0 as never] as unknown as string);
    expect(url.searchParams.get('query.bibliographic')).toBe('local-first software');
    expect(url.searchParams.get('query.author')).toBe('Kleppmann');
    expect(url.searchParams.get('rows')).toBe('2');
    expect(await searchCrossref('  ')).toEqual([]);
  });
});

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query: id_list=1706.03762</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent networks. </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL"/>
  </entry>
</feed>`;

describe('arxiv', () => {
  it('parses the Atom feed', () => {
    expect(parseArxivAtom(ATOM)).toEqual({
      title: 'Attention Is All You Need',
      entryType: 'misc',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      arxiv: '1706.03762v7',
      url: 'https://arxiv.org/abs/1706.03762v7',
      abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
      doi: '10.48550/arxiv.1706.03762',
      venue: 'arXiv',
    });
    expect(parseArxivAtom('<feed><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry></feed>')).toBeNull();
    expect(parseArxivAtom('<feed></feed>')).toBeNull();
  });

  it('lookupArxiv returns null on network/CORS failure', async () => {
    const ok = vi.fn(async () => new Response(ATOM, { status: 200 }));
    expect((await lookupArxiv('arXiv:1706.03762', { fetch: ok as unknown as typeof fetch }))?.arxiv).toBe('1706.03762v7');
    expect(String(ok.mock.calls[0][0 as never])).toContain('id_list=1706.03762');
    const cors = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await lookupArxiv('1706.03762', { fetch: cors as unknown as typeof fetch })).toBeNull();
    expect(await lookupArxiv('nonsense', { fetch: ok as unknown as typeof fetch })).toBeNull();
  });
});
