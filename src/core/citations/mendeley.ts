/**
 * Mendeley sync via BibTeX files.
 *
 * Mendeley's REST API requires a registered OAuth app, so Axiom syncs through
 * .bib files instead: Mendeley Desktop / Reference Manager (and Zotero with
 * Better BibTeX, JabRef, …) can auto-export a library to a .bib file and import
 * one. `exportLibraryBib` writes the Axiom library as BibTeX (stable keys, an
 * `axiomid` field for exact round-trips); `importBibIntoSources` matches entries
 * of an exported .bib back onto Axiom sources and returns metadata updates.
 */
import type { BibMeta, SourceMeta } from '../schema';
import { bibToMeta, metaToBib, parseBibtex, serializeBibtex, type BibEntry } from './bibtex';
import { makeCiteKey } from './citekey';
import { bibEqual, mergeBib, normalizeDoi, normalizeTitleKey, titleYearKey } from './match';

type SourceLike = Pick<SourceMeta, 'id' | 'title'> & { bib?: BibMeta };

/** BibTeX for the whole library (keys: bib.bibKey, else a generated standard key). */
export function exportLibraryBib(sources: SourceLike[], opts: { includeAbstracts?: boolean; includeAxiomId?: boolean } = {}): string {
  const used = new Set<string>();
  const entries: BibEntry[] = [];
  for (const s of sources) {
    const bib: BibMeta = { ...(s.bib ?? {}) };
    if (!bib.title) bib.title = s.title;
    if (opts.includeAbstracts === false) delete bib.abstract;
    let key = bib.bibKey && !used.has(bib.bibKey.toLowerCase()) ? bib.bibKey : makeCiteKey(bib, used);
    key = key.replace(/[\s,{}()"#%'=\\]/g, '');
    used.add(key.toLowerCase());
    const entry = metaToBib(bib, key);
    if (opts.includeAxiomId !== false) entry.fields.axiomid = s.id;
    entries.push(entry);
  }
  return serializeBibtex(entries);
}

export interface BibImportResult {
  /** changed metadata for matched sources (merge: the .bib wins for fields it has; the Axiom cite key is kept) */
  updates: { sourceId: string; bib: BibMeta }[];
  /** all matched pairs, changed or not */
  matches: { sourceId: string; key: string }[];
  /** entries that match no source */
  unmatched: BibMeta[];
  errors: { offset: number; message: string }[];
}

/** Matches entries of a .bib file onto sources: axiomid → cite key → DOI → title+year → unique title. */
export function importBibIntoSources(bibText: string, sources: SourceLike[]): BibImportResult {
  const parsed = parseBibtex(bibText);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const byKey = new Map<string, SourceLike>();
  const byDoi = new Map<string, SourceLike>();
  const byTy = new Map<string, SourceLike>();
  const byTitle = new Map<string, SourceLike | null>();
  for (const s of sources) {
    const bib = { ...(s.bib ?? {}), title: s.bib?.title ?? s.title };
    if (bib.bibKey) byKey.set(bib.bibKey.toLowerCase(), s);
    const d = normalizeDoi(bib.doi);
    if (d) byDoi.set(d, s);
    const ty = titleYearKey(bib);
    if (ty) byTy.set(ty, s);
    const t = normalizeTitleKey(bib.title);
    if (t) byTitle.set(t, byTitle.has(t) ? null : s);
  }
  const res: BibImportResult = { updates: [], matches: [], unmatched: [], errors: parsed.errors };
  const seen = new Set<string>();
  for (const e of parsed.entries) {
    const meta = bibToMeta(e);
    const doi = normalizeDoi(meta.doi);
    const ty = titleYearKey(meta);
    const t = normalizeTitleKey(meta.title);
    const src =
      (e.fields.axiomid && byId.get(e.fields.axiomid)) ||
      byKey.get(e.key.toLowerCase()) ||
      (doi && byDoi.get(doi)) ||
      (ty && byTy.get(ty)) ||
      (t && byTitle.get(t)) ||
      undefined;
    if (!src || seen.has(src.id)) {
      if (!src) res.unmatched.push(meta);
      continue;
    }
    seen.add(src.id);
    res.matches.push({ sourceId: src.id, key: e.key });
    const merged = mergeBib(src.bib, meta, 'incoming', ['bibKey', 'zoteroKey']);
    if (!merged.bibKey) merged.bibKey = e.key;
    if (!bibEqual(merged, src.bib)) res.updates.push({ sourceId: src.id, bib: merged });
  }
  return res;
}
