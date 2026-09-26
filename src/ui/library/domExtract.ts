import { looksLikeMath, unicodeMathToLatex } from '../../core/ingest/extract';
import type { SourceLocator } from '../../core/schema';
import type { Extraction } from './extraction';

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR', 'PRE', 'FIGCAPTION', 'SECTION']);

function blockPrefix(el: Element | null): string {
  if (!el) return '';
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return '#'.repeat(Math.min(3, Number(tag[1]))) + ' ';
  if (tag === 'LI') return '- ';
  if (tag === 'BLOCKQUOTE') return '> ';
  return '';
}

/**
 * Lasso extraction for DOM-rendered sources (EPUB chapters, PPTX slides): collects the words
 * whose boxes fall inside the polygon, in reading (DOM) order, keeping block structure.
 * Math rendered as MathML keeps its TeX annotation when present.
 */
export function extractFromDom(root: HTMLElement, poly: [number, number][], sourceId: string, loc: SourceLocator): Omit<Extraction, 'image'> & { images: HTMLImageElement[] } {
  const parts: string[] = [];
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    if (!text.trim()) continue;
    const parent = node.parentElement;
    if (parent?.closest('annotation, .katex-mathml')) continue;
    // word-level hit testing
    const words = text.split(/(\s+)/);
    let offset = 0;
    const picked: string[] = [];
    for (const w of words) {
      if (w.trim()) {
        range.setStart(node, offset);
        range.setEnd(node, offset + w.length);
        const r = range.getBoundingClientRect();
        if (r.width && pointInPolygon(r.left + r.width / 2, r.top + r.height / 2, poly)) picked.push(w);
      }
      offset += w.length;
    }
    if (!picked.length) continue;
    const block = parent?.closest([...BLOCK_TAGS].join(',').toLowerCase()) ?? null;
    if (block !== lastBlock) {
      if (parts.length) parts.push('\n\n');
      parts.push(blockPrefix(block));
      lastBlock = block;
    } else parts.push(' ');
    parts.push(picked.join(' '));
  }
  const images = [...root.querySelectorAll('img')].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.width > 8 && pointInPolygon(r.left + r.width / 2, r.top + r.height / 2, poly);
  });
  const markdown = parts.join('').replace(/[ \t]+/g, ' ').trim();
  const plain = markdown.replace(/^[#>-]+\s/gm, '').replace(/\s+/g, ' ').trim();
  const kind = !plain && images.length ? 'figure' : plain && looksLikeMath(plain) ? 'math' : 'text';
  return { sourceId, loc, kind, markdown, latex: unicodeMathToLatex(plain), quote: plain.slice(0, 280), images };
}

/** Rasterises an <img> region to a PNG blob (same-origin blob: URLs only). */
export async function imageToBlob(img: HTMLImageElement): Promise<{ blob: Blob; w: number; h: number } | undefined> {
  try {
    const res = await fetch(img.src);
    const blob = await res.blob();
    return { blob, w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return undefined;
  }
}
