import { describe, expect, it } from 'vitest';
import type { SourceMeta } from '../schema';
import { exportLibraryBib, importBibIntoSources } from './mendeley';
import { parseBibtex } from './bibtex';

const src = (id: string, title: string, bib: SourceMeta['bib']): SourceMeta => ({
  id,
  kind: 'pdf',
  title,
  fileName: `${id}.pdf`,
  blobId: 'b-' + id,
  size: 1,
  addedAt: 0,
  bib,
});

const LIB: SourceMeta[] = [
  src('s-1', 'Attention', { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017, bibKey: 'vaswani2017attention' }),
  src('s-2', 'knuth.pdf', { title: 'Literate Programming', authors: ['Donald E. Knuth'], year: 1984, doi: '10.1093/comjnl/27.2.97' }),
  src('s-3', 'Untitled notes', undefined),
  src('s-4', 'dup', { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017 }),
];

describe('Mendeley / .bib sync', () => {
  it('exports every source with unique keys and an axiomid', () => {
    const bib = exportLibraryBib(LIB);
    const parsed = parseBibtex(bib);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map((e) => e.key)).toEqual(['vaswani2017attention', 'knuth1984literate', 'untitled', 'vaswani2017attentiona']);
    expect(parsed.entries[2].fields.title).toBe('Untitled notes');
    expect(parsed.entries.map((e) => e.fields.axiomid)).toEqual(['s-1', 's-2', 's-3', 's-4']);
  });

  it('round-trips: an edited export changes only what was edited (plus filling missing key/type)', () => {
    const edited = exportLibraryBib(LIB).replace(/(year\s*=\s*1984)/, '$1,\n  journal = {The Computer Journal}');
    const res = importBibIntoSources(edited, LIB);
    expect(res.matches).toHaveLength(4);
    expect(res.unmatched).toEqual([]);
    const byId = new Map(res.updates.map((u) => [u.sourceId, u.bib]));
    expect(byId.get('s-2')).toMatchObject({ venue: 'The Computer Journal', bibKey: 'knuth1984literate', title: 'Literate Programming' });
    // unchanged sources only gain their generated key / default entry type
    const s1 = byId.get('s-1');
    if (s1) expect(s1).toEqual({ ...LIB[0].bib, entryType: 'article' });
    expect(byId.get('s-3')).toMatchObject({ title: 'Untitled notes', bibKey: 'untitled' });
  });

  it('matches foreign .bib files by key, DOI and title+year; reports unmatched', () => {
    const foreign = String.raw`
@article{whatever, title = {Literate programming}, year = {1984}, doi = {10.1093/COMJNL/27.2.97}, abstract = {Prose + code.}}
@inproceedings{vaswani2017attention, title = {Attention is all you need}, booktitle = {NeurIPS}, year = 2017}
@misc{other, title = {Something Else Entirely}, year = 2001}
`;
    const res = importBibIntoSources(foreign, LIB);
    expect(res.matches.map((m) => m.sourceId)).toEqual(['s-2', 's-1']);
    const u2 = res.updates.find((u) => u.sourceId === 's-2')!;
    expect(u2.bib).toMatchObject({ abstract: 'Prose + code.', doi: '10.1093/COMJNL/27.2.97', bibKey: 'whatever' });
    expect(res.updates.find((u) => u.sourceId === 's-1')!.bib).toMatchObject({ venue: 'NeurIPS', bibKey: 'vaswani2017attention', entryType: 'inproceedings' });
    expect(res.unmatched.map((m) => m.title)).toEqual(['Something Else Entirely']);
  });
});
