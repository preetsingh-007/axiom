/**
 * PDF ingestion on top of pdf.js (legacy build: it polyfills the newer JS
 * built-ins the modern build relies on, which older Chromium / iPad Safari lack).
 *
 * Big-book rules: nothing here touches every page. `analyzePdf` samples a
 * bounded number of pages, the outline is capped, text is extracted per page on
 * demand, and page proxies are released (`page.cleanup()`) after use.
 *
 * Coordinates: `getPageTextItems` returns boxes in PDF points (viewport scale 1,
 * page rotation applied) with the origin at the TOP-LEFT of the page. That is the
 * coordinate space every function in extract.ts expects. To convert to the
 * normalised `SourceLocator.rect`, divide by the page viewport width/height.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BibMeta, TocEntry } from '../schema';
import type { PdfAnalysis, TextItem } from './types';
import { estimateBodyFontSize, itemsToLines, itemsToMarkdown, itemsToText, type ExtractOptions } from './extract';

export type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type { PDFDocumentProxy, PDFPageProxy };

// ------------------------------------------------------------------ loading

interface PdfjsConfig {
  /**
   * Base URL of the static pdf.js assets (cmaps/, standard_fonts/, wasm/, iccs/),
   * with trailing slash, or null to not pass any (tests / Node).
   */
  assetBase: string | null;
  /** override the worker URL (defaults to the bundled legacy worker) */
  workerSrc?: string;
}

const config: PdfjsConfig = {
  assetBase: `${import.meta.env?.BASE_URL ?? '/'}pdfjs/`,
};

export function configurePdfjs(patch: Partial<PdfjsConfig>): void {
  Object.assign(config, patch);
}

let modPromise: Promise<PdfjsModule> | null = null;

function isBrowserWithWorkers(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof Worker !== 'undefined';
}

/** Lazily imports pdf.js (legacy build) once and wires its worker. */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!modPromise) {
    modPromise = (async () => {
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (isBrowserWithWorkers() && !mod.GlobalWorkerOptions.workerSrc) {
        const src = config.workerSrc ?? (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
        mod.GlobalWorkerOptions.workerSrc = src;
      }
      return mod;
    })();
    modPromise.catch(() => {
      modPromise = null;
    });
  }
  return modPromise;
}

export interface OpenPdfOptions {
  password?: string;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  /**
   * pdf.js takes ownership of (detaches) the buffer it is given. By default a
   * copy is passed so the caller's data stays usable; set true to hand over the
   * buffer itself and save memory on huge files.
   */
  transfer?: boolean;
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** Opens a PDF from memory with range/stream-friendly options. */
export async function openPdf(data: ArrayBuffer | Uint8Array, opts: OpenPdfOptions = {}): Promise<PDFDocumentProxy> {
  throwIfAborted(opts.signal);
  const pdfjs = await loadPdfjs();
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = opts.transfer ? data : data.slice();
  else bytes = new Uint8Array(opts.transfer ? data : data.slice(0));
  const base = config.assetBase;
  const task = pdfjs.getDocument({
    data: bytes,
    password: opts.password,
    disableAutoFetch: true,
    disableStream: false,
    isEvalSupported: false,
    ...(base
      ? {
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
        }
      : {}),
    verbosity: 0,
  });
  if (opts.onProgress) task.onProgress = (p: { loaded: number; total: number }) => opts.onProgress!(p.loaded, p.total);
  const onAbort = () => void task.destroy();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const doc = await task.promise;
    throwIfAborted(opts.signal);
    return doc;
  } catch (e) {
    if (opts.signal?.aborted) throw abortError();
    throw e;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ------------------------------------------------------------------ text items

type Matrix = [number, number, number, number, number, number];

function mul(m1: number[], m2: number[]): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

/**
 * Converts pdf.js text content into top-left-origin boxes in PDF points
 * (viewport scale 1, page rotation applied).
 */
export async function getPageTextItems(page: PDFPageProxy): Promise<TextItem[]> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const raw of tc.items) {
    if (!('str' in raw)) continue;
    const it = raw as RawTextItem;
    if (!it.str) {
      if (it.hasEOL && out.length) out[out.length - 1].eol = true;
      continue;
    }
    const m = mul(vp.transform, it.transform);
    const fs = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || it.height || 1;
    const style = tc.styles[it.fontName];
    const asc = clamp(Number.isFinite(style?.ascent) && style.ascent > 0 ? style.ascent : 0.8, 0.5, 1.1);
    const desc = clamp(Number.isFinite(style?.descent) ? style.descent : -0.2, -0.5, 0);
    const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const w = it.width;
    let box: { x: number; y: number; w: number; h: number };
    if (Math.abs(angle) < 0.5) {
      box = { x: m[4], y: m[5] - fs * asc, w, h: fs * (asc - desc) };
    } else {
      const dl = Math.hypot(m[0], m[1]) || 1;
      const dir = [m[0] / dl, m[1] / dl];
      const ul = Math.hypot(m[2], m[3]) || 1;
      const up = [m[2] / ul, m[3] / ul];
      const pts: [number, number][] = [];
      for (const along of [0, w]) {
        for (const vert of [fs * asc, fs * desc]) pts.push([m[4] + dir[0] * along + up[0] * vert, m[5] + dir[1] * along + up[1] * vert]);
      }
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const item: TextItem = { str: it.str, ...box, fontSize: fs, fontName: it.fontName };
    if (it.hasEOL) item.eol = true;
    if (Math.abs(angle) >= 0.5) item.angle = Math.round(angle * 10) / 10;
    out.push(item);
  }
  return out;
}

/** Releases a document opened with `openPdf` (worker, caches). */
export async function closePdf(pdf: PDFDocumentProxy): Promise<void> {
  await pdf.loadingTask.destroy();
}

/** Markdown of one page (1-based), releasing the page afterwards. */
export async function extractPageMarkdown(pdf: PDFDocumentProxy, pageNumber: number, opts: ExtractOptions = {}): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  try {
    return itemsToMarkdown(await getPageTextItems(page), opts);
  } finally {
    page.cleanup();
  }
}

/**
 * Lazily yields page texts (e.g. for search indexing of an 800-page book in the
 * background). Cancellable; pages are released as soon as they are read.
 */
export async function* iteratePageTexts(
  pdf: PDFDocumentProxy,
  opts: { from?: number; to?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ page: number; text: string }> {
  const from = Math.max(1, opts.from ?? 1);
  const to = Math.min(pdf.numPages, opts.to ?? pdf.numPages);
  for (let p = from; p <= to; p++) {
    throwIfAborted(opts.signal);
    const page = await pdf.getPage(p);
    try {
      yield { page: p, text: itemsToText(await getPageTextItems(page)) };
    } finally {
      page.cleanup();
    }
  }
}

// ------------------------------------------------------------------ identifiers & metadata heuristics

const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i;

/** First DOI in the text, with trailing punctuation (and unbalanced ")") removed. */
export function findDoi(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = DOI_RE.exec(text);
  if (!m) return undefined;
  let doi = m[1];
  for (;;) {
    const before = doi;
    doi = doi.replace(/[.,;:]+$/, '');
    if (doi.endsWith(')') && (doi.match(/\(/g) ?? []).length < (doi.match(/\)/g) ?? []).length) doi = doi.slice(0, -1);
    if (doi === before) break;
  }
  return doi;
}

const ARXIV_NEW = /arxiv\s*[:.]?\s*(?:\/?abs\/|\/?pdf\/)?(\d{4}\.\d{4,5}(?:v\d+)?)/i;
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;
const ARXIV_OLD =
  /\b((?:astro-ph|cond-mat|gr-qc|hep-(?:ex|lat|ph|th)|math-ph|nlin|nucl-(?:ex|th)|physics|quant-ph|math|cs|q-bio|q-fin|stat|chao-dyn|solv-int|patt-sol|adap-org|cmp-lg|comp-gas|alg-geom|dg-ga|funct-an|q-alg)(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/;

/** arXiv identifier (new "2101.00001v2" or old "hep-th/9901001" style). */
export function findArxivId(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const url = ARXIV_URL.exec(text);
  if (url) return url[1].replace(/\.pdf$/, '');
  const n = ARXIV_NEW.exec(text);
  if (n) return n[1];
  const o = ARXIV_OLD.exec(text);
  if (o) return o[1];
  return undefined;
}

/** Year encoded in an arXiv id (2101.00001 → 2021, hep-th/9901001 → 1999). */
export function arxivYear(id: string): number | undefined {
  const n = /^(\d{2})(\d{2})\.\d{4,5}/.exec(id);
  if (n) return 2000 + Number(n[1]);
  const o = /\/(\d{2})\d{5}/.exec(id);
  if (o) {
    const yy = Number(o[1]);
    return yy >= 91 ? 1900 + yy : 2000 + yy;
  }
  return undefined;
}

/** Parses "D:YYYYMMDDHHmmSS..." (or ISO) into a Date. */
export function parsePdfDate(s: unknown): Date | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s.trim());
  if (m) {
    const [y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m.slice(1).map((v) => v);
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? undefined : iso;
}

/** Producer-generated or otherwise useless titles ("Microsoft Word - foo.docx", "untitled", file names…). */
export function isGarbageTitle(t: string | undefined | null, fileName?: string): boolean {
  if (!t) return true;
  const s = t.trim();
  if (s.length < 3 || !/\p{L}/u.test(s)) return true;
  if (/^(microsoft\s+(word|powerpoint|excel)|word|powerpoint)\s*-/i.test(s)) return true;
  if (/\.(docx?|tex|dvi|pdf|indd|pptx?|key|rtf|odt|qxd|ps|eps|txt|md|html?)$/i.test(s)) return true;
  if (/^(untitled|no title|title|document\d*|presentation\d*|slide\s*\d*|layout\s*\d*|paper|draft|main|manuscript|article|pdf|none|null|unknown)$/i.test(s))
    return true;
  if (/^untitled\b/i.test(s)) return true;
  if (/^[\w-]+$/.test(s) && /[_]|\d{3,}/.test(s)) return true; // "paper_final_v3", "ms123456"
  if (/^(doi|arxiv)[:\s]/i.test(s)) return true;
  if (fileName) {
    const base = fileName.replace(/\.[^.]+$/, '').trim().toLowerCase();
    if (base && s.toLowerCase() === base) return true;
  }
  return false;
}

function isGarbageAuthor(a: string): boolean {
  const s = a.trim();
  return (
    !s ||
    !/\p{L}/u.test(s) ||
    /^(administrator|admin|user|owner|unknown|author|authors|default|windows user|microsoft\b.*|dell|hp|lenovo|pc|root|system|anonymous)$/i.test(s)
  );
}

/** Splits an author field ("A B; C D", "A B and C D", "A B, C D") into names. */
export function splitAuthors(field: string | string[] | undefined | null): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field.flatMap((f) => splitAuthors(f));
  let parts = field
    .split(/\s*(?:;|\band\b|&|\n)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  // "A B, C D" lists (but not "Last, First")
  parts = parts.flatMap((part) => {
    if (!part.includes(',')) return [part];
    const commaParts = part.split(/\s*,\s*/).filter(Boolean);
    return commaParts.length > 1 && commaParts.every((p) => /\s/.test(p)) ? commaParts : [part];
  });
  return parts.filter((p) => !isGarbageAuthor(p));
}

const INSTITUTION = /\b(universit|institut|department|dept\b|school|college|laborator|lab\b|labs\b|inc\b|corp|center|centre|research|faculty|academy|abstract|e-?mail|google|microsoft|ibm|meta|amazon|nvidia|deepmind|openai|anthropic)/i;

/** Extracts person names from an author byline ("Ada Lovelace1,2, Alan Turing*, and Grace Hopper†"). */
export function parseAuthorLine(line: string): string[] {
  const cleaned = line
    .replace(/[*†‡§¶∗⋆✉]/g, ' ')
    .replace(/(\p{L})[\d¹²³⁴⁵⁶⁷⁸⁹⁰]+(?:\s*,\s*[\d¹²³⁴⁵⁶⁷⁸⁹⁰]+)*/gu, '$1')
    .replace(/\S+@\S+/g, ' ');
  const tokens = cleaned
    .split(/\s*(?:,|;|\band\b|&|·|•|\s{3,})\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return [];
  const NAME = /^\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|van|von|der|de|da|di|del|la|le|bin|ibn))*\s+\p{Lu}[\p{L}'’-]+$/u;
  const names = tokens.filter((t) => t.length <= 40 && NAME.test(t) && !INSTITUTION.test(t));
  return names.length && names.length >= tokens.length * 0.5 ? names : [];
}

/** Abstract paragraph from sample text (best effort). */
export function findAbstract(text: string): string | undefined {
  const m = /(?:^|\n)\s*abstract\b[\s.:—–-]*([\s\S]{60,3000}?)(?=\n\s*\n\s*(?:\d+\.?|[IVX]+\.)?\s*(?:introduction|keywords|index terms|ccs concepts)\b|\n\s*\n|$)/i.exec(
    text,
  );
  if (!m) return undefined;
  const s = m[1].replace(/\s+/g, ' ').trim();
  return s.length >= 60 ? s.slice(0, 2000) : undefined;
}

interface HeuristicMeta {
  title?: string;
  authors?: string[];
}

/** Title = largest text near the top of page 1; authors = name-like line(s) right below it. */
export function guessTitleAndAuthors(items: TextItem[], pageHeight: number): HeuristicMeta {
  const body = estimateBodyFontSize(items);
  const cands = items.filter(
    (it) =>
      !it.angle &&
      it.str.trim().length >= 1 &&
      it.y < pageHeight * 0.6 &&
      !/^(arxiv|preprint|proceedings|journal|vol\.|volume|doi|https?:|www\.|published|accepted|received|copyright|©)/i.test(it.str.trim()),
  );
  if (!cands.length) return {};
  const maxFs = Math.max(...cands.map((c) => c.fontSize));
  if (maxFs < body * 1.15) return {};
  const big = cands.filter((c) => c.fontSize >= maxFs * 0.92).sort((a, b) => a.y - b.y);
  const cluster: TextItem[] = [big[0]];
  let bottom = big[0].y + big[0].h;
  for (const it of big.slice(1)) {
    if (it.y - bottom > maxFs * 1.3) break;
    cluster.push(it);
    bottom = Math.max(bottom, it.y + it.h);
  }
  const title = itemsToText(cluster, { bodyFontSize: maxFs }).replace(/\s+/g, ' ').trim();
  const out: HeuristicMeta = {};
  if (title.length >= 4 && title.length <= 300 && /\p{L}{2}/u.test(title)) out.title = title;

  // authors: lines between the title and "Abstract"
  const below = items
    .filter((it) => !it.angle && it.y >= bottom - 1 && it.y < bottom + body * 12 && it.fontSize < maxFs * 0.9)
    .sort((a, b) => a.y - b.y);
  const lines = itemsToLines(below);
  const authors: string[] = [];
  for (const l of lines.slice(0, 4)) {
    if (/^\s*abstract\b/i.test(l)) break;
    const names = parseAuthorLine(l);
    if (names.length) authors.push(...names);
    else if (authors.length) break;
  }
  if (authors.length && authors.length <= 30) out.authors = [...new Set(authors)];
  return out;
}

// ------------------------------------------------------------------ outline

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

async function buildToc(
  pdf: PDFDocumentProxy,
  outline: OutlineNode[],
  maxEntries: number,
  maxDepth: number,
  signal?: AbortSignal,
): Promise<{ toc: TocEntry[]; truncated: boolean }> {
  let count = 0;
  let truncated = false;
  const refCache = new Map<string, Promise<number | undefined>>();
  const pageOfRef = (ref: { num: number; gen: number }) => {
    const key = `${ref.num}R${ref.gen}`;
    let p = refCache.get(key);
    if (!p) {
      p = pdf.getPageIndex(ref).then(
        (i) => i + 1,
        () => undefined,
      );
      refCache.set(key, p);
    }
    return p;
  };
  const resolve = async (dest: OutlineNode['dest']): Promise<number | undefined> => {
    let explicit: unknown[] | null = null;
    if (typeof dest === 'string') explicit = await pdf.getDestination(dest).catch(() => null);
    else if (Array.isArray(dest)) explicit = dest;
    if (!explicit?.length) return undefined;
    const target = explicit[0] as unknown;
    if (target && typeof target === 'object' && 'num' in (target as object)) return pageOfRef(target as { num: number; gen: number });
    if (typeof target === 'number' && Number.isInteger(target)) return target + 1;
    return undefined;
  };
  const walk = async (nodes: OutlineNode[], depth: number): Promise<TocEntry[]> => {
    throwIfAborted(signal);
    const selected: OutlineNode[] = [];
    for (const n of nodes) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      count++;
      selected.push(n);
    }
    const pages = await Promise.all(selected.map((n) => resolve(n.dest).catch(() => undefined)));
    const out: TocEntry[] = [];
    for (let i = 0; i < selected.length; i++) {
      const n = selected[i];
      const e: TocEntry = { title: (n.title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled' };
      if (pages[i]) e.page = pages[i];
      const kids = (n.items ?? []) as OutlineNode[];
      if (kids.length) {
        if (depth + 1 < maxDepth) {
          const c = await walk(kids, depth + 1);
          if (c.length) e.children = c;
        } else truncated = true;
      }
      out.push(e);
    }
    return out;
  };
  const toc = await walk(outline, 0);
  return { toc, truncated };
}

// ------------------------------------------------------------------ analysis

export interface AnalyzePdfOptions {
  signal?: AbortSignal;
  /** cap on outline entries (default 2000) */
  maxTocEntries?: number;
  /** cap on outline depth (default 6) */
  maxTocDepth?: number;
  /** pages sampled for text (default 3) */
  samplePages?: number;
  /** pages sampled for slide detection (default 8) */
  slideSamples?: number;
  /** original file name: titles equal to it are treated as garbage */
  fileName?: string;
}

function sampleIndices(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i + 1);
  const set = new Set<number>();
  for (let i = 1; i <= Math.min(4, k); i++) set.add(i);
  const rest = k - set.size;
  for (let j = 1; j <= rest; j++) set.add(Math.min(n, Math.round((j * n) / (rest + 1))));
  return [...set].sort((a, b) => a - b);
}

function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const [x0, y0, x1, y1] = page.view;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return page.rotate % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

function xmpGet(md: { get(name: string): unknown } | null | undefined, name: string): unknown {
  try {
    return md?.get(name);
  } catch {
    return undefined;
  }
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) return v.map(firstString).find(Boolean);
  return undefined;
}

/** One-shot, bounded analysis at import time (metadata, outline, slides, sample text, identifiers). */
export async function analyzePdf(pdf: PDFDocumentProxy, opts: AnalyzePdfOptions = {}): Promise<PdfAnalysis> {
  const { signal } = opts;
  const n = pdf.numPages;
  throwIfAborted(signal);

  // metadata (Info dict + XMP)
  const md = await pdf.getMetadata().catch(() => null);
  const info = (md?.info ?? {}) as Record<string, unknown>;
  const xmp = md?.metadata as { get(name: string): unknown } | null | undefined;
  const infoTitle = typeof info.Title === 'string' ? info.Title.trim() : undefined;
  const xmpTitle = firstString(xmpGet(xmp, 'dc:title'));
  const infoAuthor = typeof info.Author === 'string' ? info.Author : undefined;
  const xmpCreators = xmpGet(xmp, 'dc:creator');

  // outline
  throwIfAborted(signal);
  const outline = await pdf.getOutline().catch(() => null);
  const { toc, truncated } = outline?.length
    ? await buildToc(pdf, outline, opts.maxTocEntries ?? 2000, opts.maxTocDepth ?? 6, signal)
    : { toc: [] as TocEntry[], truncated: false };

  // slide detection on a bounded sample of pages
  let landscape = 0;
  const slideIdx = sampleIndices(n, opts.slideSamples ?? 8);
  let firstSize: { width: number; height: number } | undefined;
  for (const i of slideIdx) {
    throwIfAborted(signal);
    const page = await pdf.getPage(i);
    const s = pageSize(page);
    if (i === 1) firstSize = s;
    if (s.width / s.height >= 1.25) landscape++;
    page.cleanup();
  }
  const isSlides = slideIdx.length > 0 && landscape / slideIdx.length >= 2 / 3;

  // sample text from the first pages
  const texts: string[] = [];
  let page1Items: TextItem[] = [];
  for (let i = 1; i <= Math.min(n, opts.samplePages ?? 3); i++) {
    throwIfAborted(signal);
    const page = await pdf.getPage(i);
    try {
      const items = await getPageTextItems(page);
      if (i === 1) page1Items = items;
      texts.push(itemsToText(items));
    } catch {
      /* unreadable page: skip */
    } finally {
      page.cleanup();
    }
  }
  const sampleText = texts.join('\n\n').slice(0, 20000);

  // identifiers
  const idSources = [
    firstString(xmpGet(xmp, 'prism:doi')),
    firstString(xmpGet(xmp, 'pdfx:doi')),
    firstString(xmpGet(xmp, 'dc:identifier')),
    typeof info.Subject === 'string' ? info.Subject : undefined,
    typeof info.Keywords === 'string' ? info.Keywords : undefined,
    sampleText,
  ].filter(Boolean) as string[];
  let doi: string | undefined;
  for (const s of idSources) if ((doi = findDoi(s))) break;
  let arxiv: string | undefined;
  for (const s of idSources) if ((arxiv = findArxivId(s))) break;

  // title & authors
  const guess = page1Items.length && firstSize ? guessTitleAndAuthors(page1Items, firstSize.height) : {};
  let title: string | undefined;
  if (!isGarbageTitle(infoTitle, opts.fileName)) title = infoTitle;
  else if (!isGarbageTitle(xmpTitle, opts.fileName)) title = xmpTitle;
  else if (guess.title) title = guess.title;
  let authors = splitAuthors(infoAuthor);
  if (!authors.length) authors = splitAuthors(xmpCreators as string | string[] | undefined);
  if (!authors.length && guess.authors) authors = guess.authors;

  // year
  let year = arxiv ? arxivYear(arxiv) : undefined;
  if (!year) {
    const d = parsePdfDate(info.CreationDate) ?? parsePdfDate(firstString(xmpGet(xmp, 'xmp:createdate')));
    const y = d?.getUTCFullYear();
    if (y && y >= 1900 && y <= new Date().getUTCFullYear() + 1) year = y;
  }

  const bib: BibMeta = {};
  if (title) bib.title = title;
  if (authors.length) bib.authors = authors;
  if (year) bib.year = year;
  if (doi) bib.doi = doi;
  if (arxiv) {
    bib.arxiv = arxiv;
    bib.url = `https://arxiv.org/abs/${arxiv}`;
  }
  const abstract = findAbstract(sampleText);
  if (abstract) bib.abstract = abstract;
  bib.entryType = isSlides ? 'misc' : n >= 150 ? 'book' : arxiv && !doi ? 'misc' : 'article';

  const result: PdfAnalysis = { pageCount: n, bib, toc, isSlides, sampleText };
  if (title) result.title = title;
  if (firstSize) result.pageSize = firstSize;
  if (truncated) result.tocTruncated = true;
  return result;
}
