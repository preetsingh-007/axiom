/**
 * EPUB 2/3 parsing with JSZip.
 *
 * Only the container, OPF and navigation documents are read up front; chapter
 * XHTML is decompressed on demand, sanitized, and kept in a small LRU cache.
 * Images referenced by chapters become object URLs of their zip entries (created
 * lazily, revoked by `dispose()`). Book CSS is dropped on purpose so every book
 * renders in Axiom's reading theme.
 *
 * Element ids inside chapters are prefixed (`epubAnchorId(chapter, id)`) so that
 * several chapters can live in one DOM; internal links become
 * `href="#<prefixed id>"` plus `data-epub-chapter` / `data-epub-fragment`.
 */
import JSZip from 'jszip';
import type { EpubBook, EpubChapter, EpubTocEntry } from './types';
import { attr, child, childrenNamed, elements, find, findAll, parseXml, path, textContent, type XmlElement } from './xml';
import { purifyHtml, sanitizeTree } from './sanitize';
import { LRU } from '../util/lru';

/** DOM id used for fragment `id` of chapter `chapter` in rendered chapter HTML. */
export function epubAnchorId(chapter: number, fragment?: string): string {
  return fragment ? `epub${chapter}-${fragment}` : `epub${chapter}`;
}

interface ManifestItem {
  id: string;
  /** absolute path inside the zip */
  path: string;
  mediaType: string;
  properties: string[];
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolves `rel` against the file `base` (both zip paths); returns [path, fragment]. */
export function resolveZipPath(base: string, rel: string): [string, string | undefined] {
  const hashAt = rel.indexOf('#');
  const fragment = hashAt >= 0 ? safeDecode(rel.slice(hashAt + 1)) || undefined : undefined;
  let p = hashAt >= 0 ? rel.slice(0, hashAt) : rel;
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  if (!p) return [base, fragment];
  const joined = p.startsWith('/') ? p.slice(1) : dirOf(base) + p;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return [safeDecode(parts.join('/')), fragment];
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function mimeFromPath(p: string): string {
  return EXT_MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function htmlToText(xhtml: string): string {
  return xhtml
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export interface ParseEpubOptions {
  /** number of sanitized chapters kept in memory (default 6) */
  chapterCacheSize?: number;
}

/** Parses an EPUB. Throws with a readable message when the file is not a valid EPUB. */
export async function parseEpub(blob: Blob, opts: ParseEpubOptions = {}): Promise<EpubBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer());
  } catch {
    throw new Error('This file is not a valid EPUB (it is not a zip archive).');
  }
  const byLower = new Map<string, string>();
  zip.forEach((p) => byLower.set(p.toLowerCase(), p));
  const entry = (p: string) => zip.file(p) ?? zip.file(byLower.get(p.toLowerCase()) ?? '\0') ?? zip.file(encodeURI(p));
  const readText = async (p: string) => {
    const f = entry(p);
    return f ? f.async('string') : null;
  };

  // container → OPF
  let opfPath: string | undefined;
  const container = await readText('META-INF/container.xml');
  if (container) opfPath = attr(find(parseXml(container), 'rootfile'), 'full-path');
  if (!opfPath || !entry(opfPath)) opfPath = [...byLower.values()].find((p) => p.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new Error('This EPUB has no package document (content.opf).');
  const opfXml = parseXml((await readText(opfPath)) ?? '');
  const pkg = find(opfXml, 'package') ?? opfXml;
  const metadata = child(pkg, 'metadata') ?? find(pkg, 'metadata');

  // metadata
  const dc = (name: string) => childrenNamed(metadata, name).map((e) => textContent(e).trim()).filter(Boolean);
  const metas = childrenNamed(metadata, 'meta');
  const refines = new Map<string, Record<string, string>>();
  for (const m of metas) {
    const r = attr(m, 'refines');
    const prop = attr(m, 'property');
    if (r && prop) {
      const key = r.replace(/^#/, '');
      const rec = refines.get(key) ?? {};
      rec[prop] = textContent(m).trim();
      refines.set(key, rec);
    }
  }
  const creators = childrenNamed(metadata, 'creator')
    .filter((c) => {
      const role = attr(c, 'role') ?? refines.get(attr(c, 'id') ?? '')?.['role'];
      return !role || role === 'aut';
    })
    .map((c) => textContent(c).trim())
    .filter(Boolean);
  const uidId = attr(pkg, 'unique-identifier');
  const identifiers = childrenNamed(metadata, 'identifier');
  const identifier = textContent(identifiers.find((i) => attr(i, 'id') === uidId) ?? identifiers[0]).trim() || undefined;

  // manifest & spine
  const manifest = new Map<string, ManifestItem>();
  const byPath = new Map<string, ManifestItem>();
  for (const it of childrenNamed(child(pkg, 'manifest'), 'item')) {
    const id = attr(it, 'id');
    const href = attr(it, 'href');
    if (!id || !href) continue;
    const item: ManifestItem = {
      id,
      path: resolveZipPath(opfPath, href)[0],
      mediaType: attr(it, 'media-type') ?? mimeFromPath(href),
      properties: (attr(it, 'properties') ?? '').split(/\s+/).filter(Boolean),
    };
    manifest.set(id, item);
    byPath.set(item.path, item);
  }
  const spineEl = child(pkg, 'spine');
  const chapters: EpubChapter[] = [];
  const spineIndex = new Map<string, number>();
  for (const ref of childrenNamed(spineEl, 'itemref')) {
    const item = manifest.get(attr(ref, 'idref') ?? '');
    if (!item) continue;
    spineIndex.set(item.path, chapters.length);
    spineIndex.set(item.path.toLowerCase(), chapters.length);
    chapters.push({ id: item.id, href: item.path });
  }
  if (!chapters.length) throw new Error('This EPUB has an empty reading order (spine).');

  const resolveHref = (href: string, from?: number): { chapter: number; fragment?: string } | null => {
    if (isExternal(href)) return null;
    const base = from !== undefined && chapters[from] ? chapters[from].href : opfPath!;
    const [p, fragment] = resolveZipPath(base, href);
    const idx = spineIndex.get(p) ?? spineIndex.get(p.toLowerCase());
    if (idx === undefined) return null;
    return fragment ? { chapter: idx, fragment } : { chapter: idx };
  };

  // table of contents: EPUB3 nav, else NCX
  let toc: EpubTocEntry[] = [];
  const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
  if (navItem) {
    const navSrc = await readText(navItem.path);
    if (navSrc) toc = parseNav(parseXml(navSrc), navItem.path, (h, base) => resolveFromFile(h, base));
  }
  if (!toc.length) {
    const ncxItem =
      manifest.get(attr(spineEl, 'toc') ?? '') ?? [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxSrc = await readText(ncxItem.path);
      if (ncxSrc) toc = parseNcx(parseXml(ncxSrc), ncxItem.path, (h, base) => resolveFromFile(h, base));
    }
  }
  function resolveFromFile(href: string, baseFile: string) {
    if (isExternal(href)) return null;
    const [p, fragment] = resolveZipPath(baseFile, href);
    const idx = spineIndex.get(p) ?? spineIndex.get(p.toLowerCase());
    if (idx === undefined) return null;
    return { chapter: idx, fragment };
  }
  // chapter titles from the first TOC entry that points at each chapter
  const walkTitles = (entries: EpubTocEntry[]) => {
    for (const e of entries) {
      if (e.chapter !== undefined && !chapters[e.chapter].title && !e.fragment) chapters[e.chapter].title = e.title;
      if (e.children) walkTitles(e.children);
    }
  };
  walkTitles(toc);
  const walkTitlesLoose = (entries: EpubTocEntry[]) => {
    for (const e of entries) {
      if (e.chapter !== undefined && !chapters[e.chapter].title) chapters[e.chapter].title = e.title;
      if (e.children) walkTitlesLoose(e.children);
    }
  };
  walkTitlesLoose(toc);

  // object URLs for zip entries (lazy, shared across chapters)
  const urls = new Map<string, string>();
  let disposed = false;
  const objectUrlFor = async (p: string): Promise<string | null> => {
    const existing = urls.get(p);
    if (existing) return existing;
    const f = entry(p);
    if (!f || disposed) return null;
    const bytes = await f.async('uint8array');
    const type = byPath.get(p)?.mediaType ?? mimeFromPath(p);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    if (disposed) {
      URL.revokeObjectURL(url);
      return null;
    }
    urls.set(p, url);
    return url;
  };

  // cover
  let coverPath: string | undefined = [...manifest.values()].find((m) => m.properties.includes('cover-image'))?.path;
  if (!coverPath) {
    const coverMeta = metas.find((m) => attr(m, 'name') === 'cover');
    const it = coverMeta ? manifest.get(attr(coverMeta, 'content') ?? '') : undefined;
    if (it && it.mediaType.startsWith('image/')) coverPath = it.path;
  }
  if (!coverPath) {
    coverPath = [...manifest.values()].find((m) => m.mediaType.startsWith('image/') && /cover/i.test(m.id + m.path))?.path;
  }
  const coverUrl = coverPath ? ((await objectUrlFor(coverPath)) ?? undefined) : undefined;

  // chapters
  const cache = new LRU<number, Promise<string>>(Math.max(1, opts.chapterCacheSize ?? 6));
  const renderChapter = async (index: number): Promise<string> => {
    const ch = chapters[index];
    const src = await readText(ch.href);
    if (src == null) return '';
    const doc = parseXml(src);
    const body = find(doc, 'body') ?? doc;
    // resolve images first (async), then serialize synchronously
    const imgRefs = new Set<string>();
    for (const img of findAll(body, 'img')) {
      const s = attr(img, 'src');
      if (s && !isExternal(s)) imgRefs.add(s);
    }
    for (const im of findAll(body, 'image')) {
      const s = attr(im, 'href');
      if (s && !isExternal(s)) imgRefs.add(s);
    }
    const imgMap = new Map<string, string>();
    await Promise.all(
      [...imgRefs].map(async (ref) => {
        const [p] = resolveZipPath(ch.href, ref);
        const url = await objectUrlFor(p);
        if (url) imgMap.set(ref, url);
      }),
    );
    const html = sanitizeTree(body, {
      idPrefix: epubAnchorId(index) + '-',
      resolveUrl: (kind, value) => {
        const v = value.trim();
        if (kind === 'img') {
          if (imgMap.has(v)) return imgMap.get(v)!;
          if (/^https:\/\//i.test(v) || /^data:image\/(png|jpe?g|gif|webp);/i.test(v)) return v;
          return null;
        }
        if (/^(https?|mailto):/i.test(v)) return v;
        if (isExternal(v)) return null;
        const target = resolveHref(v, index);
        if (!target) return null;
        return '#' + epubAnchorId(target.chapter, target.fragment);
      },
      linkAttrs: (value) => {
        const v = value.trim();
        if (/^(https?|mailto):/i.test(v)) return { target: '_blank', rel: 'noopener noreferrer' };
        const target = resolveHref(v, index);
        if (!target) return {};
        const a: Record<string, string> = { 'data-epub-chapter': String(target.chapter) };
        if (target.fragment) a['data-epub-fragment'] = target.fragment;
        return a;
      },
    });
    return purifyHtml(html);
  };

  const book: EpubBook = {
    title: dc('title')[0] || 'Untitled',
    authors: creators,
    toc,
    chapters,
    resolveHref,
    chapterHtml(index: number) {
      if (disposed) return Promise.reject(new Error('EPUB disposed'));
      if (!Number.isInteger(index) || index < 0 || index >= chapters.length) {
        return Promise.reject(new RangeError(`chapter ${index} out of range (0..${chapters.length - 1})`));
      }
      let p = cache.get(index);
      if (!p) {
        p = renderChapter(index);
        cache.set(index, p);
        p.catch(() => cache.delete(index));
      }
      return p;
    },
    async sampleText(maxChars = 4000) {
      let out = '';
      for (const ch of chapters) {
        if (out.length >= maxChars) break;
        const src = await readText(ch.href);
        if (!src) continue;
        const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src);
        const t = htmlToText(bodyMatch ? bodyMatch[1] : src);
        if (t) out += (out ? '\n\n' : '') + t;
      }
      return out.slice(0, maxChars);
    },
    dispose() {
      disposed = true;
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      for (const k of [...cache.keys()]) cache.delete(k);
    },
  };
  const lang = dc('language')[0];
  if (lang) book.language = lang;
  const publisher = dc('publisher')[0];
  if (publisher) book.publisher = publisher;
  const date = dc('date')[0];
  if (date) book.date = date;
  if (identifier) book.identifier = identifier;
  if (coverUrl) book.coverUrl = coverUrl;
  return book;
}

type Resolver = (href: string, baseFile: string) => { chapter: number; fragment?: string } | null;

function makeEntry(title: string, href: string | undefined, base: string, resolve: Resolver): EpubTocEntry {
  const e: EpubTocEntry = { title: title.replace(/\s+/g, ' ').trim() || 'Untitled' };
  if (href) {
    const t = resolve(href, base);
    if (t) {
      e.chapter = t.chapter;
      if (t.fragment) e.fragment = t.fragment;
    }
  }
  return e;
}

/** EPUB3 navigation document → TOC. */
function parseNav(doc: XmlElement, base: string, resolve: Resolver): EpubTocEntry[] {
  const navs = findAll(doc, 'nav');
  const nav = navs.find((n) => /\btoc\b/.test(attr(n, 'type') ?? '')) ?? navs[0];
  const ol = nav ? (child(nav, 'ol') ?? find(nav, 'ol')) : undefined;
  if (!ol) return [];
  const walk = (list: XmlElement, depth: number): EpubTocEntry[] => {
    if (depth > 10) return [];
    const out: EpubTocEntry[] = [];
    for (const li of childrenNamed(list, 'li')) {
      const label = elements(li).find((e) => e.local === 'a' || e.local === 'span');
      const e = makeEntry(textContent(label), label?.local === 'a' ? attr(label, 'href') : undefined, base, resolve);
      const sub = child(li, 'ol');
      if (sub) {
        const kids = walk(sub, depth + 1);
        if (kids.length) e.children = kids;
      }
      out.push(e);
    }
    return out;
  };
  return walk(ol, 0);
}

/** EPUB2 NCX → TOC. */
function parseNcx(doc: XmlElement, base: string, resolve: Resolver): EpubTocEntry[] {
  const navMap = find(doc, 'navMap');
  if (!navMap) return [];
  const walk = (el: XmlElement, depth: number): EpubTocEntry[] => {
    if (depth > 10) return [];
    return childrenNamed(el, 'navPoint').map((np) => {
      const e = makeEntry(textContent(path(np, 'navLabel', 'text')), attr(child(np, 'content'), 'src'), base, resolve);
      const kids = walk(np, depth + 1);
      if (kids.length) e.children = kids;
      return e;
    });
  };
  return walk(navMap, 0);
}
