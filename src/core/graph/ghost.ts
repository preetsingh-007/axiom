/**
 * Semantic Ghost Tags: suggest tags for newly imported text (paper abstract, slide text…)
 * from the user's existing graph, optionally refined by an AI provider.
 *
 * Offline scoring (deterministic): every existing concept (title or alias) is matched against
 * the text — exact phrase (after folding and singularization), loose phrase (all words inside a
 * short window), acronym (only when the long form also occurs), or a one-edit fuzzy word for long
 * single-word concepts. A match is weighted by
 *   occurrences (log-damped) × specificity (rarity of the concept's words across all concept
 *   titles, IDF-like) × usage prior (how often the user applies the concept) × match quality,
 * and squashed into (0, 1).
 */

import type { AIRequest } from '../ai/types';
import { fold, STOPWORDS, withinOneEdit } from './tokenize';
import { acronymOf, conceptTokens, normalizeConcept, singularize } from './similarity';

export interface GhostConcept {
  title: string;
  count: number;
  aliases?: string[];
}

export interface GhostTag {
  tag: string;
  score: number;
  /** 'graph' = offline match against existing concepts, 'ai' = AI-only suggestion */
  origin: 'graph' | 'ai' | 'both';
  /** true when the tag is an existing concept (spelled as in the graph) */
  existing: boolean;
}

export interface GhostAI {
  complete(req: AIRequest): Promise<{ text: string }>;
}

export interface GhostOptions {
  text: string;
  concepts: GhostConcept[];
  /** maximum suggestions (default 8) */
  max?: number;
  /** tags to never suggest (already applied, dismissed); compared normalized */
  exclude?: string[];
  /** minimum score in (0, 1) (default 0.25) */
  minScore?: number;
  ai?: GhostAI;
}

const DEFAULT_EXCLUDE = ['flashcard'];
const SQUASH_K = 2.5;

interface ConceptForm {
  concept: GhostConcept;
  tokens: string[];
  /** written like an acronym (RL, MDPs): matched case-sensitively */
  acronym: string | null;
}

function textTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').matchAll(/[\p{L}\p{N}\p{M}]+/gu)) out.push(singularize(fold(m[0])));
  return out;
}

/** Start positions of `needle` as a contiguous word sequence in `hay`. */
function phrasePositions(hay: string[], needle: string[]): number[] {
  const out: number[] = [];
  if (!needle.length || needle.length > hay.length) return out;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    out.push(i);
  }
  return out;
}

/** Occurrences where every needle word appears within a window of `needle.length + 2` words. */
function countLoose(hay: string[], needle: string[]): number {
  if (needle.length < 2) return 0;
  const w = needle.length + 2;
  let n = 0;
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== needle[0] && !needle.includes(hay[i])) continue;
    const window = hay.slice(i, i + w);
    if (needle.every((t) => window.includes(t))) {
      n++;
      i += w - 1;
    }
  }
  return n;
}

/** Deterministic, offline ghost-tag suggestions (see module docs for the scoring). */
export function suggestGhostTagsLocal(opts: Omit<GhostOptions, 'ai'>): GhostTag[] {
  const max = opts.max ?? 8;
  const minScore = opts.minScore ?? 0.25;
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])].map(normalizeConcept));
  const hay = textTokens(opts.text);
  if (!hay.length) return [];
  const haySet = new Set(hay);
  const original = opts.text.normalize('NFKC');

  // concept-word document frequency across all concept titles (for specificity)
  const forms: ConceptForm[] = [];
  const df = new Map<string, number>();
  for (const c of opts.concepts) {
    const words = new Set<string>();
    for (const name of [c.title, ...(c.aliases ?? [])]) {
      const tokens = conceptTokens(name);
      if (!tokens.length) continue;
      const compact = name.replace(/[^\p{L}\p{N}]/gu, '');
      const acronym = tokens.length === 1 && /^\p{Lu}[\p{Lu}\p{N}]{1,7}s?$/u.test(compact) ? compact.replace(/s$/, '') : null;
      forms.push({ concept: c, tokens, acronym });
      for (const t of tokens) words.add(t);
    }
    for (const t of words) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const nConcepts = Math.max(1, opts.concepts.length);
  const idf = (t: string) => Math.log(1 + nConcepts / (df.get(t) ?? 1));

  // Longest concepts first: words already covered by a longer match ("Reinforcement Learning")
  // weaken shorter concepts inside it ("Learning").
  forms.sort((a, b) => b.tokens.length - a.tokens.length);
  const covered = new Uint8Array(hay.length);
  const best = new Map<GhostConcept, number>();
  for (const f of forms) {
    const { tokens } = f;
    if (exclude.has(tokens.join(' '))) continue;
    if (tokens.every((t) => STOPWORDS.has(t))) continue;
    let occ = 0;
    let quality = 1;
    if (f.acronym) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${f.acronym}s?(?![\\p{L}\\p{N}])`, 'gu');
      occ = [...original.matchAll(re)].length;
    } else {
      if (tokens.length === 1 && tokens[0].length < 3) continue;
      const positions = phrasePositions(hay, tokens);
      const free = positions.filter((p) => tokens.some((_, j) => !covered[p + j]));
      for (const p of positions) covered.fill(1, p, p + tokens.length);
      occ = free.length;
      if (positions.length && !free.length) {
        occ = positions.length;
        quality = 0.3;
      }
      if (!occ && tokens.length > 1) {
        occ = countLoose(hay, tokens);
        quality = 0.6;
      }
      if (tokens.length > 1) {
        // acronym of the long form counts once the long form itself appears
        const acr = acronymOf(tokens);
        if (occ && acr.length >= 2) {
          const re = new RegExp(`(?<![\\p{L}\\p{N}])${acr.toUpperCase()}s?(?![\\p{L}\\p{N}])`, 'gu');
          occ += [...original.matchAll(re)].length;
        }
      } else if (!occ && tokens[0].length >= 6) {
        for (const w of haySet) {
          if (w.length >= 6 && withinOneEdit(w, tokens[0])) {
            occ = hay.filter((x) => x === w).length;
            quality = 0.5;
            break;
          }
        }
      }
    }
    if (!occ) continue;
    const specificity = tokens.reduce((s, t) => s + (STOPWORDS.has(t) ? 0 : idf(t)), 0) / Math.max(1, tokens.length);
    const lengthBonus = 1 + 0.25 * (tokens.length - 1);
    const prior = 1 + 0.3 * Math.log1p(f.concept.count);
    const raw = (1 + Math.log(occ)) * specificity * lengthBonus * prior * quality;
    if (raw > (best.get(f.concept) ?? 0)) best.set(f.concept, raw);
  }

  const out: GhostTag[] = [];
  for (const [c, raw] of best) {
    const score = raw / (raw + SQUASH_K);
    if (score >= minScore) out.push({ tag: c.title, score: round(score), origin: 'graph', existing: true });
  }
  out.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return out.slice(0, max);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Extracts a JSON string array from an AI answer (tolerates prose / code fences around it). */
export function parseTagList(answer: string): string[] {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(answer.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'tag' in x ? String((x as { tag: unknown }).tag) : ''))
      .map((s) => s.replace(/^#/, '').replace(/^\[\[|\]\]$/g, '').trim())
      .filter((s) => s.length > 0 && s.length <= 80 && !/[\[\]|\n]/.test(s));
  } catch {
    return [];
  }
}

function buildPrompt(text: string, concepts: GhostConcept[], max: number): string {
  const known = [...concepts]
    .sort((a, b) => b.count - a.count)
    .slice(0, 200)
    .map((c) => c.title);
  return [
    `Suggest up to ${max} concise topic tags for the text below.`,
    'Prefer tags from the EXISTING list when they fit (use their exact spelling); add new tags only for important missing topics.',
    'Answer with a JSON array of strings only.',
    '',
    `EXISTING: ${JSON.stringify(known)}`,
    '',
    'TEXT:',
    text.slice(0, 6000),
  ].join('\n');
}

/**
 * Ghost-tag suggestions: the offline graph match, optionally merged with an AI answer
 * (task 'tags'). AI tags are mapped onto existing concept spellings when they normalize to one;
 * tags suggested by both sources are boosted. AI failures fall back to the offline result.
 */
export async function suggestGhostTags(opts: GhostOptions): Promise<GhostTag[]> {
  const max = opts.max ?? 8;
  const local = suggestGhostTagsLocal({ ...opts, max: Math.max(max, 16) });
  if (!opts.ai) return local.slice(0, max);
  let aiTags: string[] = [];
  try {
    const res = await opts.ai.complete({
      task: 'tags',
      prompt: buildPrompt(opts.text, opts.concepts, max),
      system: 'You label research notes with topic tags. Reply with JSON only.',
      json: true,
      maxTokens: 300,
      temperature: 0.2,
    });
    aiTags = parseTagList(res.text);
  } catch {
    return local.slice(0, max);
  }
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])].map(normalizeConcept));
  const byNorm = new Map<string, GhostConcept>();
  for (const c of opts.concepts) {
    for (const name of [c.title, ...(c.aliases ?? [])]) {
      const n = normalizeConcept(name);
      if (n && !byNorm.has(n)) byNorm.set(n, c);
    }
  }
  const merged = new Map<string, GhostTag>();
  for (const t of local) merged.set(normalizeConcept(t.tag), { ...t });
  aiTags.forEach((raw, rank) => {
    const concept = byNorm.get(normalizeConcept(raw));
    const tag = concept?.title ?? raw;
    const key = normalizeConcept(tag);
    if (!key || exclude.has(key)) return;
    const rankPenalty = rank * 0.02;
    const prev = merged.get(key);
    if (prev) {
      prev.score = round(Math.min(1, prev.score + 0.2));
      prev.origin = 'both';
    } else {
      merged.set(key, { tag, score: round((concept ? 0.55 : 0.4) - rankPenalty), origin: 'ai', existing: !!concept });
    }
  });
  return [...merged.values()].sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag)).slice(0, max);
}
