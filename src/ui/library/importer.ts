import { create } from 'zustand';
import JSZip from 'jszip';
import type { BibMeta, SourceKind, SourceMeta, TocEntry } from '../../core/schema';
import { openPdf, analyzePdf, closePdf } from '../../core/ingest/pdf';
import { parseEpub } from '../../core/ingest/epub';
import { parsePptx } from '../../core/ingest/pptx';
import { makeCiteKey } from '../../core/citations/citekey';
import { lookupDoi } from '../../core/citations/crossref';
import { suggestGhostTags } from '../../core/graph/ghost';
import { getServicesUnsafe } from '../app/servicesRef';
import type { AppServices } from '../app/bootstrap';
import { useUI } from '../app/store';
import type { AIConfig } from '../../core/ai/types';
import { renderSlideToCanvas } from './pptx/PptxSlideView';

interface ImportProgress {
  active: number;
  done: number;
  total: number;
  current?: string;
}

const useProgressStore = create<ImportProgress>(() => ({ active: 0, done: 0, total: 0 }));
export const useImportProgress = () => useProgressStore();

/** Sniffs the real format from magic bytes (+ zip contents), not just the extension. */
export async function detectKind(file: File): Promise<SourceKind | 'ppt' | null> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return /\.pptx?$/i.test(file.name) ? 'ppt' : null;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (ascii.includes('mimetypeapplication/epub+zip')) return 'epub';
    if (/\.epub$/i.test(file.name)) return 'epub';
    if (/\.pptx$/i.test(file.name)) return 'pptx';
    try {
      const zip = await JSZip.loadAsync(file);
      if (zip.file('ppt/presentation.xml')) return 'pptx';
      if (zip.file('META-INF/container.xml')) return 'epub';
    } catch {
      return null;
    }
  }
  return null;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/webp', q = 0.85): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

function titleFromFile(name: string) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

interface Analysis {
  title: string;
  bib: BibMeta;
  toc: TocEntry[];
  pageCount?: number;
  isSlides?: boolean;
  sampleText: string;
  thumb?: Blob | null;
}

async function analyse(kind: SourceKind, file: File): Promise<Analysis> {
  if (kind === 'pdf') {
    const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
    try {
      const a = await analyzePdf(pdf, { fileName: file.name });
      let thumb: Blob | null = null;
      try {
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 360 / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        thumb = await canvasToBlob(canvas);
      } catch {
        /* thumbnail optional */
      }
      return { title: a.title || a.bib.title || titleFromFile(file.name), bib: a.bib, toc: a.toc, pageCount: a.pageCount, isSlides: a.isSlides, sampleText: a.sampleText, thumb };
    } finally {
      await closePdf(pdf);
    }
  }
  if (kind === 'epub') {
    const book = await parseEpub(file);
    try {
      let thumb: Blob | null = null;
      if (book.coverUrl) thumb = await fetch(book.coverUrl).then((r) => r.blob()).catch(() => null);
      const year = book.date ? Number(/\d{4}/.exec(book.date)?.[0]) || undefined : undefined;
      const bib: BibMeta = { title: book.title, authors: book.authors, year, publisher: book.publisher, entryType: 'book' };
      return { title: book.title || titleFromFile(file.name), bib, toc: book.toc, pageCount: book.chapters.length, sampleText: await book.sampleText(6000), thumb };
    } finally {
      book.dispose();
    }
  }
  const deck = await parsePptx(file);
  try {
    let thumb: Blob | null = null;
    if (deck.slides[0]) thumb = await renderSlideToCanvas(deck, deck.slides[0], 480).then((c) => canvasToBlob(c)).catch(() => null);
    const toc: TocEntry[] = deck.slides.map((s) => ({ title: s.title || `Slide ${s.index + 1}`, page: s.index + 1 }));
    const text = deck.slides.map((s) => s.elements.map((e) => (e.kind === 'text' ? e.paragraphs.map((p) => p.text).join('\n') : '')).join('\n')).join('\n');
    const title = deck.title || deck.slides[0]?.title || titleFromFile(file.name);
    return { title, bib: { title, authors: deck.author ? [deck.author] : undefined, entryType: 'misc' }, toc, pageCount: deck.slides.length, isSlides: true, sampleText: text.slice(0, 6000), thumb };
  } finally {
    deck.dispose();
  }
}

async function importOne(file: File): Promise<string | null> {
  const services = getServicesUnsafe() as AppServices;
  const { vault } = services;
  const kind = await detectKind(file);
  if (kind === 'ppt') {
    useUI.getState().toast({ message: `“${file.name}” is a legacy .ppt file — please save it as .pptx or PDF first`, kind: 'error' });
    return null;
  }
  if (!kind) {
    useUI.getState().toast({ message: `“${file.name}” isn't a PDF, EPUB or PPTX`, kind: 'error' });
    return null;
  }
  const blobId = await vault.putBlob(file);
  const id = 's-' + blobId.slice(2, 16);
  if (vault.getSource(id)) return id; // already imported (content-addressed)

  const a = await analyse(kind, file);
  const existingKeys = vault.listSources().map((s) => s.bib?.bibKey).filter((k): k is string => !!k);
  const bib: BibMeta = { ...a.bib, title: a.bib.title || a.title };
  bib.bibKey = makeCiteKey(bib, existingKeys);
  const thumbBlobId = a.thumb ? await vault.putBlob(a.thumb) : undefined;
  const meta: SourceMeta = {
    id,
    kind,
    title: a.title,
    fileName: file.name,
    blobId,
    size: file.size,
    addedAt: Date.now(),
    pageCount: a.pageCount,
    isSlides: a.isSlides,
    bib,
    toc: a.toc,
    thumbBlobId,
  };
  vault.putSource(meta);
  void enrich(id, a.sampleText);
  return id;
}

function hasModelProvider(cfg: AIConfig): boolean {
  return !!(cfg.gemini?.apiKey || cfg.anthropic?.apiKey || (cfg.openai?.baseUrl && cfg.openai.model) || cfg.webllm?.enabled);
}

/** Background enrichment: ghost tags from the user's graph (+AI) and Crossref metadata. */
async function enrich(sourceId: string, sampleText: string) {
  const { vault, graph, ai, aiConfig } = getServicesUnsafe() as AppServices;
  const src = vault.getSource(sourceId);
  if (!src) return;
  try {
    const tags = await suggestGhostTags({
      text: `${src.title}\n${src.bib?.abstract ?? ''}\n${sampleText}`,
      concepts: graph.concepts(),
      exclude: [...(src.tags ?? []), ...(src.dismissedGhostTags ?? [])],
      max: 6,
      // the offline keyphrase fallback is too noisy for suggestions; use AI only when a real model is set up
      ai: hasModelProvider(aiConfig.current) ? ai : undefined,
    });
    if (tags.length) vault.updateSource(sourceId, { ghostTags: tags.map((t) => t.tag) });
  } catch (e) {
    console.warn('[axiom] ghost tags failed', e);
  }
  if (src.bib?.doi && navigator.onLine) await refreshCitation(sourceId);
}

/** Looks up the DOI on Crossref and merges missing fields (keeps the user's key stable). */
export async function refreshCitation(sourceId: string): Promise<boolean> {
  const { vault } = getServicesUnsafe();
  const src = vault.getSource(sourceId);
  if (!src?.bib?.doi) return false;
  try {
    const remote = await lookupDoi(src.bib.doi);
    if (!remote) return false;
    const merged: BibMeta = { ...remote, ...Object.fromEntries(Object.entries(src.bib).filter(([, v]) => v !== undefined && v !== '')) };
    // prefer authoritative authors/year/venue from Crossref
    if (remote.authors?.length) merged.authors = remote.authors;
    if (remote.year) merged.year = remote.year;
    if (remote.venue) merged.venue = remote.venue;
    if (remote.title && (!src.bib.title || src.bib.title === src.title)) merged.title = remote.title;
    const others = vault.listSources().filter((s) => s.id !== sourceId).map((s) => s.bib?.bibKey).filter((k): k is string => !!k);
    merged.bibKey = makeCiteKey(merged, others);
    vault.updateSource(sourceId, { bib: merged, title: merged.title && src.title === src.bib.title ? merged.title : src.title });
    return true;
  } catch {
    return false;
  }
}

/** Imports documents into the Source Vault. Returns how many were added. */
export async function importFilesToLibrary(files: File[]): Promise<number> {
  const accepted = files.filter((f) => f.size > 0);
  if (!accepted.length) return 0;
  const st = useProgressStore;
  st.setState((s) => ({ active: s.active + accepted.length, total: s.total + accepted.length }));
  let added = 0;
  for (const f of accepted) {
    st.setState({ current: f.name });
    try {
      if (await importOne(f)) added++;
    } catch (e) {
      console.error(e);
      useUI.getState().toast({ message: `Couldn't import “${f.name}”: ${(e as Error).message ?? e}`, kind: 'error' });
    } finally {
      st.setState((s) => ({ active: s.active - 1, done: s.done + 1 }));
    }
  }
  st.setState((s) => (s.active === 0 ? { active: 0, done: 0, total: 0, current: undefined } : s));
  return added;
}

export function confirmGhostTag(sourceId: string, tag: string) {
  const { vault } = getServicesUnsafe();
  const src = vault.getSource(sourceId);
  if (!src) return;
  vault.updateSource(sourceId, { tags: [...new Set([...(src.tags ?? []), tag])], ghostTags: (src.ghostTags ?? []).filter((t) => t !== tag) });
  vault.ensureConcept(tag);
}

export function dismissGhostTag(sourceId: string, tag: string) {
  const { vault } = getServicesUnsafe();
  const src = vault.getSource(sourceId);
  if (!src) return;
  vault.updateSource(sourceId, { dismissedGhostTags: [...new Set([...(src.dismissedGhostTags ?? []), tag])], ghostTags: (src.ghostTags ?? []).filter((t) => t !== tag) });
}
