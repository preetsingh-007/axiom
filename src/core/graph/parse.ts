/**
 * Reference parsing for block markdown.
 *
 * Recognised syntax:
 *  - `[[Page]]`, `[[Page|alias]]`              links
 *  - `#tag`, `#[[multi word tag]]`             tags (graph edges, like links)
 *  - `![[Page]]`, `![[Page#^blockId]]`         transclusions (embeds)
 *  - `((blockId))`                             block references
 *  - `{{c1::answer}}`                          cloze deletions
 *
 * Everything inside code fences, inline code, `$math$` / `$$math$$` and URLs is ignored.
 * All offsets are UTF-16 offsets into the original string so edits can be applied in place.
 */

import { normalizeTitle } from '../util/ids';

export interface EmbedTarget {
  page: string;
  block?: string;
}

export interface ParsedRefs {
  /** link targets as written (trimmed), de-duplicated case-insensitively */
  links: string[];
  tags: string[];
  embeds: EmbedTarget[];
  blockRefs: string[];
  /** number of distinct cloze indices ({{c1::…}}, {{c2::…}}) */
  clozes: number;
}

type RegionKind = 'fence' | 'code' | 'math' | 'url';

interface Region {
  start: number;
  end: number;
  kind: RegionKind;
  /** content boundaries (without delimiters) */
  innerStart: number;
  innerEnd: number;
}

// ---------------------------------------------------------------------------
// Region scanning (code, math, URLs)
// ---------------------------------------------------------------------------

const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>"'`\]\)]+|\bwww\.[^\s<>"'`\]\)]+|\bmailto:[^\s<>"'`\]\)]+/gi;
/** markdown link destination: `](dest)` */
const MD_DEST_RE = /\]\(([^()\s]+(?:\s+"[^"]*")?)\)/g;

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function scanFences(text: string, out: Region[]) {
  let pos = 0;
  let open: { start: number; innerStart: number; ch: string; len: number } | null = null;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') {
        out.push({ start: open.start, end: lineEnd, kind: 'fence', innerStart: open.innerStart, innerEnd: Math.max(open.innerStart, pos - 1) });
        open = null;
      }
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { start: pos, innerStart: Math.min(text.length, lineEnd + 1), ch: m[1][0], len: m[1].length };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (open) out.push({ start: open.start, end: text.length, kind: 'fence', innerStart: open.innerStart, innerEnd: text.length });
}

function inRegions(regions: Region[], i: number): Region | undefined {
  for (const r of regions) if (i >= r.start && i < r.end) return r;
  return undefined;
}

/** Finds code fences, inline code, math and URL regions (sorted, non-overlapping). */
function scanRegions(text: string, math = true): Region[] {
  const fences: Region[] = [];
  scanFences(text, fences);
  const out: Region[] = [...fences];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const fence = inRegions(fences, i);
    if (fence) {
      i = fence.end;
      continue;
    }
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      let j = text.indexOf(ticks, i + run);
      while (j !== -1 && text[j + run] === '`') {
        // longer run: not a match, skip it
        let k = j;
        while (text[k] === '`') k++;
        j = text.indexOf(ticks, k);
      }
      if (j === -1) {
        i += run;
        continue;
      }
      out.push({ start: i, end: j + run, kind: 'code', innerStart: i + run, innerEnd: j });
      i = j + run;
      continue;
    }
    if (math && c === '$') {
      if (text[i + 1] === '$') {
        let j = text.indexOf('$$', i + 2);
        while (j !== -1 && text[j - 1] === '\\') j = text.indexOf('$$', j + 1);
        if (j === -1) {
          i += 2;
          continue;
        }
        out.push({ start: i, end: j + 2, kind: 'math', innerStart: i + 2, innerEnd: j });
        i = j + 2;
        continue;
      }
      const next = text[i + 1];
      if (next === undefined || isSpace(next)) {
        i++;
        continue;
      }
      let j = i + 1;
      let found = -1;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '$' && !isSpace(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? '')) {
          found = j;
          break;
        }
        j++;
      }
      if (found === -1) {
        i++;
        continue;
      }
      out.push({ start: i, end: found + 1, kind: 'math', innerStart: i + 1, innerEnd: found });
      i = found + 1;
      continue;
    }
    i++;
  }
  // URLs (outside code/math)
  for (const re of [URL_RE, MD_DEST_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = re === MD_DEST_RE ? m.index + 2 : m.index;
      const end = re === MD_DEST_RE ? m.index + m[0].length - 1 : m.index + m[0].length;
      if (inRegions(out, start)) continue;
      out.push({ start, end, kind: 'url', innerStart: start, innerEnd: end });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Replaces the given regions with spaces, keeping offsets stable. */
function maskWith(text: string, regions: Region[]): string {
  if (!regions.length) return text;
  let out = '';
  let pos = 0;
  for (const r of regions) {
    if (r.start < pos) continue;
    out += text.slice(pos, r.start) + ' '.repeat(r.end - r.start);
    pos = r.end;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------
// Reference scanning
// ---------------------------------------------------------------------------

/** Characters allowed immediately before a `#tag`. */
const TAG_BOUNDARY = `(?<![^\\s(\\[{,;:!?"'“”‘’«»*_~>|])`;
const TAG_BODY = `[\\p{L}\\p{N}_]+(?:[\\-/.][\\p{L}\\p{N}_]+)*`;
const REF_RE = new RegExp(
  `(#|!)?\\[\\[([^\\[\\]\\n]+?)\\]\\]|\\(\\(([A-Za-z0-9_-]+)\\)\\)|${TAG_BOUNDARY}#(${TAG_BODY})`,
  'gu',
);
const BARE_TAG_RE = new RegExp(`^${TAG_BODY}$`, 'u');
const HEX_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CLOZE_RE = /\{\{c(\d+)::/g;

type RefKind = 'link' | 'embed' | 'tag' | 'blockref';

interface RefMatch {
  kind: RefKind;
  start: number;
  end: number;
  /** span of the target name inside the text */
  targetStart: number;
  targetEnd: number;
  target: string;
  /** embeds / links: `#^blockId` fragment */
  block?: string;
  /** tags: true for the `#[[…]]` form */
  bracket?: boolean;
}

function isTagName(name: string): boolean {
  if (/^\d+$/.test(name)) return false;
  if (HEX_RE.test(name) && /\d/.test(name)) return false;
  return true;
}

function scanRefs(text: string): RefMatch[] {
  const masked = maskWith(text, scanRegions(text));
  const out: RefMatch[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(masked))) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[2] !== undefined) {
      const prefix = m[1];
      const inner = m[2];
      const innerStart = start + (prefix ? 1 : 0) + 2;
      const pipe = inner.indexOf('|');
      let target = pipe === -1 ? inner : inner.slice(0, pipe);
      let block: string | undefined;
      const frag = target.indexOf('#^');
      if (frag !== -1 && prefix !== '#') {
        block = target.slice(frag + 2).trim() || undefined;
        target = target.slice(0, frag);
      }
      const lead = target.length - target.trimStart().length;
      const trimmed = target.trim();
      if (!trimmed) continue;
      const kind: RefKind = prefix === '#' ? 'tag' : prefix === '!' ? 'embed' : 'link';
      out.push({
        kind,
        start,
        end,
        targetStart: innerStart + lead,
        targetEnd: innerStart + lead + trimmed.length,
        target: trimmed,
        block,
        bracket: kind === 'tag' ? true : undefined,
      });
    } else if (m[3] !== undefined) {
      out.push({ kind: 'blockref', start, end, targetStart: start + 2, targetEnd: end - 2, target: m[3] });
    } else if (m[4] !== undefined) {
      if (!isTagName(m[4])) continue;
      out.push({ kind: 'tag', start, end, targetStart: start + 1, targetEnd: end, target: m[4] });
    }
  }
  return out;
}

function pushUnique(list: string[], seen: Set<string>, value: string) {
  const key = normalizeTitle(value);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

/** Extracts links, tags, embeds, block refs and cloze count from block markdown. */
export function parseRefs(markdown: string): ParsedRefs {
  const links: string[] = [];
  const tags: string[] = [];
  const embeds: EmbedTarget[] = [];
  const blockRefs: string[] = [];
  const seenLinks = new Set<string>();
  const seenTags = new Set<string>();
  const seenEmbeds = new Set<string>();
  const seenBlocks = new Set<string>();
  for (const r of scanRefs(markdown)) {
    if (r.kind === 'link') pushUnique(links, seenLinks, r.target);
    else if (r.kind === 'tag') pushUnique(tags, seenTags, r.target);
    else if (r.kind === 'embed') {
      const key = normalizeTitle(r.target) + '\u0000' + (r.block ?? '');
      if (seenEmbeds.has(key)) continue;
      seenEmbeds.add(key);
      embeds.push(r.block ? { page: r.target, block: r.block } : { page: r.target });
    } else if (!seenBlocks.has(r.target)) {
      seenBlocks.add(r.target);
      blockRefs.push(r.target);
    }
  }
  // clozes: ignore code, but allow clozes that wrap math
  const codeMasked = maskWith(markdown, scanRegions(markdown, false).filter((r) => r.kind !== 'url'));
  const clozeIdx = new Set<string>();
  CLOZE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOZE_RE.exec(codeMasked))) clozeIdx.add(m[1]);
  return { links, tags, embeds, blockRefs, clozes: clozeIdx.size };
}

/** True when `name` can be written as a bare `#tag` (otherwise it needs `#[[…]]`). */
export function isBareTag(name: string): boolean {
  return BARE_TAG_RE.test(name) && isTagName(name);
}

/** Formats a tag in the shortest valid form. */
export function formatTag(name: string): string {
  return isBareTag(name) ? `#${name}` : `#[[${name}]]`;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function stripMarkup(s: string): string {
  return (
    s
      // embeds / links / bracket tags
      .replace(/!?\[\[([^\[\]\n]+?)\]\]/g, (_m, inner: string) => {
        const pipe = inner.indexOf('|');
        if (pipe !== -1) return inner.slice(pipe + 1);
        const frag = inner.indexOf('#^');
        return frag === -1 ? inner : inner.slice(0, frag);
      })
      .replace(/#(?=[^\s#])/g, (m, offset: number, str: string) => {
        // drop the `#` of tags (keep the word); headings are handled below
        const prev = str[offset - 1];
        return prev === undefined || /[\s(\[{,;:!?"'*_~>|]/.test(prev) ? '' : m;
      })
      .replace(/\(\([A-Za-z0-9_-]+\)\)/g, '')
      .replace(/\{\{c\d+::((?:(?!::|\}\}).)*)(?:::(?:(?!\}\}).)*)?\}\}/g, '$1')
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
      .replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]*?\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
  );
}

/** Strips markdown markup, keeping readable text (link aliases, tag words, code and math content). */
export function plainText(markdown: string): string {
  if (!markdown) return '';
  const regions = scanRegions(markdown).filter((r) => r.kind !== 'url');
  let out = '';
  let pos = 0;
  for (const r of regions) {
    if (r.start < pos) continue;
    out += stripMarkup(markdown.slice(pos, r.start));
    out += ' ' + markdown.slice(r.innerStart, r.innerEnd) + ' ';
    pos = r.end;
  }
  out += stripMarkup(markdown.slice(pos));
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** A text edit: replace `deleteCount` chars at `index` with `insert`. */
export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/**
 * Edits that rename references to `oldTitle` (compared normalized) into `newTitle`.
 * Aliases (`[[old|alias]]`), block fragments and the embed/tag syntax are preserved.
 * Edits are returned in ascending order and do not overlap; apply them from the end.
 */
export function conceptEdits(
  text: string,
  oldTitle: string,
  newTitle: string,
  opts: { links?: boolean; tags?: boolean } = {},
): TextEdit[] {
  const doLinks = opts.links ?? true;
  const doTags = opts.tags ?? true;
  const key = normalizeTitle(oldTitle);
  const next = newTitle.trim();
  const edits: TextEdit[] = [];
  for (const r of scanRefs(text)) {
    if (r.kind === 'blockref' || normalizeTitle(r.target) !== key) continue;
    if (r.kind === 'tag') {
      if (!doTags) continue;
      if (r.bracket) edits.push({ index: r.targetStart, deleteCount: r.targetEnd - r.targetStart, insert: next });
      else edits.push({ index: r.start, deleteCount: r.end - r.start, insert: formatTag(next) });
    } else {
      if (!doLinks) continue;
      edits.push({ index: r.targetStart, deleteCount: r.targetEnd - r.targetStart, insert: next });
    }
  }
  return edits.filter((e) => text.slice(e.index, e.index + e.deleteCount) !== e.insert);
}

/** Applies ascending, non-overlapping edits to a string. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.index) + e.insert + out.slice(e.index + e.deleteCount);
  }
  return out;
}

/** Renames `[[old]]`, `[[old|alias]]` and `![[old…]]` references (not tags). */
export function renameLinkInText(text: string, oldTitle: string, newTitle: string): string {
  return applyEdits(text, conceptEdits(text, oldTitle, newTitle, { tags: false }));
}

/** Renames `#old` and `#[[old]]` tags (bare form when the new name allows it). */
export function renameTagInText(text: string, oldTitle: string, newTitle: string): string {
  return applyEdits(text, conceptEdits(text, oldTitle, newTitle, { links: false }));
}

/** Renames both links and tags. */
export function renameConceptInText(text: string, oldTitle: string, newTitle: string): string {
  return applyEdits(text, conceptEdits(text, oldTitle, newTitle));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unlinked occurrences of `phrase` (case-insensitive, whole words) in block markdown,
 * skipping code, math, URLs and existing references.
 */
export function findMentions(text: string, phrase: string): { start: number; end: number }[] {
  const words = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!words.length) return [];
  const regions = scanRegions(text);
  for (const r of scanRefs(text)) regions.push({ start: r.start, end: r.end, kind: 'code', innerStart: r.start, innerEnd: r.end });
  regions.sort((a, b) => a.start - b.start);
  const masked = maskWith(text, regions);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${words.join('\\s+')}(?![\\p{L}\\p{N}_])`, 'giu');
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}
