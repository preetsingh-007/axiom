/**
 * Beautify: turns a lassoed selection of raw ink into clean, non-destructive overlays.
 *
 *   beautify(strokes, { ai, rasterize, palette }) → { items, unrecognizedStrokeIds, needsAI, errors }
 *
 *  - shapes → `{ kind: 'shape', svg, bbox, color, shape, strokeIds }`: perfectly snapped SVG in
 *    logical coordinates, aligned with their neighbours, connectors glued to shape boundaries,
 *    colour-coded by class unless the ink already had a non-default colour;
 *  - writing → rasterised (callback from the UI, which owns canvases) and read by the AI:
 *    one request per writing block returning `{"kind":"math"|"text","content":"..."}` →
 *    `{ kind: 'latex' | 'text', x, y, w, h, latex | text, strokeIds }`;
 *  - without an AI provider, writing stays as ink: its ids are reported in
 *    `unrecognizedStrokeIds` and `needsAI` is true so the UI can suggest connecting one.
 *
 * Raw strokes are never modified; the caller stores the items in the block's `beautified`
 * field (see `mergeBeautified`) and toggles `beautified.active` to switch views.
 */
import type { AIRequest, AITask } from '../ai/types';
import type { Beautified, BeautifiedItem, Stroke } from '../schema';
import { inflateBBox, strokesBBox } from './geometry';
import { CURRENT_INK } from './render';
import { clusterStrokes, type WritingCluster } from './cluster';
import { alignShapes, geometryBBox, geometryToSvg, snapConnectors } from './shapes';
import type { ShapeGeometry, ShapeKind } from './recognize';

/** Minimal AI surface used by ink (implemented by the app's AIRouter). */
export interface InkAI {
  complete(req: AIRequest, signal?: AbortSignal): Promise<{ text: string }>;
  /** `opts.images`: the request will carry images (OCR); only image-capable providers count */
  canHandle(task: AITask, opts?: { images?: boolean }): boolean;
}

export interface RasterImage {
  mime: string;
  /** base64 without the data: prefix */
  data: string;
}

export interface BeautifyOptions {
  ai?: InkAI | null;
  /** renders strokes to an image for OCR (black ink on white) */
  rasterize: (strokes: Stroke[]) => Promise<RasterImage>;
  /**
   * Colours assigned by shape class when the ink uses the default colour, in order:
   * [rectangle, circle/ellipse, triangle, diamond, line/arrow]. Missing entries fall back
   * to the defaults (`'currentInk'` for connectors).
   */
  palette?: string[];
  /** align nearby shapes and snap connectors (default true) */
  align?: boolean;
  /** max parallel AI requests (default 3) */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface BeautifyResult {
  items: BeautifiedItem[];
  /** strokes left as raw ink: writing without AI / failed OCR, and large unrecognised strokes */
  unrecognizedStrokeIds: string[];
  /** writing was found but no AI provider can read handwriting */
  needsAI: boolean;
  errors: string[];
  stats: { shapes: number; text: number; latex: number };
}

/** Default class colours; mid-tone hues that stay legible on light and dark backgrounds. */
export const DEFAULT_SHAPE_PALETTE: string[] = ['#3e7bfa', '#30a46c', '#f76b15', '#8e4ec6', CURRENT_INK];

function classColor(kind: ShapeKind, palette: string[]): string {
  const idx = kind === 'rectangle' ? 0 : kind === 'circle' || kind === 'ellipse' ? 1 : kind === 'triangle' ? 2 : kind === 'diamond' ? 3 : 4;
  return palette[idx] ?? DEFAULT_SHAPE_PALETTE[idx];
}

/** Keeps the ink colour when most member strokes use a non-default colour. */
function inkColorOf(strokes: readonly Stroke[]): string | null {
  const counts = new Map<string, number>();
  for (const s of strokes) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [c, k] of counts) {
    if (k > bestN) {
      best = c;
      bestN = k;
    }
  }
  if (!best || best === CURRENT_INK) return null;
  return best;
}

const OCR_SYSTEM =
  'You are a precise OCR engine for handwritten research notes. Transcribe exactly what is written; never explain, never solve. Reply with JSON only.';

export function ocrPrompt(mathy: boolean): string {
  return [
    mathy
      ? 'The image shows a handwritten snippet that is probably mathematics.'
      : 'The image shows a handwritten snippet that is probably prose (it may contain some math).',
    'Decide whether it is primarily mathematical notation ("math") or prose ("text").',
    'Respond with JSON only: {"kind":"math"|"text","content":"..."}.',
    'For math, content is LaTeX without surrounding $ delimiters (use \\\\ between lines).',
    'For text, content is the plain transcription, preserving line breaks; wrap inline math in $...$.',
    'If the image is illegible, respond {"kind":"text","content":""}.',
  ].join(' ');
}

/** Strips $…$, $$…$$, \[…\], \(…\) delimiters. */
export function stripMathDelimiters(s: string): string {
  let t = s.trim();
  const pairs: [string, string][] = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$', '$'],
  ];
  for (const [a, b] of pairs) {
    if (t.startsWith(a) && t.endsWith(b) && t.length >= a.length + b.length) {
      t = t.slice(a.length, t.length - b.length).trim();
      break;
    }
  }
  return t;
}

/** Parses the model's answer; tolerant of code fences and surrounding chatter. */
export function parseOcrResponse(text: string, fallback: 'math' | 'text'): { kind: 'math' | 'text'; content: string } | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { kind?: unknown; content?: unknown };
      if (typeof obj.content === 'string') {
        const kind = obj.kind === 'math' ? 'math' : obj.kind === 'text' ? 'text' : fallback;
        const content = kind === 'math' ? stripMathDelimiters(obj.content) : obj.content.trim();
        return content ? { kind, content } : null;
      }
    } catch {
      /* fall through to plain text */
    }
  }
  if (!raw || raw.startsWith('{')) return null;
  return { kind: fallback, content: fallback === 'math' ? stripMathDelimiters(raw) : raw };
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const run = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
  return out;
}

function pickTask(ai: InkAI, mathy: boolean): AITask | null {
  const math = ai.canHandle('math-ocr', { images: true });
  const hw = ai.canHandle('handwriting', { images: true });
  if (mathy) return math ? 'math-ocr' : hw ? 'handwriting' : null;
  return hw ? 'handwriting' : math ? 'math-ocr' : null;
}

/** Beautifies a selection of strokes. Never throws for recognition/AI failures (see `errors`). */
export async function beautify(strokes: readonly Stroke[], opts: BeautifyOptions): Promise<BeautifyResult> {
  const palette = opts.palette ?? DEFAULT_SHAPE_PALETTE;
  const clusters = clusterStrokes(strokes);
  const items: BeautifiedItem[] = [];
  const unrecognized: string[] = clusters.leftovers.map((s) => s.id);
  const errors: string[] = [];
  const stats = { shapes: 0, text: 0, latex: 0 };

  // ---- shapes
  const placed = clusters.shapes.map((c) => ({ geometry: c.recognition.geometry as ShapeGeometry, cluster: c }));
  if (opts.align !== false) {
    alignShapes(placed);
    snapConnectors(placed);
  }
  for (const p of placed) {
    const members = p.cluster.strokes;
    const avgSize = members.reduce((a, s) => a + s.size, 0) / Math.max(1, members.length);
    const sw = Math.min(8, Math.max(1.5, avgSize * 0.9));
    const kind = p.geometry.kind as ShapeKind;
    const b = geometryBBox(p.geometry, sw);
    const pad = sw / 2;
    items.push({
      kind: 'shape',
      shape: kind,
      svg: geometryToSvg(p.geometry, sw),
      bbox: [round(b.x - pad), round(b.y - pad), round(b.w + 2 * pad), round(b.h + 2 * pad)],
      color: inkColorOf(members) ?? classColor(kind, palette),
      strokeIds: members.map((s) => s.id),
    });
    stats.shapes++;
  }

  // ---- writing
  const ai = opts.ai ?? null;
  const writing = clusters.writing;
  let needsAI = false;
  if (writing.length) {
    const tasks = writing.map((w) => async () => {
      if (opts.signal?.aborted) return null;
      const task = ai ? pickTask(ai, w.mathy) : null;
      if (!ai || !task) {
        needsAI = true;
        return null;
      }
      try {
        return await readWriting(ai, task, w, opts);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        return null;
      }
    });
    const results = await pool(tasks, Math.max(1, opts.concurrency ?? 3));
    results.forEach((r, i) => {
      if (r) {
        items.push(r);
        if (r.kind === 'latex') stats.latex++;
        else stats.text++;
      } else {
        for (const s of writing[i].strokes) unrecognized.push(s.id);
      }
    });
  }

  return { items, unrecognizedStrokeIds: unrecognized, needsAI, errors, stats };
}

async function readWriting(ai: InkAI, task: AITask, w: WritingCluster, opts: BeautifyOptions): Promise<BeautifiedItem | null> {
  const image = await opts.rasterize(w.strokes);
  const res = await ai.complete(
    {
      task,
      system: OCR_SYSTEM,
      prompt: ocrPrompt(w.mathy),
      images: [image],
      json: true,
      temperature: 0,
      maxTokens: 800,
    },
    opts.signal,
  );
  const parsed = parseOcrResponse(res.text, task === 'math-ocr' ? 'math' : 'text');
  if (!parsed) return null;
  const maxSize = w.strokes.reduce((a, s) => Math.max(a, s.size), 0);
  const b = inflateBBox(strokesBBox(w.strokes), maxSize / 2);
  const box = { x: round(b.x), y: round(b.y), w: round(Math.max(b.w, 10)), h: round(Math.max(b.h, 10)) };
  const strokeIds = w.strokes.map((s) => s.id);
  return parsed.kind === 'math' ? { kind: 'latex', ...box, latex: parsed.content, strokeIds } : { kind: 'text', ...box, text: parsed.content, strokeIds };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// Maintaining a block's `beautified` value

/**
 * Merges new items into a block's beautified state: previous items that share strokes with
 * `replacedStrokeIds` (the beautified selection) are dropped, the rest are kept.
 */
export function mergeBeautified(prev: Beautified | undefined | null, items: BeautifiedItem[], replacedStrokeIds: Iterable<string>, now = Date.now()): Beautified {
  const replaced = new Set(replacedStrokeIds);
  const kept = (prev?.items ?? []).filter((it) => !it.strokeIds.some((id) => replaced.has(id)));
  return { items: [...kept, ...items], active: true, createdAt: prev?.createdAt ?? now };
}

/** Expands a selection so it covers whole beautified items it touches (for re-beautify). */
export function expandToItems(ids: Iterable<string>, beautified: Beautified | undefined | null): Set<string> {
  const out = new Set(ids);
  if (!beautified) return out;
  for (const it of beautified.items) if (it.strokeIds.some((id) => out.has(id))) for (const id of it.strokeIds) out.add(id);
  return out;
}

/** Removes deleted strokes from items; items left without strokes disappear. Returns null when empty. */
export function removeStrokesFromBeautified(b: Beautified | undefined | null, removed: Iterable<string>): Beautified | null {
  if (!b) return null;
  const gone = new Set(removed);
  const items = b.items
    .map((it) => ({ ...it, strokeIds: it.strokeIds.filter((id) => !gone.has(id)) }))
    .filter((it) => it.strokeIds.length > 0) as BeautifiedItem[];
  return items.length ? { ...b, items } : null;
}

const WRAP_RE = /^<g transform="matrix\(([-0-9.eE]+) 0 0 ([-0-9.eE]+) ([-0-9.eE]+) ([-0-9.eE]+)\)">([\s\S]*)<\/g>$/;

/** Wraps (or re-wraps) an SVG fragment in a uniform scale+translate: p' = s·p + (tx, ty). */
export function transformSvgFragment(svg: string, s: number, tx: number, ty: number): string {
  let inner = svg;
  let S = s;
  let TX = tx;
  let TY = ty;
  const m = svg.match(WRAP_RE);
  if (m) {
    const s1 = Number(m[1]);
    const t1x = Number(m[3]);
    const t1y = Number(m[4]);
    inner = m[5];
    S = s * s1;
    TX = s * t1x + tx;
    TY = s * t1y + ty;
  }
  if (Math.abs(S - 1) < 1e-9 && Math.abs(TX) < 1e-9 && Math.abs(TY) < 1e-9) return inner;
  const r = (n: number) => String(Math.round(n * 1000) / 1000);
  return `<g transform="matrix(${r(S)} 0 0 ${r(S)} ${r(TX)} ${r(TY)})">${inner}</g>`;
}

/**
 * Moves/scales the items whose strokes are all in `ids`, matching a stroke transform
 * p' = origin + (p − origin)·s + (dx, dy).
 */
export function transformBeautified(b: Beautified | undefined | null, ids: Iterable<string>, t: { dx: number; dy: number; s?: number; ox?: number; oy?: number }): Beautified | null {
  if (!b) return null;
  const set = new Set(ids);
  const s = t.s ?? 1;
  const ox = t.ox ?? 0;
  const oy = t.oy ?? 0;
  const X = (x: number) => round(ox + (x - ox) * s + t.dx);
  const Y = (y: number) => round(oy + (y - oy) * s + t.dy);
  const items = b.items.map((it): BeautifiedItem => {
    if (!it.strokeIds.every((id) => set.has(id))) return it;
    if (it.kind === 'shape') {
      const tx = ox * (1 - s) + t.dx;
      const ty = oy * (1 - s) + t.dy;
      return { ...it, svg: transformSvgFragment(it.svg, s, tx, ty), bbox: [X(it.bbox[0]), Y(it.bbox[1]), round(it.bbox[2] * s), round(it.bbox[3] * s)] };
    }
    return { ...it, x: X(it.x), y: Y(it.y), w: round(it.w * s), h: round(it.h * s) };
  });
  return { ...b, items };
}
