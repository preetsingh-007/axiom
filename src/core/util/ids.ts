const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random, URL-safe id (~71 bits at the default length). */
export function uid(len = 12): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** FNV-1a 32-bit hash → base36. Deterministic, fast, non-cryptographic. */
export function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 64-bit-ish deterministic hash (two FNV passes with different seeds). */
export function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x100001b3);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function bytesHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x100001b3);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + bytes.length.toString(36);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalises a concept title so "Reinforcement  learning" == "reinforcement learning". */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Deterministic page id for concept pages: two devices creating [[X]] offline converge on one page. */
export function conceptPageId(title: string): string {
  return 'c-' + hash64(normalizeTitle(title));
}

export function dailyPageId(date: string): string {
  return 'd-' + date;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return isoDate(dt);
}

export function formatDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
