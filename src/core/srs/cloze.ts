/**
 * Flashcard content generation from blocks tagged `#flashcard`.
 *
 *  - explicit clozes `{{c1::answer}}` / `{{c1::answer::hint}}` → one card per cN index;
 *  - `front :: back` (or a first line ending in "?") → one basic card;
 *  - otherwise offline heuristics: **bold** terms, definitions ("X is Y"), [[links]],
 *    inline $math$ and key numbers, capped at a few cards per block;
 *  - non-text blocks (math, ink, image, …) → a basic card whose answer is the block itself
 *    (the UI renders it from pageId/blockId; `back` holds a text fallback).
 *
 * Optional AI generation goes through anything shaped like `AIRouter.completeJSON` and falls
 * back to the heuristics on any failure.
 */
import type { BlockType } from '../schema';
import type { AIRequest, ProviderId } from '../ai/types';
import { clozeRequest } from '../ai/prompts';
import { hash64 } from '../util/ids';

/** Matches the routing tag (also `#flashcards`), with the whitespace before it. */
const TAG_RE = /(^|[ \t]+)#flashcards?(?![\w/-])/gim;

/** True when the text carries the `#flashcard` routing tag. */
export function hasFlashcardTag(text: string): boolean {
  TAG_RE.lastIndex = 0;
  const found = TAG_RE.test(text);
  TAG_RE.lastIndex = 0;
  return found;
}

/** Removes the `#flashcard` tag from text meant for display. */
export function stripFlashcardTag(text: string): string {
  return text
    .replace(TAG_RE, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- cloze parsing

export interface ClozeSpan {
  index: number;
  answer: string;
  hint?: string;
  /** offsets of the whole `{{cN::…}}` marker in the source text */
  start: number;
  end: number;
}

const OPEN_RE = /\{\{c(\d+)::/g;

/**
 * Parses cloze markers. Brace-aware, so LaTeX like `{{c1::$\sqrt{\frac{a}{b}}$}}` works, and
 * `$…$` segments are opaque (a `::` inside math is not a hint separator).
 */
export function parseClozes(text: string): ClozeSpan[] {
  const out: ClozeSpan[] = [];
  OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(text))) {
    const bodyStart = m.index + m[0].length;
    let depth = 0;
    let sep = -1;
    let end = -1;
    for (let i = bodyStart; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '$') {
        const close = text.indexOf('$', i + 1);
        if (close > i) {
          i = close;
          continue;
        }
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth > 0) depth--;
        else if (text[i + 1] === '}') {
          end = i;
          break;
        }
      } else if (c === ':' && text[i + 1] === ':' && depth === 0 && sep < 0) {
        sep = i;
        i++;
      }
    }
    if (end < 0) break;
    const answer = text.slice(bodyStart, sep >= 0 ? sep : end);
    const hint = sep >= 0 ? text.slice(sep + 2, end).trim() : undefined;
    out.push({ index: Number(m[1]), answer, hint: hint || undefined, start: m.index, end: end + 2 });
    OPEN_RE.lastIndex = end + 2;
  }
  return out;
}

/** Distinct cloze indices in ascending order. */
export function clozeIndices(text: string): number[] {
  return [...new Set(parseClozes(text).map((s) => s.index))].sort((a, b) => a - b);
}

export interface ClozeFormat {
  hidden: (hint: string | undefined) => string;
  revealed: (answer: string) => string;
}

/** Default: inline HTML wrappers (survive markdown rendering; style `.cloze-hidden` / `.cloze-revealed`). */
export const DEFAULT_CLOZE_FORMAT: ClozeFormat = {
  hidden: (hint) => `<span class="cloze cloze-hidden">[${hint ?? '...'}]</span>`,
  revealed: (answer) => `<mark class="cloze cloze-revealed">${answer}</mark>`,
};

/**
 * Markdown for one side of a cloze card: the active cloze (`index`) is shown as `[...]`
 * (or `[hint]`) or, when `reveal` is true, as its highlighted answer; every other cloze is
 * shown as plain text. The `#flashcard` tag is stripped.
 */
export function renderCloze(front: string, index: number, reveal: boolean, format: ClozeFormat = DEFAULT_CLOZE_FORMAT): string {
  const text = stripFlashcardTag(front);
  let out = '';
  let pos = 0;
  for (const s of parseClozes(text)) {
    out += text.slice(pos, s.start);
    if (s.index === index) out += reveal ? format.revealed(s.answer) : format.hidden(s.hint);
    else out += s.answer;
    pos = s.end;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------- heuristics

interface Candidate {
  /** replaced range */
  start: number;
  end: number;
  answer: string;
  prefix?: string;
  suffix?: string;
  priority: number;
}

interface Range {
  start: number;
  end: number;
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

const PRONOUN_RE = /^(it|this|that|these|those|there|he|she|they|we|you|i|which|what|who|here|one)\b/i;
const DEFINITION_RE =
  /^(\s*(?:(?:the|a|an)\s+)?)(.+?)\s+(?:is defined as|is known as|is called|are called|refers to|refer to|denotes|denote|means|is|are)\s+(.+?)[.!]?\s*$/i;

/** Returns every heuristic candidate, unfiltered (priority: lower = better). */
function candidates(text: string): { cands: Candidate[]; protectedRanges: Range[] } {
  const cands: Candidate[] = [];
  const prot: Range[] = [];
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) fn(m);
  };

  // regions that must never be split or partially clozed
  scan(/`[^`\n]+`/g, (m) => prot.push({ start: m.index, end: m.index + m[0].length }));
  scan(/\]\([^)\s]*\)/g, (m) => prot.push({ start: m.index, end: m.index + m[0].length }));
  scan(/<[^>\n]+>/g, (m) => prot.push({ start: m.index, end: m.index + m[0].length }));

  scan(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (m) => {
    const start = m.index + m[1].length;
    prot.push({ start: m.index, end: m.index + m[0].length });
    cands.push({ start, end: start + m[2].length, answer: m[2], priority: 1 });
  });
  scan(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (m) => {
    const label = (m[2] ?? m[1]).trim();
    prot.push({ start: m.index, end: m.index + m[0].length });
    cands.push({ start: m.index, end: m.index + m[0].length, answer: label, priority: 3 });
  });
  scan(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?!\$)/g, (m) => {
    prot.push({ start: m.index, end: m.index + m[0].length });
    cands.push({ start: m.index, end: m.index + m[0].length, answer: m[0], priority: 4 });
  });
  scan(/(?<![\w.,$\\])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?%)?(?![\w])/g, (m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/^\s*$/.test(text.slice(lineStart, m.index)) && /^\d+[.)]\s/.test(text.slice(m.index))) return; // list numbering
    const value = m[0];
    if (!m[2] && !m[1].includes('.') && m[1].replace(/,/g, '').length < 2) return; // single digits are rarely key facts
    cands.push({ start: m.index, end: m.index + value.length, answer: value, priority: 5 });
  });

  // proper nouns / named concepts (capitalised runs that don't start a sentence)
  scan(/\b[A-Z][\p{L}\p{N}'-]*(?:\s+[A-Z][\p{L}\p{N}'-]*){0,2}/gu, (m) => {
    let start = m.index;
    let term = m[0];
    const article = /^(?:The|A|An)\s+/.exec(term);
    if (article) {
      start += article[0].length;
      term = term.slice(article[0].length);
    }
    if (term.length < 3 || /^[A-Z]$/.test(term)) return;
    // sentence-initial capitals carry no signal ("The Bellman …" is fine: the article starts the sentence)
    if (!article && /(^|[.!?:\n])\s*$/.test(text.slice(0, m.index))) return;
    cands.push({ start, end: start + term.length, answer: term, priority: 5.5 });
  });

  // definitions, sentence by sentence
  const sentRe = /[^.!?\n]+[.!?]?/g;
  scan(sentRe, (m) => {
    const d = DEFINITION_RE.exec(m[0]);
    if (!d) return;
    const subjStart = m.index + d[1].length;
    const subject = d[2].replace(/[\s,:;]+$/, '');
    const words = subject.split(/\s+/).filter(Boolean);
    if (subject.length >= 2 && words.length <= 6 && !PRONOUN_RE.test(subject) && !/[,;]/.test(subject)) {
      cands.push({ start: subjStart, end: subjStart + subject.length, answer: subject, priority: 2 });
      return;
    }
    const pred = d[3];
    const predWords = pred.split(/\s+/);
    // only substantial predicates: 2–8 words, at least two of them longer than 3 letters
    if (predWords.length <= 8 && predWords.filter((x) => x.replace(/\W/g, '').length > 3).length >= 2) {
      const predStart = m.index + m[0].lastIndexOf(pred);
      cands.push({ start: predStart, end: predStart + pred.length, answer: pred, priority: 6 });
    }
  });
  return { cands, protectedRanges: prot };
}

/**
 * Heuristic cloze generation. Returns the text with up to `max` `{{cN::…}}` markers
 * (c1 = most salient), or null when nothing is worth clozing.
 */
export function heuristicCloze(text: string, max = 3): string | null {
  const { cands, protectedRanges } = candidates(text);
  cands.sort((a, b) => a.priority - b.priority || a.start - b.start);
  const chosen: (Candidate & { index: number })[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (chosen.length >= max) break;
    const key = c.answer.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    if (chosen.some((o) => overlaps(o, c))) continue;
    // must not cut through a protected region (being exactly one, or inside bold, is fine)
    const cuts = protectedRanges.some(
      (p) => overlaps(p, c) && !(p.start <= c.start && p.end >= c.end) && !(c.start <= p.start && c.end >= p.end),
    );
    const insideCode = protectedRanges.some((p) => text[p.start] === '`' && overlaps(p, c));
    if (cuts || insideCode) continue;
    // a definition subject/predicate that swallows a whole marked-up region would duplicate it
    if ((c.priority === 2 || c.priority === 6) && protectedRanges.some((p) => c.start <= p.start && c.end >= p.end)) continue;
    seen.add(key);
    chosen.push({ ...c, index: chosen.length + 1 });
  }
  if (!chosen.length) return null;
  chosen.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const c of chosen) {
    out += text.slice(pos, c.start) + `{{c${c.index}::${c.answer}}}`;
    pos = c.end;
  }
  return out + text.slice(pos);
}

/**
 * Splits a multi-cloze text into one text per index, each with a single `{{c1::…}}`
 * (other clozes unwrapped to plain text). This is the JSON item format of the 'cloze' AI task.
 */
export function splitClozes(text: string): string[] {
  const spans = parseClozes(text);
  return clozeIndices(text).map((idx) => {
    let out = '';
    let pos = 0;
    for (const s of spans) {
      out += text.slice(pos, s.start);
      out += s.index === idx ? `{{c1::${s.answer}${s.hint ? '::' + s.hint : ''}}}` : s.answer;
      pos = s.end;
    }
    return out + text.slice(pos);
  });
}

// ---------------------------------------------------------------- cards

/** What the indexer knows about a flashcard block. */
export interface FlashcardInput {
  type: BlockType;
  /** block text (markdown for text blocks, LaTeX for math, caption for images/ink) */
  text: string;
  pageTitle: string;
  /** text preceding the block on the page, for context on basic cards */
  contextText?: string;
}

/** Card content before scheduling state is attached. */
export interface GeneratedCard {
  kind: 'cloze' | 'basic';
  /** cloze text with {{cN::…}} markers, or the question of a basic card */
  front: string;
  /** answer of a basic card (text fallback when the block itself can't be rendered) */
  back?: string;
  /** cN for clozes; 0 for basic cards */
  clozeIndex: number;
}

/** Hash of everything card content is derived from; a change triggers regeneration. */
export function flashcardSourceHash(src: FlashcardInput): string {
  const ctx = src.type === 'text' ? '' : `${src.pageTitle}\u0000${src.contextText ?? ''}`;
  return hash64(`${src.type}\u0000${src.text}\u0000${ctx}`);
}

function recallFront(src: FlashcardInput): string {
  const ctx = src.contextText ? stripFlashcardTag(src.contextText).trim() : '';
  const title = src.pageTitle.trim() || 'Untitled';
  return `Recall: **${title}**${ctx ? `\n\n${ctx}` : ''}`;
}

function blockAnswer(src: FlashcardInput): string {
  const text = stripFlashcardTag(src.text);
  if (!text) return '';
  if (src.type === 'math') return `$$\n${text}\n$$`;
  if (src.type === 'code') return '```\n' + text + '\n```';
  return text;
}

/** Splits "question :: answer" (outside cloze markers) or "question?\nanswer". */
function splitQA(text: string): { front: string; back: string } | null {
  const sep = text.search(/\s::\s/);
  if (sep > 0) {
    const front = text.slice(0, sep).trim();
    const back = text.slice(sep).replace(/^\s::\s/, '').trim();
    if (front && back) return { front, back };
  }
  const nl = text.indexOf('\n');
  if (nl > 0 && text.slice(0, nl).trim().endsWith('?')) {
    const back = text.slice(nl + 1).trim();
    if (back) return { front: text.slice(0, nl).trim(), back };
  }
  return null;
}

function clozeCards(front: string): GeneratedCard[] {
  return clozeIndices(front).map((clozeIndex) => ({ kind: 'cloze', front, clozeIndex }));
}

/** Content for cards that don't need (or can't use) AI: explicit clozes, Q/A, non-text blocks. */
function deterministicCards(src: FlashcardInput): GeneratedCard[] | null {
  if (src.type !== 'text') return [{ kind: 'basic', front: recallFront(src), back: blockAnswer(src), clozeIndex: 0 }];
  const text = stripFlashcardTag(src.text);
  if (clozeIndices(text).length) return clozeCards(text);
  const qa = splitQA(text);
  if (qa) return [{ kind: 'basic', front: qa.front, back: qa.back, clozeIndex: 0 }];
  if (!text) return [];
  return null;
}

export interface GenerateOptions {
  /** max heuristic/AI cloze cards per block (default 3) */
  max?: number;
}

/** Offline, deterministic card generation for one flashcard block. */
export function generateCards(src: FlashcardInput, opts: GenerateOptions = {}): GeneratedCard[] {
  const fixed = deterministicCards(src);
  if (fixed) return fixed;
  const text = stripFlashcardTag(src.text);
  const cloze = heuristicCloze(text, opts.max ?? 3);
  if (cloze) return clozeCards(cloze);
  return [{ kind: 'basic', front: recallFront(src), back: text, clozeIndex: 0 }];
}

/** The slice of `AIRouter` that AI cloze generation needs. */
export interface ClozeAI {
  completeJSON<T>(
    req: AIRequest,
    validate: (value: unknown) => T | undefined,
    signal?: AbortSignal,
  ): Promise<{ value: T; provider: ProviderId }>;
}

const norm = (s: string) => s.replace(/[$*_`[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Validates the 'cloze' task output: `[{"text": "… {{c1::…}} …"}]`. Items without a cloze,
 * or whose answers don't occur in the source, are dropped. Returns undefined when empty.
 */
export function parseClozeItems(value: unknown, source: string, max = 3): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { cards?: unknown }).cards)
      ? (value as { cards: unknown[] }).cards
      : null;
  if (!list) return undefined;
  const src = norm(source);
  const out: string[] = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined;
    if (typeof text !== 'string') continue;
    const spans = parseClozes(text);
    if (!spans.length || !spans.every((s) => norm(s.answer) && src.includes(norm(s.answer)))) continue;
    out.push(text.trim());
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/** Turns AI items (one card each) into cards: item i's clozes are renumbered to c(i+1). */
export function clozeItemsToCards(items: string[]): GeneratedCard[] {
  return items.map((text, i) => ({
    kind: 'cloze',
    front: text.replace(/\{\{c\d+::/g, `{{c${i + 1}::`),
    clozeIndex: i + 1,
  }));
}

/**
 * AI-assisted generation (task 'cloze'). Explicit clozes, Q/A and non-text blocks never hit
 * the network; any AI failure or invalid output falls back to `generateCards`.
 */
export async function generateCardsAI(
  src: FlashcardInput,
  ai: ClozeAI,
  opts: GenerateOptions & { signal?: AbortSignal } = {},
): Promise<GeneratedCard[]> {
  const fixed = deterministicCards(src);
  if (fixed) return fixed;
  const text = stripFlashcardTag(src.text);
  const max = opts.max ?? 3;
  try {
    const { value } = await ai.completeJSON(clozeRequest(text, max), (v) => parseClozeItems(v, text, max), opts.signal);
    return clozeItemsToCards(value);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return generateCards(src, opts);
  }
}
