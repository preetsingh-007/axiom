/**
 * Focus view: a whiteboard or photo opened full screen, zoomable.
 *
 *  - pinch with two fingers zooms (and pans) around the fingers; one finger pans when a pen is
 *    in use (the pen draws), trackpad pinch / Ctrl+wheel zooms around the cursor, ⌘/Ctrl + − 0;
 *  - zoomed in, the pen gets finer, so writing at a comfortable size lands small and neat;
 *  - it edits the same block as the note: everything syncs and shows in the note immediately.
 *
 * Gestures in the note itself are untouched: zoom lives only here.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { Minus, Plus, ArrowDownToLine } from 'lucide-react';
import { INK_LOGICAL_WIDTH } from '../../core/schema';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import type { AIRouter } from '../../core/ai/router';
import { useServices } from '../app/services';
import { useBlobUrl } from '../hooks/usePage';
import { InkCanvas } from './InkCanvas';
import { InkToolbar } from './InkToolbar';
import { useFocusInk, type FocusTarget } from './focusStore';
import './focus.css';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 6;
const PAD = 16;

export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 1000) / 1000));
}

/** Mounted once at app level; renders the focus view while a target is open. */
export function FocusViewHost() {
  const target = useFocusInk((s) => s.target);
  const close = useFocusInk((s) => s.close);
  if (!target) return null;
  return <FocusView key={blockKey(target.block)} target={target} onClose={close} />;
}

let keySeq = 0;
const keys = new WeakMap<object, number>();
function blockKey(b: object): number {
  let k = keys.get(b);
  if (k === undefined) keys.set(b, (k = ++keySeq));
  return k;
}

function useBlockAlive(block: Y.Map<unknown>, onGone: () => void) {
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useEffect(() => {
    const parent = block.parent as Y.Map<unknown> | null;
    const id = block.get('id') as string | undefined;
    if (!parent || !id) return;
    const check = () => {
      if (parent.get(id) !== block) goneRef.current();
    };
    parent.observe(check);
    return () => parent.unobserve(check);
  }, [block]);
}

export function FocusView({ target, onClose }: { target: FocusTarget; onClose: () => void }) {
  const services = useServices();
  const ai = services.ai as AIRouter | undefined;
  const { block, kind } = target;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [baseW, setBaseW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const baseRef = useRef(0);
  baseRef.current = baseW;
  /** scroll position to apply after the next layout (keeps the zoom anchor in place) */
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const blobUrl = useBlobUrl(target.image?.blobId);
  const photoUrl = target.image?.url ?? blobUrl;

  useBlockAlive(block, onClose);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScroller(el);
    const measure = () => setBaseW(Math.max(200, el.clientWidth - PAD * 2));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const s = pendingScroll.current;
    if (!el || !s) return;
    pendingScroll.current = null;
    el.scrollLeft = s.left;
    el.scrollTop = s.top;
  }, [zoom, baseW]);

  /** Zooms to `z`, keeping the content point under (clientX, clientY) under it. */
  const zoomAt = useCallback((z: number, clientX?: number, clientY?: number, from?: { z: number; clientX: number; clientY: number; left: number; top: number }) => {
    const el = scrollerRef.current;
    const base = baseRef.current;
    if (!el || !base) return;
    const next = clampZoom(z);
    const r = el.getBoundingClientRect();
    const ax = (clientX ?? r.left + el.clientWidth / 2) - r.left;
    const ay = (clientY ?? r.top + el.clientHeight / 2) - r.top;
    const z0 = from?.z ?? zoomRef.current;
    const left0 = from?.left ?? el.scrollLeft;
    const top0 = from?.top ?? el.scrollTop;
    const fx = from ? from.clientX - r.left : ax;
    const fy = from ? from.clientY - r.top : ay;
    // content coordinates (fraction of the content width) of the anchor before zooming
    const w0 = base * z0;
    const off0 = Math.max(PAD, (el.clientWidth - w0) / 2);
    const cx = (left0 + fx - off0) / w0;
    const cy = (top0 + fy - PAD) / w0;
    const w1 = base * next;
    const off1 = Math.max(PAD, (el.clientWidth - w1) / 2);
    pendingScroll.current = { left: Math.max(0, cx * w1 + off1 - ax), top: Math.max(0, cy * w1 + PAD - ay) };
    if (next === zoomRef.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    } else setZoom(next);
  }, []);

  // ---- pinch (two fingers) and trackpad zoom
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let pinch: { d0: number; z: number; clientX: number; clientY: number; left: number; top: number } | null = null;
    let raf = 0;
    let latest: { z: number; x: number; y: number } | null = null;
    const two = (e: TouchEvent) => {
      const a = e.touches[0];
      const b = e.touches[1];
      return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const t = two(e);
      pinch = { d0: Math.max(10, t.d), z: zoomRef.current, clientX: t.x, clientY: t.y, left: el.scrollLeft, top: el.scrollTop };
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const t = two(e);
      latest = { z: pinch.z * (t.d / pinch.d0), x: t.x, y: t.y };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pinch && latest) zoomAt(latest.z, latest.x, latest.y, pinch);
      });
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    // Safari: its own page pinch-zoom would fight ours
    const onGesture = (e: Event) => e.preventDefault();
    const opts = { passive: false } as AddEventListenerOptions;
    el.addEventListener('gesturestart', onGesture, opts);
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('wheel', onWheel, opts);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('touchstart', onStart, opts);
      el.removeEventListener('touchmove', onMove, opts);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel, opts);
      el.removeEventListener('gesturestart', onGesture, opts);
    };
  }, [zoomAt]);

  // ---- keyboard: Escape closes, ⌘/Ctrl + / − / 0 zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomAt(zoomRef.current * 1.25);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault();
        zoomAt(zoomRef.current / 1.25);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        zoomAt(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomAt]);

  useEffect(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  const extend = () => {
    const h = Number(block.get('height')) || 300;
    const apply = () => block.set('height', Math.ceil(h + 300));
    if (block.doc) block.doc.transact(apply, LOCAL_ORIGIN);
    else apply();
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  };

  const photo = kind === 'photo' && target.image && target.image.w > 0 && target.image.h > 0 ? target.image : null;
  const fixedHeight = photo ? Math.round((INK_LOGICAL_WIDTH * photo.h) / photo.w) : undefined;
  const width = baseW * zoom;
  const title = target.title ?? (kind === 'photo' ? 'Annotate photo' : 'Whiteboard');

  return (
    <div className="focus-view" role="dialog" aria-modal="true" aria-label={title}>
      <header className="focus-bar">
        <span className="focus-title">{title}</span>
        <div className="focus-zoom" role="group" aria-label="Zoom">
          <button type="button" className="focus-btn" onClick={() => zoomAt(zoom / 1.25)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" title="Zoom out (⌘−)">
            <Minus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="focus-btn focus-zoom-value" onClick={() => zoomAt(1)} title="Fit width (⌘0)" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset`}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="focus-btn" onClick={() => zoomAt(zoom * 1.25)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in (⌘+) · pinch to zoom">
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {kind === 'whiteboard' && (
          <button type="button" className="focus-btn" onClick={extend} title="Add space below" aria-label="Add space below">
            <ArrowDownToLine size={16} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="focus-done" onClick={onClose}>
          Done
        </button>
      </header>
      <div ref={scrollerRef} className="focus-scroll" tabIndex={-1} data-zoom={zoom}>
        {baseW > 0 && scroller && (
          <div className="focus-content" style={{ width, marginLeft: Math.max(PAD, (scroller.clientWidth - width) / 2) }}>
            <InkCanvas
              block={block}
              ai={ai}
              scroller={scroller}
              zoom={zoom}
              minHeight={kind === 'whiteboard' ? 600 : undefined}
              fixedHeight={fixedHeight}
              className="focus-ink"
              background={photo && photoUrl ? <img className="ink-photo-img" src={photoUrl} alt="" draggable={false} /> : undefined}
            />
          </div>
        )}
      </div>
      <div className="focus-dock">
        <InkToolbar />
      </div>
    </div>
  );
}

export default FocusViewHost;
