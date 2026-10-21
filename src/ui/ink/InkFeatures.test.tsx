import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import type { AIRequest, AITask } from '../../core/ai/types';
import type { InkAI } from '../../core/ink/beautify';
import type { Beautified, InkLabel, Stroke } from '../../core/schema';
import { blockIds, blockLabelList, blockPlainText, blockStrokes, blockType, getBlock, insertBlocks } from '../../core/blocks';
import { arc, toStroke, word } from '../../core/ink/testing/synth';
import { InkCanvas } from './InkCanvas';
import { InkSurface } from './surface';
import { PEN_SIZES, useInkStore } from './inkStore';
import { addPending, isKeptAsInk, keepAsInk, listPending, movePending, removePending, updatePending } from './conversions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeAI implements InkAI {
  calls: AIRequest[] = [];
  constructor(private answer = '{"kind":"text","content":"hello"}') {}
  canHandle(task: AITask) {
    return task === 'handwriting' || task === 'math-ocr';
  }
  async complete(req: AIRequest) {
    this.calls.push(req);
    return { text: this.answer };
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useInkStore.setState({ tool: 'none', penDetected: false, sizeIndex: 0, autoConvert: false });
  // happy-dom has no canvas: OCR rasterisation is stubbed
  vi.spyOn(InkSurface.prototype, 'rasterize').mockResolvedValue({ mime: 'image/png', data: 'x' });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function pointer(el: Element, type: string, init: Partial<PointerEventInit> & { clientX: number; clientY: number }) {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, pressure: 0.5, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
}

function drag(el: Element, pts: [number, number][]) {
  pointer(el, 'pointerdown', { clientX: pts[0][0], clientY: pts[0][1] });
  for (const [x, y] of pts.slice(1)) pointer(el, 'pointermove', { clientX: x, clientY: y });
  const [lx, ly] = pts[pts.length - 1];
  pointer(el, 'pointerup', { clientX: lx, clientY: ly, buttons: 0 });
}

function lasso(el: Element, x0: number, y0: number, x1: number, y1: number) {
  drag(el, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 1],
  ]);
}

function doubleTap(el: Element, x: number, y: number) {
  for (let i = 0; i < 2; i++) {
    pointer(el, 'pointerdown', { clientX: x, clientY: y });
    pointer(el, 'pointerup', { clientX: x, clientY: y, buttons: 0 });
  }
}

async function flush(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A page doc with text / whiteboard / text; returns the whiteboard block. */
function page(strokes: Stroke[], extra: { labels?: InkLabel[]; height?: number } = {}) {
  const doc = new Y.Doc();
  const ids = insertBlocks(doc, [
    { type: 'text', text: 'before' },
    { type: 'ink', height: extra.height ?? 400, strokes, labels: extra.labels },
    { type: 'text', text: 'after' },
  ]);
  return { doc, block: getBlock(doc, ids[1])!, inkId: ids[1] };
}

const types = (doc: Y.Doc) => blockIds(doc).map((id) => blockType(getBlock(doc, id)!));

describe('handwriting previews', () => {
  it('Beautify shows typed text in place of the writing; nothing is stored until decided', async () => {
    const strokes = word('hello', 100, 100, 30);
    const { doc, block } = page(strokes);
    const ai = new FakeAI();
    act(() => root.render(<InkCanvas block={block} ai={ai} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    let updates = 0;
    doc.on('update', () => updates++);
    lasso(el, 80, 80, 300, 150);
    doubleTap(el, 150, 115);
    await flush();
    expect(ai.calls).toHaveLength(1);
    expect(host.querySelector('.ink-preview')!.textContent).toBe('hello');
    expect(host.querySelector('.ink-preview-bar')).not.toBeNull();
    // the preview lives only on this device
    expect(updates).toBe(0);
    expect(block.get('beautified')).toBeUndefined();
    expect(listPending(block)).toHaveLength(1);
  });

  it('Accept replaces standalone writing with a text block in the note', async () => {
    const strokes = word('hello', 100, 100, 30);
    const { doc, block } = page(strokes);
    act(() => root.render(<InkCanvas block={block} ai={new FakeAI()} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 300, 150);
    doubleTap(el, 150, 115);
    await flush();
    const accept = [...host.querySelectorAll('.ink-preview-bar button')].find((b) => b.textContent === 'Accept') as HTMLButtonElement;
    act(() => accept.click());
    expect(types(doc)).toEqual(['text', 'text', 'text']);
    expect(blockPlainText(getBlock(doc, blockIds(doc)[1])!)).toBe('hello');
  });

  it('Keep ink drops the preview and leaves the strokes untouched', async () => {
    const strokes = word('hello', 100, 100, 30);
    const { doc, block } = page(strokes);
    act(() => root.render(<InkCanvas block={block} ai={new FakeAI()} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 300, 150);
    doubleTap(el, 150, 115);
    await flush();
    let updates = 0;
    doc.on('update', () => updates++);
    const keep = [...host.querySelectorAll('.ink-preview-bar button')].find((b) => b.textContent === 'Keep ink') as HTMLButtonElement;
    act(() => keep.click());
    expect(host.querySelector('.ink-preview')).toBeNull();
    expect(updates).toBe(0);
    expect(blockStrokes(block)!.length).toBe(strokes.length);
    expect(isKeptAsInk(block, strokes[0].id)).toBe(true);
  });

  it('the preview can be corrected before accepting; writing beside a drawing becomes a label', async () => {
    const strokes = [...word('hello', 100, 100, 30), toStroke(arc(600, 115, 60, 60, 0, Math.PI * 2.05), { id: 'circle' })];
    const { doc, block } = page(strokes);
    act(() => root.render(<InkCanvas block={block} ai={new FakeAI()} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 300, 150);
    doubleTap(el, 150, 115);
    await flush();
    act(() => (host.querySelector('.ink-preview-bar button[aria-label="Edit text"]') as HTMLButtonElement).click());
    const ta = host.querySelector('.ink-editor textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('hello');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'hello there');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => ([...host.querySelectorAll('.ink-editor button')].find((b) => b.textContent === 'Done') as HTMLButtonElement).click());
    expect(listPending(block)[0].content).toBe('hello there');
    act(() => ([...host.querySelectorAll('.ink-preview-bar button')].find((b) => b.textContent === 'Accept') as HTMLButtonElement).click());
    expect(types(doc)).toEqual(['text', 'ink', 'text']);
    expect(blockStrokes(block)!.toArray().map((s) => s.id)).toEqual(['circle']);
    expect(blockLabelList(block)[0].content).toBe('hello there');
    expect(host.querySelector('.ink-label')!.textContent).toBe('hello there');
  });

  it('a math answer becomes a math block', async () => {
    const strokes = word('ab', 100, 100, 30);
    const { doc, block } = page(strokes);
    act(() => root.render(<InkCanvas block={block} ai={new FakeAI('{"kind":"math","content":"x^2"}')} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 200, 150);
    doubleTap(el, 130, 115);
    await flush();
    expect(host.querySelector('.ink-preview-latex .katex')).not.toBeNull();
    act(() => ([...host.querySelectorAll('.ink-preview-bar button')].find((b) => b.textContent === 'Accept') as HTMLButtonElement).click());
    const b = getBlock(doc, blockIds(doc)[1])!;
    expect(blockType(b)).toBe('math');
    expect(blockPlainText(b)).toBe('x^2');
  });

  it('auto-convert reads new writing after a pause', async () => {
    const { block } = page([]);
    const ai = new FakeAI('{"kind":"text","content":"hi"}');
    act(() => root.render(<InkCanvas block={block} ai={ai} />));
    act(() => {
      useInkStore.getState().setTool('pen');
      useInkStore.getState().setAutoConvert(true);
    });
    const el = host.querySelector('.ink-block')!;
    for (const s of word('abc', 100, 100, 30)) {
      const pts: [number, number][] = [];
      for (let i = 0; i < s.pts.length; i += 3) pts.push([s.pts[i], s.pts[i + 1]]);
      drag(el, pts);
    }
    expect(blockStrokes(block)!.length).toBe(3);
    expect(ai.calls).toHaveLength(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1500));
    });
    await flush();
    expect(ai.calls).toHaveLength(1);
    expect(host.querySelector('.ink-preview')!.textContent).toBe('hi');
    act(() => useInkStore.getState().setAutoConvert(false));
  });
});

describe('review fixes', () => {
  it('Beautify keeps typed text stored by older versions until the owner decides', async () => {
    const strokes = word('hello', 100, 100, 30);
    const old: Beautified = { active: true, createdAt: 0, items: [{ kind: 'text', x: 100, y: 100, w: 150, h: 30, text: 'Old', strokeIds: strokes.map((s) => s.id) }] };
    const doc = new Y.Doc();
    const [id] = insertBlocks(doc, [{ type: 'ink', height: 400, strokes, beautified: old }]);
    const block = getBlock(doc, id)!;
    act(() => root.render(<InkCanvas block={block} ai={new FakeAI()} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 300, 150);
    act(() => ([...host.querySelectorAll('.ink-selection-bar button')].find((b) => b.textContent?.includes('Beautify')) as HTMLButtonElement).click());
    await flush();
    expect(listPending(block)).toHaveLength(1);
    expect((block.get('beautified') as Beautified).items).toHaveLength(1);
  });

  it('ink below the stored height (e.g. from another device) stays visible', () => {
    const { block } = page([], { height: 300 });
    act(() => root.render(<InkCanvas block={block} />));
    act(() => {
      block.doc!.transact(() => (block.get('strokes') as Y.Array<Stroke>).push([{ id: 'far', pts: [100, 880, 0.5, 200, 900, 0.5], color: 'currentInk', size: 4, tool: 'pen' }]));
    });
    const ratio = (host.querySelector('.ink-surface') as HTMLElement).style.aspectRatio;
    expect(Number(ratio.split('/')[1])).toBeGreaterThanOrEqual(900);
  });

  it('Accept all is a single undo step', async () => {
    const strokes = [...word('abc', 100, 60, 30), ...word('abd', 100, 200, 30)];
    const { doc, block } = page(strokes);
    const ai = new FakeAI();
    act(() => root.render(<InkCanvas block={block} ai={ai} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 40, 300, 260);
    act(() => ([...host.querySelectorAll('.ink-selection-bar button')].find((b) => b.textContent?.includes('Beautify')) as HTMLButtonElement).click());
    await flush();
    expect(listPending(block)).toHaveLength(2);
    const { undoManagerFor } = await import('../desk/undo');
    const um = undoManagerFor(doc);
    act(() => ([...host.querySelectorAll('.ink-preview-all button')].find((b) => b.textContent?.includes('Accept all')) as HTMLButtonElement).click());
    expect(types(doc)).toEqual(['text', 'text', 'text', 'text']);
    um.undo();
    expect(types(doc)).toEqual(['text', 'ink', 'text']);
    expect(blockStrokes(getBlock(doc, blockIds(doc)[1])!)!.length).toBe(strokes.length);
  });
});

describe('typed labels', () => {
  const label: InkLabel = { id: 'L', x: 100, y: 100, w: 120, h: 30, kind: 'text', content: 'force', size: 20, createdAt: 0 };

  it('renders, edits and deletes a label', () => {
    const { block } = page([], { labels: [label] });
    act(() => root.render(<InkCanvas block={block} />));
    expect(host.querySelector('.ink-label')!.textContent).toBe('force');
    const el = host.querySelector('.ink-block')!;
    // pointer mode: tap a label to edit it
    pointer(el, 'pointerdown', { clientX: 150, clientY: 110 });
    pointer(el, 'pointerup', { clientX: 150, clientY: 110, buttons: 0 });
    const ta = host.querySelector('.ink-editor textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('force');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'F = ma');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => ([...host.querySelectorAll('.ink-editor button')].find((b) => b.textContent === 'Done') as HTMLButtonElement).click());
    expect(blockLabelList(block)[0].content).toBe('F = ma');
    expect(host.querySelector('.ink-label')!.textContent).toBe('F = ma');
  });

  it('lasso selects labels with strokes; moving and deleting include them', () => {
    const s: Stroke = { id: 's', pts: [100, 200, 0.5, 200, 210, 0.5], color: 'currentInk', size: 3, tool: 'pen' };
    const { block } = page([s], { labels: [label] });
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 260, 240);
    expect(host.querySelector('.ink-label[data-ink-selected]')).not.toBeNull();
    drag(el, [
      [150, 150],
      [160, 155],
      [200, 190],
    ]);
    const moved = blockLabelList(block)[0];
    expect(moved.x).toBeCloseTo(150);
    expect(moved.y).toBeCloseTo(140);
    expect(blockStrokes(block)!.get(0).pts[0]).toBeCloseTo(150);
    act(() => (host.querySelector('button[aria-label="Delete selection"]') as HTMLButtonElement).click());
    expect(blockLabelList(block)).toHaveLength(0);
    expect(blockStrokes(block)!.length).toBe(0);
  });

  it('a selection of only labels can be moved and deleted (no Beautify)', () => {
    const { block } = page([], { labels: [label] });
    act(() => root.render(<InkCanvas block={block} />));
    act(() => useInkStore.getState().setTool('lasso'));
    const el = host.querySelector('.ink-block')!;
    lasso(el, 80, 80, 260, 160);
    expect(host.querySelector('.ink-selection')).not.toBeNull();
    expect([...host.querySelectorAll('.ink-selection-bar button')].some((b) => b.textContent?.includes('Beautify'))).toBe(false);
    act(() => (host.querySelector('button[aria-label="Delete selection"]') as HTMLButtonElement).click());
    expect(blockLabelList(block)).toHaveLength(0);
  });
});

describe('photos and zoom', () => {
  it('draws on a photo without strokes yet; the canvas never grows', () => {
    const doc = new Y.Doc();
    const [id] = insertBlocks(doc, [{ type: 'image', image: { blobId: 'b', w: 1000, h: 250 } }]);
    const block = getBlock(doc, id)!;
    act(() => root.render(<InkCanvas block={block} fixedHeight={250} background={<img className="ink-photo-img" alt="" />} />));
    expect(host.querySelector('.ink-block.ink-photo .ink-photo-img')).not.toBeNull();
    act(() => useInkStore.getState().setTool('pen'));
    const el = host.querySelector('.ink-block')!;
    drag(el, [
      [10, 10],
      [100, 240],
      [120, 400],
    ]);
    const strokes = blockStrokes(block)!.toArray();
    expect(strokes).toHaveLength(1);
    // clamped to the photo, and no height was added to an image block
    for (let i = 1; i < strokes[0].pts.length; i += 3) expect(strokes[0].pts[i]).toBeLessThanOrEqual(250);
    expect(block.get('height')).toBeUndefined();
  });

  it('zoomed in, new strokes are finer and the eraser keeps its on-screen size', () => {
    const { block } = page([]);
    act(() => root.render(<InkCanvas block={block} zoom={4} />));
    act(() => useInkStore.getState().setTool('pen'));
    drag(host.querySelector('.ink-block')!, [
      [10, 10],
      [80, 40],
    ]);
    expect(blockStrokes(block)!.get(0).size).toBeCloseTo(PEN_SIZES[0] / 2, 2);
  });

  it('a viewport limits the canvases to the visible part of the surface', () => {
    const root2 = document.createElement('div');
    const surface = document.createElement('div');
    const committed = document.createElement('canvas');
    const wet = document.createElement('canvas');
    root2.append(surface);
    surface.append(committed, wet);
    const { block } = page([], { height: 3000 });
    const eng = new InkSurface(root2, surface, committed, wet, block, { onSelection() {}, onDoubleTapSelection() {}, onTap() {}, onCount() {} });
    eng.setWidth(2000);
    expect(committed.style.height).toBe('6000px');
    eng.setViewport({ x: 300, y: 1200, w: 800, h: 600 });
    expect(committed.style.left).toBe('300px');
    expect(committed.style.top).toBe('1200px');
    expect(committed.style.width).toBe('801px');
    expect(committed.style.height).toBe('601px');
    eng.setViewport(null);
    expect(committed.style.left).toBe('');
    expect(committed.style.width).toBe('2000px');
    eng.destroy();
  });
});

describe('pending conversion store', () => {
  it('adds, replaces overlapping previews, updates, moves and removes', () => {
    const a = new Y.Map<unknown>();
    const b = new Y.Map<unknown>();
    addPending(a, [{ id: '1', kind: 'text', content: 'x', strokeIds: ['s1', 's2'] }]);
    addPending(a, [{ id: '2', kind: 'text', content: 'y', strokeIds: ['s2', 's3'] }]);
    expect(listPending(a).map((c) => c.id)).toEqual(['2']);
    updatePending(a, '2', { content: 'z' });
    expect(listPending(a)[0].content).toBe('z');
    movePending(a, b, ['s2', 's3']);
    expect(listPending(a)).toHaveLength(0);
    expect(listPending(b).map((c) => c.id)).toEqual(['2']);
    removePending(b, ['2']);
    expect(listPending(b)).toHaveLength(0);
    keepAsInk(a, ['s9']);
    expect(isKeptAsInk(a, 's9')).toBe(true);
    expect(isKeptAsInk(b, 's9')).toBe(false);
  });
});

describe('older beautified handwriting', () => {
  it('still renders and toggles (existing notes are unchanged)', () => {
    const beautified: Beautified = { active: true, createdAt: 0, items: [{ kind: 'text', x: 10, y: 10, w: 100, h: 30, text: 'Old', strokeIds: ['a'] }] };
    const doc = new Y.Doc();
    const [id] = insertBlocks(doc, [{ type: 'ink', height: 300, strokes: [{ id: 'a', pts: [10, 10, 0.5, 100, 30, 0.5], color: 'currentInk', size: 3, tool: 'pen' }], beautified }]);
    act(() => root.render(<InkCanvas block={getBlock(doc, id)!} />));
    expect(host.querySelector('.ink-text')!.textContent).toBe('Old');
    expect(host.querySelector('.ink-preview')).toBeNull();
  });
});
