/**
 * InkSurface: the imperative engine behind <InkCanvas>.
 *
 * Owns the two canvases (committed + wet), pointer handling, rAF-batched drawing and all CRDT
 * writes for strokes. React is only notified about rare events (selection changed, stroke count,
 * taps), never per pointer event.
 *
 *  - committed layer: every stroke in the block (minus hidden ones), redrawn fully only when
 *    needed; appended strokes (local or remote) are drawn incrementally;
 *  - wet layer (`desynchronized` 2D context): the in-progress stroke incl. predicted points,
 *    lasso path, eraser cursor, and the dragged selection (moved with a CSS transform).
 */
import type * as Y from 'yjs';
import type { Beautified, Stroke } from '../../core/schema';
import { INK_LOGICAL_WIDTH } from '../../core/schema';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import {
  bbox,
  bboxContains,
  inflateBBox,
  pathLength,
  strokeBBox,
  strokeHitBySegment,
  strokeInPolygon,
  strokesBBox,
  transformStroke,
  unionBBox,
  type BBox,
  type Pt,
} from '../../core/ink/geometry';
import { PointSmoother, PressureSimulator, quantizePoints } from '../../core/ink/smoothing';
import { coveredStrokeIds, itemBBox, PathCache, renderStrokes, resolveInkColor, strokeOutline, traceOutline, HIGHLIGHTER_ALPHA } from '../../core/ink/render';
import { removeStrokesFromBeautified, transformBeautified, type RasterImage } from '../../core/ink/beautify';
import { uid } from '../../core/util/ids';
import { ERASER_RADIUS, strokeWidthFor, useInkStore } from './inkStore';

export interface InkSelection {
  ids: string[];
  /** logical-space bounding box (includes stroke width and covered beautified items) */
  box: BBox;
}

export interface SurfaceCallbacks {
  onSelection(sel: InkSelection | null): void;
  /** double tap inside the selection */
  onDoubleTapSelection(): void;
  /** a tap that isn't part of a drawing gesture (pointer mode, read-only, lasso tap on empty space) */
  onTap(p: Pt, client: { x: number; y: number }): void;
  onCount(n: number): void;
}

/** Transform p' = origin + (p − origin)·s + (dx, dy) in logical units. */
export interface DragTransform {
  dx: number;
  dy: number;
  s: number;
  ox: number;
  oy: number;
}

type DrawGesture = {
  kind: 'draw';
  id: number;
  tool: 'pen' | 'highlighter';
  pts: number[];
  predicted: number[];
  color: string;
  size: number;
  smoother: PointSmoother | null;
  pressure: PressureSimulator | null;
  realPressure: boolean;
};
type Gesture =
  | DrawGesture
  | { kind: 'erase'; id: number; last: Pt | null; erased: Set<string> }
  | { kind: 'lasso'; id: number; pts: Pt[] }
  | { kind: 'move'; id: number; start: Pt; client: { x: number; y: number }; dragging: boolean; t: DragTransform }
  | { kind: 'scale'; id: number; anchor: Pt; start: Pt; dragging: boolean; t: DragTransform }
  | { kind: 'pan'; id: number; lastX: number; lastY: number; scroller: HTMLElement | null };

const GROW_MARGIN = 80;
const GROW_STEP = 300;
const MAX_CANVAS_PIXELS = 16_000_000;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 20;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null;
  while (n) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

export class InkSurface {
  private block: Y.Map<unknown>;
  private arr: Y.Array<Stroke> | null = null;
  private strokes: Stroke[] = [];
  private cache = new PathCache();
  private covered = new Set<string>();
  private dragHidden = new Set<string>();
  private eraseHidden = new Set<string>();
  private width = 0;
  private scale = 1;
  private dpr = 1;
  private logicalHeight = 300;
  private minHeight = 0;
  private inkColor = '#1d2230';
  private committedCtx: CanvasRenderingContext2D | null = null;
  private wetCtx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private dirtyFull = false;
  private dirtyWet = false;
  private pendingDragReset = false;
  private gesture: Gesture | null = null;
  private gesturePointerType = '';
  private rect: DOMRect | null = null;
  private touches = new Set<number>();
  private multitouch = false;
  private selection: InkSelection | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private down: { id: number; x: number; y: number; t: number } | null = null;
  private readOnly = false;
  private destroyed = false;
  private growPending = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private root: HTMLElement,
    private surface: HTMLElement,
    private committed: HTMLCanvasElement,
    private wet: HTMLCanvasElement,
    block: Y.Map<unknown>,
    private cb: SurfaceCallbacks,
  ) {
    this.block = block;
    try {
      this.committedCtx = committed.getContext('2d', { alpha: true }) as CanvasRenderingContext2D | null;
      this.wetCtx = (wet.getContext('2d', { desynchronized: true, alpha: true } as CanvasRenderingContext2DSettings) ??
        wet.getContext('2d')) as CanvasRenderingContext2D | null;
    } catch {
      this.committedCtx = null;
      this.wetCtx = null;
    }
    if (typeof Path2D === 'undefined') {
      // non-browser environment (tests): keep state logic, skip painting
      this.committedCtx = null;
      this.wetCtx = null;
    }
    this.resolveInk();
    this.bindBlock();
    this.bindDom();
  }

  // ------------------------------------------------------------------ lifecycle / CRDT

  private bindBlock() {
    const onBlock = (ev: Y.YMapEvent<unknown>) => {
      if (ev.keysChanged.has('strokes')) this.bindStrokes();
      if (ev.keysChanged.has('beautified')) this.refreshCovered();
      if (ev.keysChanged.has('height')) this.applyHeight();
    };
    this.block.observe(onBlock);
    this.cleanup.push(() => this.block.unobserve(onBlock));
    this.bindStrokes();
    this.refreshCovered();
    this.applyHeight();
  }

  private unbindStrokes: (() => void) | null = null;

  private bindStrokes() {
    this.unbindStrokes?.();
    const arr = (this.block.get('strokes') as Y.Array<Stroke> | undefined) ?? null;
    this.arr = arr;
    this.strokes = arr ? arr.toArray() : [];
    this.cb.onCount(this.strokes.length);
    if (!arr) {
      this.unbindStrokes = null;
      this.invalidate();
      return;
    }
    const onStrokes = (ev: Y.YArrayEvent<Stroke>) => {
      const prevLen = this.strokes.length;
      this.strokes = arr.toArray();
      const d = ev.changes.delta;
      const appendOnly =
        (d.length === 1 && d[0].insert !== undefined && prevLen === 0) ||
        (d.length === 2 && d[0].retain === prevLen && d[1].insert !== undefined);
      if (appendOnly && !this.dirtyFull && this.committedCtx) {
        renderStrokes(this.committedCtx, this.strokes.slice(prevLen), this.scale, this.dpr, {
          cache: this.cache,
          inkColor: this.inkColor,
          hidden: this.hiddenSet(),
          clear: false,
        });
      } else {
        if (this.strokes.length < prevLen) this.cache.prune(new Set(this.strokes.map((s) => s.id)));
        this.invalidate();
      }
      if (this.selection) {
        const alive = new Set(this.strokes.map((s) => s.id));
        const ids = this.selection.ids.filter((id) => alive.has(id));
        if (ids.length !== this.selection.ids.length) this.setSelection(ids.length ? this.selectionFor(ids) : null);
      }
      this.cb.onCount(this.strokes.length);
    };
    arr.observe(onStrokes);
    this.unbindStrokes = () => arr.unobserve(onStrokes);
    this.invalidate();
  }

  private refreshCovered() {
    this.covered = coveredStrokeIds(this.block.get('beautified') as Beautified | undefined);
    this.invalidate();
  }

  private applyHeight() {
    const h = Number(this.block.get('height')) || 300;
    this.logicalHeight = h;
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.unbindStrokes?.();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  setReadOnly(v: boolean) {
    this.readOnly = v;
    if (v) this.cancelGesture();
  }

  setMinHeight(h: number) {
    this.minHeight = h;
    this.resize();
  }

  /** Displayed height in logical units. */
  get displayHeight(): number {
    return Math.max(this.logicalHeight, this.minHeight);
  }

  get currentScale(): number {
    return this.scale;
  }

  // ------------------------------------------------------------------ sizing / colours

  setWidth(width: number) {
    if (Math.abs(width - this.width) < 0.5) return;
    this.width = width;
    this.resize();
  }

  private resize() {
    if (!this.width) return;
    this.scale = this.width / INK_LOGICAL_WIDTH;
    const cssW = this.width;
    const cssH = this.displayHeight * this.scale;
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // keep backing stores within mobile canvas limits for very tall blocks
    this.dpr = Math.max(0.5, Math.min(rawDpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssW * cssH))));
    for (const c of [this.committed, this.wet]) {
      const w = Math.round(cssW * this.dpr);
      const h = Math.round(cssH * this.dpr);
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
    }
    this.dirtyWet = true;
    this.invalidate();
  }

  /** Re-reads --ink-default (call on theme changes). */
  resolveInk() {
    let c = '';
    try {
      c = getComputedStyle(this.root).getPropertyValue('--ink-default').trim();
    } catch {
      /* ignore */
    }
    const next = c || '#1d2230';
    if (next !== this.inkColor) {
      this.inkColor = next;
      this.invalidate();
    }
  }

  private hiddenSet(): Set<string> {
    if (!this.dragHidden.size && !this.eraseHidden.size) return this.covered;
    const s = new Set(this.covered);
    for (const id of this.dragHidden) s.add(id);
    for (const id of this.eraseHidden) s.add(id);
    return s;
  }

  // ------------------------------------------------------------------ rendering

  private invalidate() {
    this.dirtyFull = true;
    this.schedule();
  }

  private schedule() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.frame();
    });
  }

  private frame() {
    if (this.dirtyFull) {
      this.dirtyFull = false;
      if (this.committedCtx) {
        renderStrokes(this.committedCtx, this.strokes, this.scale, this.dpr, { cache: this.cache, inkColor: this.inkColor, hidden: this.hiddenSet() });
      }
    }
    if (this.pendingDragReset) {
      this.pendingDragReset = false;
      this.applyDragTransform(null);
      this.clearWet();
    }
    if (this.dirtyWet) {
      this.dirtyWet = false;
      this.drawWet();
    }
    const g = this.gesture;
    if (g && g.kind === 'lasso') {
      // animate the marching-ants lasso
      this.dirtyWet = true;
      this.schedule();
    }
  }

  private clearWet() {
    const ctx = this.wetCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.wet.width, this.wet.height);
  }

  private drawWet() {
    const ctx = this.wetCtx;
    const g = this.gesture;
    if (!ctx) return;
    if (g && (g.kind === 'move' || g.kind === 'scale') && g.dragging) return; // wet holds the dragged strokes
    this.clearWet();
    if (!g) return;
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (g.kind === 'draw') {
      const outline = strokeOutline({ pts: g.pts, size: g.size, tool: g.tool }, { last: false, extra: g.predicted });
      if (!outline.length) return;
      const path = new Path2D();
      traceOutline(path, outline);
      ctx.globalAlpha = g.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1;
      ctx.fillStyle = resolveInkColor(g.color, this.inkColor);
      ctx.fill(path);
      ctx.globalAlpha = 1;
    } else if (g.kind === 'lasso' && g.pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(g.pts[0].x, g.pts[0].y);
      for (const p of g.pts) ctx.lineTo(p.x, p.y);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.setLineDash([6 / this.scale, 5 / this.scale]);
      ctx.lineDashOffset = -((performance.now() / 40) % 11) / this.scale;
      ctx.strokeStyle = this.accent();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = this.accent();
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (g.kind === 'erase' && g.last) {
      ctx.beginPath();
      ctx.arc(g.last.x, g.last.y, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeStyle = this.inkColor;
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private accentCache = '';
  private accent(): string {
    if (!this.accentCache) {
      try {
        this.accentCache = getComputedStyle(this.root).getPropertyValue('--accent').trim() || '#3d5bd9';
      } catch {
        this.accentCache = '#3d5bd9';
      }
    }
    return this.accentCache;
  }

  /** Theme changed: re-resolve colours and redraw. */
  themeChanged() {
    this.accentCache = '';
    this.resolveInk();
    this.invalidate();
  }

  // ------------------------------------------------------------------ pointer handling

  private bindDom() {
    const opts = { passive: false } as AddEventListenerOptions;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(this.root, 'pointerdown', (e) => this.onDown(e));
    on(this.root, 'pointermove', (e) => this.onMove(e));
    on(this.root, 'pointerup', (e) => this.onUp(e));
    on(this.root, 'pointercancel', (e) => this.onCancel(e));
    // iOS: stop the Pencil from scrolling/selecting even when touch-action allows panning
    // (e.g. the very first pen contact in pointer mode, before the pen tool auto-activates)
    const stylus = (e: TouchEvent) => {
      if (this.readOnly || (e.target as Element | null)?.closest?.('.ink-ui')) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if ((e.changedTouches[i] as Touch & { touchType?: string }).touchType === 'stylus') {
          if (e.cancelable) e.preventDefault();
          return;
        }
      }
    };
    on(this.root, 'touchstart', stylus);
    on(this.root, 'touchmove', stylus);
  }

  private toLogical(clientX: number, clientY: number): Pt {
    const r = this.rect ?? this.surface.getBoundingClientRect();
    return { x: (clientX - r.left) / this.scale, y: (clientY - r.top) / this.scale };
  }

  private onDown(e: PointerEvent) {
    const target = e.target as Element | null;
    if (target?.closest?.('.ink-ui')) return; // buttons & popovers handle themselves
    const store = useInkStore.getState();
    if (e.pointerType === 'pen' && !store.penDetected) store.setPenDetected(true);
    const tool = useInkStore.getState().tool;

    if (e.pointerType === 'touch') {
      this.touches.add(e.pointerId);
      // a pen stroke in progress: palms and fingers are ignored entirely
      if (this.gesture && this.gesturePointerType !== 'touch') return;
      if (this.touches.size > 1) {
        // second finger: the gesture belongs to the page (pinch / accordion spread)
        this.multitouch = true;
        this.cancelGesture();
        return;
      }
    }
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (this.readOnly || tool === 'none') return;
    if (e.pointerType === 'touch') {
      if (useInkStore.getState().penDetected) {
        // palm rejection: fingers never draw once a pen is known; one (non-palm) finger pans the page
        if (e.width < 60 && e.height < 60) {
          this.gesture = { kind: 'pan', id: e.pointerId, lastX: e.clientX, lastY: e.clientY, scroller: scrollParent(this.root) };
          this.gesturePointerType = 'touch';
        }
        return;
      }
      if (this.multitouch) return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    this.rect = this.surface.getBoundingClientRect();
    const p = this.toLogical(e.clientX, e.clientY);
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    const eff = penEraser ? 'eraser' : tool;

    if (eff === 'lasso') {
      const handle = target?.closest?.('[data-ink-handle]') as HTMLElement | null;
      if (this.selection && handle) {
        const b = this.selection.box;
        const h = handle.dataset.inkHandle ?? 'se';
        const anchor = { x: h.includes('w') ? b.x + b.w : b.x, y: h.includes('n') ? b.y + b.h : b.y };
        this.gesture = { kind: 'scale', id: e.pointerId, anchor, start: p, dragging: false, t: { dx: 0, dy: 0, s: 1, ox: anchor.x, oy: anchor.y } };
      } else if (this.selection && bboxContains(inflateBBox(this.selection.box, 6 / this.scale), p)) {
        this.gesture = { kind: 'move', id: e.pointerId, start: p, client: { x: e.clientX, y: e.clientY }, dragging: false, t: { dx: 0, dy: 0, s: 1, ox: 0, oy: 0 } };
      } else {
        if (this.selection) this.setSelection(null);
        this.gesture = { kind: 'lasso', id: e.pointerId, pts: [p] };
      }
    } else if (eff === 'eraser') {
      const g: Gesture = { kind: 'erase', id: e.pointerId, last: null, erased: new Set() };
      this.gesture = g;
      this.eraseAt(g, p);
    } else if (eff === 'pen' || eff === 'highlighter') {
      if (this.selection) this.setSelection(null);
      const real = e.pointerType === 'pen' && e.pressure > 0;
      const g: DrawGesture = {
        kind: 'draw',
        id: e.pointerId,
        tool: eff,
        pts: [],
        predicted: [],
        color: eff === 'highlighter' ? store.highlighterColor : store.color,
        size: strokeWidthFor(eff, store.sizeIndex),
        smoother: e.pointerType === 'pen' ? null : new PointSmoother(),
        pressure: real ? null : new PressureSimulator(),
        realPressure: real,
      };
      this.gesture = g;
      this.addDrawPoint(g, e);
    } else return;

    this.gesturePointerType = e.pointerType;
    e.preventDefault();
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    this.dirtyWet = true;
    this.schedule();
  }

  private addDrawPoint(g: DrawGesture, ev: PointerEvent) {
    let { x, y } = this.toLogical(ev.clientX, ev.clientY);
    if (g.smoother) [x, y] = g.smoother.filter(x, y, ev.timeStamp);
    x = Math.max(0, Math.min(INK_LOGICAL_WIDTH, x));
    y = Math.max(0, y);
    const n = g.pts.length;
    if (n >= 3 && Math.abs(g.pts[n - 3] - x) < 0.25 && Math.abs(g.pts[n - 2] - y) < 0.25) return;
    const p = g.realPressure ? ev.pressure || 0.5 : g.pressure!.next(x, y, ev.timeStamp);
    g.pts.push(x, y, p);
    if (y > this.displayHeight - GROW_MARGIN) this.grow();
  }

  private onMove(e: PointerEvent) {
    const g = this.gesture;
    if (!g || e.pointerId !== g.id) return;
    if (e.pointerType === 'touch' && this.multitouch) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    switch (g.kind) {
      case 'draw': {
        for (const ev of list) this.addDrawPoint(g, ev);
        g.predicted = [];
        const pred = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
        const lastP = g.pts[g.pts.length - 1] ?? 0.5;
        for (const ev of pred) {
          const q = this.toLogical(ev.clientX, ev.clientY);
          g.predicted.push(q.x, q.y, lastP);
        }
        break;
      }
      case 'erase':
        for (const ev of list) this.eraseAt(g, this.toLogical(ev.clientX, ev.clientY));
        break;
      case 'lasso':
        for (const ev of list) {
          const p = this.toLogical(ev.clientX, ev.clientY);
          const l = g.pts[g.pts.length - 1];
          if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 1.5) g.pts.push(p);
        }
        break;
      case 'move': {
        const p = this.toLogical(e.clientX, e.clientY);
        if (!g.dragging && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 4) return;
        if (!g.dragging) this.beginDrag(g);
        g.t = { dx: p.x - g.start.x, dy: p.y - g.start.y, s: 1, ox: 0, oy: 0 };
        this.applyDragTransform(g.t);
        return;
      }
      case 'scale': {
        const p = this.toLogical(e.clientX, e.clientY);
        if (!g.dragging) this.beginDrag(g);
        const d0 = Math.hypot(g.start.x - g.anchor.x, g.start.y - g.anchor.y) || 1;
        const d1 = Math.hypot(p.x - g.anchor.x, p.y - g.anchor.y);
        g.t = { dx: 0, dy: 0, s: Math.max(0.1, Math.min(10, d1 / d0)), ox: g.anchor.x, oy: g.anchor.y };
        this.applyDragTransform(g.t);
        return;
      }
      case 'pan': {
        const dy = e.clientY - g.lastY;
        const dx = e.clientX - g.lastX;
        g.lastX = e.clientX;
        g.lastY = e.clientY;
        g.scroller?.scrollBy(-dx, -dy);
        return;
      }
    }
    this.dirtyWet = true;
    this.schedule();
  }

  private onUp(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size === 0) {
        const wasMulti = this.multitouch;
        this.multitouch = false;
        if (wasMulti) {
          this.down = null;
          return;
        }
      }
    }
    const g = this.gesture;
    const down = this.down;
    this.down = null;
    if (!g || g.id !== e.pointerId) {
      if (down && down.id === e.pointerId && e.timeStamp - down.t < 350 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) {
        const r = this.surface.getBoundingClientRect();
        this.cb.onTap({ x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale }, { x: e.clientX, y: e.clientY });
      }
      return;
    }
    this.gesture = null;
    switch (g.kind) {
      case 'draw':
        g.predicted = [];
        this.finishDraw(g, e);
        this.commitStroke(g);
        break;
      case 'erase':
        this.commitErase(g);
        break;
      case 'lasso':
        this.finishLasso(g, e);
        break;
      case 'move':
        if (g.dragging) this.commitTransform(g.t);
        else this.handleSelectionTap(e);
        break;
      case 'scale':
        if (g.dragging) this.commitTransform(g.t);
        break;
      case 'pan':
        break;
    }
    this.rect = null;
    this.dirtyWet = true;
    this.schedule();
  }

  private onCancel(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (!this.touches.size) this.multitouch = false;
    }
    if (this.gesture?.id === e.pointerId) this.cancelGesture();
  }

  /** Drops the in-progress gesture without committing anything. */
  cancelGesture() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    try {
      if (this.root.hasPointerCapture?.(g.id)) this.root.releasePointerCapture(g.id);
    } catch {
      /* ignore */
    }
    if (g.kind === 'erase') {
      this.eraseHidden.clear();
      this.invalidate();
    }
    if ((g.kind === 'move' || g.kind === 'scale') && g.dragging) {
      this.dragHidden.clear();
      this.pendingDragReset = true;
      this.invalidate();
    }
    this.rect = null;
    this.dirtyWet = true;
    this.schedule();
  }

  // ------------------------------------------------------------------ commits

  private doc(): Y.Doc | null {
    return this.block.doc ?? null;
  }

  private transact(fn: () => void) {
    const doc = this.doc();
    if (doc) doc.transact(fn, LOCAL_ORIGIN);
    else fn();
  }

  private grow() {
    if (this.growPending || this.readOnly) return;
    this.growPending = true;
    // defer out of the pointer handler; height changes resize canvases
    queueMicrotask(() => {
      this.growPending = false;
      if (this.destroyed) return;
      const next = Math.ceil(this.displayHeight + GROW_STEP);
      this.transact(() => this.block.set('height', next));
    });
  }

  /** Smoothed input lags slightly: end the stroke exactly where the pointer was lifted. */
  private finishDraw(g: DrawGesture, e: PointerEvent) {
    if (!g.smoother || g.pts.length < 3) return;
    const p = this.toLogical(e.clientX, e.clientY);
    const n = g.pts.length;
    if (Math.hypot(g.pts[n - 3] - p.x, g.pts[n - 2] - p.y) < 0.5) return;
    g.pts.push(Math.max(0, Math.min(INK_LOGICAL_WIDTH, p.x)), Math.max(0, p.y), g.pts[n - 1]);
  }

  private commitStroke(g: DrawGesture) {
    if (!this.arr || !g.pts.length) return;
    let pts = quantizePoints(g.pts);
    if (pts.length === 3) pts = [...pts, pts[0] + 0.1, pts[1], pts[2]]; // a tap → dot
    const stroke: Stroke = { id: uid(10), pts, color: g.color, size: g.size, tool: g.tool };
    const arr = this.arr;
    // committed layer draws the appended stroke synchronously in the observer
    this.transact(() => arr.push([stroke]));
    this.clearWet();
  }

  private eraseAt(g: Extract<Gesture, { kind: 'erase' }>, p: Pt) {
    const a = g.last ?? p;
    g.last = p;
    let changed = false;
    const r = ERASER_RADIUS;
    for (const s of this.strokes) {
      if (g.erased.has(s.id) || this.covered.has(s.id)) continue;
      if (strokeHitBySegment(s, a, p, r, this.cache.box(s))) {
        g.erased.add(s.id);
        this.eraseHidden.add(s.id);
        changed = true;
      }
    }
    if (changed) this.invalidate();
  }

  private commitErase(g: Extract<Gesture, { kind: 'erase' }>) {
    const ids = g.erased;
    this.eraseHidden.clear();
    if (ids.size) this.deleteStrokes(ids);
    this.invalidate();
  }

  /** Deletes strokes (and their beautified items) in one transaction. */
  deleteStrokes(ids: Set<string>) {
    const arr = this.arr;
    if (!arr || !ids.size) return;
    this.transact(() => {
      const list = arr.toArray();
      // delete contiguous runs from the end
      for (let i = list.length - 1; i >= 0; i--) {
        if (!ids.has(list[i].id)) continue;
        let j = i;
        while (j - 1 >= 0 && ids.has(list[j - 1].id)) j--;
        arr.delete(j, i - j + 1);
        i = j;
      }
      const b = this.block.get('beautified') as Beautified | undefined;
      if (b && b.items.some((it) => it.strokeIds.some((id) => ids.has(id)))) {
        const nb = removeStrokesFromBeautified(b, ids);
        if (nb) this.block.set('beautified', nb);
        else this.block.delete('beautified');
      }
    });
  }

  // ------------------------------------------------------------------ selection

  private selectionFor(ids: string[]): InkSelection {
    const set = new Set(ids);
    const sel = this.strokes.filter((s) => set.has(s.id));
    const maxSize = sel.reduce((a, s) => Math.max(a, s.size), 0);
    let box = inflateBBox(strokesBBox(sel), maxSize / 2 + 4);
    const b = this.block.get('beautified') as Beautified | undefined;
    if (b?.active) {
      for (const it of b.items) if (it.strokeIds.length && it.strokeIds.every((id) => set.has(id))) box = unionBBox(box, inflateBBox(itemBBox(it), 4));
    }
    return { ids, box };
  }

  private setSelection(sel: InkSelection | null) {
    this.selection = sel;
    this.cb.onSelection(sel);
  }

  /** Selects the given strokes (programmatic). */
  select(ids: string[]) {
    this.setSelection(ids.length ? this.selectionFor(ids) : null);
  }

  clearSelection() {
    if (this.selection) this.setSelection(null);
  }

  getSelection(): InkSelection | null {
    return this.selection;
  }

  getStrokes(): readonly Stroke[] {
    return this.strokes;
  }

  private finishLasso(g: Extract<Gesture, { kind: 'lasso' }>, e: PointerEvent) {
    const poly = g.pts;
    if (poly.length < 3 || pathLength(poly) < 8) {
      this.cb.onTap(poly[0] ?? this.toLogical(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
      return;
    }
    const pb = bbox(poly);
    const ids = this.strokes.filter((s) => strokeInPolygon(s, poly, 0.6, pb)).map((s) => s.id);
    this.setSelection(ids.length ? this.selectionFor(ids) : null);
    if (ids.length) this.root.focus({ preventScroll: true });
  }

  private handleSelectionTap(e: PointerEvent) {
    const now = e.timeStamp;
    const last = this.lastTap;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX) {
      this.lastTap = null;
      this.cb.onDoubleTapSelection();
      return;
    }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }

  private beginDrag(g: Extract<Gesture, { kind: 'move' | 'scale' }>) {
    const sel = this.selection;
    if (!sel) return;
    g.dragging = true;
    for (const id of sel.ids) this.dragHidden.add(id);
    // committed layer without the selection, wet layer with it (then moved by CSS transform)
    if (this.committedCtx) {
      renderStrokes(this.committedCtx, this.strokes, this.scale, this.dpr, { cache: this.cache, inkColor: this.inkColor, hidden: this.hiddenSet() });
      this.dirtyFull = false;
    }
    if (this.wetCtx) {
      const ids = new Set(sel.ids);
      const moving = this.strokes.filter((s) => ids.has(s.id) && !this.covered.has(s.id));
      renderStrokes(this.wetCtx, moving, this.scale, this.dpr, { cache: this.cache, inkColor: this.inkColor });
    }
  }

  /** Applies (or clears) the live drag transform to the wet layer, selection box and selected overlay items. */
  private applyDragTransform(t: DragTransform | null) {
    const sc = this.scale;
    const setT = (el: HTMLElement | SVGElement, origin: string, transform: string) => {
      el.style.transformOrigin = origin;
      el.style.transform = transform;
    };
    const css = t ? `translate(${t.dx * sc}px, ${t.dy * sc}px) scale(${t.s})` : '';
    setT(this.wet, t ? `${t.ox * sc}px ${t.oy * sc}px` : '', css);
    const selEl = this.root.querySelector<HTMLElement>('.ink-selection');
    if (selEl && this.selection) {
      const b = this.selection.box;
      setT(selEl, t ? `${(t.ox - b.x) * sc}px ${(t.oy - b.y) * sc}px` : '', css);
    }
    this.root.querySelectorAll<HTMLElement>('.ink-overlay .ink-item[data-ink-selected]').forEach((el) => {
      const x = Number(el.dataset.x ?? 0);
      const y = Number(el.dataset.y ?? 0);
      setT(el, t ? `${(t.ox - x) * sc}px ${(t.oy - y) * sc}px` : '', css);
    });
    this.root.querySelectorAll<SVGGElement>('.ink-overlay g[data-ink-selected]').forEach((el) => {
      el.style.transformBox = 'view-box';
      setT(el, t ? `${t.ox}px ${t.oy}px` : '', t ? `translate(${t.dx}px, ${t.dy}px) scale(${t.s})` : '');
    });
  }

  private commitTransform(t: DragTransform) {
    const sel = this.selection;
    const arr = this.arr;
    this.dragHidden.clear();
    if (!sel || !arr || (Math.abs(t.dx) < 0.05 && Math.abs(t.dy) < 0.05 && Math.abs(t.s - 1) < 1e-3)) {
      this.pendingDragReset = true;
      this.invalidate();
      return;
    }
    const ids = new Set(sel.ids);
    let maxY = 0;
    this.transact(() => {
      const list = arr.toArray();
      for (let i = list.length - 1; i >= 0; i--) {
        if (!ids.has(list[i].id)) continue;
        const next = transformStroke(list[i], t);
        maxY = Math.max(maxY, strokeBBox(next).y + strokeBBox(next).h);
        arr.delete(i, 1);
        arr.insert(i, [next]);
      }
      const b = this.block.get('beautified') as Beautified | undefined;
      if (b) {
        const nb = transformBeautified(b, ids, t);
        if (nb) this.block.set('beautified', nb);
      }
      if (maxY > this.displayHeight - GROW_MARGIN) this.block.set('height', Math.ceil(maxY + GROW_STEP));
    });
    this.setSelection(this.selectionFor(sel.ids));
    this.pendingDragReset = true;
    this.invalidate();
  }

  // ------------------------------------------------------------------ rasterisation for OCR

  /** Renders strokes black-on-white for OCR (pen strokes only), returning base64 PNG. */
  async rasterize(strokes: Stroke[]): Promise<RasterImage> {
    const pens = strokes.filter((s) => s.tool === 'pen');
    const list = pens.length ? pens : strokes;
    const box = strokesBBox(list);
    const pad = 16;
    const w = box.w + pad * 2;
    const h = box.h + pad * 2;
    const k = Math.max(0.5, Math.min(4, Math.max(2, 360 / h), 2400 / w, 2400 / h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const ctx = typeof Path2D === 'undefined' ? null : canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderStrokes(ctx, list, k, 1, { cache: this.cache, clear: false, colorOverride: '#000000', offset: { x: box.x - pad, y: box.y - pad } });
    const url = canvas.toDataURL('image/png');
    return { mime: 'image/png', data: url.slice(url.indexOf(',') + 1) };
  }
}
