/**
 * Lens query language (Dynamic Workspaces).
 *
 * A lens aggregates blocks from the whole vault. Grammar (case-insensitive keys):
 *
 *   query   := or
 *   or      := and ( "OR" and )*
 *   and     := unary+                     (juxtaposition = AND; a literal "AND" is ignored)
 *   unary   := "-"? atom
 *   atom    := "(" or ")" | term
 *   term    := word | "quoted phrase" | [[Concept]] | #tag | #[[multi word]]
 *            | tag:foo | tag:"multi word" | page:"Title" | source:"title, bibkey or id"
 *            | type:text|math|code|ink|image|slide|embed | is:flashcard | has:anchor
 *            | before:YYYY-MM-DD | after:YYYY-MM-DD
 *
 *  - free words match block text (all words, prefix per word); "quoted" requires the phrase;
 *  - `[[X]]` matches blocks linking OR tagging X (aliases folded); `tag:` / `#` only tags;
 *  - `source:` matches blocks anchored to the source, plus blocks of pages generated from it;
 *  - `after:` is inclusive of that day, `before:` exclusive (block creation time, local days).
 *
 * Example — "all blocks tagged Reinforcement Learning and these two papers":
 *   [[Reinforcement Learning]] OR source:"Paper A" OR source:"Paper B"
 */

import type { BlockType } from '../schema';
import type { Vault } from '../vault';
import { normalizeTitle } from '../util/ids';
import type { BlockEntry, GraphIndex } from './index';
import { fold } from './tokenize';

/** Help text for the lens editor UI. */
export const LENS_HELP = `Lens queries combine filters (AND by default):
  word "exact phrase"        full-text match
  [[Concept]]                blocks linking or tagging a concept
  #tag  tag:foo  tag:"a b"   blocks with a tag
  page:"Title"               blocks on a page
  source:"Paper title"       blocks anchored to a source (title, bibkey or id)
  type:math|code|ink|image|text
  is:flashcard  has:anchor
  after:2026-01-01  before:2026-02-01   block creation date
  -term  -tag:x              exclude
  a OR b                     either side;  ( … ) groups
Example: [[Reinforcement Learning]] OR source:"Paper A" OR source:"Paper B"`;

const BLOCK_TYPES: readonly BlockType[] = ['text', 'math', 'code', 'ink', 'image', 'slide', 'embed'];

export type LensTerm =
  | { kind: 'text'; value: string; phrase: boolean }
  | { kind: 'tag'; value: string }
  | { kind: 'ref'; value: string }
  | { kind: 'page'; value: string }
  | { kind: 'source'; value: string }
  | { kind: 'type'; value: BlockType }
  | { kind: 'is'; value: 'flashcard' }
  | { kind: 'has'; value: 'anchor' }
  | { kind: 'before' | 'after'; value: number; raw: string };

export type LensNode =
  | { op: 'term'; term: LensTerm; negated: boolean }
  | { op: 'and'; children: LensNode[]; negated: boolean }
  | { op: 'or'; children: LensNode[]; negated: boolean };

export interface ParsedLens {
  /** null for an empty (or entirely invalid) query */
  ast: LensNode | null;
  errors: string[];
}

export interface LensResult {
  pageId: string;
  blockId: string;
}

// ------------------------------------------------------------------ lexer

type Tok =
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'or' }
  | { t: 'and' }
  | { t: 'neg' }
  | { t: 'term'; term: LensTerm | null };

function parseDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return null;
  return d.getTime();
}

function makeTerm(key: string, value: string, errors: string[]): LensTerm | null {
  switch (key) {
    case 'tag':
      return value ? { kind: 'tag', value } : null;
    case 'page':
      return value ? { kind: 'page', value } : null;
    case 'source':
    case 'src':
      return value ? { kind: 'source', value } : null;
    case 'type': {
      const v = value.toLowerCase() as BlockType;
      if (BLOCK_TYPES.includes(v)) return { kind: 'type', value: v };
      errors.push(`Unknown block type "${value}" (use ${BLOCK_TYPES.join(', ')})`);
      return null;
    }
    case 'is':
      if (value.toLowerCase() === 'flashcard' || value.toLowerCase() === 'card') return { kind: 'is', value: 'flashcard' };
      errors.push(`Unknown filter is:${value} (use is:flashcard)`);
      return null;
    case 'has':
      if (value.toLowerCase() === 'anchor') return { kind: 'has', value: 'anchor' };
      errors.push(`Unknown filter has:${value} (use has:anchor)`);
      return null;
    case 'before':
    case 'after': {
      const t = parseDate(value);
      if (t === null) {
        errors.push(`Invalid date "${value}" (use YYYY-MM-DD)`);
        return null;
      }
      return { kind: key, value: t, raw: value };
    }
  }
  return null;
}

const KEYS = new Set(['tag', 'page', 'source', 'src', 'type', 'is', 'has', 'before', 'after']);

function lex(q: string, errors: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = q.length;
  const readQuoted = (): string => {
    // at opening quote
    const close = q.indexOf('"', i + 1);
    const end = close === -1 ? n : close;
    if (close === -1) errors.push('Unclosed quote');
    const v = q.slice(i + 1, end);
    i = close === -1 ? n : close + 1;
    return v.trim();
  };
  const readWord = (): string => {
    const start = i;
    while (i < n && !/[\s()]/.test(q[i])) i++;
    return q.slice(start, i);
  };
  while (i < n) {
    const c = q[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === '-' && i + 1 < n && !/\s/.test(q[i + 1]) && (i === 0 || /[\s(]/.test(q[i - 1]))) {
      toks.push({ t: 'neg' });
      i++;
      continue;
    }
    if (q.startsWith('[[', i) || q.startsWith('#[[', i)) {
      const isTag = c === '#';
      const open = i + (isTag ? 3 : 2);
      const close = q.indexOf(']]', open);
      if (close === -1) errors.push('Unclosed [[');
      const v = q.slice(open, close === -1 ? n : close).trim();
      i = close === -1 ? n : close + 2;
      toks.push({ t: 'term', term: v ? { kind: isTag ? 'tag' : 'ref', value: v } : null });
      continue;
    }
    if (c === '"') {
      const v = readQuoted();
      toks.push({ t: 'term', term: v ? { kind: 'text', value: v, phrase: true } : null });
      continue;
    }
    if (c === '#' && i + 1 < n && /[\p{L}\p{N}_]/u.test(q[i + 1])) {
      i++;
      toks.push({ t: 'term', term: { kind: 'tag', value: readWord() } });
      continue;
    }
    const m = /^([a-zA-Z]+):/.exec(q.slice(i));
    if (m && KEYS.has(m[1].toLowerCase())) {
      i += m[0].length;
      const value = q[i] === '"' ? readQuoted() : q.startsWith('[[', i) ? readBracket() : readWord();
      if (!value) errors.push(`Missing value for ${m[1]}:`);
      toks.push({ t: 'term', term: value ? makeTerm(m[1].toLowerCase(), value, errors) : null });
      continue;
    }
    const w = readWord();
    if (w === 'OR' || w === '|' || w === '||') toks.push({ t: 'or' });
    else if (w === 'AND' || w === '&&') toks.push({ t: 'and' });
    else {
      if (m) errors.push(`Unknown filter "${m[1]}:" (searching it as text)`);
      toks.push({ t: 'term', term: { kind: 'text', value: w, phrase: false } });
    }
  }
  return toks;

  function readBracket(): string {
    const close = q.indexOf(']]', i + 2);
    const v = q.slice(i + 2, close === -1 ? n : close);
    i = close === -1 ? n : close + 2;
    return v.trim();
  }
}

// ------------------------------------------------------------------ parser

/** Parses a lens query. Never throws; problems are reported in `errors`. */
export function parseLens(q: string): ParsedLens {
  const errors: string[] = [];
  const toks = lex(q ?? '', errors);
  let pos = 0;

  const parseOr = (): LensNode | null => {
    const children: LensNode[] = [];
    const first = parseAnd();
    if (first) children.push(first);
    while (pos < toks.length && toks[pos].t === 'or') {
      pos++;
      const next = parseAnd();
      if (next) children.push(next);
      else errors.push('OR without a right-hand side');
    }
    if (!children.length) return null;
    return children.length === 1 ? children[0] : { op: 'or', children, negated: false };
  };

  const parseAnd = (): LensNode | null => {
    const children: LensNode[] = [];
    while (pos < toks.length) {
      const tk = toks[pos];
      if (tk.t === 'or' || tk.t === 'rp') break;
      if (tk.t === 'and') {
        pos++;
        continue;
      }
      const node = parseUnary();
      if (node) children.push(node);
    }
    if (!children.length) return null;
    return children.length === 1 ? children[0] : { op: 'and', children, negated: false };
  };

  const parseUnary = (): LensNode | null => {
    let negated = false;
    while (toks[pos]?.t === 'neg') {
      negated = !negated;
      pos++;
    }
    const tk = toks[pos];
    if (!tk) {
      errors.push('Dangling "-"');
      return null;
    }
    if (tk.t === 'lp') {
      pos++;
      const inner = parseOr();
      if (toks[pos]?.t === 'rp') pos++;
      else errors.push('Missing ")"');
      if (!inner) return null;
      return negated ? { ...inner, negated: !inner.negated } : inner;
    }
    if (tk.t === 'term') {
      pos++;
      return tk.term ? { op: 'term', term: tk.term, negated } : null;
    }
    // stray token (e.g. OR after "-"): skip it
    pos++;
    return null;
  };

  let ast: LensNode | null = null;
  const parts: LensNode[] = [];
  while (pos < toks.length) {
    const node = parseOr();
    if (node) parts.push(node);
    if (toks[pos]?.t === 'rp') {
      errors.push('Unmatched ")"');
      pos++;
    }
  }
  if (parts.length === 1) ast = parts[0];
  else if (parts.length > 1) ast = { op: 'and', children: parts, negated: false };
  return { ast, errors };
}

// ------------------------------------------------------------------ evaluation

type Pred = (e: BlockEntry) => boolean;
/** A term evaluates to an explicit set of blocks or a predicate. */
type Evaluated = { set: Set<BlockEntry> } | { pred: Pred };

function sourceIds(vault: Vault, value: string): Set<string> {
  const q = normalizeTitle(value);
  const exact = new Set<string>();
  const partial = new Set<string>();
  for (const s of vault.listSources()) {
    const title = normalizeTitle(s.bib?.title || s.title || '');
    if (s.id === value || normalizeTitle(s.bib?.bibKey ?? '') === q || title === q || normalizeTitle(s.fileName ?? '') === q) exact.add(s.id);
    else if (q.length >= 3 && title.includes(q)) partial.add(s.id);
  }
  return exact.size ? exact : partial;
}

function evalTerm(term: LensTerm, index: GraphIndex, vault: Vault): Evaluated {
  switch (term.kind) {
    case 'text': {
      const found = index.matchText(term.value, { prefix: !term.phrase });
      if (!term.phrase) return { set: new Set(found) };
      const needle = fold(term.value).replace(/\s+/g, ' ');
      return { set: new Set(found.filter((e) => fold(e.text).replace(/\s+/g, ' ').includes(needle))) };
    }
    case 'tag':
      return { set: new Set(index.blocksWithTag(term.value)) };
    case 'ref':
      return { set: new Set(index.blocksReferencing(term.value)) };
    case 'page': {
      const set = new Set<BlockEntry>();
      for (const id of index.pagesTitled(term.value)) for (const e of index.pageBlocks(id)) set.add(e);
      return { set };
    }
    case 'source': {
      const ids = sourceIds(vault, term.value);
      const set = new Set<BlockEntry>();
      for (const id of ids) for (const e of index.blocksForSource(id)) set.add(e);
      if (ids.size) {
        for (const p of vault.listPages()) {
          if (p.sourceId && ids.has(p.sourceId)) for (const e of index.pageBlocks(p.id)) set.add(e);
        }
      }
      return { set };
    }
    case 'type':
      return { pred: (e) => e.type === term.value };
    case 'is':
      return { set: new Set(index.flashcardEntries()) };
    case 'has':
      return { pred: (e) => !!e.anchorSourceId };
    case 'before':
      return { pred: (e) => e.createdAt < term.value };
    case 'after':
      return { pred: (e) => e.createdAt >= term.value };
  }
}

function universe(index: GraphIndex): Set<BlockEntry> {
  return new Set(index.allBlocks());
}

function evalNode(node: LensNode, index: GraphIndex, vault: Vault, all: () => Set<BlockEntry>): Set<BlockEntry> {
  let result: Set<BlockEntry>;
  if (node.op === 'term') {
    const ev = evalTerm(node.term, index, vault);
    result = 'set' in ev ? ev.set : filter(all(), ev.pred);
  } else if (node.op === 'or') {
    result = new Set();
    for (const c of node.children) for (const e of evalNode(c, index, vault, all)) result.add(e);
  } else {
    // AND: intersect positive sets (smallest first), then filter by predicates and negations
    const sets: Set<BlockEntry>[] = [];
    const preds: Pred[] = [];
    const negs: Set<BlockEntry>[] = [];
    for (const c of node.children) {
      if (c.op === 'term') {
        const ev = evalTerm(c.term, index, vault);
        if ('pred' in ev) preds.push(c.negated ? (e) => !ev.pred(e) : ev.pred);
        else (c.negated ? negs : sets).push(ev.set);
      } else if (c.negated) {
        negs.push(evalNode({ ...c, negated: false }, index, vault, all));
      } else {
        sets.push(evalNode(c, index, vault, all));
      }
    }
    sets.sort((a, b) => a.size - b.size);
    let base = sets.length ? sets[0] : all();
    for (let i = 1; i < sets.length; i++) base = filter(base, (e) => sets[i].has(e));
    result = filter(base, (e) => preds.every((p) => p(e)) && negs.every((s) => !s.has(e)));
    return node.negated ? filter(all(), (e) => !result.has(e)) : result;
  }
  return node.negated ? filter(all(), (e) => !result.has(e)) : result;
}

function filter(set: Iterable<BlockEntry>, pred: Pred): Set<BlockEntry> {
  const out = new Set<BlockEntry>();
  for (const e of set) if (pred(e)) out.add(e);
  return out;
}

/**
 * Evaluates a parsed lens against the graph index. Results are ordered by page `updatedAt`
 * (most recent first), then block order.
 */
export function evaluateLens(index: GraphIndex, vault: Vault, ast: LensNode | ParsedLens | null): LensResult[] {
  const node = ast && 'errors' in ast ? ast.ast : (ast as LensNode | null);
  if (!node) return [];
  let cached: Set<BlockEntry> | null = null;
  const all = () => (cached ??= universe(index));
  return index.sortBlocks(evalNode(node, index, vault, all)).map((e) => ({ pageId: e.pageId, blockId: e.blockId }));
}

/** Convenience: parse + evaluate. */
export function runLens(index: GraphIndex, vault: Vault, query: string): { results: LensResult[]; errors: string[] } {
  const parsed = parseLens(query);
  return { results: evaluateLens(index, vault, parsed.ast), errors: parsed.errors };
}
