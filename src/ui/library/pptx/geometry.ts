/** Geometry + text helpers shared by the DOM and canvas slide renderers. */
import type { PptxParagraph } from '../../../core/ingest/types';

export const PT_TO_PX = 96 / 72;
/** default text insets of a PowerPoint text body: 0.1in left/right, 0.05in top/bottom */
export const INSET_X = 9.6;
export const INSET_Y = 4.8;
/** indentation per paragraph level */
export const LEVEL_INDENT = 36;
export const LINE_HEIGHT = 1.2;
export const SLIDE_FONT = "Calibri, Carlito, 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
export const DEFAULT_BG = '#FFFFFF';
export const DEFAULT_TEXT = '#000000';

/** SVG path for a preset geometry in a w×h box, or null for a plain rectangle. */
export function shapePath(geom: string, w: number, h: number): string | null {
  const r = (v: number) => Math.round(v * 100) / 100;
  switch (geom) {
    case 'ellipse':
    case 'circle': {
      const rx = w / 2;
      const ry = h / 2;
      return `M0 ${r(ry)}A${r(rx)} ${r(ry)} 0 1 0 ${r(w)} ${r(ry)}A${r(rx)} ${r(ry)} 0 1 0 0 ${r(ry)}Z`;
    }
    case 'roundRect': {
      const k = Math.min(w, h) * 0.16667;
      return `M${r(k)} 0H${r(w - k)}Q${r(w)} 0 ${r(w)} ${r(k)}V${r(h - k)}Q${r(w)} ${r(h)} ${r(w - k)} ${r(h)}H${r(k)}Q0 ${r(h)} 0 ${r(h - k)}V${r(k)}Q0 0 ${r(k)} 0Z`;
    }
    case 'triangle':
      return `M${r(w / 2)} 0L${r(w)} ${r(h)}H0Z`;
    case 'rtTriangle':
      return `M0 0L${r(w)} ${r(h)}H0Z`;
    case 'diamond':
      return `M${r(w / 2)} 0L${r(w)} ${r(h / 2)}L${r(w / 2)} ${r(h)}L0 ${r(h / 2)}Z`;
    case 'parallelogram': {
      const k = Math.min(w, h) * 0.25;
      return `M${r(k)} 0H${r(w)}L${r(w - k)} ${r(h)}H0Z`;
    }
    case 'hexagon': {
      const k = Math.min(w, h) * 0.25;
      return `M${r(k)} 0H${r(w - k)}L${r(w)} ${r(h / 2)}L${r(w - k)} ${r(h)}H${r(k)}L0 ${r(h / 2)}Z`;
    }
    case 'rightArrow': {
      const head = Math.min(w, h) * 0.5;
      return `M0 ${r(h * 0.25)}H${r(w - head)}V0L${r(w)} ${r(h / 2)}L${r(w - head)} ${r(h)}V${r(h * 0.75)}H0Z`;
    }
    case 'leftArrow': {
      const head = Math.min(w, h) * 0.5;
      return `M${r(w)} ${r(h * 0.25)}H${r(head)}V0L0 ${r(h / 2)}L${r(head)} ${r(h)}V${r(h * 0.75)}H${r(w)}Z`;
    }
    case 'chevron': {
      const k = Math.min(w, h) * 0.5;
      return `M0 0H${r(w - k)}L${r(w)} ${r(h / 2)}L${r(w - k)} ${r(h)}H0L${r(k)} ${r(h / 2)}Z`;
    }
    case 'homePlate': {
      const k = Math.min(w, h) * 0.5;
      return `M0 0H${r(w - k)}L${r(w)} ${r(h / 2)}L${r(w - k)} ${r(h)}H0Z`;
    }
    case 'line':
    case 'straightConnector1':
    case 'bentConnector2':
    case 'bentConnector3':
    case 'curvedConnector3':
      return `M0 0L${r(w)} ${r(h)}`;
    default:
      return null;
  }
}

export const isLineGeom = (geom: string) => /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(geom);

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of table) while (n >= v) (out += s), (n -= v);
  return out;
}

function alpha(n: number): string {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function autoNumber(scheme: string, n: number): string {
  let core: string;
  if (scheme.startsWith('alphaLc')) core = alpha(n);
  else if (scheme.startsWith('alphaUc')) core = alpha(n).toUpperCase();
  else if (scheme.startsWith('romanLc')) core = roman(n);
  else if (scheme.startsWith('romanUc')) core = roman(n).toUpperCase();
  else core = String(n);
  if (scheme.endsWith('ParenBoth')) return `(${core})`;
  if (scheme.endsWith('ParenR')) return `${core})`;
  if (scheme.endsWith('Plain')) return core;
  return `${core}.`;
}

/** Bullet label per paragraph ("•", "1.", "a)") or null; auto-numbering restarts per level run. */
export function bulletLabels(paragraphs: PptxParagraph[]): (string | null)[] {
  const counters = new Map<number, number>();
  return paragraphs.map((p) => {
    const level = p.level ?? 0;
    for (const k of [...counters.keys()]) if (k > level) counters.delete(k);
    if (!p.bullet || !p.text.trim()) {
      if (!p.bullet) counters.delete(level);
      return null;
    }
    const ch = p.bulletChar;
    if (ch && ch.length > 1 && /^(arabic|alpha|roman)/.test(ch)) {
      const n = (counters.get(level) ?? 0) + 1;
      counters.set(level, n);
      return autoNumber(ch, n);
    }
    counters.delete(level);
    return ch && ch.length <= 2 ? ch : level % 2 ? '–' : '•';
  });
}
