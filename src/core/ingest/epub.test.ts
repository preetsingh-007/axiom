import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { epubAnchorId, parseEpub, resolveZipPath } from './epub';

const fixtureBlob = (name: string) =>
  new Blob([readFileSync(join(process.cwd(), 'tests/fixtures', name))], { type: 'application/epub+zip' });

describe('resolveZipPath', () => {
  it('resolves relative paths and fragments', () => {
    expect(resolveZipPath('OEBPS/text/ch1.xhtml', '../images/a%20b.png')).toEqual(['OEBPS/images/a b.png', undefined]);
    expect(resolveZipPath('OEBPS/text/ch1.xhtml', 'ch2.xhtml#sec')).toEqual(['OEBPS/text/ch2.xhtml', 'sec']);
    expect(resolveZipPath('OEBPS/text/ch1.xhtml', '#top')).toEqual(['OEBPS/text/ch1.xhtml', 'top']);
    expect(resolveZipPath('OEBPS/content.opf', '/root.xhtml')).toEqual(['root.xhtml', undefined]);
  });
});

describe('parseEpub (fixture)', () => {
  it('reads metadata, spine and the EPUB3 nav TOC', async () => {
    const book = await parseEpub(fixtureBlob('book.epub'));
    expect(book.title).toBe('The Axiom Test Book');
    expect(book.authors).toEqual(['Ada Lovelace', 'Charles Babbage']);
    expect(book.language).toBe('en');
    expect(book.publisher).toBe('Analytical Press');
    expect(book.date).toBe('1843-09-01');
    expect(book.identifier).toMatch(/^urn:uuid:/);
    expect(book.chapters.map((c) => c.href)).toEqual(['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml', 'OEBPS/text/ch3.xhtml']);
    expect(book.chapters[1].title).toBe('Chapter 2. Notes on Operations');
    expect(book.toc).toEqual([
      { title: 'Chapter 1. The Engine', chapter: 0 },
      { title: 'Chapter 2. Notes on Operations', chapter: 1, children: [{ title: '2.1 The Figure', chapter: 1, fragment: 'sec2-1' }] },
      { title: 'Chapter 3. Poetical Science', chapter: 2 },
    ]);
    expect(book.coverUrl).toMatch(/^blob:/);
    expect(book.resolveHref('text/ch3.xhtml')).toEqual({ chapter: 2 });
    expect(book.resolveHref('ch2.xhtml#sec2-1', 0)).toEqual({ chapter: 1, fragment: 'sec2-1' });
    expect(book.resolveHref('https://example.org')).toBeNull();
    book.dispose();
  });

  it('sanitizes chapter HTML: no scripts/handlers/CSS, keeps MathML/tables, rewrites links and ids', async () => {
    const book = await parseEpub(fixtureBlob('book.epub'));
    const html = await book.chapterHtml(0);
    expect(html).not.toMatch(/<script|alert\(|onclick|<style|<link|style=|class="chapter"/i);
    expect(html).toContain(`<h1 id="${epubAnchorId(0, 'ch1')}">Chapter 1. The Engine</h1>`);
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mi>n</mi></mfrac></math>');
    expect(html).toContain('<table><thead><tr><th>Operation</th>');
    expect(html).toContain(`href="#${epubAnchorId(1, 'sec2-1')}" data-epub-chapter="1" data-epub-fragment="sec2-1"`);
    expect(html).toContain('href="https://example.org/" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<div></div>'); // self-closing XHTML div expanded
    expect(html.startsWith('<h1')).toBe(true); // body content only
    // cached
    expect(await book.chapterHtml(0)).toBe(html);
    book.dispose();
  });

  it('rewrites <img> and SVG <image> to object URLs of zip entries', async () => {
    const book = await parseEpub(fixtureBlob('book.epub'));
    const html = await book.chapterHtml(1);
    const imgs = [...html.matchAll(/<img src="([^"]+)" alt="Figure 1: the engine" loading="lazy"/g)];
    expect(imgs).toHaveLength(1);
    expect(imgs[0][1]).toMatch(/^blob:/);
    expect(html).toMatch(/<image href="blob:[^"]+" width="40" height="30"><\/image>/);
    // the same zip entry maps to one URL
    const svgUrl = /<image href="([^"]+)"/.exec(html)![1];
    expect(svgUrl).toBe(imgs[0][1]);
    expect(html).toContain(`id="${epubAnchorId(1, 'sec2-1')}"`);
    await expect(book.chapterHtml(9)).rejects.toThrow(RangeError);
    book.dispose();
    await expect(book.chapterHtml(0)).rejects.toThrow(/disposed/);
  });

  it('sampleText gives plain text of the first chapters', async () => {
    const book = await parseEpub(fixtureBlob('book.epub'));
    const t = await book.sampleText(200);
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t).toMatch(/^Chapter 1\. The Engine\nThe Analytical Engine weaves/);
    expect(t).not.toContain('alert');
    book.dispose();
  });
});

describe('parseEpub (EPUB2 / edge cases)', () => {
  async function epub2(): Promise<Blob> {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file(
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
    );
    zip.file(
      'content.opf',
      `<package version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>Old Book</dc:title><dc:creator opf:role="aut">Jane Austen</dc:creator><dc:creator opf:role="edt">An Editor</dc:creator>
        <meta name="cover" content="cov"/></metadata>
        <manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="cov" href="img/c.jpg" media-type="image/jpeg"/>
        <item id="a" href="a.html" media-type="application/xhtml+xml"/><item id="b" href="b%20c.html" media-type="application/xhtml+xml"/></manifest>
        <spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>`,
    );
    zip.file(
      'toc.ncx',
      `<ncx><navMap><navPoint><navLabel><text>One</text></navLabel><content src="a.html"/></navPoint>
       <navPoint><navLabel><text>Two</text></navLabel><content src="b%20c.html#x"/></navPoint></navMap></ncx>`,
    );
    zip.file('img/c.jpg', new Uint8Array([0xff, 0xd8, 0xff]));
    zip.file('a.html', '<html><body><p>Hello &amp; welcome&nbsp;here</p><img src="missing.png" alt="gone"/><iframe src="x"></iframe></body></html>');
    zip.file('b c.html', '<html><body><p id="x">Second</p></body></html>');
    return new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);
  }

  it('falls back to the NCX, filters non-author creators, handles encoded hrefs and missing images', async () => {
    const book = await parseEpub(await epub2());
    expect(book.title).toBe('Old Book');
    expect(book.authors).toEqual(['Jane Austen']);
    expect(book.toc).toEqual([
      { title: 'One', chapter: 0 },
      { title: 'Two', chapter: 1, fragment: 'x' },
    ]);
    expect(book.coverUrl).toMatch(/^blob:/);
    const html = await book.chapterHtml(0);
    expect(html).toBe('<p>Hello &amp; welcome here</p><span class="epub-missing-img">gone</span>');
    expect(await book.chapterHtml(1)).toBe(`<p id="${epubAnchorId(1, 'x')}">Second</p>`);
    book.dispose();
  });

  it('rejects non-EPUB input clearly', async () => {
    await expect(parseEpub(new Blob(['not a zip']))).rejects.toThrow(/not a valid EPUB/);
    const zip = new JSZip();
    zip.file('hello.txt', 'x');
    await expect(parseEpub(new Blob([await zip.generateAsync({ type: 'arraybuffer' })]))).rejects.toThrow(/package document/);
  });
});
