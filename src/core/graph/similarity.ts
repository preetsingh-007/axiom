/**
 * Duplicate / near-duplicate concept detection for tag auto-merging.
 *
 * Signals: normalization (case, whitespace, punctuation, diacritics, English plurals), word
 * order, Jaro-Winkler on the normalized string, fuzzy token-set overlap, and acronyms
 * (`RL` ↔ `Reinforcement Learning`, `MDPs` ↔ `Markov Decision Process`).
 *
 * Candidate generation uses blocking (shared prefix of any token, sorted-token signature,
 * acronym key) and a sorted-neighbourhood window inside oversized blocks, so it scales to
 * thousands of concepts without comparing every pair.
 */

import { normalizeTitle } from '../util/ids';
import { fold } from './tokenize';

export interface ConceptLike {
  title: string;
  count?: number;
}

export type MergeReason = 'variant' | 'word-order' | 'acronym' | 'typo' | 'similar';

export interface MergeCandidate {
  /** concept to merge away */
  a: string;
  /** suggested canonical concept (more used / long form) */
  b: string;
  score: number;
  reason: MergeReason;
}

const IRREGULAR: Record<string, string> = {
  matrices: 'matrix',
  indices: 'index',
  vertices: 'vertex',
  analyses: 'analysis',
  hypotheses: 'hypothesis',
  theses: 'thesis',
  axes: 'axis',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  children: 'child',
  people: 'person',
  mice: 'mouse',
  men: 'man',
  women: 'woman',
  series: 'series',
  species: 'species',
  bias: 'bias',
  alias: 'alias',
  atlas: 'atlas',
  canvas: 'canvas',
  gas: 'gas',
};

const MINOR_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'for', 'in', 'on', 'to', 'with', 'by', 'at', 'from']);

/** Naive English singularization of one lower-case word. */
export function singularize(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/sses$/.test(w)) return w.slice(0, -2);
  if (/(?:x|ch|sh|zz)es$/.test(w)) return w.slice(0, -2);
  if (/(?:ss|us|is|ics)$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Word tokens of a concept title: folded, punctuation split, singularized. */
export function conceptTokens(title: string): string[] {
  return title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (/^[\p{Lu}\p{N}]*\p{Lu}[\p{Lu}\p{N}]*s$/u.test(w) && w.length >= 3 ? fold(w.slice(0, -1)) : singularize(fold(w))));
}

/** Canonical comparison key: `Neural-Networks` → `neural network`. */
export function normalizeConcept(title: string): string {
  return conceptTokens(title).join(' ');
}

/** Initials of the significant words (`markov decision process` → `mdp`). */
export function acronymOf(tokens: string[]): string {
  return tokens
    .filter((t) => !MINOR_WORDS.has(t))
    .map((t) => t[0])
    .join('');
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Uint8Array(la);
  const mb = new Uint8Array(lb);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = mb[j] = 1;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token-set overlap where tokens count as equal when Jaro-Winkler ≥ 0.92 (both ≥ 4 chars). */
export function tokenSetSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const used = new Uint8Array(b.length);
  let shared = 0;
  for (const x of a) {
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue;
      const y = b[j];
      if (x === y || (x.length >= 4 && y.length >= 4 && jaroWinkler(x, y) >= 0.92)) {
        used[j] = 1;
        shared++;
        break;
      }
    }
  }
  return shared / (a.length + b.length - shared);
}

interface Prepared {
  title: string;
  count: number;
  norm: string;
  tokens: string[];
  sortedKey: string;
  acronym: string;
  digits: string;
  /** looks like an acronym as written (`RL`, `MDPs`, `GANs`) */
  isAcronym: boolean;
}

function prepare(c: ConceptLike): Prepared {
  const tokens = conceptTokens(c.title);
  const compact = c.title.replace(/[^\p{L}\p{N}]/gu, '');
  return {
    title: c.title,
    count: c.count ?? 0,
    norm: tokens.join(' '),
    tokens,
    sortedKey: [...tokens].sort().join(' '),
    acronym: tokens.length > 1 ? acronymOf(tokens) : '',
    digits: (c.title.match(/\d+/g) ?? []).join(','),
    isAcronym: tokens.length === 1 && /^[\p{Lu}\p{N}]{2,8}s?$/u.test(compact) && /\p{Lu}/u.test(compact),
  };
}

/** Pair key for dismissed merge suggestions (order-independent). */
export function pairKey(a: string, b: string): string {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  return x < y ? `${x}\u0001${y}` : `${y}\u0001${x}`;
}

/** Similarity of two prepared concepts, or null when they should not be merged. */
function compare(x: Prepared, y: Prepared): { score: number; reason: MergeReason } | null {
  if (!x.norm || !y.norm) return null;
  if (x.digits !== y.digits) return null; // GPT-3 vs GPT-4, Chapter 1 vs Chapter 2
  if (x.norm === y.norm) return { score: 1, reason: 'variant' };
  if (x.sortedKey === y.sortedKey) return { score: 0.95, reason: 'word-order' };
  const ax = x.isAcronym ? x.tokens[0] : '';
  const ay = y.isAcronym ? y.tokens[0] : '';
  if ((ax && ax === y.acronym) || (ay && ay === x.acronym)) return { score: 0.9, reason: 'acronym' };
  const minLen = Math.min(x.norm.length, y.norm.length);
  if (minLen < 4) return null;
  const jw = jaroWinkler(x.norm, y.norm);
  const ts = tokenSetSimilarity(x.tokens, y.tokens);
  // a single differing character in a long-enough string
  if (minLen >= 5 && jw >= 0.94 && x.tokens.length === y.tokens.length && editsAtMost1(x.norm, y.norm)) {
    return { score: 0.9, reason: 'typo' };
  }
  const threshold = minLen < 7 ? 0.96 : 0.92;
  if (jw >= threshold && ts >= 0.5) return { score: Math.min(0.89, jw * 0.6 + ts * 0.4), reason: 'similar' };
  if (ts >= 0.99 && x.tokens.length === y.tokens.length) return { score: 0.88, reason: 'similar' };
  return null;
}

function editsAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length;
  let eb = b.length;
  while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return ea - i <= 1 && eb - i <= 1;
}

const MAX_BLOCK = 120;
const WINDOW = 12;

/**
 * Ranked merge suggestions among `concepts`. `dismissed` holds {@link pairKey}s to skip.
 * In each candidate `b` is the suggested merge target.
 */
export function findMergeCandidates(
  concepts: ConceptLike[],
  dismissed: Iterable<string> = [],
  opts: { limit?: number; minScore?: number } = {},
): MergeCandidate[] {
  const skip = dismissed instanceof Set ? (dismissed as Set<string>) : new Set(dismissed);
  const items = concepts.map(prepare);
  const blocks = new Map<string, number[]>();
  const put = (key: string, i: number) => {
    const list = blocks.get(key);
    if (list) {
      if (list[list.length - 1] !== i) list.push(i);
    } else blocks.set(key, [i]);
  };
  items.forEach((it, i) => {
    if (!it.norm) return;
    for (const t of it.tokens) put('p:' + t.slice(0, 3), i);
    put('s:' + it.sortedKey, i);
    if (it.acronym.length >= 2) put('a:' + it.acronym, i);
    if (it.isAcronym) put('a:' + it.tokens[0], i);
  });

  const seen = new Set<number>();
  const n = items.length;
  const out: MergeCandidate[] = [];
  const minScore = opts.minScore ?? 0.85;
  const consider = (i: number, j: number) => {
    if (i === j) return;
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const key = lo * n + hi;
    if (seen.has(key)) return;
    seen.add(key);
    const x = items[lo];
    const y = items[hi];
    if (normalizeTitle(x.title) === normalizeTitle(y.title)) return;
    const res = compare(x, y);
    if (!res || res.score < minScore) return;
    if (skip.has(pairKey(x.title, y.title))) return;
    // target: long form for acronyms, else the more used, else the shorter title
    let from = x;
    let into = y;
    if (res.reason === 'acronym') {
      if (y.isAcronym) [from, into] = [y, x];
    } else if (x.count > y.count || (x.count === y.count && x.title.length < y.title.length)) {
      [from, into] = [y, x];
    }
    out.push({ a: from.title, b: into.title, score: res.score, reason: res.reason });
  };
  for (const list of blocks.values()) {
    if (list.length < 2) continue;
    if (list.length <= MAX_BLOCK) {
      for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) consider(list[p], list[q]);
    } else {
      const sorted = [...list].sort((p, q) => (items[p].norm < items[q].norm ? -1 : 1));
      for (let p = 0; p < sorted.length; p++) {
        for (let q = p + 1; q < Math.min(sorted.length, p + WINDOW); q++) consider(sorted[p], sorted[q]);
      }
    }
  }
  const countOf = new Map(items.map((it) => [it.title, it.count]));
  out.sort((p, q) => q.score - p.score || (countOf.get(q.a) ?? 0) + (countOf.get(q.b) ?? 0) - (countOf.get(p.a) ?? 0) - (countOf.get(p.b) ?? 0));
  return opts.limit ? out.slice(0, opts.limit) : out;
}
