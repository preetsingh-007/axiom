import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acquirePdf, cropPage } from './pdfCache';
import { loadPdfjs, getPageTextItems, type PDFDocumentProxy, type PDFPageProxy } from '../../core/ingest/pdf';
import type { Highlight, SourceMeta, SourceLocator } from '../../core/schema';
import { useServices } from '../app/services';
import { useYShallow } from '../hooks/useY';
import { LassoOverlay } from './LassoOverlay';
import { analyseSelection, type Extraction } from './extraction';
import type { ReaderTool } from './ReaderPane';
import { useSelectionMenu, type SelectionInfo } from './SelectionMenu';

const GAP = 14;
const MAX_CANVAS_PIXELS = 12_000_000;

interface Props {
  source: SourceMeta;
  zoom: number;
  tool: ReaderTool;
  jump?: { loc: SourceLocator; flash?: boolean; nonce: number };
  onExtract(ex: Extraction, anchorRect: DOMRect): void;
  onSelection(info: SelectionInfo | null): void;
  onPageChange(page: number): void;
  onZoom(z: number): void;
  scrollToPage?: { page: number; nonce: number };
}

/**
 * Virtualised PDF viewer built for 800-page textbooks: only pages near the viewport are
 * rendered (canvas + text layer), far pages are released, and the reading position is
 * saved continuously so the book re-opens exactly where you left it, on any device.
 */
export function PdfViewer({ source, zoom, tool, jump, onExtract, onSelection, onPageChange, onZoom, scrollToPage }: Props) {
  const { vault } = useServices();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [sizes, setSizes] = useState<Map<number, { w: number; h: number }>>(new Map());
  const [width, setWidth] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [flash, setFlash] = useState<{ page: number; rect: [number, number, number, number]; nonce: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const handle = acquirePdf(source.id);
    handle.pdf
      .then(async (d) => {
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (!alive) return;
        setBaseSize({ w: vp.width, h: vp.height });
        setPdf(d);
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
      handle.release();
    };
  }, [source.id]);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pageCount = pdf?.numPages ?? source.pageCount ?? 0;
  const fitWidth = Math.max(200, Math.min(width - 32, source.isSlides ? 1400 : 1000));
  const cssWidthFor = (n: number) => {
    const s = sizes.get(n) ?? baseSize;
    if (!s || !baseSize) return fitWidth * zoom;
    return (fitWidth * zoom * s.w) / baseSize.w;
  };
  const cssHeightFor = (n: number) => {
    const s = sizes.get(n) ?? baseSize;
    if (!s) return fitWidth * zoom * 1.3;
    return (cssWidthFor(n) * s.h) / s.w;
  };

  // cumulative offsets for O(log n) page lookup
  const offsets = useRef<number[]>([]);
  {
    const arr: number[] = new Array(pageCount + 1);
    let y = 16;
    for (let n = 1; n <= pageCount; n++) {
      arr[n] = y;
      y += cssHeightFor(n) + GAP;
    }
    arr[0] = y; // total height stored at index 0
    offsets.current = arr;
  }

  const pageAt = useCallback(
    (y: number) => {
      const off = offsets.current;
      let lo = 1,
        hi = pageCount;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (off[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [pageCount],
  );

  const reportSize = useCallback((n: number, w: number, h: number) => {
    setSizes((prev) => {
      const cur = prev.get(n);
      if (cur && Math.abs(cur.w - w) < 0.5 && Math.abs(cur.h - h) < 0.5) return prev;
      if (!cur && baseSize && Math.abs(baseSize.w - w) < 0.5 && Math.abs(baseSize.h - h) < 0.5) return prev;
      const next = new Map(prev);
      next.set(n, { w, h });
      return next;
    });
  }, [baseSize]);

  // restore reading position once laid out
  useLayoutEffect(() => {
    if (restored.current || !pdf || !width || !scroll.current) return;
    restored.current = true;
    if (jump) return; // a wormhole jump wins
    const vs = vault.getViewState(source.id);
    if (vs?.loc.page) {
      const n = Math.min(pageCount, vs.loc.page);
      scroll.current.scrollTop = offsets.current[n] + (vs.intra ?? 0) * cssHeightFor(n);
    }
  });

  // wormhole jumps
  useEffect(() => {
    if (!jump || !pdf || !width || !scroll.current) return;
    const n = Math.min(pageCount, Math.max(1, jump.loc.page ?? 1));
    const h = cssHeightFor(n);
    const rect = jump.loc.rect;
    const targetY = offsets.current[n] + (rect ? (rect[1] + rect[3] / 2) * h : 0) - scroll.current.clientHeight / 2;
    scroll.current.scrollTo({ top: Math.max(0, targetY), behavior: restored.current ? 'smooth' : 'auto' });
    restored.current = true;
    if (rect && jump.flash) setFlash({ page: n, rect, nonce: jump.nonce });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce, pdf, width > 0]);

  useEffect(() => {
    if (!scrollToPage || !scroll.current) return;
    scroll.current.scrollTo({ top: offsets.current[Math.min(pageCount, scrollToPage.page)] - 8, behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToPage?.nonce]);

  // keep zoom anchored on the current page (offsets include fixed gaps that don't scale)
  const posRef = useRef<{ n: number; intra: number }>({ n: 1, intra: 0 });
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || prevZoom.current === zoom) return;
    prevZoom.current = zoom;
    const { n, intra } = posRef.current;
    if (offsets.current[n] !== undefined) el.scrollTop = offsets.current[n] + intra * cssHeightFor(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // persist view state (throttled)
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 3]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onScroll = () => {
    const el = scroll.current;
    if (!el || !pageCount) return;
    const top = el.scrollTop;
    const first = pageAt(top);
    posRef.current = { n: first, intra: Math.max(0, Math.min(1, (top - offsets.current[first]) / cssHeightFor(first))) };
    const last = pageAt(top + el.clientHeight);
    setVisibleRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
    const cur = pageAt(top + el.clientHeight / 3);
    onPageChange(cur);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const n = pageAt(el.scrollTop);
      const intra = Math.max(0, Math.min(1, (el.scrollTop - offsets.current[n]) / cssHeightFor(n)));
      vault.setViewState(source.id, { loc: { page: n }, zoom, intra, updatedAt: Date.now() });
    }, 500);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    if (pdf) onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, width, zoom]);

  // ctrl+wheel / pinch zoom inside the reader
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom(Math.max(0.4, Math.min(4, zoom * Math.exp(-e.deltaY * 0.01))));
    };
    let pinch: { d0: number; z0: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const ts = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { d0: dist(e.touches), z0: zoom };
    };
    const tm = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const z = Math.max(0.4, Math.min(4, pinch.z0 * (dist(e.touches) / pinch.d0)));
      el.style.setProperty('--pinch', String(z / zoom));
      el.classList.add('pinching');
    };
    const te = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      const k = parseFloat(el.style.getPropertyValue('--pinch') || '1');
      el.classList.remove('pinching');
      el.style.removeProperty('--pinch');
      if (Math.abs(k - 1) > 0.02) onZoom(Math.max(0.4, Math.min(4, zoom * k)));
      pinch = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', te);
    el.addEventListener('touchcancel', te);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', ts);
      el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', te);
      el.removeEventListener('touchcancel', te);
    };
  }, [zoom, onZoom]);

  // text selection → floating menu
  useSelectionMenu(scroll, source.id, onSelection);

  useYShallow(vault.highlights);
  const byPage = new Map<number, Highlight[]>();
  for (const h of vault.highlightsFor(source.id)) {
    const p = h.loc.page ?? 0;
    const list = byPage.get(p);
    if (list) list.push(h);
    else byPage.set(p, [h]);
  }

  const onLasso = async (poly: [number, number][], bbox: DOMRect) => {
    if (!pdf || !scroll.current) return;
    const cx = bbox.left + bbox.width / 2;
    const cy = bbox.top + bbox.height / 2;
    const pageEl = (document.elementsFromPoint(cx, cy).find((el) => el.classList.contains('pdfv-page')) as HTMLElement | undefined) ??
      [...scroll.current.querySelectorAll<HTMLElement>('.pdfv-page')].find((el) => {
        const r = el.getBoundingClientRect();
        return cy >= r.top && cy <= r.bottom;
      });
    if (!pageEl) return;
    const n = Number(pageEl.dataset.page);
    const pr = pageEl.getBoundingClientRect();
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const toPage = ([x, y]: [number, number]): [number, number] => [((x - pr.left) / pr.width) * vp.width, ((y - pr.top) / pr.height) * vp.height];
    const polyPage = poly.map(toPage);
    const items = await getPageTextItems(page);
    const ex = analyseSelection(items, polyPage, vp.width, vp.height, source.id, n);
    const r = ex.loc.rect!;
    // pad the crop a little so glyph edges aren't clipped
    const pad = 0.006;
    const crop = await cropPage(source.id, n, [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(1, r[2] + 2 * pad), Math.min(1, r[3] + 2 * pad)]);
    if (crop) ex.image = crop;
    onExtract(ex, bbox);
  };

  if (error) return <div className="ui-empty"><h3>Couldn't open this PDF</h3><p>{error}</p></div>;

  const total = offsets.current[0] ?? 0;
  const renderFrom = Math.max(1, visibleRange[0] - 2);
  const renderTo = Math.min(pageCount, visibleRange[1] + 2);
  const pages: number[] = [];
  for (let n = renderFrom; n <= renderTo; n++) pages.push(n);

  return (
    <div ref={scroll} className={`pdfv-scroll${source.isSlides ? ' slides' : ''} tool-${tool}`} onScroll={onScroll} tabIndex={0} aria-label={`${source.title}, ${pageCount} pages`}>
      <div className="pdfv-canvas" style={{ height: total }}>
        {pdf &&
          pages.map((n) => (
            <PdfPage
              key={n}
              pdf={pdf}
              n={n}
              top={offsets.current[n]}
              cssWidth={cssWidthFor(n)}
              cssHeight={cssHeightFor(n)}
              highlights={byPage.get(n)}
              flash={flash?.page === n ? flash : null}
              onSize={reportSize}
            />
          ))}
      </div>
      <LassoOverlay active={tool === 'lasso'} penLasso={tool === 'select'} target={scroll} onComplete={onLasso} />
    </div>
  );
}

const PdfPage = memo(function PdfPage({
  pdf,
  n,
  top,
  cssWidth,
  cssHeight,
  highlights,
  flash,
  onSize,
}: {
  pdf: PDFDocumentProxy;
  n: number;
  top: number;
  cssWidth: number;
  cssHeight: number;
  highlights?: Highlight[];
  flash: { rect: [number, number, number, number]; nonce: number } | null;
  onSize(n: number, w: number, h: number): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let alive = true;
    pdf.getPage(n).then((p) => {
      if (!alive) return;
      const vp = p.getViewport({ scale: 1 });
      onSize(n, vp.width, vp.height);
      setPage(p);
    });
    return () => {
      alive = false;
    };
  }, [pdf, n, onSize]);

  // canvas render (debounced on zoom changes)
  useEffect(() => {
    if (!page || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = (cssWidth / base.width) * dpr;
    if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    const vp = page.getViewport({ scale });
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    const t = setTimeout(() => {
      // render offscreen then swap, so zooming never flashes blank
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = page.render({ canvasContext: off.getContext('2d')!, canvas: off, viewport: vp });
      task.promise
        .then(() => {
          canvas.width = off.width;
          canvas.height = off.height;
          canvas.getContext('2d')!.drawImage(off, 0, 0);
          off.width = off.height = 0;
          setRendered(true);
        })
        .catch(() => {});
    }, rendered ? 120 : 0);
    return () => {
      clearTimeout(t);
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, cssWidth]);

  // text layer (for selection, highlights & accessibility)
  useEffect(() => {
    if (!page || !textRef.current) return;
    const container = textRef.current;
    let cancelled = false;
    let layer: { cancel(): void } | null = null;
    (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      container.replaceChildren();
      const vp = page.getViewport({ scale: cssWidth / page.getViewport({ scale: 1 }).width });
      container.style.setProperty('--total-scale-factor', String(vp.scale));
      container.style.setProperty('--scale-factor', String(vp.scale));
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
      layer = tl;
      await tl.render().catch(() => {});
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [page, cssWidth, n]);

  return (
    <div className="pdfv-page" data-page={n} style={{ top, width: cssWidth, height: cssHeight }}>
      <canvas ref={canvasRef} className={`pdfv-canvas-el${rendered ? ' ready' : ''}`} style={{ width: cssWidth, height: cssHeight }} aria-hidden />
      <div className="pdfv-hl-layer" aria-hidden>
        {highlights?.map((h) =>
          h.rects.map((r, i) => (
            <div
              key={h.id + i}
              className="pdfv-hl"
              data-highlight-id={h.id}
              style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%`, background: `var(--highlight-${h.color})` }}
            />
          )),
        )}
      </div>
      <div ref={textRef} className="textLayer" />
      {flash && (
        <div
          key={flash.nonce}
          className="pdfv-flash"
          style={{ left: `${flash.rect[0] * 100}%`, top: `${flash.rect[1] * 100}%`, width: `${flash.rect[2] * 100}%`, height: `${flash.rect[3] * 100}%` }}
        />
      )}
      <div className="pdfv-pagenum">{n}</div>
    </div>
  );
});
