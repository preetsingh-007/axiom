import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import type { Beautified, Stroke } from '../../core/schema';
import { InkCanvas } from './InkCanvas';
import { InkToolbar, useInkShortcuts, isEditableTarget } from './InkToolbar';
import { useInkStore } from './inkStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBlock(strokes: Stroke[] = [], extra: Record<string, unknown> = {}) {
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const block = new Y.Map<unknown>();
  doc.transact(() => {
    blocks.set('b1', block);
    block.set('id', 'b1');
    block.set('type', 'ink');
    const arr = new Y.Array<Stroke>();
    arr.push(strokes);
    block.set('strokes', arr);
    block.set('height', 300);
    for (const [k, v] of Object.entries(extra)) block.set(k, v);
  });
  return { doc, block, strokes: () => (block.get('strokes') as Y.Array<Stroke>).toArray() };
}

const line = (id: string, x0: number, y0: number, x1: number, y1: number): Stroke => {
  const pts: number[] = [];
  for (let i = 0; i <= 20; i++) pts.push(x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * i) / 20, 0.5);
  return { id, pts, color: 'currentInk', size: 3, tool: 'pen' };
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useInkStore.setState({ tool: 'none', penDetected: false, sizeIndex: 0 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function pointer(el: Element, type: string, init: Partial<PointerEventInit> & { clientX: number; clientY: number }) {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, pressure: 0.5, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
}

function drag(el: Element, pts: [number, number][], init: Partial<PointerEventInit> = {}) {
  pointer(el, 'pointerdown', { clientX: pts[0][0], clientY: pts[0][1], ...init });
  for (const [x, y] of pts.slice(1)) pointer(el, 'pointermove', { clientX: x, clientY: y, ...init });
  const [lx, ly] = pts[pts.length - 1];
  pointer(el, 'pointerup', { clientX: lx, clientY: ly, buttons: 0, ...init });
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('InkCanvas', () => {
  it('renders an accessible whiteboard', () => {
    const { block } = makeBlock([line('a', 10, 10, 100, 10), line('b', 10, 50, 100, 50)]);
    act(() => root.render(<InkCanvas block={block} />));
    const img = host.querySelector('[role="img"]')!;
    expect(img.getAttribute('aria-label')).toBe('Whiteboard, 2 strokes');
    expect(host.querySelectorAll('canvas')).toHaveLength(2);
    expect(host.querySelector('.ink-block')!.className).toContain('ink-tool-none');
  });

  it('draws a stroke with the pen and commits it in one transaction', async () => {
    const { block, doc, strokes } = makeBlock();
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('pen'));
    let txs = 0;
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === 'local') txs++;
    });
    const el = host.querySelector('.ink-block')!;
    expect(el.className).toContain('ink-capture');
    drag(el, [
      [20, 20],
      [40, 25],
      [60, 30],
      [80, 40],
    ]);
    await flush();
    expect(strokes()).toHaveLength(1);
    const s = strokes()[0];
    expect(s.tool).toBe('pen');
    expect(s.color).toBe('currentInk');
    expect(s.pts.length % 3).toBe(0);
    expect(s.pts.length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < s.pts.length; i++) expect(Math.round(s.pts[i] * 100) % 1).toBe(0); // quantised
    expect(txs).toBe(1);
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Whiteboard, 1 stroke');
  });

  it('auto-grows the block when drawing near the bottom', async () => {
    const { block } = makeBlock();
    let reported = 0;
    act(() => root.render(<InkCanvas block={block} onHeightChange={(h) => (reported = h)} />));
    act(() => useInkStore.getState().setTool('pen'));
    drag(host.querySelector('.ink-block')!, [
      [20, 200],
      [30, 260],
      [40, 290],
    ]);
    await flush();
    expect(block.get('height')).toBe(600);
    expect(reported).toBe(600);
  });

  it('a pen pointer switches pointer mode to the pen tool; fingers are then ignored', async () => {
    const { block, strokes } = makeBlock();
    act(() => root.render(<InkCanvas block={block} />));
    const el = host.querySelector('.ink-block')!;
    drag(el, [
      [10, 10],
      [50, 50],
    ], { pointerType: 'pen', pressure: 0.7 });
    await flush();
    expect(useInkStore.getState().penDetected).toBe(true);
    expect(useInkStore.getState().tool).toBe('pen');
    expect(strokes()).toHaveLength(1);
    expect(strokes()[0].pts[2]).toBeCloseTo(0.7);
    drag(el, [
      [10, 100],
      [80, 120],
    ], { pointerType: 'touch', pointerId: 7 });
    await flush();
    expect(strokes()).toHaveLength(1);
  });

  it('palms touching during a pen stroke neither cancel it nor draw', async () => {
    const { block, strokes } = makeBlock();
    useInkStore.setState({ tool: 'pen', penDetected: true });
    act(() => root.render(<InkCanvas block={block} />));
    const el = host.querySelector('.ink-block')!;
    const pen = { pointerType: 'pen', pointerId: 1, pressure: 0.5 };
    pointer(el, 'pointerdown', { clientX: 10, clientY: 10, ...pen });
    pointer(el, 'pointermove', { clientX: 30, clientY: 20, ...pen });
    pointer(el, 'pointerdown', { clientX: 300, clientY: 200, pointerType: 'touch', pointerId: 5, width: 80, height: 80 });
    pointer(el, 'pointerdown', { clientX: 320, clientY: 220, pointerType: 'touch', pointerId: 6 });
    pointer(el, 'pointermove', { clientX: 60, clientY: 40, ...pen });
    pointer(el, 'pointerup', { clientX: 60, clientY: 40, buttons: 0, ...pen });
    pointer(el, 'pointerup', { clientX: 300, clientY: 200, pointerType: 'touch', pointerId: 5 });
    pointer(el, 'pointerup', { clientX: 320, clientY: 220, pointerType: 'touch', pointerId: 6 });
    await flush();
    expect(strokes()).toHaveLength(1);
    expect(strokes()[0].pts.length).toBeGreaterThanOrEqual(9);
  });

  it('a second finger cancels the in-progress finger stroke', async () => {
    const { block, strokes } = makeBlock();
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('pen'));
    const el = host.querySelector('.ink-block')!;
    pointer(el, 'pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch', pointerId: 1 });
    pointer(el, 'pointermove', { clientX: 30, clientY: 20, pointerType: 'touch', pointerId: 1 });
    const second = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 20 });
    act(() => {
      el.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false); // the page gets the gesture
    pointer(el, 'pointermove', { clientX: 40, clientY: 30, pointerType: 'touch', pointerId: 1 });
    pointer(el, 'pointerup', { clientX: 40, clientY: 30, pointerType: 'touch', pointerId: 1 });
    pointer(el, 'pointerup', { clientX: 100, clientY: 20, pointerType: 'touch', pointerId: 2 });
    await flush();
    expect(strokes()).toHaveLength(0);
    // single finger draws again afterwards (no pen seen on this device)
    drag(el, [
      [10, 10],
      [60, 60],
    ], { pointerType: 'touch', pointerId: 3 });
    await flush();
    expect(strokes()).toHaveLength(1);
  });

  it('erases whole strokes the eraser touches, in one transaction', async () => {
    const { block, strokes } = makeBlock([line('a', 10, 10, 200, 10), line('b', 10, 100, 200, 100), line('c', 10, 200, 200, 200)]);
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('eraser'));
    drag(host.querySelector('.ink-block')!, [
      [50, 0],
      [50, 50],
      [50, 120],
    ]);
    await flush();
    expect(strokes().map((s) => s.id)).toEqual(['c']);
  });

  it('lasso selects strokes; Delete removes them; Escape clears', async () => {
    const { block, strokes } = makeBlock([line('a', 20, 20, 80, 20), line('b', 20, 40, 80, 40), line('far', 400, 200, 500, 200)]);
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    drag(el, [
      [5, 5],
      [100, 5],
      [100, 60],
      [5, 60],
      [5, 6],
    ]);
    await flush();
    expect(host.querySelector('.ink-selection')).not.toBeNull();
    expect(host.querySelector('.ink-selection-bar button')!.textContent).toContain('Beautify');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('.ink-selection')).toBeNull();
    drag(el, [
      [5, 5],
      [100, 5],
      [100, 60],
      [5, 60],
      [5, 6],
    ]);
    await flush();
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await flush();
    expect(strokes().map((s) => s.id)).toEqual(['far']);
  });

  it('moves the selection by dragging it', async () => {
    const { block, strokes } = makeBlock([line('a', 20, 20, 80, 20)]);
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    drag(el, [
      [5, 5],
      [100, 5],
      [100, 60],
      [5, 60],
      [5, 6],
    ]);
    drag(el, [
      [50, 20],
      [60, 30],
      [80, 50],
    ]);
    await flush();
    const s = strokes()[0];
    expect(s.id).toBe('a');
    expect(s.pts[0]).toBeCloseTo(50);
    expect(s.pts[1]).toBeCloseTo(50);
  });

  it('double-tap inside the selection runs Beautify (shapes offline, AI notice for writing)', async () => {
    const circle: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = (i / 80) * Math.PI * 2.05;
      circle.push(200 + Math.cos(t) * 60, 150 + Math.sin(t) * 60, 0.5);
    }
    const { block } = makeBlock([{ id: 'c', pts: circle, color: 'currentInk', size: 3, tool: 'pen' }]);
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    drag(el, [
      [100, 50],
      [300, 50],
      [300, 250],
      [100, 250],
      [100, 51],
    ]);
    expect(host.querySelector('.ink-selection')).not.toBeNull();
    const tap = () => {
      pointer(el, 'pointerdown', { clientX: 200, clientY: 150 });
      pointer(el, 'pointerup', { clientX: 200, clientY: 150, buttons: 0 });
    };
    tap();
    tap();
    await flush();
    await flush();
    const b = block.get('beautified') as Beautified;
    expect(b.active).toBe(true);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].kind === 'shape' && b.items[0].shape).toBe('circle');
    expect(host.querySelector('.ink-overlay-svg circle')).not.toBeNull();
    // strokes are untouched (non-destructive)
    expect((block.get('strokes') as Y.Array<Stroke>).length).toBe(1);
  });

  it('renders beautified items and toggles back to the original ink on tap', async () => {
    const beautified: Beautified = {
      active: true,
      createdAt: 0,
      items: [
        { kind: 'shape', shape: 'rectangle', svg: '<rect x="10" y="10" width="100" height="50" onclick="x()"/>', bbox: [10, 10, 100, 50], color: '#3e7bfa', strokeIds: ['a'] },
        { kind: 'text', x: 200, y: 20, w: 120, h: 30, text: 'Hello', strokeIds: ['b'] },
        { kind: 'latex', x: 400, y: 20, w: 120, h: 40, latex: '\\frac{a}{b}', strokeIds: ['c'] },
      ],
    };
    const { block } = makeBlock([line('a', 10, 10, 110, 60), line('b', 200, 20, 320, 50), line('c', 400, 20, 520, 60)], { beautified });
    act(() => root.render(<InkCanvas block={block} />));
    const svg = host.querySelector('.ink-overlay-svg')!;
    expect(svg.innerHTML).toContain('<rect');
    expect(svg.innerHTML).not.toContain('onclick');
    expect(host.querySelector('.ink-text')!.textContent).toBe('Hello');
    expect(host.querySelector('.ink-latex .katex')).not.toBeNull();
    // pointer-mode tap on an item reveals the toggle
    const el = host.querySelector('.ink-block')!;
    pointer(el, 'pointerdown', { clientX: 50, clientY: 30 });
    pointer(el, 'pointerup', { clientX: 50, clientY: 30, buttons: 0 });
    const btn = host.querySelector('.ink-toggle button') as HTMLButtonElement;
    expect(btn.textContent).toContain('Show original ink');
    act(() => btn.click());
    expect((block.get('beautified') as Beautified).active).toBe(false);
    expect(host.querySelector('.ink-overlay')).toBeNull();
    expect(host.querySelector('.ink-toggle button')!.textContent).toContain('Show beautified');
  });

  it('readOnly never writes', async () => {
    const { block, strokes } = makeBlock();
    act(() => root.render(<InkCanvas block={block} readOnly />));
    act(() => useInkStore.getState().setTool('pen'));
    drag(host.querySelector('.ink-block')!, [
      [10, 10],
      [50, 50],
    ]);
    await flush();
    expect(strokes()).toHaveLength(0);
  });
});

describe('InkToolbar & shortcuts', () => {
  function Shortcuts() {
    useInkShortcuts();
    return null;
  }

  it('switches tools, colours and sizes', () => {
    act(() => root.render(<InkToolbar />));
    const pen = host.querySelector('button[aria-label="Pen (P)"]') as HTMLButtonElement;
    act(() => pen.click());
    expect(useInkStore.getState().tool).toBe('pen');
    expect(pen.getAttribute('aria-pressed')).toBe('true');
    const swatches = host.querySelectorAll('.ink-swatch');
    expect(swatches).toHaveLength(6);
    act(() => (swatches[2] as HTMLButtonElement).click());
    expect(useInkStore.getState().color).toBe(useInkStore.getState().palette[2]);
    act(() => (host.querySelectorAll('.ink-size-btn')[2] as HTMLButtonElement).click());
    expect(useInkStore.getState().sizeIndex).toBe(2);
  });

  it('keyboard shortcuts are ignored while typing', () => {
    act(() => root.render(<Shortcuts />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }));
    });
    expect(useInkStore.getState().tool).toBe('eraser');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
    });
    expect(useInkStore.getState().tool).toBe('none');
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    });
    expect(useInkStore.getState().tool).toBe('none');
    expect(isEditableTarget(ta)).toBe(true);
    const cm = document.createElement('div');
    cm.className = 'cm-editor';
    const inner = document.createElement('div');
    cm.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
    ta.remove();
  });
});
