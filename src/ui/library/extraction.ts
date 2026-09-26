import type { Anchor, SourceLocator } from '../../core/schema';
import type { NewBlock } from '../../core/blocks';
import type { TextItem } from '../../core/ingest/types';
import { classifySelection, estimateBodyFontSize, itemsToMarkdown, selectItemsInPolygon, unicodeMathToLatex } from '../../core/ingest/extract';
import { blobToImageRef } from '../desk/blocks/imageImport';
import { getServicesUnsafe } from '../app/servicesRef';
import type { AppServices } from '../app/bootstrap';

export type ExtractKind = 'text' | 'math' | 'figure';

/** The result of a Lasso on a source: semantic content + a Wormhole anchor back to it. */
export interface Extraction {
  sourceId: string;
  loc: SourceLocator;
  kind: ExtractKind;
  markdown: string;
  latex: string;
  /** cropped region image (always captured so the user can switch to "image") */
  image?: { blob: Blob; w: number; h: number };
  quote: string;
  /** true while an AI refinement (math OCR) is running */
  refining?: boolean;
  aiUsed?: boolean;
}

export function polygonBBox(poly: [number, number][]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Analyse the text items inside a lasso polygon (page space) into an Extraction. */
export function analyseSelection(items: TextItem[], polygon: [number, number][], pageW: number, pageH: number, sourceId: string, page: number): Extraction {
  const inside = selectItemsInPolygon(items, polygon);
  const [x, y, w, h] = polygonBBox(polygon);
  const kind = classifySelection(inside, w * h) as ExtractKind;
  // body size of the whole page, so a selected heading still renders as a heading
  const markdown = itemsToMarkdown(inside, { bodyFontSize: estimateBodyFontSize(items) });
  const plain = inside.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  const latex = unicodeMathToLatex(plain);
  const rect: [number, number, number, number] = [clamp01(x / pageW), clamp01(y / pageH), Math.min(1, w / pageW), Math.min(1, h / pageH)];
  return { sourceId, loc: { page, rect }, kind, markdown, latex, quote: plain.slice(0, 280) };
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

/** Uses the AI router (if a vision-capable provider is configured) to turn a math crop into exact LaTeX. */
export async function refineMath(ex: Extraction): Promise<string | null> {
  if (!ex.image) return null;
  const services = getServicesUnsafe() as AppServices;
  const ai = services.ai;
  if (!ai?.canHandle('math-ocr')) return null;
  try {
    const data = await blobToBase64(ex.image.blob);
    const res = await ai.complete({
      task: 'math-ocr',
      prompt: 'Transcribe the mathematics in this image to LaTeX. Output only the LaTeX, without $ delimiters.',
      images: [{ mime: 'image/png', data }],
      maxTokens: 800,
    });
    const tex = res.text.trim().replace(/^```(?:latex|tex)?\s*|\s*```$/g, '').replace(/^\$+|\$+$/g, '').trim();
    return tex || null;
  } catch {
    return null;
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(s);
}

/** Converts an extraction into Desk blocks, each carrying its Wormhole anchor. */
export async function extractionToBlocks(ex: Extraction, kind: ExtractKind = ex.kind): Promise<NewBlock[]> {
  const anchor: Anchor = { sourceId: ex.sourceId, loc: ex.loc, quote: ex.quote, createdAt: Date.now() };
  if (kind === 'figure' && ex.image) {
    const image = await blobToImageRef(ex.image.blob, ex.quote.slice(0, 80) || 'Figure');
    return [{ type: 'image', image, anchor }];
  }
  if (kind === 'math') return [{ type: 'math', text: ex.latex, anchor }];
  const text = ex.markdown.trim() || ex.quote;
  return [{ type: 'text', text, anchor }];
}
