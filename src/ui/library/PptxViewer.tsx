import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PptxDeck } from '../../core/ingest/types';
import { parsePptx } from '../../core/ingest/pptx';
import type { SourceLocator, SourceMeta } from '../../core/schema';
import { useServices } from '../app/services';
import { PptxSlideView, renderSlideToCanvas } from './pptx/PptxSlideView';
import { LassoOverlay } from './LassoOverlay';
import { extractFromDom } from './domExtract';
import type { Extraction } from './extraction';
import type { ReaderTool } from './ReaderPane';
import { LRU } from '../../core/util/lru';

const decks = new LRU<string, Promise<PptxDeck>>(2, (_k, p) => {
  void p.then((d) => d.dispose()).catch(() => {});
  return true;
});

export function getDeck(sourceId: string, getBlob: () => Promise<Blob | undefined>): Promise<PptxDeck> {
  let p = decks.get(sourceId);
  if (!p) {
    p = getBlob().then((b) => {
      if (!b) throw new Error('File not available on this device yet');
      return parsePptx(b);
    });
    decks.set(sourceId, p);
    p.catch(() => decks.delete(sourceId));
  }
  return p;
}

/** PPTX decks are always shown as a vertical stream of slides (slide stacking). */
export function PptxViewer({ source, tool, jump, onExtract }: { source: SourceMeta; tool: ReaderTool; jump?: { loc: SourceLocator; flash?: boolean; nonce: number }; onExtract(ex: Extraction, anchor: DOMRect): void }) {
  const { vault } = useServices();
  const [deck, setDeck] = useState<PptxDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(800);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getDeck(source.id, () => vault.getBlob(source.blobId))
      .then((d) => alive && setDeck(d))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [source.id, source.blobId, vault]);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(1400, el.clientWidth - 32)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!deck || !scroll.current) return;
    const page = jump?.loc.page ?? vault.getViewState(source.id)?.loc.page;
    if (!page) return;
    requestAnimationFrame(() => {
      const el = scroll.current?.querySelector<HTMLElement>(`[data-slide="${page}"]`);
      if (el) scroll.current!.scrollTo({ top: el.offsetTop - 12, behavior: jump ? 'smooth' : 'auto' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, jump?.nonce]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onScroll = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const el = scroll.current;
      if (!el) return;
      const slides = [...el.querySelectorAll<HTMLElement>('[data-slide]')];
      const cur = slides.filter((s) => s.offsetTop <= el.scrollTop + 40).pop() ?? slides[0];
      if (cur) vault.setViewState(source.id, { loc: { page: Number(cur.dataset.slide) }, zoom: 1, updatedAt: Date.now() });
    }, 500);
  };

  const onLasso = async (poly: [number, number][], bbox: DOMRect) => {
    const slideEl = document.elementsFromPoint(bbox.left + bbox.width / 2, bbox.top + bbox.height / 2).find((e) => (e as HTMLElement).dataset?.slide) as HTMLElement | undefined;
    if (!slideEl || !deck) return;
    const n = Number(slideEl.dataset.slide);
    const r = slideEl.getBoundingClientRect();
    const rect: [number, number, number, number] = [(bbox.left - r.left) / r.width, (bbox.top - r.top) / r.height, bbox.width / r.width, bbox.height / r.height];
    const res = extractFromDom(slideEl, poly, source.id, { page: n, rect });
    const ex: Extraction = { ...res };
    // crop the region from a raster of the slide (for "Image" mode)
    try {
      const canvas = await renderSlideToCanvas(deck, deck.slides[n - 1], 1600);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(rect[2] * canvas.width));
      c.height = Math.max(1, Math.round(rect[3] * canvas.height));
      c.getContext('2d')!.drawImage(canvas, -rect[0] * canvas.width, -rect[1] * canvas.height);
      const blob = await new Promise<Blob | null>((res2) => c.toBlob(res2, 'image/png'));
      if (blob) ex.image = { blob, w: c.width, h: c.height };
    } catch {
      /* raster optional */
    }
    onExtract(ex, bbox);
  };

  if (error) return <div className="ui-empty"><h3>Couldn't open this deck</h3><p>{error}</p></div>;
  if (!deck) return <div className="route-loading"><div className="ui-spinner" /></div>;

  return (
    <div ref={scroll} className={`pptx-scroll tool-${tool}`} onScroll={onScroll}>
      {deck.slides.map((s) => (
        <div key={s.index} className="pptx-slide-wrap" data-slide={s.index + 1}>
          <PptxSlideView deck={deck} slide={s} width={width} />
          <div className="pptx-slide-num">{s.index + 1}</div>
        </div>
      ))}
      <LassoOverlay active={tool === 'lasso'} penLasso={tool === 'select'} target={scroll} onComplete={onLasso} />
    </div>
  );
}
