/**
 * Allowlist HTML sanitizer for book content (EPUB chapters).
 *
 * The chapter XHTML is parsed with our XML parser and re-serialized from
 * scratch: only allowlisted elements/attributes are emitted, every text node and
 * attribute value is escaped, URLs are filtered through a resolver. This is safe
 * by construction and works identically in browsers, workers and tests. In a
 * real browser the result is additionally passed through DOMPurify (defence in
 * depth); see `purifyHtml`.
 */
import DOMPurify from 'dompurify';
import { type XmlElement, type XmlNode } from './xml';

const HTML_ELEMENTS = new Set(
  (
    'p div span section article aside header footer nav main figure figcaption blockquote pre code kbd samp var ' +
    'h1 h2 h3 h4 h5 h6 hr br ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col a em strong b i u s ' +
    'sub sup small big mark abbr cite q dfn time del ins ruby rt rp bdi bdo wbr img details summary center address'
  ).split(' '),
);
const SVG_ELEMENTS = new Set(
  'svg g path rect circle ellipse line polyline polygon text tspan image defs lineargradient radialgradient stop clippath desc'.split(' '),
);
const MATH_ELEMENTS = new Set(
  (
    'math mi mo mn ms mtext mrow mfrac msqrt mroot msup msub msubsup munder mover munderover mtable mtr mtd mlabeledtr ' +
    'mspace mstyle mpadded mphantom menclose merror mfenced semantics annotation mmultiscripts mprescripts none'
  ).split(' '),
);
/** Removed together with their content. */
const DROP_WITH_CONTENT = new Set(
  (
    'script style link meta iframe object embed form input button select textarea noscript template title head base ' +
    'frame frameset applet audio video source track canvas foreignobject use animate animatemotion animatetransform set ' +
    'annotation-xml mglyph malignmark dialog portal'
  ).split(' '),
);
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col']);

const COMMON_ATTRS = new Set(['id', 'title', 'lang', 'dir']);
const ELEMENT_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'headers', 'align'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'align'],
  col: ['span', 'width'],
  colgroup: ['span'],
  table: ['summary'],
  blockquote: ['cite'],
  q: ['cite'],
  time: ['datetime'],
  abbr: ['title'],
  del: ['datetime'],
  ins: ['datetime'],
  bdo: ['dir'],
  details: ['open'],
};
const SVG_ATTRS = new Set(
  (
    'viewbox d x y x1 y1 x2 y2 cx cy r rx ry points fill stroke stroke-width stroke-linecap stroke-linejoin transform ' +
    'preserveaspectratio width height font-size font-family font-weight text-anchor opacity fill-opacity stroke-opacity ' +
    'offset stop-color gradientunits clip-path fill-rule version'
  ).split(' '),
);
const MATH_ATTRS = new Set(
  (
    'mathvariant display displaystyle fence stretchy separator separators lspace rspace linethickness accent accentunder ' +
    'columnalign rowalign columnspan rowspan columnlines rowlines frame notation open close encoding scriptlevel ' +
    'mathsize mathcolor largeop movablelimits symmetric width height depth voffset'
  ).split(' '),
);

export interface SanitizeContext {
  /**
   * Maps a URL found in the document to its safe replacement, or null to drop it.
   * kind: 'img' (img src / svg image href) or 'link' (a href).
   */
  resolveUrl(kind: 'img' | 'link', value: string): string | null;
  /** prefix applied to every id (and matching internal fragment links) */
  idPrefix?: string;
  /** extra attributes to put on links, given their resolved href */
  linkAttrs?(value: string): Record<string, string>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Ns = 'html' | 'svg' | 'math';

function nsOf(local: string, parentNs: Ns): Ns | null {
  const l = local.toLowerCase();
  if (l === 'svg') return 'svg';
  if (l === 'math') return 'math';
  if (parentNs === 'svg') return SVG_ELEMENTS.has(l) ? 'svg' : null;
  if (parentNs === 'math') return MATH_ELEMENTS.has(l) ? 'math' : null;
  return HTML_ELEMENTS.has(l) ? 'html' : null;
}

function serializeChildren(el: XmlElement, ns: Ns, ctx: SanitizeContext, out: string[], inPre: boolean) {
  for (const c of el.children) serializeNode(c, ns, ctx, out, inPre);
}

function serializeNode(node: XmlNode, parentNs: Ns, ctx: SanitizeContext, out: string[], inPre: boolean) {
  if (typeof node === 'string') {
    out.push(esc(inPre ? node : node.replace(/[ \t\r\n]+/g, ' ')));
    return;
  }
  const local = node.local.toLowerCase();
  if (DROP_WITH_CONTENT.has(local)) return;
  const ns = nsOf(node.local, parentNs);
  if (!ns) {
    // unknown wrapper (html/body/epub:switch…): keep the children
    serializeChildren(node, parentNs, ctx, out, inPre);
    return;
  }
  const tag = ns === 'html' ? local : node.local; // keep camelCase for SVG (viewBox, linearGradient…)
  const attrs: string[] = [];
  const allowed = ELEMENT_ATTRS[local];
  for (const [rawName, value] of Object.entries(node.attrs)) {
    const name = rawName.toLowerCase();
    if (name.startsWith('on') || name === 'style' || name === 'class') continue;
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      if (ns !== 'html' && (local === 'svg' || local === 'math')) attrs.push(`${rawName}="${escAttr(value)}"`);
      continue;
    }
    if (name === 'id') {
      attrs.push(`id="${escAttr((ctx.idPrefix ?? '') + value)}"`);
      continue;
    }
    if (name === 'xml:lang') {
      attrs.push(`lang="${escAttr(value)}"`);
      continue;
    }
    if (name === 'epub:type') {
      attrs.push(`data-epub-type="${escAttr(value)}"`);
      continue;
    }
    if (ns === 'html') {
      if (name === 'src' && local === 'img') {
        const u = ctx.resolveUrl('img', value);
        if (u) attrs.push(`src="${escAttr(u)}"`);
        continue;
      }
      if (name === 'href' && local === 'a') {
        const u = ctx.resolveUrl('link', value);
        if (u) {
          attrs.push(`href="${escAttr(u)}"`);
          const extra = ctx.linkAttrs?.(value);
          if (extra) for (const [k, v] of Object.entries(extra)) attrs.push(`${k}="${escAttr(v)}"`);
        }
        continue;
      }
      if (COMMON_ATTRS.has(name) || allowed?.includes(name)) attrs.push(`${name}="${escAttr(value)}"`);
      continue;
    }
    if (ns === 'svg') {
      if ((name === 'href' || name === 'xlink:href') && local === 'image') {
        const u = ctx.resolveUrl('img', value);
        if (u) attrs.push(`href="${escAttr(u)}"`);
        continue;
      }
      if (SVG_ATTRS.has(name) || COMMON_ATTRS.has(name)) {
        if (/url\s*\(|javascript:/i.test(value) && name !== 'd') continue;
        attrs.push(`${rawName}="${escAttr(value)}"`);
      }
      continue;
    }
    if (MATH_ATTRS.has(name) || COMMON_ATTRS.has(name)) attrs.push(`${name}="${escAttr(value)}"`);
  }
  if (local === 'img' && !attrs.some((a) => a.startsWith('src='))) {
    // image we could not resolve: keep the alt text only
    const alt = node.attrs.alt;
    if (alt) out.push(`<span class="epub-missing-img">${esc(alt)}</span>`);
    return;
  }
  if (local === 'img') attrs.push('loading="lazy"', 'decoding="async"');
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (ns === 'html' && VOID.has(local)) {
    out.push(open);
    return;
  }
  out.push(open);
  if (local === 'annotation') out.push(esc(node.children.filter((c): c is string => typeof c === 'string').join('')));
  else serializeChildren(node, ns, ctx, out, inPre || local === 'pre');
  out.push(`</${tag}>`);
}

/** Serializes the children of `root` (e.g. a <body>) as sanitized HTML. */
export function sanitizeTree(root: XmlElement, ctx: SanitizeContext): string {
  const out: string[] = [];
  serializeChildren(root, 'html', ctx, out, false);
  return out.join('').replace(/^\s+|\s+$/g, '');
}

// ------------------------------------------------------------------ DOMPurify pass (browsers)

let purifier: ReturnType<typeof DOMPurify> | null | undefined;

function getPurifier(): ReturnType<typeof DOMPurify> | null {
  if (purifier !== undefined) return purifier;
  purifier = null;
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const p = DOMPurify(window);
    if (!p.isSupported) return null;
    // self-test: some DOM shims (e.g. test environments) mis-sanitize; our tree
    // sanitizer is already safe, so only use DOMPurify where it behaves.
    const probe = p.sanitize('<p id="a">x<script>1</script><img src="x" onerror="1"></p>');
    if (probe !== '<p id="a">x<img src="x"></p>') return null;
    purifier = p;
  } catch {
    purifier = null;
  }
  return purifier;
}

/** Defence-in-depth DOMPurify pass that keeps semantic tags, tables, MathML, SVG and our blob: images. */
export function purifyHtml(html: string): string {
  const p = getPurifier();
  if (!p) return html;
  return p.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ['style', 'link', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
    ADD_ATTR: ['target', 'loading', 'decoding'],
    ALLOW_DATA_ATTR: true,
    // allow blob: image URLs produced by the importer
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob):|#|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  }) as string;
}
