import { describe, expect, it } from 'vitest';
import { bibToMeta, escapeBibValue, latexToUnicode, metaToBib, parseBibtex, protectCase, serializeBibtex, serializeEntry } from './bibtex';
import { formatBibtexName, formatDisplayName, parseName, splitBibtexAuthors } from './names';

const SAMPLE = String.raw`
This text outside entries is a comment.
@string{ neurips = "Advances in Neural Information Processing Systems" }
@String(acm = {ACM})
@comment{ jabref-meta: databaseType:bibtex; }
@preamble{ "\newcommand{\noopsort}[1]{}" }

@inproceedings{Vaswani2017,
  author    = {Ashish Vaswani and Noam Shazeer and Niki Parmar and others},
  title     = {Attention Is All You Need},
  booktitle = neurips # " 30",
  year      = 2017,
  month     = dec,
  pages     = {5998--6008},
}

% a line comment between entries
@article(knuth84,
  author = "Donald E. Knuth",
  title = "Literate Programming",
  journal = {The Computer Journal},
  volume = {27}, number = {2},
  year = "1984",
  doi = {https://doi.org/10.1093/comjnl/27.2.97},
  publisher = acm
)

@ARTICLE{broken, title = {Missing close brace, year = 2020

@book{goedel,
  author = {G{\"o}del, Kurt and van der Waals, Johannes and {World Health Organization}},
  title = {{\"U}ber formal unentscheidbare S{\"a}tze --- a {\em study} of \emph{$\alpha$-completeness} \& more},
  publisher = {Springer},
  year = {1931},
  note = {Caf\'e na\"{\i}ve \c{c}a \v{S}koda \ss\ \o\ 100\%},
}
`;

describe('parseBibtex', () => {
  const res = parseBibtex(SAMPLE);

  it('parses entries, macros, concatenation, comments, preambles and recovers from errors', () => {
    expect(res.entries.map((e) => e.key)).toEqual(['Vaswani2017', 'knuth84', 'goedel']);
    expect(res.errors).toHaveLength(1);
    expect(res.strings).toEqual({ neurips: 'Advances in Neural Information Processing Systems', acm: 'ACM' });
    expect(res.comments[0]).toContain('jabref-meta');
    expect(res.preambles[0]).toBe('\\newcommand{\\noopsort}[1]{}');
    const v = res.entries[0];
    expect(v.type).toBe('inproceedings');
    expect(v.fields.booktitle).toBe('Advances in Neural Information Processing Systems 30');
    expect(v.fields.year).toBe('2017');
    expect(v.fields.month).toBe('December');
    const k = res.entries[1];
    expect(k.type).toBe('article');
    expect(k.fields.publisher).toBe('ACM');
    expect(k.fields.number).toBe('2');
  });

  it('converts to BibMeta with LaTeX decoded', () => {
    const v = bibToMeta(res.entries[0]);
    expect(v).toMatchObject({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
      year: 2017,
      venue: 'Advances in Neural Information Processing Systems 30',
      entryType: 'inproceedings',
      bibKey: 'Vaswani2017',
    });
    expect(bibToMeta(res.entries[1]).doi).toBe('10.1093/comjnl/27.2.97');
    const g = bibToMeta(res.entries[2]);
    expect(g.authors).toEqual(['Kurt Gödel', 'Johannes van der Waals', 'World Health Organization']);
    expect(g.title).toBe('Über formal unentscheidbare Sätze — a study of $\\alpha$-completeness & more');
  });

  it('latexToUnicode handles accents and specials', () => {
    expect(latexToUnicode(res.entries[2].fields.note)).toBe('Café naïve ça Škoda ß ø 100%');
    expect(latexToUnicode("{\\'E}cole ``quoted'' pages 1--2 \\textit{x}~y")).toBe('École “quoted” pages 1–2 x\u00a0y');
    expect(latexToUnicode('\\url{https://a.b/c_d}')).toBe('https://a.b/c_d');
  });

  it('handles edge syntax', () => {
    const r = parseBibtex('@misc{nokey}\n@misc{a, title={x}, title={dup}}\n@misc{b,\n  title = "He said {"}hi{"}"\n}');
    expect(r.entries.map((e) => e.key)).toEqual(['nokey', 'a', 'b']);
    expect(r.entries[1].fields.title).toBe('x');
    expect(r.entries[2].fields.title).toBe('He said {"}hi{"}');
    expect(parseBibtex('').entries).toEqual([]);
    expect(parseBibtex('@article{x, title = {unterminated').errors).toHaveLength(1);
  });
});

describe('serialization', () => {
  it('round-trips parse → serialize → parse losslessly', () => {
    const first = parseBibtex(SAMPLE).entries;
    const text = serializeBibtex(first);
    const again = parseBibtex(text);
    expect(again.errors).toEqual([]);
    expect(again.entries).toEqual(first);
  });

  it('uses a stable field order and aligned formatting', () => {
    const s = serializeEntry({ type: 'article', key: 'k', fields: { zzz: 'z', year: '2020', title: 'T', author: 'A, B', doi: '10.1/x' } });
    expect(s).toBe('@article{k,\n  author = {A, B},\n  title  = {T},\n  year   = 2020,\n  doi    = {10.1/x},\n  zzz    = {z}\n}');
  });

  it('escapes unbalanced braces', () => {
    const s = serializeEntry({ type: 'misc', key: 'k', fields: { title: 'a } b {' } });
    expect(parseBibtex(s).entries[0].fields.title).toBe('a \\} b \\{');
  });

  it('metaToBib escapes specials, protects case and maps venues', () => {
    const e = metaToBib(
      {
        title: 'BERT & CRDTs: 100% of $\\alpha$ in iPhone apps',
        authors: ['Ada Lovelace', 'Johannes van der Waals'],
        year: 2019,
        venue: 'NAACL',
        doi: 'https://doi.org/10.18653/v1/N19-1423',
        entryType: 'inproceedings',
      },
      'devlin2019bert',
    );
    expect(e.type).toBe('inproceedings');
    expect(e.fields.author).toBe('Lovelace, Ada and van der Waals, Johannes');
    expect(e.fields.title).toBe('{BERT} \\& {CRDTs}: 100\\% of $\\alpha$ in {iPhone} apps');
    expect(e.fields.booktitle).toBe('{NAACL}'.slice(1, -1));
    expect(e.fields.doi).toBe('10.18653/v1/N19-1423');
    // and back
    const m = bibToMeta(parseBibtex(serializeEntry(e)).entries[0]);
    expect(m.title).toBe('BERT & CRDTs: 100% of $\\alpha$ in iPhone apps');
    expect(m.authors).toEqual(['Ada Lovelace', 'Johannes van der Waals']);
    expect(metaToBib({ title: 'x', arxiv: '2101.00001' }).type).toBe('misc');
    expect(metaToBib({ title: 'x', arxiv: '2101.00001' }).fields.archiveprefix).toBe('arXiv');
  });

  it('escapeBibValue / protectCase', () => {
    expect(escapeBibValue('a_b #1 {x} ~ ^ \\')).toBe('a\\_b \\#1 \\{x\\} \\textasciitilde{} \\^{} \\textbackslash{}');
    expect(protectCase('Deep Learning with GPUs and word2vec')).toBe('Deep Learning with {GPUs} and word2vec');
  });
});

describe('names', () => {
  it('parses and formats names', () => {
    expect(parseName('Donald E. Knuth')).toMatchObject({ first: 'Donald E.', last: 'Knuth' });
    expect(parseName('van der Waals, Johannes')).toMatchObject({ first: 'Johannes', von: 'van der', last: 'Waals' });
    expect(parseName('Ludwig van Beethoven')).toMatchObject({ first: 'Ludwig', von: 'van', last: 'Beethoven' });
    expect(parseName('King, Jr., Martin Luther')).toMatchObject({ first: 'Martin Luther', jr: 'Jr.', last: 'King' });
    expect(formatDisplayName(parseName('King, Jr., Martin Luther'))).toBe('Martin Luther King Jr.');
    expect(formatBibtexName(parseName('Martin Luther King Jr.'))).toBe('King, Jr., Martin Luther');
    expect(formatBibtexName(parseName('{Barnes and Noble}'))).toBe('{Barnes and Noble}');
    expect(splitBibtexAuthors('A and {B and C} AND D and others')).toEqual(['A', '{B and C}', 'D']);
  });
});
