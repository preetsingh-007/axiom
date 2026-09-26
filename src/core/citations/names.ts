/**
 * Person-name handling shared by the BibTeX, Zotero and cite-key code.
 * Understands "First von Last", "von Last, First" and "von Last, Jr, First",
 * plus brace-protected corporate names ("{World Health Organization}").
 */

export interface PersonName {
  first: string;
  von: string;
  last: string;
  jr: string;
  /** a corporate / literal name that must not be split */
  literal?: boolean;
}

const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'ter', 'ten', 'bin', 'ibn', 'al', 'el', "d'", 'st.']);
const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|v|junior|senior)$/i;

/** Splits on whitespace outside braces. */
function words(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const isLowerWord = (w: string) => /^\p{Ll}/u.test(w.replace(/^[{\\]+/, '')) || PARTICLES.has(w.toLowerCase());

export function parseName(raw: string): PersonName {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (/^\{[^{}]*\}$/.test(s)) return { first: '', von: '', last: s.slice(1, -1), jr: '', literal: true };
  const parts = splitTopLevel(s, ',');
  if (parts.length >= 2) {
    // "von Last, First" or "von Last, Jr, First"
    const lastWords = words(parts[0]);
    const first = parts.length >= 3 ? parts.slice(2).join(', ') : parts[1];
    const jr = parts.length >= 3 ? parts[1] : '';
    let i = 0;
    while (i < lastWords.length - 1 && isLowerWord(lastWords[i])) i++;
    return { first, von: lastWords.slice(0, i).join(' '), last: lastWords.slice(i).join(' '), jr };
  }
  const ws = words(s);
  if (ws.length === 1) return { first: '', von: '', last: ws[0], jr: '' };
  let jr = '';
  if (ws.length > 2 && SUFFIX.test(ws[ws.length - 1])) jr = ws.pop()!;
  // von part: first lowercase word (not the last word) starts it
  let vonStart = -1;
  for (let i = 1; i < ws.length - 1; i++) {
    if (isLowerWord(ws[i])) {
      vonStart = i;
      break;
    }
  }
  if (vonStart >= 0) {
    let vonEnd = vonStart;
    while (vonEnd < ws.length - 1 && isLowerWord(ws[vonEnd])) vonEnd++;
    return { first: ws.slice(0, vonStart).join(' '), von: ws.slice(vonStart, vonEnd).join(' '), last: ws.slice(vonEnd).join(' '), jr };
  }
  return { first: ws.slice(0, -1).join(' '), von: '', last: ws[ws.length - 1], jr };
}

/** "Ada Lovelace", "Johannes van der Waals", "Martin Luther King Jr." */
export function formatDisplayName(n: PersonName): string {
  return [n.first, n.von, n.last, n.jr].filter(Boolean).join(' ').replace(/[{}]/g, '');
}

/** "Lovelace, Ada", "van der Waals, Johannes", "King, Jr., Martin Luther", "{World Health Organization}" */
export function formatBibtexName(n: PersonName): string {
  if (n.literal) return `{${n.last}}`;
  const last = [n.von, n.last].filter(Boolean).join(' ');
  if (!n.first) return n.jr ? `${last}, ${n.jr},` : last;
  return n.jr ? `${last}, ${n.jr}, ${n.first}` : `${last}, ${n.first}`;
}

/** Splits a BibTeX author field on top-level " and ". */
export function splitBibtexAuthors(field: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const s = field.replace(/\s+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /^ and /i.test(s.slice(i, i + 5))) {
      out.push(cur.trim());
      cur = '';
      i += 4;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((a) => a && a.toLowerCase() !== 'others');
}

/** Folds to lowercase ASCII (diacritics removed, ß→ss, æ→ae…). */
export function asciiFold(s: string): string {
  return s
    .replace(/ß/g, 'ss')
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .replace(/[Øø]/g, 'o')
    .replace(/[Łł]/g, 'l')
    .replace(/[Đđ]/g, 'd')
    .replace(/[Þþ]/g, 'th')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}
