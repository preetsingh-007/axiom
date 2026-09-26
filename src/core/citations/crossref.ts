/**
 * Crossref REST API (CORS-enabled, no key): DOI lookup and bibliographic search.
 * Pass `mailto` to join Crossref's "polite pool".
 */
import type { BibMeta } from '../schema';
import { fetchWithTimeout, HttpError, type HttpOptions } from './http';

export interface CrossrefOptions extends HttpOptions {
  mailto?: string;
  /** API base (default https://api.crossref.org) */
  baseUrl?: string;
}

const TYPE_MAP: Record<string, string> = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book-chapter': 'incollection',
  'book-section': 'incollection',
  'book-part': 'incollection',
  'reference-entry': 'incollection',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-set': 'book',
  proceedings: 'proceedings',
  report: 'techreport',
  'report-series': 'techreport',
  dissertation: 'phdthesis',
  'posted-content': 'misc',
  dataset: 'misc',
  standard: 'misc',
  other: 'misc',
};

interface CrossrefDate {
  'date-parts'?: (number | null)[][];
}

export interface CrossrefWork {
  DOI?: string;
  URL?: string;
  type?: string;
  title?: string[];
  subtitle?: string[];
  author?: { given?: string; family?: string; name?: string; sequence?: string }[];
  editor?: { given?: string; family?: string; name?: string }[];
  issued?: CrossrefDate;
  'published-print'?: CrossrefDate;
  'published-online'?: CrossrefDate;
  created?: CrossrefDate;
  'container-title'?: string[];
  'short-container-title'?: string[];
  publisher?: string;
  abstract?: string;
  relation?: Record<string, { 'id-type'?: string; id?: string }[]>;
}

function stripJats(s: string): string {
  return s
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearOf(...dates: (CrossrefDate | undefined)[]): number | undefined {
  for (const d of dates) {
    const y = d?.['date-parts']?.[0]?.[0];
    if (typeof y === 'number' && y > 0) return y;
  }
  return undefined;
}

/** Maps a Crossref `message` (work) to BibMeta. */
export function crossrefWorkToMeta(w: CrossrefWork): BibMeta {
  const meta: BibMeta = {};
  const title = w.title?.[0]?.replace(/\s+/g, ' ').trim();
  if (title) {
    const sub = w.subtitle?.[0]?.trim();
    meta.title = sub && !title.includes(sub) ? `${title}: ${sub}` : title;
  }
  const people = w.author?.length ? w.author : (w.editor ?? []);
  const authors = people
    .map((a) => (a.name ?? [a.given, a.family].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (authors.length) meta.authors = authors;
  const year = yearOf(w.issued, w['published-print'], w['published-online'], w.created);
  if (year) meta.year = year;
  const venue = w['container-title']?.[0];
  if (venue) meta.venue = venue;
  if (w.DOI) meta.doi = w.DOI.toLowerCase();
  if (w.URL) meta.url = w.URL;
  if (w.publisher) meta.publisher = w.publisher;
  if (w.abstract) meta.abstract = stripJats(w.abstract);
  meta.entryType = TYPE_MAP[w.type ?? ''] ?? 'misc';
  const arxiv = Object.values(w.relation ?? {})
    .flat()
    .find((r) => r?.['id-type'] === 'arxiv')?.id;
  if (arxiv) meta.arxiv = arxiv.replace(/^arxiv:/i, '');
  return meta;
}

function withMailto(url: string, mailto?: string): string {
  if (!mailto) return url;
  return url + (url.includes('?') ? '&' : '?') + 'mailto=' + encodeURIComponent(mailto);
}

/**
 * Metadata for a DOI. Resolves null when Crossref does not know the DOI (404);
 * throws on network errors/timeouts so callers can tell "offline" apart.
 */
export async function lookupDoi(doi: string, opts: CrossrefOptions = {}): Promise<BibMeta | null> {
  const clean = doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (!/^10\.\d{4,9}\//.test(clean)) return null;
  const base = opts.baseUrl ?? 'https://api.crossref.org';
  const url = withMailto(`${base}/works/${encodeURIComponent(clean)}`, opts.mailto);
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, `Crossref lookup failed (${res.status})`, res);
  const json = (await res.json()) as { message?: CrossrefWork };
  return json.message ? crossrefWorkToMeta(json.message) : null;
}

/** Bibliographic search by title (and optionally author); best matches first. */
export async function searchCrossref(title: string, author?: string, opts: CrossrefOptions & { rows?: number } = {}): Promise<BibMeta[]> {
  const q = title.trim();
  if (!q) return [];
  const base = opts.baseUrl ?? 'https://api.crossref.org';
  const params = new URLSearchParams({ 'query.bibliographic': q, rows: String(opts.rows ?? 5) });
  if (author?.trim()) params.set('query.author', author.trim());
  params.set('select', 'DOI,URL,type,title,subtitle,author,editor,issued,published-print,published-online,container-title,publisher,abstract');
  const url = withMailto(`${base}/works?${params.toString()}`, opts.mailto);
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, opts);
  if (!res.ok) throw new HttpError(res.status, `Crossref search failed (${res.status})`, res);
  const json = (await res.json()) as { message?: { items?: CrossrefWork[] } };
  return (json.message?.items ?? []).map(crossrefWorkToMeta);
}
