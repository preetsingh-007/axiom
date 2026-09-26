/**
 * Standardised, Better-BibTeX-like citation keys: `lastnameYEARfirstword`
 * (e.g. `vaswani2017attention`), ASCII-folded and lowercase, disambiguated with
 * a, b, c… suffixes.
 */
import type { BibMeta } from '../schema';
import { latexToUnicode } from './bibtex';
import { asciiFold, parseName } from './names';

const STOPWORDS = new Set(
  (
    'a an the on of in for and or to with at by from towards toward is are was were be via using into over about as ' +
    'its it this that these those how what why when which who do does can we our your their not no vs versus ' +
    'der die das des dem den ein eine und von zu le la les l un une des du de et el los las y del il lo gli'
  ).split(' '),
);

const clean = (s: string) => asciiFold(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Lowercase ASCII last name of the first author ("" when unknown). */
export function citeKeyAuthor(meta: BibMeta): string {
  const first = meta.authors?.find((a) => a.trim());
  if (!first) return '';
  const n = parseName(latexToUnicode(first));
  // include particles for names like "van der Waals" → "vanderwaals"? Better BibTeX drops them.
  return clean(n.last || n.first);
}

/** First significant title word, ASCII-folded, lowercase ("" when none). */
export function citeKeyTitleWord(title: string | undefined): string {
  if (!title) return '';
  const words = asciiFold(latexToUnicode(title).replace(/\$[^$]*\$/g, ' '))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.find((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w))) ?? '';
}

function suffix(i: number): string {
  // 0 → a, 25 → z, 26 → aa …
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Base key without disambiguation. */
export function baseCiteKey(meta: BibMeta): string {
  const last = citeKeyAuthor(meta);
  const year = meta.year && Number.isFinite(meta.year) ? String(Math.trunc(meta.year)).padStart(4, '0').slice(-4) : '';
  const word = citeKeyTitleWord(meta.title);
  if (last) return `${last}${year}${word}`;
  if (word) return `${word}${year}`;
  return `ref${year}`;
}

/**
 * Standardised cite key, unique among `existingKeys` (case-insensitive).
 * `vaswani2017attention`, then `vaswani2017attentiona`, `…b`, …
 */
export function makeCiteKey(meta: BibMeta, existingKeys: Iterable<string> = []): string {
  const taken = new Set<string>();
  for (const k of existingKeys) taken.add(k.toLowerCase());
  const base = baseCiteKey(meta);
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26 * 27; i++) {
    const k = base + suffix(i);
    if (!taken.has(k)) return k;
  }
  return `${base}${Date.now().toString(36)}`;
}
