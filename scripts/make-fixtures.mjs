#!/usr/bin/env node
/**
 * Generates deterministic test fixtures into tests/fixtures/:
 *   paper.pdf     2-column academic paper (3 pages, garbage Info title, DOI, outline + named dest)
 *   textbook.pdf  320-page book with chapter headings and a 2-level outline (small: standard fonts)
 *   slides.pdf    6 landscape 16:9 slides with an XMP title
 *   book.epub     EPUB3 (nav + ncx), 3 chapters, one figure, cover, CSS, a script to sanitize
 *   deck.pptx     3 slides: placeholders, bullets, rectangle, group, picture, notes, background
 *
 * Usage: node scripts/make-fixtures.mjs
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFNumber,
  PDFNull,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import JSZip from 'jszip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tests', 'fixtures');
mkdirSync(outDir, { recursive: true });

// Fixed dates → reproducible output.
const FIXED_DATE = new Date(Date.UTC(2024, 2, 15, 12, 0, 0));
const ZIP_DATE = new Date(Date.UTC(2024, 2, 15, 12, 0, 0));

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Tiny RGB PNG with a gradient and a diagonal stripe. */
function makePng(w, h, [r0, g0, b0], [r1, g1, b1]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const stripe = Math.abs(x - y) < 3;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = stripe ? 255 : Math.round(r0 + (r1 - r0) * t);
      raw[o + 1] = stripe ? 255 : Math.round(g0 + (g1 - g0) * t);
      raw[o + 2] = stripe ? 255 : Math.round(b0 + (b1 - b0) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- PDF helpers

/** Word-wrap; words containing "|" may be hyphenated at that point. */
function wrap(text, font, size, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const fits = (s) => font.widthOfTextAtSize(s, size) <= width;
  for (const word of words) {
    const plain = word.replace(/\|/g, '');
    const cand = cur ? cur + ' ' + plain : plain;
    if (fits(cand)) {
      cur = cand;
      continue;
    }
    if (word.includes('|')) {
      const parts = word.split('|');
      let done = false;
      for (let k = parts.length - 1; k >= 1; k--) {
        const head = parts.slice(0, k).join('') + '-';
        const c2 = cur ? cur + ' ' + head : head;
        if (fits(c2)) {
          lines.push(c2);
          cur = parts.slice(k).join('');
          done = true;
          break;
        }
      }
      if (done) continue;
    }
    if (cur) lines.push(cur);
    cur = plain;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Adds a document outline. entries: [{ title, page (0-based) | named, children? }]
 * Named destinations are registered in the catalog /Dests dictionary.
 */
function addOutline(doc, entries, named = {}) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const catalog = doc.catalog;
  if (Object.keys(named).length) {
    const dests = ctx.obj({});
    for (const [name, pageIdx] of Object.entries(named)) {
      dests.set(PDFName.of(name), ctx.obj([pages[pageIdx].ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
    }
    catalog.set(PDFName.of('Dests'), ctx.register(dests));
  }
  const outlinesRef = ctx.nextRef();
  function build(list, parentRef) {
    const refs = list.map(() => ctx.nextRef());
    let total = 0;
    list.forEach((e, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of('Title'), PDFHexString.fromText(e.title));
      dict.set(PDFName.of('Parent'), parentRef);
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (e.named) dict.set(PDFName.of('Dest'), PDFName.of(e.named));
      else dict.set(PDFName.of('Dest'), ctx.obj([pages[e.page].ref, PDFName.of('Fit')]));
      if (e.children?.length) {
        const sub = build(e.children, refs[i]);
        dict.set(PDFName.of('First'), sub.refs[0]);
        dict.set(PDFName.of('Last'), sub.refs[sub.refs.length - 1]);
        dict.set(PDFName.of('Count'), PDFNumber.of(-sub.total)); // closed
        total += sub.total;
      }
      total += 1;
      ctx.assign(refs[i], dict);
    });
    return { refs, total };
  }
  const top = build(entries, outlinesRef);
  const outlines = ctx.obj({});
  outlines.set(PDFName.of('Type'), PDFName.of('Outlines'));
  outlines.set(PDFName.of('First'), top.refs[0]);
  outlines.set(PDFName.of('Last'), top.refs[top.refs.length - 1]);
  outlines.set(PDFName.of('Count'), PDFNumber.of(top.total));
  ctx.assign(outlinesRef, outlines);
  catalog.set(PDFName.of('Outlines'), outlinesRef);
}

function setDates(doc) {
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('axiom make-fixtures');
  doc.setCreator('axiom make-fixtures');
}

// ---------------------------------------------------------------- paper.pdf

const LOREM = [
  'Knowledge work depends on the careful integration of heterogeneous sources, yet most tools treat documents as opaque images.',
  'We argue that a local-first architecture offers durable ownership of research notes while enabling real-time collaboration between peers.',
  'Conflict-free replicated data types provide strong eventual consistency without a central coordinator, which makes them a natural foundation.',
  'Our system reconstructs reading order from positioned glyph runs, detects columns through gap analysis, and preserves typographic structure.',
  'Empirically, the approach recovers paragraphs with high fidelity on a corpus of two-column conference papers and textbooks.',
];

/** n deterministic paragraphs of 4 rotated sentences each. */
function filler(n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = [];
    for (let k = 0; k < 4; k++) s.push(LOREM[(seed + i + k * 2) % LOREM.length]);
    out.push(s.join(' '));
  }
  return out;
}

async function makePaper() {
  const doc = await PDFDocument.create();
  setDates(doc);
  doc.setTitle('Microsoft Word - paper_final_v3.docx');
  doc.setAuthor('');
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const symbol = await doc.embedFont(StandardFonts.Symbol);

  const W = 612;
  const H = 792;
  const margin = 54;
  const gutter = 18;
  const colW = (W - 2 * margin - gutter) / 2;
  const body = 10;
  const lead = 12;

  const sections = [
    { h: '1 Introduction', paras: [
      'Researchers routinely read hundreds of papers, and the act of excerpting a passage should preserve its infor|mation rather than flatten it into a screenshot. ' + LOREM[0] + ' ' + LOREM[1],
      LOREM[2] + ' ' + LOREM[3],
      ...filler(6, 0),
    ] },
    { h: '2 Related Work', paras: [
      'Prior systems for semantic extraction rely on heuristics over geo|metric features of text runs. ' + LOREM[4] + ' ' + LOREM[0],
      LOREM[1] + ' ' + LOREM[2] + ' ' + LOREM[3],
      ...filler(6, 2),
    ] },
    { h: '3 Method', paras: [
      'We model a page as a set of positioned items and cluster them into columns by detecting wide vertical gut|ters. ' + LOREM[3],
      '@EQ',
      'The objective above is minimized with respect to the parameters, subject to the normalization con|straint. ' + LOREM[2],
    ] },
    { h: '4 Evaluation', paras: filler(6, 1) },
    { h: '5 Conclusion', paras: filler(3, 3) },
    { h: 'References', paras: [
      '[1] M. Kleppmann et al. Local-first software: you own your data, in spite of the cloud. Onward! 2019.',
      '[2] M. Shapiro et al. Conflict-free replicated data types. SSS 2011.',
    ] },
  ];

  let page = doc.addPage([W, H]);
  const pageStarts = [0];
  // Title block (full width)
  const title = 'Semantic Reading Order Reconstruction for Local-First Research Notebooks';
  const tLines = wrap(title, bold, 17, W - 2 * margin);
  let y = H - 72;
  for (const l of tLines) {
    const tw = bold.widthOfTextAtSize(l, 17);
    page.drawText(l, { x: (W - tw) / 2, y, size: 17, font: bold });
    y -= 21;
  }
  y -= 4;
  const authors = 'Ada Lovelace, Alan Turing, Grace Hopper';
  page.drawText(authors, { x: (W - roman.widthOfTextAtSize(authors, 11)) / 2, y, size: 11, font: roman });
  y -= 14;
  const aff = 'Institute for Local-First Computing';
  page.drawText(aff, { x: (W - italic.widthOfTextAtSize(aff, 10)) / 2, y, size: 10, font: italic });
  y -= 14;
  const doiLine = 'DOI: 10.5555/axiom.2024.0042.';
  page.drawText(doiLine, { x: (W - roman.widthOfTextAtSize(doiLine, 9)) / 2, y, size: 9, font: roman });
  y -= 26;

  const colTop = y;
  let col = 0;
  const colX = () => margin + col * (colW + gutter);
  const nextCol = () => {
    if (col === 0) {
      col = 1;
      y = page === doc.getPage(0) ? colTop : H - 72;
    } else {
      page = doc.addPage([W, H]);
      pageStarts.push(doc.getPageCount() - 1);
      col = 0;
      y = H - 72;
    }
  };
  const ensure = (need) => {
    if (y - need < 72) nextCol();
  };

  // Abstract
  ensure(20);
  page.drawText('Abstract', { x: colX(), y, size: 11, font: bold });
  y -= 15;
  for (const l of wrap(LOREM[0] + ' ' + LOREM[3] + ' ' + LOREM[4], italic, 9, colW)) {
    ensure(lead);
    page.drawText(l, { x: colX(), y, size: 9, font: italic });
    y -= 11;
  }
  y -= 10;

  const headingPages = {};
  for (const s of sections) {
    ensure(40);
    y -= 6;
    page.drawText(s.h, { x: colX(), y, size: 12, font: bold });
    headingPages[s.h] = doc.getPageCount() - 1;
    y -= 17;
    for (const p of s.paras) {
      if (p === '@EQ') {
        ensure(24);
        y -= 4;
        // An equation-ish line: ∑ α_i x_i² ≤ β  (Symbol font for math glyphs)
        let x = colX() + 30;
        const seg = (t, f, size, dy = 0) => {
          page.drawText(t, { x, y: y + dy, size, font: f });
          x += f.widthOfTextAtSize(t, size);
        };
        seg('∑', symbol, 13);
        seg('α', symbol, 10);
        seg('i', italic, 7, -2);
        seg(' x', italic, 10);
        seg('i', italic, 7, -2);
        seg('2', roman, 7, 4);
        seg(' ≤ ', symbol, 10);
        seg('β', symbol, 10);
        seg(' (1)', roman, 10);
        y -= lead + 8;
        continue;
      }
      const lines = wrap(p, roman, body, colW);
      lines.forEach((l, i) => {
        ensure(lead);
        page.drawText(l, { x: colX() + (i === 0 ? 10 : 0), y, size: body, font: roman });
        y -= lead;
      });
      y -= 4;
    }
  }
  // pad to exactly 3 pages
  while (doc.getPageCount() < 3) doc.addPage([W, H]);
  for (let i = 0; i < doc.getPageCount(); i++) {
    const pg = doc.getPage(i);
    const n = String(i + 1);
    pg.drawText(n, { x: W / 2 - 3, y: 40, size: 9, font: roman, color: rgb(0.3, 0.3, 0.3) });
  }

  addOutline(
    doc,
    [
      { title: 'Introduction', page: headingPages['1 Introduction'] },
      { title: 'Related Work', page: headingPages['2 Related Work'] },
      {
        title: 'Method',
        named: 'sec-method',
        children: [{ title: 'Objective', page: headingPages['3 Method'] }],
      },
      { title: 'Evaluation', page: headingPages['4 Evaluation'] },
      { title: 'Conclusion', page: headingPages['5 Conclusion'] },
    ],
    { 'sec-method': headingPages['3 Method'] },
  );
  return doc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- textbook.pdf

async function makeTextbook() {
  const doc = await PDFDocument.create();
  setDates(doc);
  doc.setTitle('Foundations of Knowledge Systems');
  doc.setAuthor('Edsger Dijkstra; Barbara Liskov');
  doc.setSubject('A synthetic 320-page textbook for performance tests');
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const PAGES = 320;
  const PER_CHAPTER = 20;
  const topics = ['Sets', 'Logic', 'Graphs', 'Automata', 'Algebra', 'Probability', 'Information', 'Learning'];
  const chapters = [];
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([432, 648]); // 6x9in
    const chap = Math.floor(i / PER_CHAPTER);
    const within = i % PER_CHAPTER;
    const cname = `${topics[chap % topics.length]} ${chap >= topics.length ? 'II' : ''}`.trim();
    if (within === 0) {
      page.drawText(`Chapter ${chap + 1}`, { x: 54, y: 560, size: 14, font: bold });
      page.drawText(cname, { x: 54, y: 530, size: 24, font: bold });
      chapters.push({ title: `Chapter ${chap + 1}: ${cname}`, page: i, children: [] });
    } else if (within % 5 === 0) {
      const secTitle = `${chap + 1}.${within / 5} ${cname} in practice`;
      page.drawText(secTitle, { x: 54, y: 580, size: 14, font: bold });
      chapters[chapters.length - 1].children.push({ title: secTitle, page: i });
    }
    page.drawText(`This is page ${i + 1} of the chapter on ${cname.toLowerCase()}.`, { x: 54, y: 500, size: 11, font: roman });
    page.drawText(String(i + 1), { x: 210, y: 36, size: 9, font: roman });
  }
  addOutline(doc, chapters);
  return doc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- slides.pdf

async function makeSlides() {
  const doc = await PDFDocument.create();
  setDates(doc);
  // No Info title: the title must come from XMP.
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const sansB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 960;
  const H = 540;
  const titles = ['Graph Neural Networks', 'Message Passing', 'Aggregation Functions', 'Over-smoothing', 'Benchmarks', 'Questions?'];
  titles.forEach((t, i) => {
    const p = doc.addPage([W, H]);
    p.drawRectangle({ x: 0, y: H - 90, width: W, height: 90, color: rgb(0.16, 0.2, 0.33) });
    p.drawText(t, { x: 48, y: H - 62, size: 36, font: sansB, color: rgb(1, 1, 1) });
    ['First key point of this slide', 'Second key point with more detail', 'Third point'].forEach((b, k) => {
      p.drawText('• ' + b, { x: 64, y: H - 160 - k * 44, size: 24, font: sans });
    });
    p.drawText(`${i + 1} / ${titles.length}`, { x: W - 90, y: 24, size: 14, font: sans });
  });
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Seminar: Graph Neural Networks</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Yoshua Bengio</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return doc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- zip helper

function zipFile(zip, path, content, opts = {}) {
  zip.file(path, content, { date: ZIP_DATE, ...opts });
}

// ---------------------------------------------------------------- book.epub

async function makeEpub() {
  const zip = new JSZip();
  zipFile(zip, 'mimetype', 'application/epub+zip', { compression: 'STORE' });
  zipFile(
    zip,
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zipFile(
    zip,
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5b1d3c52-7c0e-4a8e-9d64-000000000042</dc:identifier>
    <dc:title>The Axiom Test Book</dc:title>
    <dc:creator id="c1">Ada Lovelace</dc:creator>
    <dc:creator id="c2">Charles Babbage</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Analytical Press</dc:publisher>
    <dc:date>1843-09-01</dc:date>
    <meta property="dcterms:modified">2024-03-15T12:00:00Z</meta>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="fig1" href="images/fig1.png" media-type="image/png"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`,
  );
  zipFile(
    zip,
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/ch1.xhtml">Chapter 1. The Engine</a></li>
      <li><a href="text/ch2.xhtml">Chapter 2. Notes on Operations</a>
        <ol>
          <li><a href="text/ch2.xhtml#sec2-1">2.1 The Figure</a></li>
        </ol>
      </li>
      <li><a href="text/ch3.xhtml">Chapter 3. Poetical Science</a></li>
    </ol>
  </nav>
  <nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="text/ch1.xhtml">Start</a></li></ol></nav>
</body>
</html>`,
  );
  zipFile(
    zip,
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:5b1d3c52-7c0e-4a8e-9d64-000000000042"/></head>
  <docTitle><text>The Axiom Test Book</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1. The Engine</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Chapter 2. Notes on Operations</text></navLabel><content src="text/ch2.xhtml"/>
      <navPoint id="n21" playOrder="3"><navLabel><text>2.1 The Figure</text></navLabel><content src="text/ch2.xhtml#sec2-1"/></navPoint>
    </navPoint>
    <navPoint id="n3" playOrder="4"><navLabel><text>Chapter 3. Poetical Science</text></navLabel><content src="text/ch3.xhtml"/></navPoint>
  </navMap>
</ncx>`,
  );
  zipFile(zip, 'OEBPS/styles/book.css', 'body { font-family: "Comic Sans MS"; color: red; } h1 { font-size: 40px; }');
  const head = (t) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><title>${t}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/><style>p { color: blue; }</style></head>`;
  zipFile(
    zip,
    'OEBPS/text/ch1.xhtml',
    `${head('Chapter 1')}
<body class="chapter">
<h1 id="ch1">Chapter 1. The Engine</h1>
<p style="color: green">The Analytical Engine weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves.</p>
<script type="text/javascript">alert('xss');</script>
<p onclick="alert(1)">It might act upon other things besides <em>number</em>, were objects found whose mutual relations could be expressed.</p>
<p>The mean is <math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mi>n</mi></mfrac></math> in every case.</p>
<table><thead><tr><th>Operation</th><th>Cards</th></tr></thead><tbody><tr><td>Addition</td><td>1</td></tr></tbody></table>
<p>See <a href="ch2.xhtml#sec2-1">the figure</a> and <a href="https://example.org/">the web</a>.</p>
<div class="spacer"/>
</body></html>`,
  );
  zipFile(
    zip,
    'OEBPS/text/ch2.xhtml',
    `${head('Chapter 2')}
<body>
<h1>Chapter 2. Notes on Operations</h1>
<p>The operating mechanism can even be thrown into action independently of any object to operate upon.</p>
<h2 id="sec2-1">2.1 The Figure</h2>
<figure><img src="../images/fig1.png" alt="Figure 1: the engine"/><figcaption>Figure 1: the engine</figcaption></figure>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="30"><image xlink:href="../images/fig1.png" width="40" height="30"/></svg>
</body></html>`,
  );
  zipFile(
    zip,
    'OEBPS/text/ch3.xhtml',
    `${head('Chapter 3')}
<body>
<h1>Chapter 3. Poetical Science</h1>
<p>Imagination is the discovering faculty, pre-eminently. It is that which penetrates into the unseen worlds around us.</p>
<ul><li>Intuition</li><li>Analysis</li></ul>
</body></html>`,
  );
  zipFile(zip, 'OEBPS/images/fig1.png', makePng(64, 40, [40, 80, 200], [220, 120, 40]));
  zipFile(zip, 'OEBPS/images/cover.png', makePng(60, 90, [20, 30, 50], [90, 110, 160]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

// ---------------------------------------------------------------- deck.pptx

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 12700; // per pt

function rels(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map(([id, type, target]) => `  <Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('\n')}
</Relationships>`;
}

const xfrm = (x, y, w, h) =>
  `<a:xfrm><a:off x="${Math.round(x * EMU)}" y="${Math.round(y * EMU)}"/><a:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/></a:xfrm>`;

function placeholderSp(id, name, type, idx, bodyXml, withXfrm) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx != null ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr>${withXfrm ?? ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${bodyXml}</p:txBody></p:sp>`;
}

const para = (text, { sz, b, i, color, algn, lvl, bullet } = {}) =>
  `<a:p><a:pPr${algn ? ` algn="${algn}"` : ''}${lvl ? ` lvl="${lvl}"` : ''}>${bullet === false ? '<a:buNone/>' : bullet ? '<a:buChar char="•"/>' : ''}</a:pPr><a:r><a:rPr lang="en-US"${sz ? ` sz="${sz}"` : ''}${b ? ' b="1"' : ''}${i ? ' i="1"' : ''} dirty="0">${color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ''}</a:rPr><a:t>${text}</a:t></a:r></a:p>`;

const slideXml = (inner, bg = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

async function makePptx() {
  const zip = new JSZip();
  // 16:9 at 1280x720 px (96 dpi) = 12192000 x 6858000 EMU = 960 x 540 pt
  zipFile(
    zip,
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
  );
  zipFile(zip, '_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml']]).replace(`${REL}/metadata/core-properties`, 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'));
  zipFile(
    zip,
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Axiom Seminar Deck</dc:title>
  <dc:creator>Grace Hopper</dc:creator>
</cp:coreProperties>`,
  );
  zipFile(
    zip,
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="rId12"/><p:sldId id="257" r:id="rId10"/><p:sldId id="258" r:id="rId11"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zipFile(
    zip,
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId12', 'slide', 'slides/slide1.xml'],
      ['rId10', 'slide', 'slides/slide2.xml'],
      ['rId11', 'slide', 'slides/slide3.xml'],
    ]),
  );
  // master: title & body placeholder positions + white background
  zipFile(
    zip,
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${placeholderSp(2, 'Title Placeholder 1', 'title', null, para(''), `${xfrm(60, 30, 840, 80)}`)}
${placeholderSp(3, 'Text Placeholder 2', 'body', 1, para(''), `${xfrm(60, 130, 840, 360)}`)}
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
  );
  zipFile(zip, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  // layout: overrides title position for ctrTitle, inherits body from master
  zipFile(
    zip,
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="title"><p:cSld name="Title Slide"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${placeholderSp(2, 'Title 1', 'ctrTitle', null, para(''), `${xfrm(120, 170, 720, 120)}`)}
${placeholderSp(3, 'Subtitle 2', 'subTitle', 1, para(''), `${xfrm(120, 300, 720, 80)}`)}
</p:spTree></p:cSld></p:sldLayout>`,
  );
  zipFile(zip, 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));

  // slide 1: title slide with placeholders without xfrm (inherit from layout)
  zipFile(
    zip,
    'ppt/slides/slide1.xml',
    slideXml(
      placeholderSp(2, 'Title 1', 'ctrTitle', null, para('Local-First Knowledge Systems', { sz: 4400, b: true, algn: 'ctr' })) +
        placeholderSp(3, 'Subtitle 2', 'subTitle', 1, para('Seminar 1 · Grace Hopper', { sz: 2000, i: true, color: '626878', algn: 'ctr' })),
    ),
  );
  zipFile(zip, 'ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));

  // slide 2: title + bullets (body inherits master position), rectangle, group with ellipse + textbox
  const bullets =
    para('CRDTs converge without coordination', { sz: 2400, bullet: true }) +
    para('State-based and op-based variants', { sz: 2000, lvl: 1, bullet: true }) +
    para('Local-first means offline by default', { sz: 2400, bullet: true }) +
    para('1. Numbered item', { sz: 2400, bullet: false });
  const rect = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Rectangle 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(700, 380, 200, 100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3D5BD9"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="1D2230"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${para('Box', { sz: 1800, color: 'FFFFFF', algn: 'ctr' })}</p:txBody></p:sp>`;
  // group: child coordinate space 0..1000 x 0..500 mapped onto 60..260 x 440..540 (pt)
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group 4"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${60 * EMU}" y="${440 * EMU}"/><a:ext cx="${200 * EMU}" cy="${80 * EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${1000 * EMU}" cy="${400 * EMU}"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="6" name="Oval 5"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 400, 400)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="E0A526"/></a:solidFill></p:spPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="7" name="TextBox 6"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(500, 100, 500, 200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${para('Grouped', { sz: 1400 })}</p:txBody></p:sp>
</p:grpSp>`;
  zipFile(
    zip,
    'ppt/slides/slide2.xml',
    slideXml(
      placeholderSp(2, 'Title 1', 'title', null, para('Why CRDTs?', { b: true })) + placeholderSp(3, 'Content 2', 'body', 1, bullets) + rect + group,
    ),
  );
  zipFile(zip, 'ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));

  // slide 3: picture, colored background, notes
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="A figure"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(240, 140, 480, 300)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  const line = `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="Straight Connector 4"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(240, 460, 480, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="D9463D"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
  zipFile(
    zip,
    'ppt/slides/slide3.xml',
    slideXml(
      placeholderSp(2, 'Title 1', 'title', null, para('Results', { b: true, color: 'FFFFFF' })) + pic + line,
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1D2230"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
    ),
  );
  zipFile(
    zip,
    'ppt/slides/_rels/slide3.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', '../media/image1.png'],
      ['rId3', 'notesSlide', '../notesSlides/notesSlide3.xml'],
    ]),
  );
  zipFile(
    zip,
    'ppt/notesSlides/notesSlide3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${placeholderSp(2, 'Slide Image 1', 'sldImg', null, '<a:p/>')}
${placeholderSp(3, 'Notes Placeholder 2', 'body', 1, para('Mention the benchmark setup.') + para('Then take questions.'))}
${placeholderSp(4, 'Slide Number 3', 'sldNum', 5, para('3'))}
</p:spTree></p:cSld></p:notes>`,
  );
  zipFile(zip, 'ppt/media/image1.png', makePng(96, 60, [30, 160, 110], [240, 200, 60]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------- main

const outputs = {
  'paper.pdf': await makePaper(),
  'textbook.pdf': await makeTextbook(),
  'slides.pdf': await makeSlides(),
  'book.epub': await makeEpub(),
  'deck.pptx': await makePptx(),
};
let total = 0;
for (const [name, bytes] of Object.entries(outputs)) {
  const p = join(outDir, name);
  writeFileSync(p, bytes);
  const size = statSync(p).size;
  total += size;
  console.log(`${name.padEnd(14)} ${(size / 1024).toFixed(1).padStart(8)} KB`);
}
console.log(`${'total'.padEnd(14)} ${(total / 1024).toFixed(1).padStart(8)} KB`);
