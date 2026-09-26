/** Matching and merging of bibliographic records (shared by Zotero and .bib sync). */
import type { BibMeta } from '../schema';
import { asciiFold } from './names';

export function normalizeDoi(doi: string | undefined | null): string | undefined {
  if (!doi) return undefined;
  const d = doi
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

/** "Attention Is All You Need!" → "attentionisallyouneed" */
export function normalizeTitleKey(title: string | undefined | null): string | undefined {
  if (!title) return undefined;
  const k = asciiFold(title.replace(/\$[^$]*\$/g, ' '))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return k.length >= 4 ? k : undefined;
}

export function titleYearKey(meta: Pick<BibMeta, 'title' | 'year'>): string | undefined {
  const t = normalizeTitleKey(meta.title);
  return t ? `${t}|${meta.year ?? ''}` : undefined;
}

const FIELDS: (keyof BibMeta)[] = ['title', 'authors', 'year', 'venue', 'doi', 'arxiv', 'url', 'publisher', 'entryType', 'bibKey', 'abstract', 'zoteroKey'];

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Merges two records. `prefer: 'incoming'` lets non-empty incoming fields win
 * (except those listed in `keep`); `prefer: 'base'` only fills gaps.
 */
export function mergeBib(base: BibMeta | undefined, incoming: BibMeta, prefer: 'incoming' | 'base' = 'incoming', keep: (keyof BibMeta)[] = []): BibMeta {
  const out: BibMeta = { ...(base ?? {}) };
  for (const f of FIELDS) {
    const v = incoming[f];
    if (isEmpty(v)) continue;
    const cur = out[f];
    if (isEmpty(cur) || (prefer === 'incoming' && !keep.includes(f))) (out as Record<string, unknown>)[f] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export function bibEqual(a: BibMeta | undefined, b: BibMeta | undefined): boolean {
  for (const f of FIELDS) {
    const x = a?.[f];
    const y = b?.[f];
    if (isEmpty(x) && isEmpty(y)) continue;
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Fields present in `local` but missing in `remote`. */
export function missingFields(local: BibMeta | undefined, remote: BibMeta, fields: (keyof BibMeta)[]): Partial<BibMeta> {
  const out: Partial<BibMeta> = {};
  for (const f of fields) {
    if (!isEmpty(local?.[f]) && isEmpty(remote[f])) (out as Record<string, unknown>)[f] = local![f];
  }
  return out;
}
