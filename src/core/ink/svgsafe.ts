/**
 * Minimal allow-list sanitiser for the SVG fragments stored in `BeautifiedItem.svg`.
 * Those strings live in the CRDT and may come from peers, so they are never injected
 * verbatim: only simple geometry elements with validated attributes survive.
 */

const SHAPE_TAGS = new Set(['path', 'ellipse', 'circle', 'rect', 'line', 'polyline', 'polygon']);

const NUM = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const PAINT = /^(none|currentColor|#[0-9a-f]{3,8})$/i;

const ATTRS: Record<string, RegExp> = {
  d: /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/,
  points: /^[0-9eE.,\s+-]*$/,
  cx: NUM,
  cy: NUM,
  r: NUM,
  rx: NUM,
  ry: NUM,
  x: NUM,
  y: NUM,
  width: NUM,
  height: NUM,
  x1: NUM,
  y1: NUM,
  x2: NUM,
  y2: NUM,
  'stroke-width': NUM,
  opacity: NUM,
  'fill-opacity': NUM,
  'stroke-opacity': NUM,
  stroke: PAINT,
  fill: PAINT,
  'stroke-linecap': /^(butt|round|square)$/,
  'stroke-linejoin': /^(miter|round|bevel)$/,
  'stroke-dasharray': /^[0-9.,\s]+$/,
  transform: /^(\s*(matrix|translate|scale|rotate)\(\s*[-0-9.eE,\s]+\)\s*)+$/,
  'vector-effect': /^non-scaling-stroke$/,
};

const TAG_RE = /<\s*(\/?)\s*([a-zA-Z]+)([^<>]*?)(\/?)\s*>/g;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;

function cleanAttrs(raw: string): string {
  let out = '';
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    const value = m[2].trim();
    const re = ATTRS[name];
    if (re && re.test(value)) out += ` ${name}="${value}"`;
  }
  return out;
}

/** Returns a safe SVG fragment containing only allow-listed elements and attributes. */
export function sanitizeSvgFragment(svg: string): string {
  let out = '';
  let depth = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(svg))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosing = m[4] === '/' || /\/\s*$/.test(attrs);
    if (tag === 'g') {
      if (closing) {
        if (depth > 0) {
          out += '</g>';
          depth--;
        }
      } else if (!selfClosing) {
        out += `<g${cleanAttrs(attrs)}>`;
        depth++;
      }
      continue;
    }
    if (!closing && SHAPE_TAGS.has(tag)) out += `<${tag}${cleanAttrs(attrs)}/>`;
  }
  while (depth-- > 0) out += '</g>';
  return out;
}

/** Only `#hex` colours (or the special current-ink token) are allowed from the CRDT. */
export function safeColor(color: unknown, fallback: string): string {
  if (typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return fallback;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}
