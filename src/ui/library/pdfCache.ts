import { openPdf, closePdf, type PDFDocumentProxy } from '../../core/ingest/pdf';
import { getServicesUnsafe } from '../app/servicesRef';
import { LRU } from '../../core/util/lru';

/**
 * Shared, bounded cache of open PDF documents and rendered page bitmaps. Every viewer and
 * every slide block goes through here so a textbook is parsed once per session.
 */

/** open viewers / renders per source: a referenced document is never evicted */
const refs = new Map<string, number>();

const docs = new LRU<string, Promise<PDFDocumentProxy>>(4, (k, p) => {
  if ((refs.get(k) ?? 0) > 0) return false;
  void p.then((d) => closePdf(d)).catch(() => {});
  return true;
});

/** Pins a document while in use; call the returned release() when done. */
export function acquirePdf(sourceId: string): { pdf: Promise<PDFDocumentProxy>; release: () => void } {
  refs.set(sourceId, (refs.get(sourceId) ?? 0) + 1);
  let released = false;
  return {
    pdf: getPdf(sourceId),
    release: () => {
      if (released) return;
      released = true;
      const n = (refs.get(sourceId) ?? 1) - 1;
      if (n <= 0) refs.delete(sourceId);
      else refs.set(sourceId, n);
    },
  };
}

export function getPdf(sourceId: string): Promise<PDFDocumentProxy> {
  let p = docs.get(sourceId);
  if (!p) {
    p = (async () => {
      const { vault } = getServicesUnsafe();
      const src = vault.getSource(sourceId);
      if (!src) throw new Error('Unknown source');
      const blob = await vault.getBlob(src.blobId);
      if (!blob) throw new Error('This file has not been downloaded to this device yet. Enable Git file sync, or import it here.');
      return openPdf(new Uint8Array(await blob.arrayBuffer()));
    })();
    docs.set(sourceId, p);
    p.catch(() => docs.delete(sourceId));
  }
  return p;
}

interface Rendered {
  url: string;
  width: number;
  height: number;
}

const rendered = new LRU<string, Promise<Rendered | null>>(80, (_k, p) => {
  void p.then((r) => r && URL.revokeObjectURL(r.url));
  return true;
});

/** Renders one page to an image (object URL) at a given CSS width. Cached. */
export function renderSourcePage(sourceId: string, page: number, width: number): Promise<Rendered | null> {
  const key = `${sourceId}:${page}:${width}`;
  let p = rendered.get(key);
  if (!p) {
    p = (async () => {
      const handle = acquirePdf(sourceId);
      try {
        const pdf = await handle.pdf;
        const pg = await pdf.getPage(page);
        const base = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: width / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d')!;
        await pg.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.9));
        canvas.width = canvas.height = 0;
        if (!blob) return null;
        return { url: URL.createObjectURL(blob), width: vp.width, height: vp.height };
      } catch (e) {
        console.warn('[axiom] page render failed', e);
        return null;
      } finally {
        handle.release();
      }
    })();
    rendered.set(key, p);
    p.then((r) => r === null && rendered.delete(key));
  }
  return p;
}

/** Crops a region (normalised 0..1 page rect) of a page to a PNG blob at high resolution. */
export async function cropPage(sourceId: string, page: number, rect: [number, number, number, number], targetWidth = 1600): Promise<{ blob: Blob; w: number; h: number } | null> {
  const handle = acquirePdf(sourceId);
  try {
    return await cropPageInner(await handle.pdf, page, rect, targetWidth);
  } finally {
    handle.release();
  }
}

async function cropPageInner(pdf: PDFDocumentProxy, page: number, rect: [number, number, number, number], targetWidth: number): Promise<{ blob: Blob; w: number; h: number } | null> {
  const pg = await pdf.getPage(page);
  const base = pg.getViewport({ scale: 1 });
  const regionW = rect[2] * base.width;
  const scale = Math.min(6, Math.max(1.5, targetWidth / Math.max(1, regionW)));
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const cw = Math.max(1, Math.round(rect[2] * vp.width));
  const ch = Math.max(1, Math.round(rect[3] * vp.height));
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  await pg.render({
    canvasContext: ctx,
    canvas,
    viewport: vp,
    transform: [1, 0, 0, 1, -rect[0] * vp.width, -rect[1] * vp.height],
  }).promise;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  canvas.width = canvas.height = 0;
  return blob ? { blob, w: cw, h: ch } : null;
}
