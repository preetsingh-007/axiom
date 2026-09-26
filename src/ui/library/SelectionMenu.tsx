import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Highlighter, SendToBack, Search, Copy, X } from 'lucide-react';
import type { SourceLocator } from '../../core/schema';

export interface SelectionInfo {
  text: string;
  loc: SourceLocator;
  /** normalised rects on the page (PDF) */
  rects: [number, number, number, number][];
  anchor: DOMRect;
}

/** Watches text selections inside a PDF text layer and reports them page-normalised. */
export function useSelectionMenu(container: RefObject<HTMLElement | null>, _sourceId: string, onSelection: (s: SelectionInfo | null) => void) {
  const cb = useRef(onSelection);
  cb.current = onSelection;
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return cb.current(null);
        const range = sel.getRangeAt(0);
        const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) as HTMLElement | null;
        const pageEl = startEl?.closest<HTMLElement>('.pdfv-page');
        if (!pageEl || !el.contains(pageEl)) return cb.current(null);
        const text = sel.toString().replace(/\s+/g, ' ').trim();
        if (!text) return cb.current(null);
        const pr = pageEl.getBoundingClientRect();
        const rects: [number, number, number, number][] = [];
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          if (r.bottom < pr.top || r.top > pr.bottom) continue; // other pages
          rects.push([(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]);
        }
        const merged = mergeRects(rects);
        const bbox = range.getBoundingClientRect();
        const union = merged.reduce(
          (a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[0] + r[2]), Math.max(a[3], r[1] + r[3])],
          [1, 1, 0, 0] as number[],
        );
        cb.current({
          text,
          rects: merged,
          loc: { page: Number(pageEl.dataset.page), rect: [union[0], union[1], union[2] - union[0], union[3] - union[1]] },
          anchor: bbox,
        });
      }, 60);
    };
    el.addEventListener('pointerup', check);
    el.addEventListener('keyup', check);
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) cb.current(null);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      el.removeEventListener('pointerup', check);
      el.removeEventListener('keyup', check);
      document.removeEventListener('selectionchange', onSelChange);
      clearTimeout(t);
    };
  }, [container]);
}

/** Merges per-glyph rects on the same line into line rects (keeps highlights clean). */
export function mergeRects(rects: [number, number, number, number][]): [number, number, number, number][] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: [number, number, number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < r[3] * 0.5 && r[0] <= last[0] + last[2] + 0.02) {
      const x0 = Math.min(last[0], r[0]);
      const x1 = Math.max(last[0] + last[2], r[0] + r[2]);
      const y0 = Math.min(last[1], r[1]);
      const y1 = Math.max(last[1] + last[3], r[1] + r[3]);
      out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
    } else out.push([...r]);
  }
  return out;
}

const COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

export function SelectionMenu({
  info,
  onHighlight,
  onSend,
  onLookup,
  onClose,
}: {
  info: SelectionInfo;
  onHighlight(color: string): void;
  onSend(): void;
  onLookup(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: info.anchor.left, top: info.anchor.bottom + 8 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = info.anchor.left + info.anchor.width / 2 - w / 2;
    let top = info.anchor.top - h - 8;
    if (top < 60) top = info.anchor.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.min(top, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [info]);
  return createPortal(
    <div ref={ref} className="sel-menu" style={pos} role="toolbar" aria-label="Selection actions" onPointerDown={(e) => e.preventDefault()}>
      {COLORS.map((c) => (
        <button key={c} className="sel-swatch" style={{ background: `var(--highlight-${c})` }} onClick={() => onHighlight(c)} title={`Highlight ${c}`} aria-label={`Highlight ${c}`}>
          <Highlighter size={13} />
        </button>
      ))}
      <span className="sel-sep" />
      <button className="sel-btn" onClick={onSend} title="Send quote to Desk (with Wormhole anchor)">
        <SendToBack size={15} /> Desk
      </button>
      <button className="sel-btn" onClick={onLookup} title="Look up in the Side-Quest panel">
        <Search size={15} /> Look up
      </button>
      <button
        className="sel-btn icon"
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(info.text);
          onClose();
        }}
      >
        <Copy size={15} />
      </button>
      <button className="sel-btn icon" onClick={onClose} aria-label="Dismiss">
        <X size={15} />
      </button>
    </div>,
    document.body,
  );
}
