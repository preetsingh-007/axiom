/**
 * Canvas rasterisation of a parsed PPTX slide (backgrounds, shapes, images,
 * wrapped text). Used to create image blocks in seminar notebooks and thumbnails.
 */
import type { PptxDeck, PptxElement, PptxParagraph, PptxSlide } from '../../../core/ingest/types';
import {
  DEFAULT_BG,
  DEFAULT_TEXT,
  INSET_X,
  INSET_Y,
  LEVEL_INDENT,
  LINE_HEIGHT,
  PT_TO_PX,
  SLIDE_FONT,
  bulletLabels,
  isLineGeom,
  shapePath,
} from './geometry';

type Ctx = CanvasRenderingContext2D;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function withTransform(ctx: Ctx, e: PptxElement, draw: () => void) {
  ctx.save();
  if (e.rotation) {
    ctx.translate(e.x + e.w / 2, e.y + e.h / 2);
    ctx.rotate((e.rotation * Math.PI) / 180);
    ctx.translate(-e.w / 2, -e.h / 2);
  } else ctx.translate(e.x, e.y);
  draw();
  ctx.restore();
}

function drawShape(ctx: Ctx, geom: string, w: number, h: number, fill?: string, stroke?: string, strokeWidth?: number) {
  const d = shapePath(geom, w, h);
  const line = isLineGeom(geom);
  const path = d && typeof Path2D !== 'undefined' ? new Path2D(d) : null;
  if (fill && !line) {
    ctx.fillStyle = fill;
    if (path) ctx.fill(path);
    else ctx.fillRect(0, 0, w, h);
  }
  if (stroke || line) {
    ctx.strokeStyle = stroke ?? DEFAULT_TEXT;
    ctx.lineWidth = strokeWidth ?? 1.5;
    if (path) ctx.stroke(path);
    else if (line) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.stroke();
    } else ctx.strokeRect(0, 0, w, h);
  }
}

interface Token {
  text: string;
  font: string;
  color: string;
  size: number;
  underline: boolean;
  width: number;
}

interface Line {
  tokens: Token[];
  width: number;
  height: number;
  ascent: number;
}

function fontFor(size: number, bold?: boolean, italic?: boolean): string {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${size.toFixed(2)}px ${SLIDE_FONT}`;
}

/** Word-wraps a paragraph (with per-run styles) into lines of at most maxW px. */
function layoutParagraph(ctx: Ctx, p: PptxParagraph, maxW: number): Line[] {
  const baseSize = (p.size ?? 18) * PT_TO_PX;
  const runs = p.runs?.length
    ? p.runs
    : [{ text: p.text, size: p.size, bold: p.bold, italic: p.italic, underline: false, color: p.color }];
  const lines: Line[] = [];
  let cur: Line = { tokens: [], width: 0, height: baseSize * LINE_HEIGHT, ascent: baseSize * 0.8 };
  const push = () => {
    // drop trailing whitespace from the measured width
    while (cur.tokens.length && !cur.tokens[cur.tokens.length - 1].text.trim()) {
      cur.width -= cur.tokens.pop()!.width;
    }
    lines.push(cur);
    cur = { tokens: [], width: 0, height: baseSize * LINE_HEIGHT, ascent: baseSize * 0.8 };
  };
  for (const r of runs) {
    const size = (r.size ?? p.size ?? 18) * PT_TO_PX;
    const font = fontFor(size, r.bold ?? p.bold, r.italic ?? p.italic);
    ctx.font = font;
    const color = r.color ?? p.color ?? DEFAULT_TEXT;
    for (const piece of r.text.split(/(\n|\s+)/)) {
      if (!piece) continue;
      if (piece === '\n') {
        push();
        continue;
      }
      const isSpace = !piece.trim();
      if (isSpace && !cur.tokens.length) continue;
      let width = ctx.measureText(piece).width;
      if (!isSpace && cur.width + width > maxW && cur.tokens.length) push();
      // hard-break words longer than the box
      let text = piece;
      while (!isSpace && width > maxW && text.length > 1) {
        let k = text.length - 1;
        while (k > 1 && ctx.measureText(text.slice(0, k)).width > maxW) k--;
        const head = text.slice(0, k);
        const hw = ctx.measureText(head).width;
        cur.tokens.push({ text: head, font, color, size, underline: !!r.underline, width: hw });
        cur.width += hw;
        cur.height = Math.max(cur.height, size * LINE_HEIGHT);
        cur.ascent = Math.max(cur.ascent, size * 0.8);
        push();
        text = text.slice(k);
        width = ctx.measureText(text).width;
      }
      cur.tokens.push({ text, font, color, size, underline: !!r.underline, width });
      cur.width += width;
      cur.height = Math.max(cur.height, size * LINE_HEIGHT);
      cur.ascent = Math.max(cur.ascent, size * 0.8);
    }
  }
  push();
  return lines;
}

function drawText(ctx: Ctx, e: Extract<PptxElement, { kind: 'text' }>) {
  if (e.fill || e.stroke) drawShape(ctx, e.geom ?? 'rect', e.w, e.h, e.fill, e.stroke);
  const labels = bulletLabels(e.paragraphs);
  const innerW = Math.max(1, e.w - INSET_X * 2);
  const blocks = e.paragraphs.map((p, i) => {
    const size = (p.size ?? 18) * PT_TO_PX;
    const indent = (p.level ?? 0) * LEVEL_INDENT + (p.bullet ? size * 1.1 : 0);
    return { p, label: labels[i], size, indent, lines: layoutParagraph(ctx, p, Math.max(1, innerW - indent)) };
  });
  const total = blocks.reduce((h, b) => h + b.lines.reduce((s, l) => s + l.height, 0), 0);
  const avail = e.h - INSET_Y * 2;
  let y = INSET_Y;
  if (e.verticalAlign === 'middle') y += (avail - total) / 2;
  else if (e.verticalAlign === 'bottom') y += avail - total;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-2, -2, e.w + 4, e.h + 4);
  ctx.clip();
  ctx.textBaseline = 'alphabetic';
  for (const b of blocks) {
    b.lines.forEach((line, li) => {
      const left = INSET_X + b.indent;
      let x = left;
      const align = b.p.align ?? 'left';
      if (align === 'center') x = left + (innerW - b.indent - line.width) / 2;
      else if (align === 'right') x = left + (innerW - b.indent - line.width);
      const baseline = y + (line.height - line.ascent / 0.8) / 2 + line.ascent;
      if (li === 0 && b.label) {
        ctx.font = fontFor(b.size, b.p.bold, b.p.italic);
        ctx.fillStyle = b.p.color ?? DEFAULT_TEXT;
        ctx.fillText(b.label, INSET_X + (b.p.level ?? 0) * LEVEL_INDENT, baseline);
      }
      for (const t of line.tokens) {
        ctx.font = t.font;
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, x, baseline);
        if (t.underline && t.text.trim()) ctx.fillRect(x, baseline + t.size * 0.1, t.width, Math.max(1, t.size / 16));
        x += t.width;
      }
      y += line.height;
    });
  }
  ctx.restore();
}

/**
 * Rasterises a slide at `width` px (height follows the deck aspect ratio).
 * Pass `width * devicePixelRatio` for crisp on-screen use.
 */
export async function renderSlideToCanvas(deck: PptxDeck, slide: PptxSlide, width: number): Promise<HTMLCanvasElement> {
  const w = Math.max(1, Math.round(width));
  const scale = w / deck.width;
  const h = Math.max(1, Math.round(deck.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  // images first (parallel), fonts ready
  const images = new Map<string, HTMLImageElement | null>();
  await Promise.all([
    ...slide.elements.filter((e) => e.kind === 'image').map(async (e) => images.set(e.url, await loadImage(e.url))),
    (document as Document & { fonts?: FontFaceSet }).fonts?.ready.catch(() => undefined),
  ]);
  ctx.scale(scale, scale);
  ctx.fillStyle = slide.background ?? DEFAULT_BG;
  ctx.fillRect(0, 0, deck.width, deck.height);
  for (const e of slide.elements) {
    withTransform(ctx, e, () => {
      if (e.kind === 'shape') drawShape(ctx, e.geom, e.w, e.h, e.fill, e.stroke, e.strokeWidth);
      else if (e.kind === 'image') {
        const img = images.get(e.url);
        if (img) ctx.drawImage(img, 0, 0, e.w, e.h);
      } else drawText(ctx, e);
    });
  }
  return canvas;
}

/** PNG (or other type) blob of a rendered slide. */
export async function renderSlideToBlob(deck: PptxDeck, slide: PptxSlide, width: number, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = await renderSlideToCanvas(deck, slide, width);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality),
  );
}
