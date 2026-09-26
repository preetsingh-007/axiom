/**
 * Unicode-aware tokenizer shared by full-text search, lenses and ghost-tag suggestion.
 *
 *  - words are runs of letters / digits / combining marks (so `\frac` yields `frac`:
 *    LaTeX command words stay searchable);
 *  - terms are lower-cased and diacritics are stripped (`Schrödinger` → `schrodinger`);
 *  - CJK runs (no spaces between words) are split into overlapping character bigrams.
 */

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NON_ASCII_RE = /[^\x00-\x7f]/;
const MARK_RE = /\p{M}/gu;

/** Terms longer than this are almost always noise (hashes, base64) and are skipped. */
export const MAX_TERM_LENGTH = 40;

/** Small English stop-word list; these are not indexed. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by can do does for from had has have he her his i if in into is it its ' +
    'me my no not of on or our she so such than that the their them then there these they this those to ' +
    'us was we were what when where which while who will with would you your'
  ).split(' '),
);

/** Lower-cases and strips diacritics. Cheap for ASCII input. */
export function fold(s: string): string {
  if (!NON_ASCII_RE.test(s)) return s.toLowerCase();
  return s.normalize('NFKD').replace(MARK_RE, '').toLowerCase();
}

/**
 * Calls `emit(term, start, end)` for every term of `text`; offsets refer to `text`.
 * CJK runs emit bigrams (offsets of the two characters). No filtering is applied.
 */
export function scanTerms(text: string, emit: (term: string, start: number, end: number) => void): void {
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const word = m[0];
    const start = m.index;
    if (CJK_RE.test(word)) {
      emitCjk(word, start, emit);
      continue;
    }
    const term = fold(word);
    if (term) emit(term, start, start + word.length);
  }
}

function emitCjk(word: string, start: number, emit: (term: string, start: number, end: number) => void) {
  // Split into CJK and non-CJK sub-runs; CJK sub-runs become bigrams.
  const chars = Array.from(word);
  let offset = start;
  let run: { ch: string; at: number }[] = [];
  let latin = '';
  let latinAt = start;
  const flushCjk = () => {
    if (run.length === 1) emit(run[0].ch, run[0].at, run[0].at + run[0].ch.length);
    for (let i = 0; i + 1 < run.length; i++) {
      emit(run[i].ch + run[i + 1].ch, run[i].at, run[i + 1].at + run[i + 1].ch.length);
    }
    run = [];
  };
  const flushLatin = () => {
    if (latin) {
      const t = fold(latin);
      if (t) emit(t, latinAt, latinAt + latin.length);
    }
    latin = '';
  };
  for (const ch of chars) {
    if (CJK_RE.test(ch)) {
      flushLatin();
      run.push({ ch, at: offset });
    } else {
      flushCjk();
      if (!latin) latinAt = offset;
      latin += ch;
    }
    offset += ch.length;
  }
  flushCjk();
  flushLatin();
}

/** True when a term is worth indexing (not a stop word, not a lone Latin character, not too long). */
export function isIndexable(term: string): boolean {
  if (term.length > MAX_TERM_LENGTH) return false;
  if (term.length === 1 && !CJK_RE.test(term)) return false;
  return !STOPWORDS.has(term);
}

/** All terms of a text, in order (unfiltered). */
export function terms(text: string): string[] {
  const out: string[] = [];
  scanTerms(text, (t) => out.push(t));
  return out;
}

/** Indexable terms of a text, in order. */
export function indexTerms(text: string): string[] {
  const out: string[] = [];
  scanTerms(text, (t) => {
    if (isIndexable(t)) out.push(t);
  });
  return out;
}

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent transposition. */
export function withinOneEdit(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (i === la) return true;
    // substitution
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    // transposition
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}
