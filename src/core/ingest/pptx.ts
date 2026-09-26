/**
 * PPTX (Office Open XML presentation) parsing into a lightweight, renderable
 * slide model. Positions are in CSS px at 96 dpi (EMU / 9525), font sizes in pt.
 *
 * Supported (best effort): slide order via relationships, shapes with preset
 * geometry and solid/theme fills, text bodies (runs, sizes, bold/italic,
 * colour, alignment, bullets, levels, autofit scale), pictures (object URLs of
 * the media parts), group transforms, connectors, simple tables, layout/master
 * placeholder inheritance for positions/sizes/anchoring, backgrounds, theme
 * colours with lumMod/lumOff/tint/shade/alpha, and speaker notes.
 */
import JSZip from 'jszip';
import type { PptxDeck, PptxElement, PptxParagraph, PptxRun, PptxSlide } from './types';
import { attr, child, childrenNamed, elements, find, parseXml, path, prefixedAttr, textContent, type XmlElement } from './xml';
import { resolveZipPath } from './epub';

const EMU_PER_PX = 9525;
const emuToPx = (v: string | undefined) => (v ? Number(v) / EMU_PER_PX : 0);

// ------------------------------------------------------------------ colours

const DEFAULT_THEME: Record<string, string> = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: '4472C4',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '5B9BD5',
  accent6: '70AD47',
  hlink: '0563C1',
  folHlink: '954F72',
};

const PRESET_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  grey: '808080',
  orange: 'FFA500',
  purple: '800080',
  darkBlue: '00008B',
  darkRed: '8B0000',
  darkGreen: '006400',
  lightGray: 'D3D3D3',
};

interface ColorCtx {
  theme: Record<string, string>;
  /** master clrMap: bg1 → lt1, tx1 → dk1 … */
  map: Record<string, string>;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

const hex2 = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0');

/** Resolves a colour element (srgbClr, schemeClr, sysClr, prstClr) with modifiers to CSS. */
function resolveColorEl(el: XmlElement | undefined, cc: ColorCtx): string | undefined {
  if (!el) return undefined;
  let hex: string | undefined;
  switch (el.local) {
    case 'srgbClr':
      hex = attr(el, 'val');
      break;
    case 'schemeClr': {
      const v = attr(el, 'val') ?? '';
      const mapped = cc.map[v] ?? v;
      hex = cc.theme[mapped] ?? DEFAULT_THEME[mapped];
      break;
    }
    case 'sysClr':
      hex = attr(el, 'lastClr') ?? (attr(el, 'val') === 'window' ? 'FFFFFF' : '000000');
      break;
    case 'prstClr':
      hex = PRESET_COLORS[attr(el, 'val') ?? ''];
      break;
    case 'scrgbClr': {
      const pc = (k: string) => (Number(attr(el, k) ?? 0) / 100000) * 255;
      hex = hex2(pc('r')) + hex2(pc('g')) + hex2(pc('b'));
      break;
    }
    default:
      return undefined;
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  let alpha = 1;
  for (const m of elements(el)) {
    const val = Number(attr(m, 'val') ?? 0) / 100000;
    switch (m.local) {
      case 'lumMod':
      case 'lumOff': {
        const [h, s, l] = rgbToHsl(r, g, b);
        const nl = m.local === 'lumMod' ? l * val : Math.min(1, l + val);
        [r, g, b] = hslToRgb(h, s, nl);
        break;
      }
      case 'tint':
        r = r + (255 - r) * (1 - val);
        g = g + (255 - g) * (1 - val);
        b = b + (255 - b) * (1 - val);
        break;
      case 'shade':
        r *= val;
        g *= val;
        b *= val;
        break;
      case 'alpha':
        alpha = val;
        break;
    }
  }
  if (alpha < 1) return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(alpha * 1000) / 1000})`;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
}

const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr']);
const colorChild = (el: XmlElement | undefined) => elements(el).find((e) => COLOR_TAGS.has(e.local));

/** Fill of a spPr / bgPr: solid colour, first gradient stop, 'none', or undefined when unspecified. */
function resolveFill(sp: XmlElement | undefined, cc: ColorCtx): string | 'none' | undefined {
  if (!sp) return undefined;
  if (child(sp, 'noFill')) return 'none';
  const solid = child(sp, 'solidFill');
  if (solid) return resolveColorEl(colorChild(solid), cc);
  const grad = child(sp, 'gradFill');
  if (grad) {
    const stop = find(grad, 'gs');
    return resolveColorEl(colorChild(stop), cc);
  }
  return undefined;
}

// ------------------------------------------------------------------ transforms

interface Affine {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
const IDENTITY: Affine = { sx: 1, sy: 1, tx: 0, ty: 0 };

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

function readXfrm(x: XmlElement | undefined): Xfrm | undefined {
  if (!x) return undefined;
  const off = child(x, 'off');
  const ext = child(x, 'ext');
  if (!off || !ext) return undefined;
  const out: Xfrm = { x: emuToPx(attr(off, 'x')), y: emuToPx(attr(off, 'y')), w: emuToPx(attr(ext, 'cx')), h: emuToPx(attr(ext, 'cy')) };
  const rot = Number(attr(x, 'rot') ?? 0) / 60000;
  if (rot) out.rot = rot;
  return out;
}

function applyAffine(t: Affine, x: Xfrm): Xfrm {
  const out: Xfrm = { x: x.x * t.sx + t.tx, y: x.y * t.sy + t.ty, w: x.w * t.sx, h: x.h * t.sy };
  if (x.rot) out.rot = x.rot;
  return out;
}

// ------------------------------------------------------------------ parts & relationships

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

type Rels = Map<string, Rel>;

function relsPathFor(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

// ------------------------------------------------------------------ placeholders & text styles

interface PhInfo {
  xfrm?: Xfrm;
  /** lvl (1-based) → default size (pt) from the placeholder's lstStyle */
  sizes: Record<number, number>;
  anchor?: string;
  fontScale?: number;
}

interface PartInfo {
  path: string;
  doc: XmlElement;
  rels: Rels;
  byType: Map<string, PhInfo>;
  byIdx: Map<string, PhInfo>;
  bg?: string;
}

interface MasterInfo extends PartInfo {
  cc: ColorCtx;
  /** title/body/other → lvl → size pt */
  styles: Record<'title' | 'body' | 'other', Record<number, number>>;
}

function lvlSizes(lst: XmlElement | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  if (!lst) return out;
  for (let l = 1; l <= 9; l++) {
    const sz = attr(path(lst, `lvl${l}pPr`, 'defRPr'), 'sz');
    if (sz) out[l] = Number(sz) / 100;
  }
  return out;
}

function phKeyInfo(sp: XmlElement): { type?: string; idx?: string } | undefined {
  const nv = elements(sp).find((e) => e.local.startsWith('nv'));
  const ph = find(child(nv, 'nvPr') ?? nv, 'ph');
  if (!ph) return undefined;
  return { type: attr(ph, 'type'), idx: attr(ph, 'idx') };
}

function collectPlaceholders(doc: XmlElement, part: Pick<PartInfo, 'byType' | 'byIdx'>) {
  const tree = find(doc, 'spTree');
  for (const sp of elements(tree)) {
    if (sp.local !== 'sp') continue;
    const key = phKeyInfo(sp);
    if (!key) continue;
    const spPr = child(sp, 'spPr');
    const body = child(sp, 'txBody');
    const bodyPr = child(body, 'bodyPr');
    const info: PhInfo = { xfrm: readXfrm(child(spPr, 'xfrm')), sizes: lvlSizes(child(body, 'lstStyle')) };
    const anchor = attr(bodyPr, 'anchor');
    if (anchor) info.anchor = anchor;
    const fs = attr(child(bodyPr, 'normAutofit'), 'fontScale');
    if (fs) info.fontScale = Number(fs) / 100000;
    if (key.type && !part.byType.has(key.type)) part.byType.set(key.type, info);
    if (key.idx && !part.byIdx.has(key.idx)) part.byIdx.set(key.idx, info);
    if (!key.type && !key.idx && !part.byType.has('obj')) part.byType.set('obj', info);
  }
}

const TYPE_ALIASES: Record<string, string[]> = {
  ctrTitle: ['ctrTitle', 'title'],
  title: ['title', 'ctrTitle'],
  subTitle: ['subTitle', 'body'],
  obj: ['obj', 'body'],
  body: ['body', 'obj'],
};

function lookupPh(key: { type?: string; idx?: string }, layout: PartInfo | undefined, master: MasterInfo | undefined): PhInfo[] {
  const out: PhInfo[] = [];
  const types = key.type ? (TYPE_ALIASES[key.type] ?? [key.type]) : [];
  const push = (p: PhInfo | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (key.type) {
    for (const t of types) push(layout?.byType.get(t));
    for (const t of types) push(master?.byType.get(t));
    if (key.idx) {
      push(layout?.byIdx.get(key.idx));
      push(master?.byIdx.get(key.idx));
    }
  } else {
    if (key.idx) {
      push(layout?.byIdx.get(key.idx));
      push(master?.byIdx.get(key.idx));
    }
    for (const t of ['obj', 'body']) push(layout?.byType.get(t));
    push(master?.byType.get('body'));
  }
  return out;
}

function styleClass(type: string | undefined, isPh: boolean): 'title' | 'body' | 'other' {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (isPh && (!type || type === 'body' || type === 'obj' || type === 'subTitle')) return 'body';
  return 'other';
}

// ------------------------------------------------------------------ parser

export interface ParsePptxOptions {
  signal?: AbortSignal;
}

/** Parses a .pptx file. Throws readable errors for legacy/invalid files. */
export async function parsePptx(blob: Blob, opts: ParsePptxOptions = {}): Promise<PptxDeck> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer());
  } catch {
    throw new Error('This file is not a valid PowerPoint .pptx (not a zip archive). Legacy .ppt files must be exported to PPTX or PDF first.');
  }
  const readText = async (p: string) => {
    const f = zip.file(p);
    return f ? f.async('string') : null;
  };
  const readXml = async (p: string) => {
    const t = await readText(p);
    return t == null ? null : parseXml(t);
  };
  const readRels = async (part: string): Promise<Rels> => {
    const rels: Rels = new Map();
    const doc = await readXml(relsPathFor(part));
    if (!doc) return rels;
    for (const r of find(doc, 'Relationships')?.children ?? []) {
      if (typeof r === 'string' || r.local !== 'Relationship') continue;
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (!id || !target) continue;
      const external = attr(r, 'TargetMode') === 'External';
      rels.set(id, {
        type: (attr(r, 'Type') ?? '').split('/').pop() ?? '',
        target: external ? target : resolveZipPath(part, target)[0],
        external,
      });
    }
    return rels;
  };

  // locate the presentation part
  const rootRels = await readRels('');
  let presPath = [...rootRels.values()].find((r) => r.type === 'officeDocument')?.target ?? 'ppt/presentation.xml';
  presPath = presPath.replace(/^\//, '');
  const pres = await readXml(presPath);
  if (!pres) throw new Error('This file is not a PowerPoint presentation (ppt/presentation.xml is missing).');
  const presRels = await readRels(presPath);
  const sldSz = find(pres, 'sldSz');
  const width = emuToPx(attr(sldSz, 'cx')) || 960;
  const height = emuToPx(attr(sldSz, 'cy')) || 540;

  // core properties
  let title: string | undefined;
  let author: string | undefined;
  const coreRel = [...rootRels.values()].find((r) => r.type === 'core-properties');
  const core = await readXml(coreRel?.target ?? 'docProps/core.xml');
  if (core) {
    title = textContent(find(core, 'title')).trim() || undefined;
    author = textContent(find(core, 'creator')).trim() || undefined;
  }

  // object URLs for media, shared across slides
  const urls = new Map<string, string>();
  const allUrls: string[] = [];
  const mediaUrl = async (p: string): Promise<string | undefined> => {
    if (urls.has(p)) return urls.get(p);
    const f = zip.file(p);
    if (!f) return undefined;
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const type =
      { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' }[ext];
    if (!type) return undefined; // emf/wmf/tiff: not renderable in browsers
    const bytes = await f.async('uint8array');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    urls.set(p, url);
    allUrls.push(url);
    return url;
  };

  // masters & layouts (cached)
  const masters = new Map<string, Promise<MasterInfo>>();
  const layouts = new Map<string, Promise<PartInfo>>();
  const loadMaster = (p: string) => {
    let m = masters.get(p);
    if (!m) {
      m = (async () => {
        const doc = (await readXml(p)) ?? parseXml('');
        const rels = await readRels(p);
        const theme: Record<string, string> = { ...DEFAULT_THEME };
        const themeRel = [...rels.values()].find((r) => r.type === 'theme');
        const themeDoc = themeRel ? await readXml(themeRel.target) : null;
        const scheme = find(themeDoc ?? undefined, 'clrScheme');
        for (const e of elements(scheme)) {
          const c = colorChild(e);
          const v = c?.local === 'srgbClr' ? attr(c, 'val') : c?.local === 'sysClr' ? attr(c, 'lastClr') : undefined;
          if (v) theme[e.local] = v;
        }
        const clrMapEl = find(doc, 'clrMap');
        const map: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
        if (clrMapEl) for (const [k, v] of Object.entries(clrMapEl.attrs)) map[k] = v;
        const cc: ColorCtx = { theme, map };
        const tx = find(doc, 'txStyles');
        const info: MasterInfo = {
          path: p,
          doc,
          rels,
          byType: new Map(),
          byIdx: new Map(),
          cc,
          styles: {
            title: lvlSizes(child(tx, 'titleStyle')),
            body: lvlSizes(child(tx, 'bodyStyle')),
            other: lvlSizes(child(tx, 'otherStyle')),
          },
        };
        collectPlaceholders(doc, info);
        info.bg = readBackground(doc, cc);
        return info;
      })();
      masters.set(p, m);
    }
    return m;
  };
  const loadLayout = (p: string) => {
    let l = layouts.get(p);
    if (!l) {
      l = (async () => {
        const doc = (await readXml(p)) ?? parseXml('');
        const rels = await readRels(p);
        const info: PartInfo = { path: p, doc, rels, byType: new Map(), byIdx: new Map() };
        collectPlaceholders(doc, info);
        return info;
      })();
      layouts.set(p, l);
    }
    return l;
  };

  function readBackground(doc: XmlElement, cc: ColorCtx): string | undefined {
    const bg = find(find(doc, 'cSld'), 'bg');
    if (!bg) return undefined;
    const bgPr = child(bg, 'bgPr');
    if (bgPr) {
      const f = resolveFill(bgPr, cc);
      return f && f !== 'none' ? f : undefined;
    }
    const ref = child(bg, 'bgRef');
    if (ref) return resolveColorEl(colorChild(ref), cc);
    return undefined;
  }

  // slides in presentation order
  const slidePaths: string[] = [];
  for (const sid of childrenNamed(find(pres, 'sldIdLst'), 'sldId')) {
    const rid = prefixedAttr(sid, 'id');
    const rel = rid ? presRels.get(rid) : undefined;
    if (rel && !rel.external) slidePaths.push(rel.target);
  }

  const slides: PptxSlide[] = [];
  for (let si = 0; si < slidePaths.length; si++) {
    if (opts.signal?.aborted) {
      for (const u of allUrls) URL.revokeObjectURL(u);
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    const sp = slidePaths[si];
    const doc = await readXml(sp);
    if (!doc) continue;
    const rels = await readRels(sp);
    const layoutRel = [...rels.values()].find((r) => r.type === 'slideLayout');
    const layout = layoutRel ? await loadLayout(layoutRel.target) : undefined;
    const masterRel = layout ? [...layout.rels.values()].find((r) => r.type === 'slideMaster') : undefined;
    const master = masterRel ? await loadMaster(masterRel.target) : undefined;
    const cc: ColorCtx = master?.cc ?? { theme: DEFAULT_THEME, map: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' } };
    if (layout && layout.bg === undefined) layout.bg = readBackground(layout.doc, cc);

    const elementsOut: PptxElement[] = [];
    let slideTitle: string | undefined;

    const parseText = (
      txBody: XmlElement | undefined,
      phChain: PhInfo[],
      cls: 'title' | 'body' | 'other',
      bulletsByDefault: boolean,
    ): { paragraphs: PptxParagraph[]; anchor?: string } => {
      if (!txBody) return { paragraphs: [] };
      const bodyPr = child(txBody, 'bodyPr');
      const scaleAttr = attr(child(bodyPr, 'normAutofit'), 'fontScale');
      const scale = scaleAttr ? Number(scaleAttr) / 100000 : (phChain.find((p) => p.fontScale)?.fontScale ?? 1);
      const ownLst = lvlSizes(child(txBody, 'lstStyle'));
      const anchor = attr(bodyPr, 'anchor') ?? phChain.find((p) => p.anchor)?.anchor;
      const paragraphs: PptxParagraph[] = [];
      for (const p of childrenNamed(txBody, 'p')) {
        const pPr = child(p, 'pPr');
        const lvl = Number(attr(pPr, 'lvl') ?? 0);
        const L = lvl + 1;
        const defSize =
          ownLst[L] ?? phChain.map((ph) => ph.sizes[L]).find((v) => v !== undefined) ?? master?.styles[cls][L] ?? (cls === 'title' ? 44 : 18);
        const runs: PptxRun[] = [];
        for (const r of elements(p)) {
          if (r.local === 'br') {
            runs.push({ text: '\n' });
            continue;
          }
          if (r.local !== 'r' && r.local !== 'fld') continue;
          const rPr = child(r, 'rPr');
          const run: PptxRun = { text: textContent(child(r, 't')) };
          const sz = attr(rPr, 'sz');
          run.size = Math.round((sz ? Number(sz) / 100 : defSize) * scale * 10) / 10;
          if (attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true') run.bold = true;
          if (attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true') run.italic = true;
          const u = attr(rPr, 'u');
          if (u && u !== 'none') run.underline = true;
          const col = resolveColorEl(colorChild(child(rPr, 'solidFill')), cc);
          if (col) run.color = col;
          runs.push(run);
        }
        const text = runs.map((r) => r.text).join('');
        const para: PptxParagraph = { text };
        const first = runs.find((r) => r.text.trim()) ?? runs[0];
        const endSz = attr(child(p, 'endParaRPr'), 'sz');
        para.size = first?.size ?? Math.round((endSz ? Number(endSz) / 100 : defSize) * scale * 10) / 10;
        const textRuns = runs.filter((r) => r.text.trim());
        if (textRuns.length && textRuns.every((r) => r.bold)) para.bold = true;
        if (textRuns.length && textRuns.every((r) => r.italic)) para.italic = true;
        if (first?.color) para.color = first.color;
        const algn = attr(pPr, 'algn');
        const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' || algn === 'dist' ? 'justify' : algn === 'l' ? 'left' : undefined;
        if (align) para.align = align;
        if (lvl) para.level = lvl;
        const buChar = child(pPr, 'buChar');
        const buAuto = child(pPr, 'buAutoNum');
        if (child(pPr, 'buNone')) para.bullet = false;
        else if (buChar) {
          para.bullet = true;
          para.bulletChar = attr(buChar, 'char') ?? '•';
        } else if (buAuto) {
          para.bullet = true;
          para.bulletChar = attr(buAuto, 'type') ?? 'arabicPeriod';
        } else if (bulletsByDefault && text.trim()) para.bullet = true;
        if (runs.length > 1 || (runs.length === 1 && (runs[0].bold || runs[0].italic || runs[0].underline || runs[0].color))) {
          para.runs = runs;
        }
        paragraphs.push(para);
      }
      // trim trailing empty paragraphs
      while (paragraphs.length && !paragraphs[paragraphs.length - 1].text.trim()) paragraphs.pop();
      return anchor ? { paragraphs, anchor } : { paragraphs };
    };

    const walk = async (tree: XmlElement | undefined, t: Affine) => {
      for (const el of elements(tree)) {
        switch (el.local) {
          case 'sp':
          case 'cxnSp': {
            const key = phKeyInfo(el);
            const chain = key ? lookupPh(key, layout, master) : [];
            const spPr = child(el, 'spPr');
            let xf = readXfrm(child(spPr, 'xfrm'));
            if (!xf) xf = chain.find((c) => c.xfrm)?.xfrm;
            if (!xf) continue;
            const box = applyAffine(t, xf);
            const geom = attr(child(spPr, 'prstGeom'), 'prst') ?? (child(spPr, 'custGeom') ? 'custom' : 'rect');
            let fill = resolveFill(spPr, cc);
            if (fill === undefined) {
              const ref = path(el, 'style', 'fillRef');
              if (ref && attr(ref, 'idx') !== '0' && el.local === 'sp') fill = resolveColorEl(colorChild(ref), cc);
            }
            const ln = child(spPr, 'ln');
            let stroke: string | undefined;
            let strokeWidth: number | undefined;
            if (ln && !child(ln, 'noFill')) {
              stroke = resolveColorEl(colorChild(child(ln, 'solidFill')), cc);
              if (attr(ln, 'w')) strokeWidth = Math.max(0.5, emuToPx(attr(ln, 'w')));
            }
            if (!stroke && (!ln || !child(ln, 'noFill'))) {
              const ref = path(el, 'style', 'lnRef');
              if (ref && attr(ref, 'idx') !== '0') stroke = resolveColorEl(colorChild(ref), cc);
            }
            const isPh = !!key;
            const cls = styleClass(key?.type, isPh);
            const bulletsByDefault = isPh && cls === 'body' && key?.type !== 'subTitle';
            const { paragraphs, anchor } = parseText(child(el, 'txBody'), chain, cls, bulletsByDefault);
            const hasText = paragraphs.some((p) => p.text.trim());
            const fillCss = fill && fill !== 'none' ? fill : undefined;
            if (hasText) {
              const te: Extract<PptxElement, { kind: 'text' }> = { kind: 'text', x: box.x, y: box.y, w: box.w, h: box.h, paragraphs };
              if (fillCss) te.fill = fillCss;
              if (stroke) te.stroke = stroke;
              if (box.rot) te.rotation = box.rot;
              if (fillCss || stroke) te.geom = geom;
              if (anchor) te.verticalAlign = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
              if (key) te.placeholder = key.type ?? 'body';
              elementsOut.push(te);
              if (!slideTitle && (key?.type === 'title' || key?.type === 'ctrTitle')) slideTitle = paragraphs.map((p) => p.text).join(' ').trim();
            } else if (fillCss || stroke || geom === 'line' || el.local === 'cxnSp') {
              if (isPh && !fillCss && !stroke) continue; // empty placeholder
              const se: Extract<PptxElement, { kind: 'shape' }> = { kind: 'shape', x: box.x, y: box.y, w: box.w, h: box.h, geom };
              if (fillCss) se.fill = fillCss;
              if (stroke) se.stroke = stroke;
              if (strokeWidth) se.strokeWidth = strokeWidth;
              if (box.rot) se.rotation = box.rot;
              elementsOut.push(se);
            }
            break;
          }
          case 'pic': {
            const spPr = child(el, 'spPr');
            const key = phKeyInfo(el);
            let xf = readXfrm(child(spPr, 'xfrm'));
            if (!xf && key) xf = lookupPh(key, layout, master).find((c) => c.xfrm)?.xfrm;
            if (!xf) continue;
            const blip = find(child(el, 'blipFill'), 'blip');
            const rid = prefixedAttr(blip, 'embed');
            const rel = rid ? rels.get(rid) : undefined;
            if (!rel || rel.external) continue;
            const url = await mediaUrl(rel.target);
            if (!url) continue;
            const box = applyAffine(t, xf);
            const ie: Extract<PptxElement, { kind: 'image' }> = { kind: 'image', x: box.x, y: box.y, w: box.w, h: box.h, url };
            if (box.rot) ie.rotation = box.rot;
            const descr = attr(find(el, 'cNvPr'), 'descr');
            if (descr) ie.alt = descr;
            elementsOut.push(ie);
            break;
          }
          case 'grpSp': {
            const gx = child(child(el, 'grpSpPr'), 'xfrm');
            const off = readXfrm(gx);
            const chOff = child(gx, 'chOff');
            const chExt = child(gx, 'chExt');
            let inner = t;
            if (off && chOff && chExt) {
              const cw = emuToPx(attr(chExt, 'cx')) || off.w || 1;
              const ch = emuToPx(attr(chExt, 'cy')) || off.h || 1;
              const g: Affine = {
                sx: off.w / cw,
                sy: off.h / ch,
                tx: off.x - emuToPx(attr(chOff, 'x')) * (off.w / cw),
                ty: off.y - emuToPx(attr(chOff, 'y')) * (off.h / ch),
              };
              inner = { sx: t.sx * g.sx, sy: t.sy * g.sy, tx: t.sx * g.tx + t.tx, ty: t.sy * g.ty + t.ty };
            }
            await walk(el, inner);
            break;
          }
          case 'graphicFrame': {
            const tbl = find(el, 'tbl');
            const xf = readXfrm(child(el, 'xfrm'));
            if (!tbl || !xf) break;
            const box = applyAffine(t, xf);
            const paragraphs: PptxParagraph[] = childrenNamed(tbl, 'tr').map((tr) => ({
              text: childrenNamed(tr, 'tc')
                .map((tc) => textContent(child(tc, 'txBody')).replace(/\s+/g, ' ').trim())
                .join(' | '),
              size: 14,
            }));
            elementsOut.push({ kind: 'text', x: box.x, y: box.y, w: box.w, h: box.h, paragraphs });
            break;
          }
          case 'AlternateContent': {
            // prefer the fallback (plain DrawingML)
            const fb = child(el, 'Fallback') ?? child(el, 'Choice');
            if (fb) await walk(fb, t);
            break;
          }
        }
      }
    };
    await walk(find(doc, 'spTree'), IDENTITY);

    // notes
    let notes: string | undefined;
    const notesRel = [...rels.values()].find((r) => r.type === 'notesSlide');
    if (notesRel) {
      const nd = await readXml(notesRel.target);
      const body = elements(find(nd ?? undefined, 'spTree')).find((s) => s.local === 'sp' && phKeyInfo(s)?.type === 'body');
      if (body) {
        const txt = childrenNamed(child(body, 'txBody'), 'p')
          .map((p) => textContent(p).trim())
          .filter(Boolean)
          .join('\n');
        if (txt) notes = txt;
      }
    }

    const slide: PptxSlide = { index: si, elements: elementsOut };
    const bg = readBackground(doc, cc) ?? layout?.bg ?? master?.bg;
    if (bg) slide.background = bg;
    if (notes) slide.notes = notes;
    if (slideTitle) slide.title = slideTitle;
    slides.push(slide);
  }

  const deck: PptxDeck = {
    width,
    height,
    slides,
    dispose() {
      for (const u of allUrls) URL.revokeObjectURL(u);
      allUrls.length = 0;
      urls.clear();
    },
  };
  if (title) deck.title = title;
  if (author) deck.author = author;
  return deck;
}

/** Plain text of a deck (titles, bullets, notes) for search / ghost tags. */
export function deckText(deck: PptxDeck, maxChars = 20000): string {
  const parts: string[] = [];
  for (const s of deck.slides) {
    for (const e of s.elements) if (e.kind === 'text') parts.push(e.paragraphs.map((p) => p.text).join('\n'));
    if (s.notes) parts.push(s.notes);
    if (parts.join('\n').length > maxChars) break;
  }
  return parts.join('\n\n').slice(0, maxChars);
}
