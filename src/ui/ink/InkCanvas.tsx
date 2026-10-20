/**
 * <InkCanvas block={inkBlockYMap} ai={router} />
 *
 * A calm whiteboard area inside a document. Drawing, erasing, lasso selection, move/scale,
 * Beautify (✨ button or double-tap inside the selection) and the non-destructive
 * "Show original ink / Show beautified" toggle for shapes. All pointer work happens in
 * `InkSurface` (refs + rAF); React only re-renders for rare state changes.
 *
 * Handwriting is decided once: Beautify (or auto-convert, after a pause in writing) shows a
 * typed *preview* in place of the writing with Accept / Keep ink. Accepting turns it into real
 * note text (or a typed label when it sits beside a drawing); keeping it drops the preview.
 *
 * The same component serves photos (`fixedHeight` + `background`) and the zoomable focus view
 * (`scroller` + `zoom`: only the visible part of the canvas is drawn).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type * as Y from 'yjs';
import katex from 'katex';
import { Check, Pencil, Sparkles, Trash, Undo2, X } from 'lucide-react';
import type { Beautified, BeautifiedItem, InkLabel, Stroke } from '../../core/schema';
import { INK_LOGICAL_WIDTH } from '../../core/schema';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import { bboxContains, bboxDistance, inflateBBox, type BBox, type Pt } from '../../core/ink/geometry';
import { CURRENT_INK, itemBBox, textMetrics } from '../../core/ink/render';
import { beautify, expandToItems, mergeBeautified, type InkAI } from '../../core/ink/beautify';
import { acceptConversion, conversionBox, deleteLabel, updateLabel, type PendingConversion } from '../../core/ink/convert';
import { safeColor, sanitizeSvgFragment, escapeXml } from '../../core/ink/svgsafe';
import { getBlock, sortLabels } from '../../core/blocks';
import { uid } from '../../core/util/ids';
import { renderInline } from '../markdown/render';
import { useYShallow } from '../hooks/useY';
import { useUI } from '../app/store';
import { isDrawingTool, useInkStore } from './inkStore';
import { InkSurface, type InkSelection } from './surface';
import { addPending, isKeptAsInk, keepAsInk, listPending, movePending, removePending, updatePending, usePending } from './conversions';
import './ink.css';

export interface InkCanvasProps {
  /** the ink block's Y.Map (fields: strokes, height, beautified, labels) */
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
  /** photos: exact logical height (the canvas never grows) */
  fixedHeight?: number;
  /** drawn under the ink (e.g. the photo being annotated) */
  background?: ReactNode;
  /** focus view: the scrolling viewport (canvases cover only its visible part) */
  scroller?: HTMLElement | null;
  /** focus view zoom (finer pen when zoomed in) */
  zoom?: number;
}

export const NEEDS_AI_MESSAGE = 'Connect an AI provider in Settings to convert handwriting';
/** Pause after the last stroke before auto-convert reads the new writing. */
export const AUTO_CONVERT_DELAY = 1300;
/** Writing this close to a preview (logical units) is read together with it. */
const JOIN_DISTANCE = 70;

type TextItem = Extract<BeautifiedItem, { kind: 'text' | 'latex' }>;

function katexHtml(tex: string): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: false, output: 'html', strict: 'ignore' });
  } catch {
    return escapeXml(tex);
  }
}

/** KaTeX scaled to fill a box (beautified LaTeX, labels, previews). */
function FitMath({ tex, box, fontSize, scale }: { tex: string; box: BBox; fontSize: number; scale: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const html = useMemo(() => katexHtml(tex), [tex]);
  const base = fontSize * scale;
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    el.style.fontSize = `${base}px`;
    const cw = el.scrollWidth;
    const ch = el.scrollHeight;
    if (!cw || !ch) return;
    const k = Math.min((box.w * scale) / cw, (box.h * scale) / ch);
    el.style.fontSize = `${base * Math.max(0.35, Math.min(1.6, k))}px`;
  }, [html, base, box.w, box.h, scale]);
  return <span ref={ref} className="ink-latex-inner" dangerouslySetInnerHTML={{ __html: html }} />;
}

function LatexItem({ item, scale, selected }: { item: Extract<BeautifiedItem, { kind: 'latex' }>; scale: number; selected: boolean }) {
  return (
    <div
      className="ink-item ink-latex"
      data-x={item.x}
      data-y={item.y}
      data-ink-selected={selected ? '1' : undefined}
      style={{ left: item.x * scale, top: item.y * scale, width: item.w * scale, height: item.h * scale }}
    >
      <FitMath tex={item.latex} box={item} fontSize={textMetrics(item).fontSize} scale={scale} />
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

function labelColor(c: string | undefined): string {
  return !c || c === CURRENT_INK ? 'var(--ink-default)' : safeColor(c, 'var(--ink-default)');
}

/** A typed label on the canvas (accepted handwriting beside a drawing). */
export function LabelView({ label, scale, selected }: { label: InkLabel; scale: number; selected?: boolean }) {
  const style = { left: label.x * scale, top: label.y * scale, width: label.w * scale, minHeight: label.h * scale, fontSize: label.size * scale, color: labelColor(label.color) };
  if (label.kind === 'latex') {
    return (
      <div className="ink-item ink-label ink-label-latex" data-x={label.x} data-y={label.y} data-label-id={label.id} data-ink-selected={selected ? '1' : undefined} style={{ ...style, height: label.h * scale }}>
        <FitMath tex={label.content} box={label} fontSize={label.size} scale={scale} />
      </div>
    );
  }
  return (
    <div
      className="ink-item ink-label ink-label-text"
      data-x={label.x}
      data-y={label.y}
      data-label-id={label.id}
      data-ink-selected={selected ? '1' : undefined}
      style={style}
      dangerouslySetInnerHTML={{ __html: renderInline(label.content) }}
    />
  );
}

/** Text editor popover for a label or a preview. */
function TextEditor({
  at,
  scale,
  initial,
  kind,
  onSave,
  onCancel,
  onDelete,
}: {
  at: BBox;
  scale: number;
  initial: string;
  kind: 'text' | 'latex';
  onSave: (content: string, kind: 'text' | 'latex') => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [k, setK] = useState(kind);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="ink-editor ink-ui" style={{ left: at.x * scale, top: (at.y + at.h) * scale + 6 }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="ink-editor-input"
        value={value}
        rows={Math.min(6, Math.max(1, value.split('\n').length))}
        aria-label={k === 'latex' ? 'LaTeX' : 'Text'}
        spellCheck={k === 'text'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(value, k);
        }}
      />
      <div className="ink-editor-row">
        <div className="ink-editor-kind" role="radiogroup" aria-label="Kind">
          <button type="button" role="radio" aria-checked={k === 'text'} className="ink-bar-btn" onClick={() => setK('text')}>
            Text
          </button>
          <button type="button" role="radio" aria-checked={k === 'latex'} className="ink-bar-btn" onClick={() => setK('latex')}>
            Math
          </button>
        </div>
        {onDelete && (
          <button type="button" className="ink-bar-btn" onClick={onDelete} aria-label="Delete">
            <Trash size={14} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="ink-bar-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ink-bar-btn ink-bar-primary" onClick={() => onSave(value, k)}>
          Done
        </button>
      </div>
    </div>
  );
}

interface PreviewView {
  conv: PendingConversion;
  box: BBox;
}

function PreviewItem({ view, scale }: { view: PreviewView; scale: number }) {
  const { conv, box } = view;
  const fontSize = Math.max(10, Math.min(110, (box.h / Math.max(1, conv.kind === 'text' ? conv.content.split('\n').length : 1)) * 0.62));
  return (
    <div
      className={`ink-item ink-preview ink-preview-${conv.kind}`}
      data-preview-id={conv.id}
      style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, minHeight: box.h * scale, height: conv.kind === 'latex' ? box.h * scale : undefined, fontSize: fontSize * scale }}
    >
      {conv.kind === 'latex' ? <FitMath tex={conv.content} box={box} fontSize={fontSize} scale={scale} /> : <span dangerouslySetInnerHTML={{ __html: renderInline(conv.content) }} />}
    </div>
  );
}

export function InkCanvas({ block, readOnly = false, onHeightChange, minHeight = 160, className, ai, fixedHeight, background, scroller, zoom }: InkCanvasProps) {
  useYShallow(block as unknown as Y.AbstractType<unknown>);
  const photo = fixedHeight !== undefined && fixedHeight > 0;
  const height = photo ? fixedHeight! : Number(block.get('height')) || 300;
  const beautified = block.get('beautified') as Beautified | undefined;
  const displayH = photo ? height : Math.max(height, minHeight);
  const tool = useInkStore((s) => s.tool);
  const autoConvert = useInkStore((s) => s.autoConvert);
  const labelsMap = block.get('labels') as Y.Map<InkLabel> | undefined;
  useYShallow(labelsMap as unknown as Y.AbstractType<unknown> | undefined);
  const labels = labelsMap ? sortLabels([...labelsMap.values()]) : [];
  const pending = usePending(block);
  const strokesArr = block.get('strokes') as Y.Array<Stroke> | undefined;
  // previews follow their strokes (moved, erased)
  useYShallow((pending.length ? strokesArr : null) as unknown as Y.AbstractType<unknown> | null);

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
  const [editing, setEditing] = useState<{ type: 'label' | 'preview'; id: string } | null>(null);

  const scale = (width || INK_LOGICAL_WIDTH) / INK_LOGICAL_WIDTH;
  const aiRef = useRef(ai);
  aiRef.current = ai;
  const busyRef = useRef(false);
  const beautifyRef = useRef<() => void>(() => {});
  const tapRef = useRef<(p: Pt) => void>(() => {});
  const strokeRef = useRef<(s: Stroke) => void>(() => {});
  const scrollerRef = useRef(scroller ?? null);
  scrollerRef.current = scroller ?? null;

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
      onStrokeCommitted: (s) => strokeRef.current(s),
    });
    engineRef.current = eng;
    // focus view: track the visible part of the surface
    const updateViewport = () => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const sr = sc.getBoundingClientRect();
      const r = surface.getBoundingClientRect();
      const x = Math.max(0, sr.left - r.left);
      const y = Math.max(0, sr.top - r.top);
      const right = Math.min(r.width, sr.right - r.left);
      const bottom = Math.min(r.height, sr.bottom - r.top);
      eng.setViewport({ x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) });
    };
    const w = surface.getBoundingClientRect().width;
    if (w) {
      setWidth(w);
      eng.setWidth(w);
    }
    updateViewport();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== surface) continue;
          const cw = entry.contentRect.width;
          if (cw > 0) {
            setWidth(cw);
            eng.setWidth(cw);
          }
        }
        updateViewport();
      });
      ro.observe(surface);
      if (scrollerRef.current) ro.observe(scrollerRef.current);
    }
    const sc = scrollerRef.current;
    sc?.addEventListener('scroll', updateViewport, { passive: true });
    eng.setScroller(sc);
    // theme changes → re-resolve --ink-default
    const mo = new MutationObserver(() => eng.themeChanged());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onMq = () => eng.themeChanged();
    mq?.addEventListener?.('change', onMq);
    return () => {
      ro?.disconnect();
      sc?.removeEventListener('scroll', updateViewport);
      mo.disconnect();
      mq?.removeEventListener?.('change', onMq);
      eng.destroy();
      engineRef.current = null;
    };
  }, [block, scroller]);

  useLayoutEffect(() => {
    engineRef.current?.setFixedHeight(photo ? fixedHeight! : null);
  }, [photo, fixedHeight]);

  useEffect(() => {
    engineRef.current?.setZoom(zoom ?? 1);
  }, [zoom]);

  useEffect(() => {
    engineRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    engineRef.current?.setMinHeight(photo ? 0 : minHeight);
  }, [minHeight, photo]);

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

  // ---- previews: positions from the current strokes; drop those whose ink is gone
  const strokeList = strokesArr ? strokesArr.toArray() : [];
  const previews: PreviewView[] = [];
  const stale: string[] = [];
  if (pending.length) {
    const byId = new Map(strokeList.map((s) => [s.id, s]));
    for (const conv of pending) {
      const ss = conv.strokeIds.map((id) => byId.get(id));
      if (ss.some((s) => !s)) stale.push(conv.id);
      else previews.push({ conv, box: conversionBox(ss as Stroke[]) });
    }
  }
  const staleKey = stale.join(',');
  useEffect(() => {
    if (staleKey) removePending(block, staleKey.split(','));
  }, [block, staleKey]);
  const previewIds = previews.flatMap((p) => p.conv.strokeIds);
  const previewKey = previewIds.join(',');
  useEffect(() => {
    engineRef.current?.setPreviewHidden(previewKey ? previewKey.split(',') : []);
  }, [previewKey]);

  // ---- taps → reveal the beautified toggle, or edit a label
  tapRef.current = (p: Pt) => {
    if (readOnly) {
      setToggleAt(null);
      return;
    }
    const hitLabel = [...labels].reverse().find((l) => bboxContains(inflateBBox({ x: l.x, y: l.y, w: l.w, h: l.h }, 6), p));
    const curTool = useInkStore.getState().tool;
    if (hitLabel && (curTool === 'none' || curTool === 'lasso')) {
      setToggleAt(null);
      setEditing({ type: 'label', id: hitLabel.id });
      return;
    }
    const hitPreview = previews.find((v) => bboxContains(inflateBBox(v.box, 6), p));
    if (hitPreview) {
      setEditing({ type: 'preview', id: hitPreview.conv.id });
      return;
    }
    const b = block.get('beautified') as Beautified | undefined;
    if (!b?.items.length) {
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

  const canReadWriting = () => {
    const a = aiRef.current;
    return !!a && (a.canHandle('handwriting', { images: true }) || a.canHandle('math-ocr', { images: true }));
  };

  // ---- beautify: shapes snap in place; writing becomes a preview to accept or reject
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
      const shapes = res.items.filter((it) => it.kind === 'shape');
      const writing = res.items.filter((it): it is TextItem => it.kind !== 'shape');
      const cur = block.get('beautified') as Beautified | undefined;
      const touchesOld = !!cur?.items.some((it) => it.strokeIds.some((id) => replaced.has(id)));
      if (shapes.length || touchesOld) {
        const apply = () => {
          const merged = mergeBeautified(block.get('beautified') as Beautified | undefined, shapes, replaced);
          if (merged.items.length) block.set('beautified', merged);
          else block.delete('beautified');
        };
        if (block.doc) block.doc.transact(apply, LOCAL_ORIGIN);
        else apply();
      }
      if (writing.length) addPending(block, writing.map(toPending));
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

  // ---- auto-convert: after a pause, read the writing just added (joined with nearby previews)
  const recentRef = useRef(new Set<string>());
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoBusy = useRef(false);
  const autoAgain = useRef(false);
  const warnedAI = useRef(false);
  const autoRef = useRef(autoConvert);
  autoRef.current = autoConvert;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const runAuto = useCallback(async () => {
    autoTimer.current = null;
    const eng = engineRef.current;
    if (!eng || !autoRef.current || readOnlyRef.current) return;
    if (eng.busy || busyRef.current) {
      autoTimer.current = setTimeout(() => void runAutoRef.current(), 400);
      return;
    }
    if (autoBusy.current) {
      autoAgain.current = true;
      return;
    }
    const all = eng.getStrokes();
    const byId = new Map(all.map((s) => [s.id, s]));
    const covered = new Set((block.get('beautified') as Beautified | undefined)?.active ? (block.get('beautified') as Beautified).items.flatMap((it) => it.strokeIds) : []);
    const fresh = [...recentRef.current].map((id) => byId.get(id)).filter((s): s is Stroke => !!s && !covered.has(s.id) && !isKeptAsInk(block, s.id));
    recentRef.current.clear();
    if (!fresh.length) return;
    if (!canReadWriting()) {
      if (!warnedAI.current) {
        warnedAI.current = true;
        setNotice(NEEDS_AI_MESSAGE);
      }
      return;
    }
    // continue a line: previews right next to the new writing are re-read together with it
    const box = conversionBox(fresh);
    const joined = listPending(block).filter((c) => {
      const ss = c.strokeIds.map((id) => byId.get(id));
      return ss.every(Boolean) && bboxDistance(conversionBox(ss as Stroke[]), box) < JOIN_DISTANCE;
    });
    const ids = new Set([...fresh.map((s) => s.id), ...joined.flatMap((c) => c.strokeIds)]);
    const strokes = all.filter((s) => ids.has(s.id));
    autoBusy.current = true;
    try {
      const res = await beautify(strokes, { ai: aiRef.current, rasterize: (s) => eng.rasterize(s), align: false });
      const writing = res.items.filter((it): it is TextItem => it.kind !== 'shape');
      // only keep results whose ink is still there
      const alive = new Set(eng.getStrokes().map((s) => s.id));
      const usable = writing.filter((w) => w.strokeIds.every((id) => alive.has(id)));
      if (usable.length) addPending(block, usable.map(toPending));
      if (res.errors.length) setNotice(`Couldn't read some handwriting: ${res.errors[0]}`);
    } catch (e) {
      setNotice(`Auto-convert failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      autoBusy.current = false;
      if (autoAgain.current || recentRef.current.size) {
        autoAgain.current = false;
        autoTimer.current = setTimeout(() => void runAutoRef.current(), AUTO_CONVERT_DELAY);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block]);
  const runAutoRef = useRef(runAuto);
  runAutoRef.current = runAuto;

  strokeRef.current = (s: Stroke) => {
    if (!autoRef.current || readOnlyRef.current || s.tool !== 'pen') return;
    recentRef.current.add(s.id);
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => void runAutoRef.current(), AUTO_CONVERT_DELAY);
  };

  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );

  // ---- accept / keep ink
  const toast = useUI((s) => s.toast);
  const accept = useCallback(
    (ids: string[]) => {
      const doc = block.doc;
      const blockId = block.get('id') as string | undefined;
      if (!doc || !blockId || readOnly) return;
      // bottom-most first: each split leaves the writing above in this block
      const byId = new Map(((block.get('strokes') as Y.Array<Stroke> | undefined)?.toArray() ?? []).map((s) => [s.id, s]));
      const items = listPending(block)
        .filter((c) => ids.includes(c.id))
        .map((c) => ({ c, y: conversionBox(c.strokeIds.map((id) => byId.get(id)).filter((s): s is Stroke => !!s)).y }))
        .sort((a, b) => b.y - a.y)
        .map((x) => x.c);
      removePending(
        block,
        items.map((c) => c.id),
      );
      setEditing(null);
      let toNote = 0;
      for (const conv of items) {
        const res = acceptConversion(doc, blockId, conv, { label: photo });
        if (res.mode === 'blocks') {
          toNote++;
          if (res.movedTo) {
            const moved = getBlock(doc, res.movedTo);
            if (moved) movePending(block, moved, res.movedStrokeIds);
          }
          if (res.removedBlock) break;
        }
      }
      // in the focus view the text lands in the note behind it
      if (toNote && scrollerRef.current) toast({ message: 'Added to the note as text', timeout: 2200 });
    },
    [block, photo, readOnly, toast],
  );

  const keepInk = useCallback(
    (ids: string[]) => {
      const items = listPending(block).filter((c) => ids.includes(c.id));
      keepAsInk(
        block,
        items.flatMap((c) => c.strokeIds),
      );
      removePending(block, ids);
      setEditing(null);
    },
    [block],
  );

  const deleteSelection = useCallback(() => {
    const eng = engineRef.current;
    const sel = eng?.getSelection();
    if (!eng || !sel || readOnly) return;
    eng.deleteStrokes(new Set(sel.ids), sel.labelIds ?? []);
    eng.clearSelection();
  }, [readOnly]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (editing) {
        setEditing(null);
        e.stopPropagation();
      } else if (selection || toggleAt) {
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
  const selectedLabels = useMemo(() => new Set(selection?.labelIds ?? []), [selection]);
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
  const classes = [
    'ink-block',
    `ink-tool-${tool}`,
    photo ? 'ink-photo' : '',
    capture ? 'ink-capture' : '',
    busy ? 'ink-busy' : '',
    autoConvert && !readOnly ? 'ink-auto' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const selBox = selection?.box;
  const barBelow = selBox ? selBox.y * scale < 44 : false;
  const editLabel = editing?.type === 'label' ? labels.find((l) => l.id === editing.id) : undefined;
  const editPreview = editing?.type === 'preview' ? previews.find((p) => p.conv.id === editing.id) : undefined;

  return (
    <div ref={rootRef} className={classes} tabIndex={0} onKeyDown={onKeyDown} data-ink-tool={tool}>
      <div
        ref={surfaceRef}
        className="ink-surface"
        role="img"
        aria-label={`${photo ? 'Annotations' : 'Whiteboard'}, ${count} ${count === 1 ? 'stroke' : 'strokes'}`}
        style={{ aspectRatio: `${INK_LOGICAL_WIDTH} / ${displayH}` }}
      >
        {background}
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
        {labels.length > 0 && (
          <div className="ink-overlay ink-labels">
            {labels.map((l) => (
              <LabelView key={l.id} label={l} scale={scale} selected={selectedLabels.has(l.id)} />
            ))}
          </div>
        )}
        {previews.length > 0 && (
          <div className="ink-overlay ink-previews" aria-live="polite">
            {previews.map((v) => (
              <PreviewItem key={v.conv.id} view={v} scale={scale} />
            ))}
          </div>
        )}
        <canvas ref={wetRef} className="ink-layer ink-wet" aria-hidden="true" />
      </div>

      {!readOnly &&
        previews.map((v) =>
          editing?.type === 'preview' && editing.id === v.conv.id ? null : (
            <div
              key={v.conv.id}
              className="ink-preview-bar ink-ui"
              style={{
                left: v.box.x * scale,
                // below the writing, or above it near the bottom edge
                top: (v.box.y + v.box.h) * scale + 44 > displayH * scale ? Math.max(0, v.box.y * scale - 40) : (v.box.y + v.box.h) * scale + 4,
              }}
              role="group"
              aria-label="Converted handwriting"
            >
              <button type="button" className="ink-bar-btn ink-bar-primary" onClick={() => accept([v.conv.id])} title="Replace the handwriting with this text">
                <Check size={15} aria-hidden="true" />
                <span>Accept</span>
              </button>
              <button type="button" className="ink-bar-btn" onClick={() => setEditing({ type: 'preview', id: v.conv.id })} aria-label="Edit text" title="Fix the text before accepting">
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="ink-bar-btn" onClick={() => keepInk([v.conv.id])} title="Discard the conversion and keep the handwriting">
                <X size={15} aria-hidden="true" />
                <span>Keep ink</span>
              </button>
            </div>
          ),
        )}

      {!readOnly && previews.length > 1 && (
        <div className="ink-preview-all ink-ui" role="group" aria-label="All conversions">
          <span className="ink-preview-count">{previews.length} conversions</span>
          <button type="button" className="ink-bar-btn ink-bar-primary" onClick={() => accept(previews.map((v) => v.conv.id))}>
            <Check size={15} aria-hidden="true" />
            <span>Accept all</span>
          </button>
          <button type="button" className="ink-bar-btn" onClick={() => keepInk(previews.map((v) => v.conv.id))}>
            <span>Keep all ink</span>
          </button>
        </div>
      )}

      {editPreview && !readOnly && (
        <TextEditor
          key={`p-${editPreview.conv.id}`}
          at={editPreview.box}
          scale={scale}
          initial={editPreview.conv.content}
          kind={editPreview.conv.kind}
          onCancel={() => setEditing(null)}
          onSave={(content, kind) => {
            if (content.trim()) updatePending(block, editPreview.conv.id, { content, kind });
            setEditing(null);
          }}
        />
      )}

      {editLabel && !readOnly && (
        <TextEditor
          key={`l-${editLabel.id}`}
          at={editLabel}
          scale={scale}
          initial={editLabel.content}
          kind={editLabel.kind}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            deleteLabel(block, editLabel.id);
            setEditing(null);
          }}
          onSave={(content, kind) => {
            updateLabel(block, editLabel.id, { content, kind });
            setEditing(null);
          }}
        />
      )}

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
            {selection && selection.ids.length > 0 && (
              <button type="button" className="ink-bar-btn ink-bar-primary" onClick={() => void runBeautify()} disabled={busy} title="Beautify (or double-tap the selection)">
                <Sparkles size={15} aria-hidden="true" />
                <span>{busy ? 'Beautifying…' : 'Beautify'}</span>
              </button>
            )}
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

function toPending(it: TextItem): PendingConversion {
  return { id: uid(8), kind: it.kind, content: it.kind === 'latex' ? it.latex : it.text, strokeIds: it.strokeIds };
}

export default InkCanvas;
