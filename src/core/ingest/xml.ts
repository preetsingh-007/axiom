/**
 * A small, lenient, dependency-free XML parser.
 *
 * Used for OPF/NCX/nav (EPUB), OOXML parts (PPTX) and Atom feeds (arXiv). It is
 * deterministic across browsers, workers and Node (happy-dom's DOMParser has
 * patchy namespace support), and tolerant of the sloppy markup found in the wild:
 * unknown HTML entities are kept verbatim, mismatched end tags are ignored.
 *
 * Namespaces are not resolved; helpers match on the local name (prefix stripped).
 */

export interface XmlElement {
  /** qualified name as written, e.g. "p:sp" */
  name: string;
  /** local name, e.g. "sp" */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent?: XmlElement;
}

export type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  times: '×',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  szlig: 'ß',
  ccedil: 'ç',
};

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return v ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

const ATTR_RE = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Parses an XML string into a synthetic root element (name "#document"). Never throws. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', local: '#document', attrs: {}, children: [] };
  let cur = root;
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(cur, src.slice(i));
      break;
    }
    if (lt > i) pushText(cur, src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const text = src.slice(lt + 9, end < 0 ? n : end);
      if (text) cur.children.push(text);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?') {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src[lt + 1] === '!') {
      // DOCTYPE, possibly with an internal subset [...]
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      // pop to the matching ancestor; ignore stray end tags
      let e: XmlElement | undefined = cur;
      while (e && e !== root && e.name !== name) e = e.parent;
      if (e && e !== root) cur = e.parent ?? root;
      i = end < 0 ? n : end + 1;
      continue;
    }
    // start tag: find the closing '>' outside quotes
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    let inner = src.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const sp = inner.search(/[\s]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).trim();
    if (!name) {
      pushText(cur, '<');
      i = lt + 1;
      continue;
    }
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      const attrSrc = inner.slice(sp);
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(attrSrc))) {
        const v = m[2] ?? m[3] ?? m[4] ?? '';
        attrs[m[1]] = decodeEntities(v);
      }
    }
    const el: XmlElement = { name, local: localName(name), attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!selfClosing) cur = el;
    i = j + 1;
  }
  return root;
}

function pushText(el: XmlElement, raw: string) {
  if (!raw) return;
  const text = decodeEntities(raw);
  const last = el.children[el.children.length - 1];
  if (typeof last === 'string') el.children[el.children.length - 1] = last + text;
  else el.children.push(text);
}

// ------------------------------------------------------------ query helpers

export function isElement(n: XmlNode | undefined): n is XmlElement {
  return typeof n === 'object' && n !== null;
}

export function elements(el: XmlElement | undefined): XmlElement[] {
  if (!el) return [];
  const out: XmlElement[] = [];
  for (const c of el.children) if (typeof c !== 'string') out.push(c);
  return out;
}

/** First direct child with the given local name. */
export function child(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (typeof c !== 'string' && c.local === local) return c;
  return undefined;
}

export function childrenNamed(el: XmlElement | undefined, local: string): XmlElement[] {
  if (!el) return [];
  const out: XmlElement[] = [];
  for (const c of el.children) if (typeof c !== 'string' && c.local === local) out.push(c);
  return out;
}

/** Follows a path of local names through direct children. */
export function path(el: XmlElement | undefined, ...locals: string[]): XmlElement | undefined {
  let cur = el;
  for (const l of locals) {
    cur = child(cur, l);
    if (!cur) return undefined;
  }
  return cur;
}

/** First descendant (depth-first, document order) with the given local name. */
export function find(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === local) return c;
    const r = find(c, local);
    if (r) return r;
  }
  return undefined;
}

export function findAll(el: XmlElement | undefined, local: string, out: XmlElement[] = []): XmlElement[] {
  if (!el) return out;
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}

export function textContent(el: XmlNode | undefined): string {
  if (el === undefined) return '';
  if (typeof el === 'string') return el;
  let s = '';
  for (const c of el.children) s += typeof c === 'string' ? c : textContent(c);
  return s;
}

/** Attribute lookup ignoring the namespace prefix (e.g. "r:id" or "id"). */
export function attr(el: XmlElement | undefined, local: string): string | undefined {
  if (!el) return undefined;
  if (local in el.attrs) return el.attrs[local];
  for (const k in el.attrs) if (localName(k) === local) return el.attrs[k];
  return undefined;
}

/** Value of a namespace-prefixed attribute by local name (e.g. "r:id" for "id"), skipping unprefixed ones. */
export function prefixedAttr(el: XmlElement | undefined, local: string): string | undefined {
  if (!el) return undefined;
  for (const k in el.attrs) {
    const i = k.indexOf(':');
    if (i > 0 && k.slice(i + 1) === local && k.slice(0, i) !== 'xmlns') return el.attrs[k];
  }
  return undefined;
}
