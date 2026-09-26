/**
 * BibTeX / BibLaTeX parsing and serialization, plus conversion to and from the
 * app's `BibMeta`.
 *
 * Parser: nested braces, quoted values, `@string` macros, `#` concatenation,
 * `@comment` / `@preamble`, parenthesised entries, month macros and error
 * recovery (a broken entry is skipped, the rest of the file still parses).
 * Field values keep their LaTeX (inner braces included) so a round-trip is
 * lossless; use `latexToUnicode` for display.
 */
import type { BibMeta } from '../schema';
import { formatBibtexName, formatDisplayName, parseName, splitBibtexAuthors } from './names';

export interface BibEntry {
  /** lowercase entry type: article, inproceedings, book, misc… */
  type: string;
  key: string;
  /** lowercase field name → LaTeX value (outer delimiters removed) */
  fields: Record<string, string>;
}

export interface BibParseResult {
  entries: BibEntry[];
  strings: Record<string, string>;
  preambles: string[];
  comments: string[];
  errors: { offset: number; message: string }[];
}

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Parses a .bib file. Never throws; problems are reported in `errors`. */
export function parseBibtex(src: string): BibParseResult {
  const res: BibParseResult = { entries: [], strings: {}, preambles: [], comments: [], errors: [] };
  const macros: Record<string, string> = { ...MONTHS };
  let i = 0;
  const n = src.length;

  const ws = () => {
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') i++;
      else if (c === '%') {
        // line comment (common in hand-written files)
        while (i < n && src[i] !== '\n') i++;
      } else break;
    }
  };
  const ident = () => {
    const start = i;
    while (i < n && /[^\s"#%'(),={}]/.test(src[i])) i++;
    return src.slice(start, i);
  };
  const braced = (): string => {
    // src[i] === '{'
    let depth = 0;
    const start = i;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        i++;
        return src.slice(start + 1, i - 1);
      }
    }
    throw new ParseError('unbalanced braces', start);
  };
  const quoted = (): string => {
    const start = i;
    i++;
    let depth = 0;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) {
        i++;
        return src.slice(start + 1, i - 1);
      }
    }
    throw new ParseError('unterminated quoted value', start);
  };
  const value = (): string => {
    let out = '';
    for (;;) {
      ws();
      const c = src[i];
      if (c === '{') out += braced();
      else if (c === '"') out += quoted();
      else {
        const start = i;
        const id = ident();
        if (!id) throw new ParseError('expected a value', start);
        if (/^\d+$/.test(id)) out += id;
        else {
          const m = macros[id.toLowerCase()];
          out += m ?? id;
        }
      }
      ws();
      if (src[i] === '#') {
        i++;
        continue;
      }
      return out;
    }
  };

  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const entryStart = at;
    try {
      ws();
      const type = ident().toLowerCase();
      ws();
      const open = src[i];
      if (open !== '{' && open !== '(') throw new ParseError(`expected "{" after @${type}`, i);
      const close = open === '{' ? '}' : ')';
      if (type === 'comment') {
        if (open === '{') res.comments.push(braced().trim());
        else {
          const end = src.indexOf(')', i);
          res.comments.push(src.slice(i + 1, end < 0 ? n : end).trim());
          i = end < 0 ? n : end + 1;
        }
        continue;
      }
      i++;
      if (type === 'preamble') {
        res.preambles.push(value());
        ws();
        if (src[i] !== close) throw new ParseError('expected end of @preamble', i);
        i++;
        continue;
      }
      if (type === 'string') {
        ws();
        const name = ident();
        ws();
        if (src[i] !== '=') throw new ParseError('expected "=" in @string', i);
        i++;
        const v = value();
        macros[name.toLowerCase()] = v;
        res.strings[name] = v;
        ws();
        if (src[i] !== close) throw new ParseError('expected end of @string', i);
        i++;
        continue;
      }
      // regular entry
      ws();
      const keyStart = i;
      while (i < n && src[i] !== ',' && src[i] !== close && !/\s/.test(src[i])) i++;
      const key = src.slice(keyStart, i).trim();
      ws();
      const fields: Record<string, string> = {};
      if (src[i] === ',') i++;
      for (;;) {
        ws();
        if (src[i] === close) {
          i++;
          break;
        }
        if (i >= n) throw new ParseError('unexpected end of file', i);
        const fname = ident().toLowerCase();
        if (!fname) throw new ParseError('expected a field name', i);
        ws();
        if (src[i] !== '=') throw new ParseError(`expected "=" after ${fname}`, i);
        i++;
        const v = value();
        if (!(fname in fields)) fields[fname] = v.replace(/\s*\n\s*/g, ' ');
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== close) throw new ParseError(`expected "," or end of entry after ${fname}`, i);
      }
      res.entries.push({ type, key, fields });
    } catch (e) {
      const offset = e instanceof ParseError ? e.offset : entryStart;
      res.errors.push({ offset, message: e instanceof Error ? e.message : String(e) });
      // recover: continue at the next "@" that starts a line
      const re = /\n\s*@/g;
      re.lastIndex = Math.max(entryStart + 1, Math.min(offset, n));
      const m = re.exec(src);
      i = m ? m.index + m[0].length - 1 : n;
    }
  }
  return res;
}

// ------------------------------------------------------------------ LaTeX → Unicode

const ACCENTS: Record<string, string> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '~': '̃',
  '=': '̄',
  '.': '̇',
  '"': '̈',
  u: '̆',
  v: '̌',
  H: '̋',
  c: '̧',
  k: '̨',
  r: '̊',
  d: '̣',
  b: '̱',
};

const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  textendash: '–',
  textemdash: '—',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  dag: '†',
  ddag: '‡',
  S: '§',
  P: '¶',
  copyright: '©',
  textregistered: '®',
  texttrademark: '™',
  pounds: '£',
  euro: '€',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  textbackslash: '\\',
  textasciitilde: '~',
  textunderscore: '_',
  textbar: '|',
  textless: '<',
  textgreater: '>',
};

const STRIP_CMDS = /\\(?:emph|textit|textbf|textsc|texttt|textrm|textsf|textup|textsl|textnormal|mathrm|mbox|hbox|text|uppercase|lowercase|NoCaseChange|url|nolinkurl|enquote)\s*\{/g;

/** Converts LaTeX markup in a BibTeX value to plain Unicode for display. Inline `$math$` is kept. */
export function latexToUnicode(s: string): string {
  if (!s) return '';
  // keep inline math untouched
  const math: string[] = [];
  let t = s.replace(/\$[^$]+\$/g, (m) => {
    math.push(m);
    return `\u0000${math.length - 1}\u0000`;
  });
  t = t.replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1');
  // accents: \'e \'{e} {\'e} \'{\i} \c c
  t = t.replace(/\\([`'^~=".]|[uvHckrdb](?=[\s{]))\s*(?:\{\s*(\\?[a-zA-Z]|)\s*\}|(\\?[a-zA-Z]))/g, (_m, acc: string, a?: string, b?: string) => {
    let base = (a ?? b ?? '').trim();
    if (base === '\\i') base = 'i';
    else if (base === '\\j') base = 'j';
    else if (base.startsWith('\\')) base = SYMBOLS[base.slice(1)] ?? base.slice(1);
    return (base + (ACCENTS[acc] ?? '')).normalize('NFC');
  });
  t = t.replace(/\\([a-zA-Z]+)(?![a-zA-Z])\s?(\{\})?/g, (m, name: string) => (name in SYMBOLS ? SYMBOLS[name] : m));
  t = t.replace(STRIP_CMDS, '{');
  t = t
    .replace(/\\([&%$#_{}])/g, (_m, c: string) => `\u0001${c.charCodeAt(0)}\u0001`)
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/(?<!\\)~/g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/\\,/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\([a-zA-Z]+)\s*/g, '$1') // unknown commands: keep the word
    .replace(/\u0001(\d+)\u0001/g, (_m, c: string) => String.fromCharCode(Number(c)))
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
  return t.replace(/\u0000(\d+)\u0000/g, (_m, k: string) => math[Number(k)]);
}

const BIB_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  $: '\\$',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\^{}',
};

/** Escapes plain text for a BibTeX value (keeps Unicode and inline `$math$`; escapes LaTeX specials). */
export function escapeBibValue(s: string): string {
  return s
    .split(/(\$[^$\n]+\$)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\&%#_${}~^]/g, (c) => BIB_ESCAPES[c])))
    .join('');
}

/** Wraps words with internal capitals/acronyms ("BERT", "iPhone", "CRDTs") in braces to protect their case. */
export function protectCase(title: string): string {
  return title.replace(/(^|[\s(\-–—:/])([\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*)/gu, (m, pre: string, w: string) => {
    const internalCaps = /\p{Lu}/u.test(w.slice(1)) || (/^\p{Ll}/u.test(w) && /\p{Lu}/u.test(w));
    return internalCaps && w.length > 1 ? `${pre}{${w}}` : m;
  });
}

// ------------------------------------------------------------------ serialization

const FIELD_ORDER = [
  'author',
  'editor',
  'title',
  'subtitle',
  'journal',
  'journaltitle',
  'booktitle',
  'series',
  'edition',
  'volume',
  'number',
  'issue',
  'pages',
  'chapter',
  'year',
  'month',
  'date',
  'publisher',
  'address',
  'location',
  'school',
  'institution',
  'organization',
  'howpublished',
  'type',
  'doi',
  'eprint',
  'eprinttype',
  'archiveprefix',
  'primaryclass',
  'url',
  'urldate',
  'isbn',
  'issn',
  'language',
  'keywords',
  'abstract',
  'note',
  'file',
];

function balanced(v: string): boolean {
  let d = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\') {
      i++;
      continue;
    }
    if (v[i] === '{') d++;
    else if (v[i] === '}' && --d < 0) return false;
  }
  return d === 0;
}

function formatValue(name: string, v: string): string {
  if (name === 'year' && /^\d+$/.test(v)) return v;
  const safe = balanced(v) ? v : v.replace(/(?<!\\)([{}])/g, '\\$1');
  return `{${safe}}`;
}

/** Serializes one entry with a stable field order. */
export function serializeEntry(e: BibEntry, indent = '  '): string {
  const names = Object.keys(e.fields).filter((k) => e.fields[k] !== undefined && e.fields[k] !== '');
  const ordered = [
    ...FIELD_ORDER.filter((f) => names.includes(f)),
    ...names.filter((f) => !FIELD_ORDER.includes(f)).sort(),
  ];
  const width = Math.max(0, ...ordered.map((f) => f.length));
  const lines = ordered.map((f) => `${indent}${f.padEnd(width)} = ${formatValue(f, e.fields[f])}`);
  return `@${e.type}{${e.key},\n${lines.join(',\n')}${lines.length ? '\n' : ''}}`;
}

export function serializeBibtex(entries: BibEntry[], opts: { strings?: Record<string, string>; indent?: string } = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(opts.strings ?? {})) parts.push(`@string{${k} = {${v}}}`);
  for (const e of entries) parts.push(serializeEntry(e, opts.indent));
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}

// ------------------------------------------------------------------ BibMeta conversion

const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i;

export function normalizeDoiValue(doi: string): string {
  return doi.trim().replace(DOI_PREFIX, '');
}

/** BibTeX entry → BibMeta (display-ready Unicode). */
export function bibToMeta(e: BibEntry): BibMeta {
  const f = e.fields;
  const u = (k: string) => (f[k] !== undefined ? latexToUnicode(f[k]) : undefined);
  const meta: BibMeta = { entryType: e.type, bibKey: e.key };
  const title = u('title');
  if (title) meta.title = title;
  const authorField = f.author ?? f.editor;
  if (authorField) {
    const authors = splitBibtexAuthors(authorField).map((a) => latexToUnicode(formatDisplayName(parseName(a))) || latexToUnicode(a));
    if (authors.length) meta.authors = authors;
  }
  const yearSrc = f.year ?? f.date;
  const y = yearSrc ? /(\d{4})/.exec(yearSrc) : null;
  if (y) meta.year = Number(y[1]);
  const venue = u('journal') ?? u('journaltitle') ?? u('booktitle') ?? u('eventtitle') ?? u('howpublished') ?? u('school') ?? u('institution');
  if (venue) meta.venue = venue;
  if (f.doi) meta.doi = normalizeDoiValue(latexToUnicode(f.doi));
  const eprintType = (f.archiveprefix ?? f.eprinttype ?? '').toLowerCase();
  if (f.eprint && (eprintType === 'arxiv' || /^\d{4}\.\d{4,5}|^[a-z-]+\/\d{7}/i.test(f.eprint))) meta.arxiv = latexToUnicode(f.eprint).replace(/^arxiv:/i, '');
  else {
    const m = /arxiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(f.journal ?? f.note ?? '');
    if (m) meta.arxiv = m[1];
  }
  const url = f.url ? latexToUnicode(f.url) : undefined;
  if (url) meta.url = url;
  const publisher = u('publisher');
  if (publisher) meta.publisher = publisher;
  const abstract = u('abstract');
  if (abstract) meta.abstract = abstract;
  return meta;
}

const ENTRY_TYPES = new Set([
  'article',
  'book',
  'booklet',
  'inbook',
  'incollection',
  'inproceedings',
  'conference',
  'manual',
  'mastersthesis',
  'misc',
  'phdthesis',
  'proceedings',
  'techreport',
  'unpublished',
  'online',
  'thesis',
  'report',
]);

/** BibMeta → BibTeX entry (Unicode kept, LaTeX specials escaped, title case protected). */
export function metaToBib(meta: BibMeta, key?: string): BibEntry {
  const type = meta.entryType && ENTRY_TYPES.has(meta.entryType.toLowerCase()) ? meta.entryType.toLowerCase() : meta.arxiv && !meta.doi ? 'misc' : 'article';
  const fields: Record<string, string> = {};
  if (meta.authors?.length) {
    fields.author = meta.authors
      .map((a) => {
        const n = parseName(a);
        return formatBibtexName({ ...n, first: escapeBibValue(n.first), last: n.literal ? n.last : escapeBibValue(n.last) });
      })
      .join(' and ');
  }
  if (meta.title) fields.title = protectCase(escapeBibValue(meta.title));
  if (meta.venue) {
    const v = escapeBibValue(meta.venue);
    if (type === 'article') fields.journal = v;
    else if (type === 'inproceedings' || type === 'incollection' || type === 'conference' || type === 'inbook') fields.booktitle = v;
    else if (type === 'phdthesis' || type === 'mastersthesis' || type === 'thesis') fields.school = v;
    else if (type === 'techreport' || type === 'report') fields.institution = v;
    else if (type === 'book') fields.series = v;
    else fields.howpublished = v;
  }
  if (meta.year) fields.year = String(meta.year);
  if (meta.publisher) fields.publisher = escapeBibValue(meta.publisher);
  if (meta.doi) fields.doi = normalizeDoiValue(meta.doi);
  if (meta.arxiv) {
    fields.eprint = meta.arxiv;
    fields.archiveprefix = 'arXiv';
  }
  if (meta.url) fields.url = meta.url;
  if (meta.abstract) fields.abstract = escapeBibValue(meta.abstract);
  return { type, key: key ?? meta.bibKey ?? 'ref', fields };
}
