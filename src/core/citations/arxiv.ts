/**
 * arXiv export API (Atom). NOTE: export.arxiv.org does not reliably send CORS
 * headers, so browser requests may fail; `lookupArxiv` then resolves null. Route
 * through a proxy by passing `baseUrl` if needed.
 */
import type { BibMeta } from '../schema';
import { fetchWithTimeout, type HttpOptions } from './http';
import { attr, child, childrenNamed, find, parseXml, textContent, type XmlElement } from '../ingest/xml';

export interface ArxivOptions extends HttpOptions {
  /** default https://export.arxiv.org/api/query */
  baseUrl?: string;
}

/** Parses the first <entry> of an arXiv Atom feed. */
export function parseArxivAtom(xml: string): BibMeta | null {
  const doc = parseXml(xml);
  const entry = find(doc, 'entry');
  if (!entry) return null;
  const idUrl = textContent(child(entry, 'id')).trim();
  if (!idUrl || /api\/errors/.test(idUrl)) return null;
  const title = textContent(child(entry, 'title')).replace(/\s+/g, ' ').trim();
  if (!title || title === 'Error') return null;
  const meta: BibMeta = { title, entryType: 'misc' };
  const authors = childrenNamed(entry, 'author')
    .map((a) => textContent(child(a, 'name')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (authors.length) meta.authors = authors;
  const published = textContent(child(entry, 'published')).trim();
  const y = /^(\d{4})/.exec(published);
  if (y) meta.year = Number(y[1]);
  const idm = /arxiv\.org\/abs\/(.+)$/.exec(idUrl);
  if (idm) meta.arxiv = idm[1];
  meta.url = idUrl.replace(/^http:/, 'https:');
  const summary = textContent(child(entry, 'summary')).replace(/\s+/g, ' ').trim();
  if (summary) meta.abstract = summary;
  const doi = textContent(child(entry, 'doi')).trim();
  if (doi) meta.doi = doi.toLowerCase();
  const jref = textContent(child(entry, 'journal_ref')).replace(/\s+/g, ' ').trim();
  meta.venue = jref || 'arXiv';
  if (jref && doi) meta.entryType = 'article';
  const pdfLink = childrenNamed(entry, 'link').find((l: XmlElement) => attr(l, 'title') === 'pdf');
  if (!meta.url && pdfLink) meta.url = attr(pdfLink, 'href');
  return meta;
}

/** Metadata for an arXiv id ("2101.00001v2", "hep-th/9901001"); null on any failure (incl. CORS). */
export async function lookupArxiv(id: string, opts: ArxivOptions = {}): Promise<BibMeta | null> {
  const clean = id.trim().replace(/^arxiv:/i, '');
  if (!/^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.test(clean)) return null;
  const base = opts.baseUrl ?? 'https://export.arxiv.org/api/query';
  try {
    const res = await fetchWithTimeout(`${base}?id_list=${encodeURIComponent(clean)}&max_results=1`, {}, opts);
    if (!res.ok) return null;
    return parseArxivAtom(await res.text());
  } catch {
    return null;
  }
}
