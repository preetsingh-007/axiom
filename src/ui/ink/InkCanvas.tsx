/**
 * <InkCanvas block={inkBlockYMap} ai={router} />
 *
 * A calm whiteboard area inside a document. Drawing, erasing, lasso selection, move/scale,
 * Beautify (✨ button or double-tap inside the selection) and the non-destructive
 * "Show original ink / Show beautified" toggle. All pointer work happens in `InkSurface`
 * (refs + rAF); React only re-renders for rare state changes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type * as Y from 'yjs';
import katex from 'katex';
import { Sparkles, Trash, Undo2 } from 'lucide-react';
import type { Beautified, BeautifiedItem } from '../../core/schema';
import { INK_LOGICAL_WIDTH } from '../../core/schema';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import { bboxContains, inflateBBox, type Pt } from '../../core/ink/geometry';
import { CURRENT_INK, itemBBox, textMetrics } from '../../core/ink/render';
import { beautify, expandToItems, mergeBeautified, type InkAI } from '../../core/ink/beautify';
import { safeColor, sanitizeSvgFragment, escapeXml } from '../../core/ink/svgsafe';
import { useYShallow } from '../hooks/useY';
import { isDrawingTool, useInkStore } from './inkStore';
import { InkSurface, type InkSelection } from './surface';
import './ink.css';

export interface InkCanvasProps {
  /** the ink block's Y.Map (fields: strokes, height, beautified) */
  block: Y.Map<unknown>;
  /** disables drawing, erasing, selection and CRDT writes */
  readOnly?: boolean;
  /** called with the block height (logical units) whenever it changes */
  onHeightChange?: (height: number) => void;
  /** minimum displayed height in logical units (default 160) */
  minHeight?: number;
  className?: string;
  /** AI used by Beautify for handwriting / math OCR (the app's AIRouter) */
  ai?: InkAI | null;
}

export const NEEDS_AI_MESSAGE = 'Connect an AI provider in Settings to convert handwriting';

type TextItem = Extract<BeautifiedItem, { kind: 'text' | 'latex' }>;

function LatexItem({ item, scale, selected }: { item: Extract<BeautifiedItem, { kind: 'latex' }>; scale: number; selected: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    try {
      return katex.renderToString(item.latex, { throwOnError: false, displayMode: false, output: 'html', strict: 'ignore' });
    } catch {
      return escapeXml(item.latex);
    }
  }, [item.latex]);
  const base = textMetrics(item).fontSize * scale;
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    el.style.fontSize = `${base}px`;
    const cw = el.scrollWidth;
    const ch = el.scrollHeight;
    if (!cw || !ch) return;
    const k = Math.min((item.w * scale) / cw, (item.h * scale) / ch);
    el.style.fontSize = `${base * Math.max(0.35, Math.min(1.6, k))}px`;
  }, [html, base, item.w, item.h, scale]);
  return (
    <div
      ref={ref}
      className="ink-item ink-latex"
      data-x={item.x}
      data-y={item.y}
      data-ink-selected={selected ? '1' : undefined}
      style={{ left: item.x * scale, top: item.y * scale, width: item.w * scale, height: item.h * scale }}
    >
      <span className="ink-latex-inner" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function TextItemView({ item, scale, selected }: { item: Extract<BeautifiedItem, { kind: 'text' }>; scale: number; selected: boolean }) {
  const { fontSize } = textMetrics(item);
  return (
    <div
      className="ink-item ink-text"
      data-x={item.x}
      data-y={item.y}
      data-ink-selected={selected ? '1' : undefined}
      style={{ left: item.x * scale, top: item.y * scale, width: item.w * scale, minHeight: item.h * scale, fontSize: fontSize * scale }}
    >
      {item.text}
    </div>
  );
}

export function InkCanvas({ block, readOnly = false, onHeightChange, minHeight = 160, className, ai }: InkCanvasProps) {
  useYShallow(block as unknown as Y.AbstractType<unknown>);
  const height = Number(block.get('height')) || 300;
  const beautified = block.get('beautified') as Beautified | undefined;
  const displayH = Math.max(height, minHeight);
  const tool = useInkStore((s) => s.tool);

  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef<HTMLCanvasElement>(null);
  const wetRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<InkSurface | null>(null);

  const [width, setWidth] = useState(0);
  const [count, setCount] = useState(0);
  const [selection, setSelection] = useState<InkSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toggleAt, setToggleAt] = useState<Pt | null>(null);

  const scale = (width || INK_LOGICAL_WIDTH) / INK_LOGICAL_WIDTH;
  const aiRef = useRef(ai);
  aiRef.current = ai;
  const busyRef = useRef(false);
  const beautifyRef = useRef<() => void>(() => {});
  const tapRef = useRef<(p: Pt) => void>(() => {});

  // ---- engine lifecycle
  useLayoutEffect(() => {
    const root = rootRef.current;
    const surface = surfaceRef.current;
    const committed = committedRef.current;
    const wet = wetRef.current;
    if (!root || !surface || !committed || !wet) return;
    const eng = new InkSurface(root, surface, committed, wet, block, {
      onSelection: (s) => setSelection(s),
      onDoubleTapSelection: () => beautifyRef.current(),
      onTap: (p) => tapRef.current(p),
      onCount: (n) => setCount(n),
    });
    engineRef.current = eng;
    const w = surface.getBoundingClientRect().width;
    if (w) {
      setWidth(w);
      eng.setWidth(w);
    }
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        const cw = entries[entries.length - 1]?.contentRect.width ?? 0;
        if (cw > 0) {
          setWidth(cw);
          eng.setWidth(cw);
        }
      });
      ro.observe(surface);
    }
    // theme changes → re-resolve --ink-default
    const mo = new MutationObserver(() => eng.themeChanged());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onMq = () => eng.themeChanged();
    mq?.addEventListener?.('change', onMq);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      mq?.removeEventListener?.('change', onMq);
      eng.destroy();
      engineRef.current = null;
    };
  }, [block]);

  useEffect(() => {
    engineRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    engineRef.current?.setMinHeight(minHeight);
  }, [minHeight]);

  const onHeightRef = useRef(onHeightChange);
  onHeightRef.current = onHeightChange;
  useEffect(() => {
    onHeightRef.current?.(height);
  }, [height]);

  useEffect(() => {
    engineRef.current?.clearSelection();
    setToggleAt(null);
  }, [tool]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- taps → reveal the beautified toggle
  tapRef.current = (p: Pt) => {
    const b = block.get('beautified') as Beautified | undefined;
    if (!b?.items.length || readOnly) {
      setToggleAt(null);
      return;
    }
    const hit = b.items.some((it) => bboxContains(inflateBBox(itemBBox(it), 10), p));
    setToggleAt(hit ? p : null);
  };

  const toggleView = useCallback(() => {
    const b = block.get('beautified') as Beautified | undefined;
    if (!b || readOnly) return;
    const apply = () => block.set('beautified', { ...b, active: !b.active });
    if (block.doc) block.doc.transact(apply, LOCAL_ORIGIN);
    else apply();
  }, [block, readOnly]);

  // ---- beautify
  const runBeautify = useCallback(async () => {
    const eng = engineRef.current;
    const sel = eng?.getSelection();
    if (!eng || !sel || busyRef.current || readOnly) return;
    const prev = block.get('beautified') as Beautified | undefined;
    const ids = expandToItems(sel.ids, prev);
    const strokes = eng.getStrokes().filter((s) => ids.has(s.id) && s.tool === 'pen');
    if (!strokes.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await beautify(strokes, { ai: aiRef.current, rasterize: (s) => eng.rasterize(s) });
      const unrec = new Set(res.unrecognizedStrokeIds);
      const replaced = new Set([...ids].filter((id) => !unrec.has(id)));
      const cur = block.get('beautified') as Beautified | undefined;
      const touchesOld = !!cur?.items.some((it) => it.strokeIds.some((id) => replaced.has(id)));
      if (res.items.length || touchesOld) {
        const apply = () => block.set('beautified', mergeBeautified(block.get('beautified') as Beautified | undefined, res.items, replaced));
        if (block.doc) block.doc.transact(apply, LOCAL_ORIGIN);
        else apply();
      }
      if (res.needsAI) setNotice(NEEDS_AI_MESSAGE);
      else if (res.errors.length) setNotice(`Couldn't read some handwriting: ${res.errors[0]}`);
      else if (!res.items.length) setNotice('Nothing to beautify here');
      eng.clearSelection();
    } catch (e) {
      setNotice(`Beautify failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [block, readOnly]);
  beautifyRef.current = () => void runBeautify();

  const deleteSelection = useCallback(() => {
    const eng = engineRef.current;
    const sel = eng?.getSelection();
    if (!eng || !sel || readOnly) return;
    eng.deleteStrokes(new Set(sel.ids));
    eng.clearSelection();
  }, [readOnly]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (selection || toggleAt) {
        engineRef.current?.clearSelection();
        setToggleAt(null);
        e.stopPropagation();
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection && !readOnly) {
      e.preventDefault();
      deleteSelection();
    }
  };

  // ---- beautified overlay
  const active = !!beautified?.active;
  const selectedIds = useMemo(() => new Set(selection?.ids ?? []), [selection]);
  const isSel = useCallback((it: BeautifiedItem) => selectedIds.size > 0 && it.strokeIds.every((id) => selectedIds.has(id)), [selectedIds]);
  const shapesHtml = useMemo(() => {
    if (!active || !beautified) return '';
    return beautified.items
      .map((it) => {
        if (it.kind !== 'shape') return '';
        const color = it.color === CURRENT_INK ? 'var(--ink-default)' : safeColor(it.color, 'var(--ink-default)');
        const sel = isSel(it) ? ' data-ink-selected="1"' : '';
        return `<g style="color:${color}"${sel}>${sanitizeSvgFragment(it.svg)}</g>`;
      })
      .join('');
  }, [active, beautified, isSel]);
  const textItems = active && beautified ? (beautified.items.filter((it) => it.kind !== 'shape') as TextItem[]) : [];

  const capture = isDrawingTool(tool) && !readOnly;
  const classes = ['ink-block', `ink-tool-${tool}`, capture ? 'ink-capture' : '', busy ? 'ink-busy' : '', className ?? ''].filter(Boolean).join(' ');
  const selBox = selection?.box;
  const barBelow = selBox ? selBox.y * scale < 44 : false;

  return (
    <div ref={rootRef} className={classes} tabIndex={0} onKeyDown={onKeyDown} data-ink-tool={tool}>
      <div
        ref={surfaceRef}
        className="ink-surface"
        role="img"
        aria-label={`Whiteboard, ${count} ${count === 1 ? 'stroke' : 'strokes'}`}
        style={{ aspectRatio: `${INK_LOGICAL_WIDTH} / ${displayH}` }}
      >
        <canvas ref={committedRef} className="ink-layer ink-committed" aria-hidden="true" />
        {active && (
          <div className="ink-overlay" aria-hidden="true">
            <svg
              className="ink-overlay-svg"
              viewBox={`0 0 ${INK_LOGICAL_WIDTH} ${displayH}`}
              preserveAspectRatio="xMinYMin meet"
              dangerouslySetInnerHTML={{ __html: shapesHtml }}
            />
            {textItems.map((it, i) =>
              it.kind === 'latex' ? (
                <LatexItem key={`l${i}-${it.strokeIds[0]}`} item={it} scale={scale} selected={isSel(it)} />
              ) : (
                <TextItemView key={`t${i}-${it.strokeIds[0]}`} item={it} scale={scale} selected={isSel(it)} />
              ),
            )}
          </div>
        )}
        <canvas ref={wetRef} className="ink-layer ink-wet" aria-hidden="true" />
      </div>

      {selBox && !readOnly && (
        <div
          className="ink-selection"
          style={{ left: selBox.x * scale, top: selBox.y * scale, width: selBox.w * scale, height: selBox.h * scale }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <span key={h} className={`ink-handle ink-handle-${h}`} data-ink-handle={h} />
          ))}
          {busy && <div className="ink-shimmer" />}
          <div className={`ink-selection-bar ink-ui${barBelow ? ' ink-selection-bar-below' : ''}`}>
            <button type="button" className="ink-bar-btn ink-bar-primary" onClick={() => void runBeautify()} disabled={busy} title="Beautify (or double-tap the selection)">
              <Sparkles size={15} aria-hidden="true" />
              <span>{busy ? 'Beautifying…' : 'Beautify'}</span>
            </button>
            <button type="button" className="ink-bar-btn" onClick={deleteSelection} disabled={busy} aria-label="Delete selection" title="Delete (⌫)">
              <Trash size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {toggleAt && beautified && !readOnly && (
        <div className="ink-toggle ink-ui" style={{ left: toggleAt.x * scale, top: toggleAt.y * scale }}>
          <button type="button" className="ink-bar-btn" onClick={toggleView} aria-pressed={!beautified.active}>
            {beautified.active ? <Undo2 size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
            <span>{beautified.active ? 'Show original ink' : 'Show beautified'}</span>
          </button>
        </div>
      )}

      {notice && (
        <div className="ink-notice ink-ui" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

export default InkCanvas;
