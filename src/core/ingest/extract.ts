/**
 * The "semantic paste" engine.
 *
 * Input: positioned text runs (`TextItem`) in page space — PDF points, origin at
 * the TOP-LEFT of the page, y growing downwards (see `getPageTextItems` in
 * pdf.ts). Output: editable Markdown / LaTeX / plain text in reading order.
 *
 * Pipeline
 *  1. layout: recursive band/gutter segmentation. Items are split into
 *     horizontal bands at full-width vertical whitespace; consecutive bands
 *     sharing a vertical gutter form a multi-column block that is read column
 *     by column (recursively, so 3-column layouts and nested floats work).
 *  2. lines: items of a single-column block are grouped by vertical overlap,
 *     sorted by x, with spaces inferred from gaps and super/subscripts detected
 *     from size + baseline shift.
 *  3. paragraphs: breaks from vertical gaps, first-line indentation, short
 *     sentence-final lines, font-size changes and list markers; lines are joined
 *     with de-hyphenation.
 *  4. rendering: headings (font size relative to body), lists, escaping.
 */
import type { TextItem } from './types';

// ------------------------------------------------------------------ options

export type ScriptStyle = 'unicode' | 'html' | 'latex' | 'none';

export interface ExtractOptions {
  /** body font size of the page (pass `estimateBodyFontSize(allPageItems)` when converting a selection) */
  bodyFontSize?: number;
  /** emit `#`/`##` headings for large text (default true) */
  headings?: boolean;
  /** how super/subscripts are written in markdown (default 'unicode', falling back to html tags) */
  scripts?: ScriptStyle;
  /** keep rotated text (e.g. arXiv side banners) as trailing paragraphs (default false: dropped) */
  keepRotated?: boolean;
  /** escape markdown metacharacters in the text (default true) */
  escape?: boolean;
}

// ------------------------------------------------------------------ geometry helpers

const baselineOf = (it: TextItem) => it.y + it.h * 0.8;
const right = (it: TextItem) => it.x + it.w;
const bottom = (it: TextItem) => it.y + it.h;
const nonSpaceLen = (s: string) => s.replace(/\s+/g, '').length;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Character-weighted median font size: a robust estimate of the body text size. */
export function estimateBodyFontSize(items: TextItem[]): number {
  const buckets = new Map<number, number>();
  let total = 0;
  for (const it of items) {
    const n = nonSpaceLen(it.str);
    if (!n || !(it.fontSize > 0)) continue;
    const k = Math.round(it.fontSize * 2) / 2;
    buckets.set(k, (buckets.get(k) ?? 0) + n);
    total += n;
  }
  if (!total) return 10;
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const [size, n] of sorted) {
    acc += n;
    if (acc >= total / 2) return size;
  }
  return sorted[sorted.length - 1][0];
}

function isRotated(it: TextItem): boolean {
  const a = it.angle ?? 0;
  const norm = ((a % 360) + 360) % 360;
  return Math.min(norm, 360 - norm) > 10;
}

function cleanItems(items: TextItem[], keepRotated: boolean): { main: TextItem[]; rotated: TextItem[] } {
  const main: TextItem[] = [];
  const rotated: TextItem[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    if (!(it.w >= 0) || !(it.h > 0) || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    if (isRotated(it)) {
      if (keepRotated) rotated.push(it);
      continue;
    }
    main.push(it);
  }
  return { main, rotated };
}

// ------------------------------------------------------------------ layout: bands & gutters

interface Interval {
  a: number;
  b: number;
}

interface Ctx {
  body: number;
  gutterMin: number;
}

function mergeIntervals(ivs: Interval[], joinGap = 0): Interval[] {
  if (!ivs.length) return [];
  const s = [...ivs].sort((p, q) => p.a - q.a);
  const out: Interval[] = [{ ...s[0] }];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i].a <= last.b + joinGap) last.b = Math.max(last.b, s[i].b);
    else out.push({ ...s[i] });
  }
  return out;
}

/** Split items into horizontal bands separated by full-width vertical whitespace. */
function splitBands(items: TextItem[], body: number): TextItem[][] {
  // use the "core" of each glyph box so tight leading still leaves gaps; small
  // (script) text keeps its full box so it stays attached to its line
  const core = (it: TextItem): [number, number] =>
    it.fontSize < body * 0.88 ? [it.y, it.y + it.h] : [it.y + it.h * 0.15, it.y + it.h * 0.88];
  const sorted = [...items].sort((p, q) => core(p)[0] - core(q)[0]);
  const bands: TextItem[][] = [];
  let cur: TextItem[] = [];
  let curBottom = -Infinity;
  for (const it of sorted) {
    const [top, bot] = core(it);
    if (cur.length && top > curBottom) {
      bands.push(cur);
      cur = [];
      curBottom = -Infinity;
    }
    cur.push(it);
    curBottom = Math.max(curBottom, bot);
  }
  if (cur.length) bands.push(cur);
  return bands;
}

interface BandInfo {
  items: TextItem[];
  ivs: Interval[];
  x0: number;
  x1: number;
  /** candidate gutters inside the band (gaps ≥ gutterMin) */
  gaps: Interval[];
}

function bandInfo(items: TextItem[], ctx: Ctx): BandInfo {
  const ivs = mergeIntervals(
    items.map((it) => ({ a: it.x, b: right(it) })),
    Math.min(ctx.gutterMin * 0.5, ctx.body * 0.4),
  );
  const gaps: Interval[] = [];
  for (let i = 1; i < ivs.length; i++) {
    const g = { a: ivs[i - 1].b, b: ivs[i].a };
    if (g.b - g.a >= ctx.gutterMin) gaps.push(g);
  }
  return { items, ivs, x0: ivs[0]?.a ?? 0, x1: ivs[ivs.length - 1]?.b ?? 0, gaps };
}

/**
 * Narrow gutter g by the band's intervals; returns null when the band crosses it.
 * Intervals starting left of the gutter are left-column content (they may push its
 * left edge), intervals ending right of it are right-column content; anything
 * floating strictly inside the gutter, or spanning it, breaks the column block.
 */
function fitGutter(g: Interval, band: BandInfo, ctx: Ctx): Interval | null {
  let { a, b } = g;
  const tol = 1;
  for (const iv of band.ivs) {
    if (iv.b <= a || iv.a >= b) continue;
    if (iv.a <= a + tol) a = Math.max(a, iv.b);
    else if (iv.b >= b - tol) {
      // right-column lines start at the column edge; one starting far left of it is a float
      if (b - iv.a > ctx.body * 2.5) return null;
      b = Math.min(b, iv.a);
    } else return null;
    if (b - a < ctx.gutterMin * 0.6) return null;
  }
  return { a, b };
}

function pickGutter(band: BandInfo): Interval | null {
  if (!band.gaps.length) return null;
  const centre = (band.x0 + band.x1) / 2;
  // prefer wide gaps near the middle of the band
  let best: Interval | null = null;
  let bestScore = -Infinity;
  for (const g of band.gaps) {
    const w = g.b - g.a;
    const off = Math.abs((g.a + g.b) / 2 - centre) / Math.max(1, band.x1 - band.x0);
    const score = w * (1 - off);
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

interface Block {
  items: TextItem[];
  gutter: Interval | null;
  bands: BandInfo[];
}

/** Table-like blocks (short, row-aligned cells) are read row-wise, not column-wise. */
function isTableLike(block: Block): boolean {
  if (!block.gutter || block.bands.length < 2) return false;
  const mid = (block.gutter.a + block.gutter.b) / 2;
  let both = 0;
  const leftChars: number[] = [];
  const rightChars: number[] = [];
  for (const band of block.bands) {
    let l = 0;
    let r = 0;
    for (const it of band.items) {
      if (it.x + it.w / 2 < mid) l += nonSpaceLen(it.str);
      else r += nonSpaceLen(it.str);
    }
    if (l && r) both++;
    if (l) leftChars.push(l);
    if (r) rightChars.push(r);
  }
  return both / block.bands.length >= 0.8 && median(leftChars) <= 18 && median(rightChars) <= 18;
}

/** Ordered list of single-column leaf blocks. */
function layoutBlocks(items: TextItem[], ctx: Ctx, depth = 0): TextItem[][] {
  if (items.length <= 1 || depth > 8) return [items];
  const infos = splitBands(items, ctx.body).map((b) => bandInfo(b, ctx));
  const regionX0 = Math.min(...infos.map((b) => b.x0));
  const regionX1 = Math.max(...infos.map((b) => b.x1));
  const regionW = Math.max(1, regionX1 - regionX0);
  const ambiguous = (b: BandInfo) => !b.gaps.length && b.x1 - b.x0 < regionW * 0.55;

  const blocks: Block[] = [];
  let cur: Block | null = null;
  const open = (band: BandInfo, gutter: Interval | null) => {
    cur = { items: [...band.items], gutter, bands: [band] };
    blocks.push(cur);
  };
  for (let i = 0; i < infos.length; i++) {
    const band = infos[i];
    const c = cur as Block | null;
    if (c && c.gutter) {
      const g = fitGutter(c.gutter, band, ctx);
      if (g) {
        c.gutter = g;
        c.items.push(...band.items);
        c.bands.push(band);
        continue;
      }
      open(band, pickGutter(band));
      continue;
    }
    // current block is single-column (or none)
    if (ambiguous(band)) {
      // look ahead: narrow bands just above a multi-column block belong to it
      let j = i;
      while (j < infos.length && ambiguous(infos[j])) j++;
      const next = infos[j];
      let g = next ? pickGutter(next) : null;
      // narrow the gutter over the multi-column block that follows
      for (let k = j + 1; g && k < infos.length; k++) {
        const ng = fitGutter(g, infos[k], ctx);
        if (!ng) break;
        g = ng;
      }
      if (g && infos.slice(i, j).every((b) => fitGutter(g!, b, ctx))) {
        let gg: Interval | null = g;
        const nb: Block = { items: [], gutter: g, bands: [] };
        for (let k = i; k <= j; k++) {
          gg = gg ? fitGutter(gg, infos[k], ctx) : null;
          nb.items.push(...infos[k].items);
          nb.bands.push(infos[k]);
        }
        nb.gutter = gg ?? g;
        blocks.push(nb);
        cur = nb;
        i = j;
        continue;
      }
    }
    const g = pickGutter(band);
    if (g) open(band, g);
    else if (c && !c.gutter) {
      c.items.push(...band.items);
      c.bands.push(band);
    } else open(band, null);
  }

  const out: TextItem[][] = [];
  for (const b of blocks) {
    if (!b.gutter || isTableLike(b)) {
      out.push(b.items);
      continue;
    }
    const mid = (b.gutter.a + b.gutter.b) / 2;
    const left: TextItem[] = [];
    const rightSide: TextItem[] = [];
    for (const it of b.items) (it.x + it.w / 2 < mid ? left : rightSide).push(it);
    if (!left.length || !rightSide.length) {
      out.push(b.items);
      continue;
    }
    out.push(...layoutBlocks(left, ctx, depth + 1), ...layoutBlocks(rightSide, ctx, depth + 1));
  }
  return out;
}

// ------------------------------------------------------------------ lines

type Level = 0 | 1 | -1; // 1 = superscript, -1 = subscript

interface Token {
  text: string;
  level: Level;
  bold?: boolean;
  italic?: boolean;
}

interface Line {
  items: TextItem[];
  tokens: Token[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  fs: number;
  /** plain text (scripts inlined) */
  plain: string;
}

function groupLines(items: TextItem[]): TextItem[][] {
  // Large text first establishes the lines; small (script) text then attaches
  // to the line it overlaps most.
  const sorted = [...items].sort((p, q) => q.fontSize - p.fontSize || baselineOf(p) - baselineOf(q) || p.x - q.x);
  const lines: { items: TextItem[]; top: number; bottom: number }[] = [];
  for (const it of sorted) {
    let target: (typeof lines)[number] | undefined;
    let bestScore = 0;
    for (const ln of lines) {
      const ov = Math.min(ln.bottom, bottom(it)) - Math.max(ln.top, it.y);
      if (ov <= 0) continue;
      const lnH = ln.bottom - ln.top;
      const minH = Math.min(lnH, it.h);
      const scriptLike = minH < Math.max(lnH, it.h) * 0.88;
      const score = ov / minH;
      if (score >= (scriptLike ? 0.25 : 0.5) && score > bestScore) {
        bestScore = score;
        target = ln;
      }
    }
    if (target) {
      target.items.push(it);
      target.top = Math.min(target.top, it.y);
      target.bottom = Math.max(target.bottom, bottom(it));
    } else lines.push({ items: [it], top: it.y, bottom: bottom(it) });
  }
  const med = (l: { items: TextItem[] }) => median(l.items.map(baselineOf));
  return lines.sort((a, b) => med(a) - med(b)).map((l) => l.items);
}

function buildLine(items: TextItem[]): Line {
  const sorted = [...items].sort((p, q) => p.x - q.x || q.y - p.y);
  // dominant size by character count
  const weights = new Map<number, number>();
  for (const it of sorted) {
    const k = Math.round(it.fontSize * 2) / 2;
    weights.set(k, (weights.get(k) ?? 0) + Math.max(1, nonSpaceLen(it.str)));
  }
  let fs = sorted[0].fontSize;
  let best = -1;
  for (const [k, w] of weights) if (w > best || (w === best && k > fs)) [fs, best] = [k, w];
  const domBaselines = sorted.filter((it) => Math.abs(it.fontSize - fs) <= fs * 0.1).map(baselineOf);
  const base = median(domBaselines.length ? domBaselines : sorted.map(baselineOf));

  const tokens: Token[] = [];
  let prev: TextItem | null = null;
  for (const it of sorted) {
    // drop fake-bold duplicates (same text drawn twice with a tiny offset)
    if (prev && prev.str === it.str && Math.abs(prev.x - it.x) < it.fontSize * 0.3 && Math.abs(prev.y - it.y) < it.fontSize * 0.3) continue;
    let level: Level = 0;
    const b = baselineOf(it);
    if (it.fontSize < fs * 0.88) {
      if (b < base - fs * 0.18) level = 1;
      else if (b > base + fs * 0.1) level = -1;
    }
    let text = it.str;
    if (prev) {
      const gap = it.x - right(prev);
      const space = gap > Math.min(prev.fontSize, it.fontSize) * 0.15;
      const last = tokens[tokens.length - 1];
      if (space && last && !/\s$/.test(last.text) && !/^\s/.test(text) && level === 0 && last.level === 0) {
        last.text += ' ';
      } else if (space && level === 0 && last && last.level !== 0) text = ' ' + text;
    }
    const last = tokens[tokens.length - 1];
    if (last && last.level === level && last.bold === it.bold && last.italic === it.italic) last.text += text;
    else tokens.push({ text, level, bold: it.bold, italic: it.italic });
    prev = it;
  }
  for (const t of tokens) t.text = t.text.replace(/\s+/g, ' ');
  if (tokens.length) {
    tokens[0].text = tokens[0].text.replace(/^\s+/, '');
    tokens[tokens.length - 1].text = tokens[tokens.length - 1].text.replace(/\s+$/, '');
  }
  return {
    items: sorted,
    tokens: tokens.filter((t) => t.text),
    x0: Math.min(...sorted.map((i) => i.x)),
    x1: Math.max(...sorted.map(right)),
    top: Math.min(...sorted.map((i) => i.y)),
    bottom: Math.max(...sorted.map(bottom)),
    baseline: base,
    fs,
    plain: tokens.map((t) => t.text).join(''),
  };
}

// ------------------------------------------------------------------ paragraphs

type ParaKind = 'p' | 'h' | 'li';

interface Para {
  kind: ParaKind;
  lines: Line[];
  /** heading level 1..3 */
  hLevel?: number;
  /** list marker as found ("•", "3.", "(a)") and nesting level */
  marker?: string;
  ordered?: boolean;
  indent?: number;
  /** x where list item text starts (for continuation lines) */
  textX?: number;
}

const BULLET_RE = /^\s*([•◦▪▫‣⁃●○■□►▶✓✔◆◇∙·*]|[-–—](?=\s))\s*/;
const NUMBER_RE = /^\s*(\(?(?:\d{1,3}|[a-z]|[ivx]{1,5})[.)])\s+(?=\S)/i;

function listMarker(text: string): { marker: string; ordered: boolean; rest: string } | null {
  let m = BULLET_RE.exec(text);
  if (m && text.length > m[0].length) return { marker: m[1], ordered: false, rest: text.slice(m[0].length) };
  m = NUMBER_RE.exec(text);
  if (m) {
    const mk = m[1];
    // "e.g." / "i.e." / initials like "J. Smith" should not be list markers
    if (/^[a-z]\.$/i.test(mk) && /^[A-Z][a-z]/.test(text.slice(m[0].length)) && /^[A-Z]\.$/.test(mk)) return null;
    return { marker: mk, ordered: /^\(?\d/.test(mk), rest: text.slice(m[0].length) };
  }
  return null;
}

function headingLevel(fs: number, body: number): number {
  const r = fs / body;
  if (r >= 1.5) return 1;
  if (r >= 1.15) return 2;
  return 0;
}

function buildParas(lines: Line[], ctx: Ctx, opts: Required<Pick<ExtractOptions, 'headings'>>): Para[] {
  if (!lines.length) return [];
  const bodyLines = lines.filter((l) => Math.abs(l.fs - ctx.body) <= ctx.body * 0.15);
  const ref = bodyLines.length ? bodyLines : lines;
  const blockLeft = median(ref.map((l) => l.x0).sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(ref.length / 2))));
  const blockRight = Math.max(...ref.map((l) => l.x1));
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].baseline - lines[i - 1].baseline;
    if (d > 0 && Math.abs(lines[i].fs - lines[i - 1].fs) <= lines[i].fs * 0.1) deltas.push(d / lines[i].fs);
  }
  const leadRatio = deltas.length ? Math.min(median(deltas), 2.2) : 1.2;

  const paras: Para[] = [];
  let cur: Para | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const hl = opts.headings && ln.plain.length <= 160 && /\p{L}/u.test(ln.plain) ? headingLevel(ln.fs, ctx.body) : 0;
    const boldHeading =
      opts.headings && !hl && ln.tokens.length > 0 && ln.tokens.every((t) => t.bold) && ln.plain.length <= 80 && !/[.,;:]$/.test(ln.plain);
    const lm = hl ? null : listMarker(ln.plain);
    const prev = i > 0 ? lines[i - 1] : null;
    let brk = !cur;
    if (cur && prev) {
      const fs = Math.max(ln.fs, prev.fs);
      const gap = ln.baseline - prev.baseline;
      const prevHeading = cur.kind === 'h';
      if (hl || boldHeading) {
        brk = !(prevHeading && cur.hLevel === (hl || 3) && Math.abs(prev.fs - ln.fs) <= ln.fs * 0.1 && gap <= fs * 1.9);
      } else if (prevHeading) brk = true;
      else if (Math.abs(ln.fs - prev.fs) > Math.max(ln.fs, prev.fs) * 0.15) brk = true;
      else if (gap > leadRatio * fs * 1.4 + fs * 0.1) brk = true;
      else if (gap < -fs) brk = true; // went back up: new block
      else if (lm) brk = true;
      else if (/^\[\d{1,3}\]\s/.test(ln.plain)) brk = true;
      else if (cur.kind === 'li') {
        brk = ln.x0 < (cur.textX ?? blockLeft) - fs * 0.6;
        if (!brk && /[.!?:]$/.test(prev.plain) && prev.x1 < blockRight - fs * 3) brk = true;
      } else {
        const indented = ln.x0 - blockLeft > fs * 0.8;
        const prevIndented = prev.x0 - blockLeft > fs * 0.8;
        const centred = Math.abs(ln.x0 - blockLeft - (blockRight - ln.x1)) < fs * 0.5 && ln.x0 - blockLeft > fs * 2;
        if (indented && !prevIndented && !centred && ln.x0 - blockLeft < fs * 6) brk = true;
        else if (/[.!?:]["”’)]?$/.test(prev.plain) && prev.x1 < blockRight - fs * 2.5) brk = true;
      }
    }
    if (brk) {
      if (hl || boldHeading) cur = { kind: 'h', lines: [ln], hLevel: hl || 3 };
      else if (lm) {
        const firstItem = ln.items[0];
        const textX = ln.items.length > 1 && firstItem.str.trim().length <= 3 ? ln.items[1].x : ln.x0 + ln.fs * 1.2;
        cur = {
          kind: 'li',
          lines: [ln],
          marker: lm.marker,
          ordered: lm.ordered,
          indent: Math.max(0, Math.round((ln.x0 - blockLeft) / (ln.fs * 1.5))),
          textX,
        };
      } else cur = { kind: 'p', lines: [ln] };
      paras.push(cur);
    } else cur!.lines.push(ln);
  }
  return paras;
}

// ------------------------------------------------------------------ joining & rendering

const SUP_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', '*': '*', '†': '†', '‡': '‡', ',': ',',
};
const SUB_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ', i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ',
};

function mapAll(s: string, map: Record<string, string>): string | null {
  let out = '';
  for (const ch of s) {
    const m = map[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_$])/g, '\\$1').replace(/\[\[/g, '\\[\\[');
}

function renderTokens(tokens: Token[], style: ScriptStyle, escape: boolean): string {
  let out = '';
  for (const t of tokens) {
    const raw = t.text;
    let txt = escape ? escapeMd(raw) : raw;
    if (t.level !== 0 && style !== 'none') {
      const trimmed = raw.trim();
      if (style === 'latex') txt = `$${t.level > 0 ? '^' : '_'}{${unicodeMathToLatex(trimmed)}}$`;
      else {
        const mapped = style === 'unicode' ? mapAll(trimmed, t.level > 0 ? SUP_MAP : SUB_MAP) : null;
        const inner = escape ? escapeMd(trimmed) : trimmed;
        txt = mapped ?? (t.level > 0 ? `<sup>${inner}</sup>` : `<sub>${inner}</sub>`);
      }
    }
    if (escape && t.level === 0 && txt.trim()) {
      const lead = /^\s*/.exec(txt)![0];
      const trail = /\s*$/.exec(txt)![0];
      const core = txt.trim();
      if (t.bold && t.italic) txt = `${lead}***${core}***${trail}`;
      else if (t.bold) txt = `${lead}**${core}**${trail}`;
      else if (t.italic) txt = `${lead}*${core}*${trail}`;
    }
    out += txt;
  }
  return out;
}

/** Joins line strings with de-hyphenation. */
export function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    if (!out) {
      out = s;
      continue;
    }
    if (/­$/.test(out)) {
      out = out.slice(0, -1) + s;
      continue;
    }
    const m = /([\p{L}]*)([-‐])$/u.exec(out);
    if (m && m[1].length > 0) {
      const wordStart = out.length - m[0].length;
      const before = out.slice(Math.max(0, wordStart - 1), wordStart);
      const compound = before === '-' || before === '‐';
      if (/^\p{Ll}/u.test(s) && !compound && /\p{Ll}$/u.test(m[1])) {
        out = out.slice(0, -1) + s; // "infor-" + "mation"
      } else {
        out += s; // keep the hyphen: "state-of-the-" + "art", "COVID-" + "19"
      }
      continue;
    }
    out += ' ' + s;
  }
  return out;
}

function paraText(p: Para, style: ScriptStyle, escape: boolean): string {
  const lines = p.lines.map((l) => renderTokens(l.tokens, style, escape));
  if (p.kind === 'li' && lines.length) {
    const lm = listMarker(p.lines[0].plain);
    if (lm) {
      // strip the marker from the rendered first line
      const renderedMarker = escape ? escapeMd(lm.marker) : lm.marker;
      const idx = lines[0].indexOf(renderedMarker);
      if (idx >= 0) lines[0] = lines[0].slice(idx + renderedMarker.length).trimStart();
    }
  }
  return joinLines(lines);
}

function escapeParagraphStart(s: string): string {
  return s.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, '\\$1');
}

// ------------------------------------------------------------------ public API

function analyse(items: TextItem[], opts: ExtractOptions) {
  const { main, rotated } = cleanItems(items, !!opts.keepRotated);
  const body = opts.bodyFontSize && opts.bodyFontSize > 0 ? opts.bodyFontSize : estimateBodyFontSize(main);
  const ctx: Ctx = { body, gutterMin: Math.max(6, body * 0.9) };
  const blocks = main.length ? layoutBlocks(main, ctx) : [];
  const paraBlocks = blocks.map((b) => {
    const lines = groupLines(b).map(buildLine).filter((l) => l.tokens.length);
    return buildParas(lines, ctx, { headings: opts.headings !== false });
  });
  const rotatedParas: Para[] = rotated.length
    ? [{ kind: 'p', lines: groupLines(rotated.map((r) => ({ ...r, angle: 0 }))).map(buildLine) }]
    : [];
  return { paras: [...paraBlocks.flat(), ...rotatedParas], ctx };
}

/** Reading-order Markdown for a set of items (a page, or a lassoed selection). */
export function itemsToMarkdown(items: TextItem[], opts: ExtractOptions = {}): string {
  const { paras } = analyse(items, opts);
  const style = opts.scripts ?? 'unicode';
  const escape = opts.escape !== false;
  const out: string[] = [];
  let prevKind: ParaKind | null = null;
  for (const p of paras) {
    let text = paraText(p, style, escape);
    if (!text) continue;
    let block: string;
    if (p.kind === 'h') block = '#'.repeat(p.hLevel ?? 2) + ' ' + text.replace(/^\*\*(.*)\*\*$/, '$1');
    else if (p.kind === 'li') {
      const indent = '  '.repeat(Math.min(p.indent ?? 0, 4));
      const mk = p.ordered ? p.marker!.replace(/[()]/g, '').replace(/\)$/, '.').replace(/(\d+)$/, '$1.') : '-';
      const lead = p.ordered ? mk : p.marker && /^[-–—•◦▪●○■□*·∙]$/.test(p.marker) ? '-' : `- ${p.marker}`;
      block = `${indent}${lead} ${text}`;
    } else {
      if (escape) text = escapeParagraphStart(text);
      block = text;
    }
    if (out.length) out.push(prevKind === 'li' && p.kind === 'li' ? '\n' : '\n\n');
    out.push(block);
    prevKind = p.kind;
  }
  return out.join('');
}

/** Plain reading-order text (no markup); paragraphs separated by blank lines. */
export function itemsToText(items: TextItem[], opts: Omit<ExtractOptions, 'escape' | 'scripts'> = {}): string {
  const { paras } = analyse(items, { ...opts, headings: false });
  return paras
    .map((p) => {
      const t = joinLines(p.lines.map((l) => renderTokens(l.tokens, 'unicode', false)));
      return p.kind === 'li' ? t : t;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Visual lines in reading order (layout-aware: columns are read one after another). */
export function itemsToLines(items: TextItem[], opts: Pick<ExtractOptions, 'bodyFontSize'> = {}): string[] {
  const { main } = cleanItems(items, false);
  if (!main.length) return [];
  const body = opts.bodyFontSize && opts.bodyFontSize > 0 ? opts.bodyFontSize : estimateBodyFontSize(main);
  const ctx: Ctx = { body, gutterMin: Math.max(6, body * 0.9) };
  return layoutBlocks(main, ctx)
    .flatMap((b) => groupLines(b).map(buildLine))
    .map((l) => renderTokens(l.tokens, 'unicode', false))
    .filter(Boolean);
}

/** LaTeX for a math selection: lines become rows, scripts become ^{}/_{}; trailing "(n)" becomes \tag{n}. */
export function itemsToLatex(items: TextItem[]): string {
  const { main } = cleanItems(items, false);
  if (!main.length) return '';
  const lines = groupLines(main).map(buildLine);
  const rows: string[] = [];
  let tag: string | null = null;
  for (const ln of lines) {
    let s = '';
    for (const t of ln.tokens) {
      if (t.level === 0) s += unicodeMathToLatex(t.text, { keepSpaces: true });
      else {
        const inner = unicodeMathToLatex(t.text.trim());
        s += `${t.level > 0 ? '^' : '_'}{${inner}}`;
      }
    }
    s = s.replace(/\s+/g, ' ').trim();
    const m = /\s*\((\d{1,3}[a-z]?)\)$/.exec(s);
    if (m) {
      tag = tag ?? m[1];
      s = s.slice(0, m.index).trim();
    }
    if (s) rows.push(s);
  }
  let out = rows.join(' \\\\\n');
  if (rows.length > 1) out = `\\begin{gathered}\n${out}\n\\end{gathered}`;
  if (tag) out += ` \\tag{${tag}}`;
  return out;
}

// ------------------------------------------------------------------ selection

export type Point = [number, number];

export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

export function polygonBounds(poly: Point[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (!poly.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Items whose centre lies inside the polygon, or whose box is covered by at
 * least `minOverlap` (sampled on a 6×3 grid). Polygon and items must share one
 * coordinate space (page points, top-left origin).
 */
export function selectItemsInPolygon(items: TextItem[], polygon: Point[], opts: { minOverlap?: number } = {}): TextItem[] {
  if (polygon.length < 3) return [];
  const minOverlap = opts.minOverlap ?? 0.5;
  const bb = polygonBounds(polygon);
  const out: TextItem[] = [];
  for (const it of items) {
    if (it.x > bb.x + bb.w || it.x + it.w < bb.x || it.y > bb.y + bb.h || it.y + it.h < bb.y) continue;
    if (pointInPolygon(it.x + it.w / 2, it.y + it.h / 2, polygon)) {
      out.push(it);
      continue;
    }
    const nx = 6;
    const ny = 3;
    let hit = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (pointInPolygon(it.x + ((i + 0.5) / nx) * it.w, it.y + ((j + 0.5) / ny) * it.h, polygon)) hit++;
      }
    }
    if (hit / (nx * ny) >= minOverlap) out.push(it);
  }
  return out;
}

// ------------------------------------------------------------------ classification

const GREEK = 'αβγδεϵζηθϑικλμνξοπϖρϱσςτυφϕχψωΓΔΘΛΞΠΣΥΦΨΩ';
const STRONG_MATH = GREEK + '∑∏∐∫∬∭∮√∛∂∇∞≤≥≠≈≡≅≃∼∝≪≫∈∉∋⊂⊃⊆⊇∪∩∀∃∄∅⇒⇐⇔→←↔↦⊕⊗⊥∥±∓×÷⋅∘⟨⟩⌊⌋⌈⌉ℝℕℤℚℂℓℏ′″⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₓᵢⱼ∧∨¬';
const STRONG_SET = new Set(Array.from(STRONG_MATH));
const MATH_WORDS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'arg', 'mod', 'argmax', 'argmin', 'sinh', 'cosh', 'tanh', 'where', 'for', 'and', 'if']);

/** Heuristic: does this string read as a formula rather than prose? */
export function looksLikeMath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/\\[a-zA-Z]{2,}|\$[^$]+\$/.test(t)) return true;
  let strong = 0;
  let ops = 0;
  for (const ch of t) {
    if (STRONG_SET.has(ch)) strong++;
    else if ('=+−-*/<>^_|'.includes(ch)) ops++;
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  const longWords = (t.match(/\p{L}{4,}/gu) ?? []).filter((w) => !MATH_WORDS.has(w.toLowerCase()) && !/^[A-Z]?[α-ω]+$/.test(w));
  const singles = (t.match(/(?:^|[^\p{L}])[\p{L}](?=$|[^\p{L}])/gu) ?? []).length;
  const digits = (t.match(/\d/g) ?? []).length;
  const allowedWords = Math.max(1, Math.floor(tokens.length * 0.25));
  if (longWords.length > allowedWords) return false;
  if (strong >= 1) return true;
  return ops >= 1 && singles + digits >= 2 && /[=<>^_]|[+\-*/]\s*\w/.test(t);
}

/**
 * Classifies a lasso selection.
 * @param regionArea area of the selection in the same units as the items (pt²)
 */
export function classifySelection(items: TextItem[], regionArea: number): 'text' | 'math' | 'figure' {
  const { main } = cleanItems(items, true);
  if (!main.length) return 'figure';
  let textArea = 0;
  let chars = 0;
  let shortItems = 0;
  for (const it of main) {
    textArea += it.w * it.h;
    const n = nonSpaceLen(it.str);
    chars += n;
    if (n <= 4) shortItems++;
  }
  const coverage = regionArea > 0 ? textArea / regionArea : 1;
  const avgLen = chars / main.length;
  if (coverage < 0.03) return 'figure';
  if (coverage < 0.12 && avgLen < 6 && shortItems / main.length > 0.6) return 'figure';

  const lines = groupLines(main).map(buildLine);
  const text = lines.map((l) => l.plain).join('\n');
  let strong = 0;
  let nonSpace = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (STRONG_SET.has(ch) || '=+−<>^|'.includes(ch)) strong++;
  }
  const words = (text.match(/\p{L}{4,}/gu) ?? []).filter((w) => !MATH_WORDS.has(w.toLowerCase())).length;
  const tokens = text.split(/\s+/).filter(Boolean).length || 1;
  const wordRatio = words / tokens;
  const mathLines = lines.filter((l) => looksLikeMath(l.plain)).length;
  const scriptTokens = lines.reduce((n, l) => n + l.tokens.filter((t) => t.level !== 0).length, 0);
  const italicSingles = main.filter((it) => /^\p{L}$/u.test(it.str.trim())).length;
  const symRatio = strong / Math.max(1, nonSpace);
  if (mathLines / lines.length >= 0.6 && wordRatio < 0.5) return 'math';
  if (symRatio >= 0.08 && wordRatio < 0.4) return 'math';
  if ((scriptTokens + italicSingles) / main.length >= 0.3 && wordRatio < 0.35 && symRatio > 0.02) return 'math';
  return 'text';
}

export interface SemanticSelection {
  kind: 'text' | 'math' | 'figure';
  /** markdown for text, `$$…$$` for math, '' for figures (crop the page image instead) */
  markdown: string;
  latex?: string;
  text: string;
  items: TextItem[];
  /** selection bounds in page points */
  bounds: { x: number; y: number; w: number; h: number };
}

/**
 * One-shot "Lasso & Drop": select, classify, convert.
 * @param pageItems all items of the page (used for the body font size too)
 */
export function extractSelection(pageItems: TextItem[], polygon: Point[], opts: ExtractOptions = {}): SemanticSelection {
  const items = selectItemsInPolygon(pageItems, polygon);
  const bounds = polygonBounds(polygon);
  const kind = classifySelection(items, polygonArea(polygon));
  const bodyFontSize = opts.bodyFontSize ?? estimateBodyFontSize(pageItems);
  const text = itemsToText(items, { bodyFontSize });
  if (kind === 'math') {
    const latex = itemsToLatex(items);
    return { kind, latex, markdown: `$$\n${latex}\n$$`, text, items, bounds };
  }
  if (kind === 'figure') return { kind, markdown: '', text, items, bounds };
  return { kind, markdown: itemsToMarkdown(items, { ...opts, bodyFontSize }), text, items, bounds };
}

// ------------------------------------------------------------------ unicode → LaTeX

const LATEX_MAP: Record<string, string> = {
  // Greek lower
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ϵ: '\\epsilon', ε: '\\varepsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', µ: '\\mu', ν: '\\nu', ξ: '\\xi',
  ο: 'o', π: '\\pi', ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon',
  φ: '\\varphi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  // Greek upper
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon',
  Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
  // big operators & calculus
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '∂': '\\partial', '∇': '\\nabla', '∞': '\\infty',
  // binary operators
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '∘': '\\circ', '∗': '\\ast',
  '−': '-', '–': '-', '⊕': '\\oplus', '⊗': '\\otimes', '⊙': '\\odot', '∧': '\\land', '∨': '\\lor', '¬': '\\neg',
  '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  // relations
  '≤': '\\leq', '⩽': '\\leq', '≥': '\\geq', '⩾': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim',
  '≃': '\\simeq', '≅': '\\cong', '∝': '\\propto', '≪': '\\ll', '≫': '\\gg', '≺': '\\prec', '≻': '\\succ',
  '⪯': '\\preceq', '⪰': '\\succeq', '⊥': '\\perp', '∥': '\\parallel', '∣': '\\mid', '≔': ':=', '≜': '\\triangleq',
  // arrows
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow', '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow', '⟶': '\\longrightarrow',
  '⟹': '\\Longrightarrow', '⟺': '\\iff', '↪': '\\hookrightarrow',
  // sets & logic
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '⊊': '\\subsetneq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
  '∄': '\\nexists', '∖': '\\setminus', '⋃': '\\bigcup', '⋂': '\\bigcap',
  ℝ: '\\mathbb{R}', ℕ: '\\mathbb{N}', ℤ: '\\mathbb{Z}', ℚ: '\\mathbb{Q}', ℂ: '\\mathbb{C}', ℙ: '\\mathbb{P}', '𝔼': '\\mathbb{E}',
  ℓ: '\\ell', ℏ: '\\hbar', ℵ: '\\aleph', '′': "'", '″': "''", '‴': "'''",
  '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '‖': '\\|',
  '°': '^{\\circ}',
  // escapes
  '%': '\\%', '#': '\\#', '&': '\\&', '{': '\\{', '}': '\\}', '~': '\\sim',
};

const FRACTIONS: Record<string, [string, string]> = {
  '½': ['1', '2'], '⅓': ['1', '3'], '⅔': ['2', '3'], '¼': ['1', '4'], '¾': ['3', '4'], '⅕': ['1', '5'], '⅖': ['2', '5'],
  '⅗': ['3', '5'], '⅘': ['4', '5'], '⅙': ['1', '6'], '⅚': ['5', '6'], '⅛': ['1', '8'], '⅜': ['3', '8'], '⅝': ['5', '8'], '⅞': ['7', '8'],
};

const SUP_REV: Record<string, string> = {};
for (const [k, v] of Object.entries(SUP_MAP)) if (v !== k && !(v in SUP_REV)) SUP_REV[v] = k === '−' ? '-' : k;
const SUB_REV: Record<string, string> = {};
for (const [k, v] of Object.entries(SUB_MAP)) if (!(v in SUB_REV)) SUB_REV[v] = k === '−' ? '-' : k;
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'arg', 'dim', 'ker', 'deg', 'gcd', 'Pr']);

/**
 * Best-effort, deterministic conversion of Unicode math to LaTeX:
 * "α² + β₁ ≤ √x" → "\alpha^{2} + \beta_{1} \leq \sqrt{x}".
 */
export function unicodeMathToLatex(s: string, opts: { keepSpaces?: boolean } = {}): string {
  const chars = Array.from(s.normalize('NFC'));
  const toks: string[] = [];
  let i = 0;
  const readOperand = (): string => {
    while (i < chars.length && chars[i] === ' ') i++;
    if (i >= chars.length) return '';
    if (chars[i] === '(') {
      let depth = 0;
      const start = i;
      for (; i < chars.length; i++) {
        if (chars[i] === '(') depth++;
        else if (chars[i] === ')' && --depth === 0) break;
      }
      const inner = chars.slice(start + 1, i).join('');
      i++;
      return unicodeMathToLatex(inner);
    }
    const start = i;
    while (i < chars.length && /[\p{L}\p{N}.]/u.test(chars[i])) i++;
    if (i === start) i++;
    return unicodeMathToLatex(chars.slice(start, i).join(''));
  };
  while (i < chars.length) {
    const ch = chars[i];
    if (ch in SUP_REV || ch in SUB_REV) {
      const rev = ch in SUP_REV ? SUP_REV : SUB_REV;
      let run = '';
      while (i < chars.length && chars[i] in rev) run += rev[chars[i++]];
      toks.push(`${rev === SUP_REV ? '^' : '_'}{${run}}`);
      continue;
    }
    if (ch === '√' || ch === '∛' || ch === '∜') {
      i++;
      const operand = readOperand();
      toks.push(ch === '√' ? `\\sqrt{${operand}}` : `\\sqrt[${ch === '∛' ? 3 : 4}]{${operand}}`);
      continue;
    }
    if (ch in FRACTIONS) {
      const [a, b] = FRACTIONS[ch];
      toks.push(`\\frac{${a}}{${b}}`);
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < chars.length && /[A-Za-z]/.test(chars[j])) j++;
      const word = chars.slice(i, j).join('');
      toks.push(FUNCS.has(word) ? '\\' + word : word);
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      toks.push(' ');
      while (i < chars.length && /\s/.test(chars[i])) i++;
      continue;
    }
    toks.push(LATEX_MAP[ch] ?? ch);
    i++;
  }
  // join with a space where a control word would swallow the next letter
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (out && /\\[A-Za-z]+$/.test(out) && /^[A-Za-z0-9]/.test(t)) out += ' ';
    out += t;
  }
  out = out.replace(/\s+/g, ' ');
  return opts.keepSpaces ? out : out.trim();
}
