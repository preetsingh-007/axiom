import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzePdf,
  closePdf,
  arxivYear,
  configurePdfjs,
  extractPageMarkdown,
  findAbstract,
  findArxivId,
  findDoi,
  getPageTextItems,
  isGarbageTitle,
  iteratePageTexts,
  openPdf,
  parseAuthorLine,
  parsePdfDate,
  splitAuthors,
} from './pdf';
import { itemsToLatex, selectItemsInPolygon } from './extract';

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures', name)));

beforeAll(() => {
  configurePdfjs({ assetBase: null });
});

describe('identifier helpers', () => {
  it('findDoi strips trailing punctuation and unbalanced parens', () => {
    expect(findDoi('DOI: 10.5555/axiom.2024.0042.')).toBe('10.5555/axiom.2024.0042');
    expect(findDoi('see (https://doi.org/10.1145/3290605.3300234), p. 3')).toBe('10.1145/3290605.3300234');
    expect(findDoi('doi:10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0')).toBe('10.1002/(SICI)1097-4571(199806)49:8');
    expect(findDoi('no identifier here')).toBeUndefined();
  });

  it('findArxivId handles new, old and URL styles', () => {
    expect(findArxivId('arXiv:2101.00001v2 [cs.LG] 5 Jan 2021')).toBe('2101.00001v2');
    expect(findArxivId('see https://arxiv.org/abs/1706.03762')).toBe('1706.03762');
    expect(findArxivId('preprint hep-th/9901001v1')).toBe('hep-th/9901001v1');
    expect(findArxivId('arxiv.org/abs/math.GT/0309136')).toBe('math.GT/0309136');
    expect(findArxivId('version 2101.00001 of nothing')).toBeUndefined();
    expect(arxivYear('2101.00001v2')).toBe(2021);
    expect(arxivYear('hep-th/9901001')).toBe(1999);
    expect(arxivYear('math/0309136')).toBe(2003);
  });

  it('isGarbageTitle / splitAuthors / parseAuthorLine / parsePdfDate', () => {
    expect(isGarbageTitle('Microsoft Word - paper_final_v3.docx')).toBe(true);
    expect(isGarbageTitle('untitled')).toBe(true);
    expect(isGarbageTitle('paper_final_v3')).toBe(true);
    expect(isGarbageTitle('main.tex')).toBe(true);
    expect(isGarbageTitle('report', 'report.pdf')).toBe(true);
    expect(isGarbageTitle('Attention Is All You Need')).toBe(false);
    expect(splitAuthors('Edsger Dijkstra; Barbara Liskov')).toEqual(['Edsger Dijkstra', 'Barbara Liskov']);
    expect(splitAuthors('Ada Lovelace, Alan Turing and Grace Hopper')).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(splitAuthors('Lovelace, Ada')).toEqual(['Lovelace, Ada']);
    expect(splitAuthors('Administrator')).toEqual([]);
    expect(parseAuthorLine('Ada Lovelace1,2, Alan Turing*, and Grace Hopper†')).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(parseAuthorLine('Department of Computer Science, University of Somewhere')).toEqual([]);
    expect(parsePdfDate('D:20240315120000Z')?.getUTCFullYear()).toBe(2024);
    expect(parsePdfDate('garbage')).toBeUndefined();
  });

  it('findAbstract', () => {
    const t = 'Title\n\nAbstract\nWe study the problem of reading order reconstruction in scanned and born-digital documents at scale.\n\n1 Introduction\nText';
    expect(findAbstract(t)).toMatch(/^We study the problem/);
  });
});

describe('pdf.js on fixtures', () => {
  it('analyzes the two-column paper: heuristic title/authors, DOI, outline with named dest', async () => {
    const pdf = await openPdf(fixture('paper.pdf'));
    const a = await analyzePdf(pdf, { fileName: 'paper.pdf' });
    expect(a.pageCount).toBe(3);
    expect(a.isSlides).toBe(false);
    expect(a.title).toBe('Semantic Reading Order Reconstruction for Local-First Research Notebooks');
    expect(a.bib.authors).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(a.bib.doi).toBe('10.5555/axiom.2024.0042');
    expect(a.bib.year).toBe(2024);
    expect(a.bib.abstract).toMatch(/^Knowledge work depends/);
    expect(a.toc.map((t) => t.title)).toEqual(['Introduction', 'Related Work', 'Method', 'Evaluation', 'Conclusion']);
    expect(a.toc[0].page).toBe(1);
    const method = a.toc[2];
    expect(method.page).toBeGreaterThanOrEqual(1);
    expect(method.children?.[0]).toMatchObject({ title: 'Objective', page: method.page });
    expect(a.toc[4].page).toBeGreaterThanOrEqual(method.page!);
    expect(a.pageSize).toEqual({ width: 612, height: 792 });
    await closePdf(pdf);
  });

  it('extracts page 1 of the paper as reading-order markdown', async () => {
    const pdf = await openPdf(fixture('paper.pdf'));
    const md = await extractPageMarkdown(pdf, 1);
    expect(md.startsWith('# Semantic Reading Order Reconstruction for Local-First Research Notebooks\n\n')).toBe(true);
    expect(md).toContain('## 1 Introduction');
    expect(md).toContain('its information rather than flatten it'); // de-hyphenated across lines
    // left column comes before the right column
    const iIntro = md.indexOf('## 1 Introduction');
    const iRel = md.indexOf('## 2 Related Work');
    expect(iIntro).toBeGreaterThan(0);
    expect(iRel === -1 || iRel > iIntro).toBe(true);
    await closePdf(pdf);
  });

  it('turns the equation line into LaTeX', async () => {
    const pdf = await openPdf(fixture('paper.pdf'));
    let latex = '';
    for (let p = 1; p <= pdf.numPages && !latex; p++) {
      const page = await pdf.getPage(p);
      const items = await getPageTextItems(page);
      const sigma = items.find((i) => i.str.includes('∑'));
      if (sigma) {
        const sel = selectItemsInPolygon(items, [
          [sigma.x - 5, sigma.y - 6],
          [sigma.x + 200, sigma.y - 6],
          [sigma.x + 200, sigma.y + sigma.h + 4],
          [sigma.x - 5, sigma.y + sigma.h + 4],
        ]);
        latex = itemsToLatex(sel);
      }
    }
    expect(latex).toBe('\\sum\\alpha_{i} x_{i}^{2} \\leq \\beta \\tag{1}');
    await closePdf(pdf);
  });

  it('analyzes the 320-page textbook quickly with a capped two-level outline', async () => {
    const t0 = performance.now();
    const pdf = await openPdf(fixture('textbook.pdf'));
    const a = await analyzePdf(pdf);
    expect(a.pageCount).toBe(320);
    expect(a.title).toBe('Foundations of Knowledge Systems');
    expect(a.bib.authors).toEqual(['Edsger Dijkstra', 'Barbara Liskov']);
    expect(a.bib.entryType).toBe('book');
    expect(a.toc).toHaveLength(16);
    expect(a.toc[0]).toMatchObject({ title: 'Chapter 1: Sets', page: 1 });
    expect(a.toc[15].page).toBe(301);
    expect(a.toc[1].children?.map((c) => c.page)).toEqual([26, 31, 36]);
    expect(performance.now() - t0).toBeLessThan(8000);

    const capped = await analyzePdf(pdf, { maxTocEntries: 10, maxTocDepth: 1 });
    expect(capped.toc).toHaveLength(10);
    expect(capped.toc.every((e) => !e.children)).toBe(true);
    expect(capped.tocTruncated).toBe(true);

    const pages: number[] = [];
    for await (const p of iteratePageTexts(pdf, { from: 20, to: 22 })) {
      pages.push(p.page);
      expect(p.text).toContain(`page ${p.page} of`);
    }
    expect(pages).toEqual([20, 21, 22]);
    await closePdf(pdf);
  });

  it('detects landscape slides and reads the XMP title', async () => {
    const pdf = await openPdf(fixture('slides.pdf'));
    const a = await analyzePdf(pdf);
    expect(a.isSlides).toBe(true);
    expect(a.pageCount).toBe(6);
    expect(a.title).toBe('Seminar: Graph Neural Networks');
    expect(a.bib.authors).toEqual(['Yoshua Bengio']);
    expect(a.bib.entryType).toBe('misc');
    await closePdf(pdf);
  });

  it('honours AbortSignal', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(openPdf(fixture('paper.pdf'), { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const pdf = await openPdf(fixture('textbook.pdf'));
    const ctl2 = new AbortController();
    ctl2.abort();
    await expect(analyzePdf(pdf, { signal: ctl2.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await closePdf(pdf);
  });

  it('does not detach the caller buffer by default', async () => {
    const data = fixture('slides.pdf');
    const pdf = await openPdf(data);
    expect(data.byteLength).toBeGreaterThan(0);
    await closePdf(pdf);
  });
});
