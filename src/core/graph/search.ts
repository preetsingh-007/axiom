/**
 * In-memory inverted index with BM25 ranking, prefix matching for the last query token and a
 * one-edit fuzzy fallback. Designed for ~100k short documents (blocks) with incremental updates:
 *
 *  - postings are packed `[docId, tf, docId, tf, …]` number arrays (SMI-packed by V8);
 *  - removed documents are tombstoned and skipped at query time; postings are compacted
 *    (with doc-id renumbering) once tombstones exceed half of the id space;
 *  - scores are accumulated into reusable typed arrays and the top-k is selected with a heap,
 *    so a query never allocates per-document objects.
 */

import { indexTerms, isIndexable, scanTerms, STOPWORDS, withinOneEdit } from './tokenize';

/** Payload stored for each document. `doc` is maintained by the index (it changes on compaction). */
export interface SearchPayload {
  doc: number;
}

export interface SearchHit<T> {
  payload: T;
  score: number;
  /** index terms that matched (for highlighting) */
  terms: Set<string>;
}

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_TOKENS = 12;
const PREFIX_SCAN_LIMIT = 5000;
const PREFIX_EXPANSIONS = 48;
const FUZZY_EXPANSIONS = 8;
const PREFIX_WEIGHT = 0.7;
const FUZZY_WEIGHT = 0.5;

interface Expansion {
  term: string;
  weight: number;
}

export class SearchIndex<T extends SearchPayload> {
  private docs: (T | null)[] = [];
  private lens: number[] = [];
  private boosts: number[] = [];
  private postings = new Map<string, number[]>();
  private sorted: string[] = [];
  private fresh: string[] = [];
  private byLen = new Map<number, string[]>();
  private liveCount = 0;
  private totalLen = 0;
  private scores = new Float64Array(0);
  private masks = new Uint32Array(0);
  private touched = new Int32Array(0);

  /** Number of live documents. */
  get size(): number {
    return this.liveCount;
  }

  /** Indexes `text` for `payload` (sets `payload.doc`). `boost` multiplies the document's score. */
  add(text: string, payload: T, boost = 1): number {
    const id = this.docs.length;
    payload.doc = id;
    this.docs.push(payload);
    this.boosts.push(boost);
    const tf = new Map<string, number>();
    let len = 0;
    for (const t of indexTerms(text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      len++;
    }
    this.lens.push(len);
    this.totalLen += len;
    this.liveCount++;
    for (const [term, n] of tf) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
        this.fresh.push(term);
        let bucket = this.byLen.get(term.length);
        if (!bucket) this.byLen.set(term.length, (bucket = []));
        bucket.push(term);
      }
      list.push(id, n);
    }
    if (this.fresh.length > Math.max(2048, this.sorted.length >> 2)) this.mergeFresh();
    return id;
  }

  /** Tombstones a document. */
  remove(payload: T): void {
    const id = payload.doc;
    if (this.docs[id] !== payload) return;
    this.docs[id] = null;
    this.totalLen -= this.lens[id];
    this.liveCount--;
    if (this.docs.length > 4096 && this.liveCount < this.docs.length / 2) this.compact();
  }

  /** Merges pending terms into the sorted term list (call after bulk loads). */
  optimize(): void {
    this.mergeFresh();
  }

  private mergeFresh() {
    if (!this.fresh.length) return;
    const add = this.fresh.sort();
    this.fresh = [];
    const a = this.sorted;
    const out: string[] = new Array(a.length + add.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < a.length && j < add.length) out[k++] = a[i] < add[j] ? a[i++] : add[j++];
    while (i < a.length) out[k++] = a[i++];
    while (j < add.length) out[k++] = add[j++];
    this.sorted = out;
  }

  /** Drops tombstones, renumbers documents and removes empty terms. */
  private compact() {
    const remap = new Int32Array(this.docs.length).fill(-1);
    const docs: T[] = [];
    const lens: number[] = [];
    const boosts: number[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i];
      if (!d) continue;
      remap[i] = docs.length;
      d.doc = docs.length;
      docs.push(d);
      lens.push(this.lens[i]);
      boosts.push(this.boosts[i]);
    }
    const postings = new Map<string, number[]>();
    for (const [term, list] of this.postings) {
      const next: number[] = [];
      for (let p = 0; p < list.length; p += 2) {
        const nid = remap[list[p]];
        if (nid !== -1) next.push(nid, list[p + 1]);
      }
      if (next.length) postings.set(term, next);
    }
    this.docs = docs;
    this.lens = lens;
    this.boosts = boosts;
    this.postings = postings;
    this.sorted = [...postings.keys()].sort();
    this.fresh = [];
    this.byLen = new Map();
    for (const t of this.sorted) {
      let bucket = this.byLen.get(t.length);
      if (!bucket) this.byLen.set(t.length, (bucket = []));
      bucket.push(t);
    }
  }

  private df(term: string): number {
    const l = this.postings.get(term);
    return l ? l.length >> 1 : 0;
  }

  /** Terms starting with `prefix` (excluding `prefix` itself), most frequent first. */
  private prefixTerms(prefix: string, max: number): string[] {
    const found: string[] = [];
    const s = this.sorted;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < s.length && found.length < PREFIX_SCAN_LIMIT && s[i].startsWith(prefix); i++) {
      if (s[i] !== prefix) found.push(s[i]);
    }
    for (const t of this.fresh) if (t !== prefix && t.startsWith(prefix)) found.push(t);
    if (found.length <= max) return found;
    return found
      .map((t) => ({ t, df: this.df(t) }))
      .sort((a, b) => b.df - a.df)
      .slice(0, max)
      .map((x) => x.t);
  }

  private fuzzyTerms(token: string, max: number): string[] {
    const found: string[] = [];
    for (let l = token.length - 1; l <= token.length + 1; l++) {
      const bucket = this.byLen.get(l);
      if (!bucket) continue;
      for (const t of bucket) if (withinOneEdit(token, t)) found.push(t);
    }
    return found
      .sort((a, b) => this.df(b) - this.df(a))
      .slice(0, max);
  }

  /**
   * Expands query tokens into index terms. Returns one expansion list per required token.
   * `prefixLast`: the last token also matches as a prefix. `fuzzy`: tokens ≥ 5 chars without
   * any match fall back to terms within one edit.
   */
  private expand(query: string, prefixLast: boolean, fuzzy: boolean): Expansion[][] {
    const raw: string[] = [];
    scanTerms(query, (t) => {
      if (!raw.includes(t)) raw.push(t);
    });
    const tokens = raw.slice(0, MAX_QUERY_TOKENS);
    const endsWithSpace = /\s$/.test(query);
    const out: Expansion[][] = [];
    tokens.forEach((token, i) => {
      const isLast = i === tokens.length - 1 && prefixLast && !endsWithSpace;
      const list: Expansion[] = [];
      if (isIndexable(token) && this.postings.has(token)) list.push({ term: token, weight: 1 });
      if (isLast) for (const t of this.prefixTerms(token, PREFIX_EXPANSIONS)) list.push({ term: t, weight: PREFIX_WEIGHT });
      if (!list.length && fuzzy && token.length >= 5) {
        for (const t of this.fuzzyTerms(token, FUZZY_EXPANSIONS)) list.push({ term: t, weight: FUZZY_WEIGHT });
      }
      // Stop words / single letters that match nothing are not required.
      if (!list.length && (STOPWORDS.has(token) || !isIndexable(token))) return;
      out.push(list);
    });
    return out;
  }

  private ensureCapacity() {
    const n = this.docs.length;
    if (this.scores.length >= n) return;
    const cap = Math.max(1024, n * 2);
    this.scores = new Float64Array(cap);
    this.masks = new Uint32Array(cap);
    this.touched = new Int32Array(cap);
  }

  /**
   * Accumulates BM25 scores for the expanded query. Returns the number of touched docs;
   * `this.touched[0..n)` holds their ids, `this.masks` which tokens they matched.
   */
  private accumulate(groups: Expansion[][]): number {
    this.ensureCapacity();
    const N = Math.max(1, this.liveCount);
    const avgdl = this.totalLen / N || 1;
    const { scores, masks, touched, docs, lens, boosts } = this;
    let count = 0;
    groups.forEach((group, gi) => {
      const bit = 1 << gi;
      for (const { term, weight } of group) {
        const list = this.postings.get(term);
        if (!list) continue;
        const df = list.length >> 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) * weight;
        for (let p = 0; p < list.length; p += 2) {
          const id = list[p];
          if (docs[id] === null) continue;
          const tf = list[p + 1];
          const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * lens[id]) / avgdl));
          if (masks[id] === 0) touched[count++] = id;
          masks[id] |= bit;
          scores[id] += s * boosts[id];
        }
      }
    });
    return count;
  }

  private reset(count: number) {
    for (let i = 0; i < count; i++) {
      const id = this.touched[i];
      this.scores[id] = 0;
      this.masks[id] = 0;
    }
  }

  /**
   * Ranked search. Documents matching every token rank first; if none do, partial matches are
   * returned with a proportional penalty.
   */
  search(query: string, limit = 20, opts: { prefix?: boolean; fuzzy?: boolean } = {}): SearchHit<T>[] {
    const groups = this.expand(query, opts.prefix ?? true, opts.fuzzy ?? true);
    if (!groups.length || limit <= 0) return [];
    const full = groups.length >= 32 ? 0xffffffff : (1 << groups.length) - 1;
    const count = this.accumulate(groups);
    const { scores, masks, touched } = this;
    let anyFull = false;
    for (let i = 0; i < count; i++) {
      if (masks[touched[i]] === full) {
        anyFull = true;
        break;
      }
    }
    // top-k min-heap over (score, id)
    const heapIds: number[] = [];
    const heapScores: number[] = [];
    const push = (id: number, s: number) => {
      if (heapIds.length < limit) {
        heapIds.push(id);
        heapScores.push(s);
        let i = heapIds.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heapScores[parent] <= heapScores[i]) break;
          swap(heapIds, heapScores, i, parent);
          i = parent;
        }
      } else if (s > heapScores[0]) {
        heapIds[0] = id;
        heapScores[0] = s;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heapIds.length && heapScores[l] < heapScores[m]) m = l;
          if (r < heapIds.length && heapScores[r] < heapScores[m]) m = r;
          if (m === i) break;
          swap(heapIds, heapScores, i, m);
          i = m;
        }
      }
    };
    for (let i = 0; i < count; i++) {
      const id = touched[i];
      const mask = masks[id];
      if (anyFull) {
        if (mask === full) push(id, scores[id]);
      } else {
        push(id, scores[id] * (popcount(mask) / groups.length));
      }
    }
    const order = heapIds.map((id, i) => ({ id, s: heapScores[i] })).sort((a, b) => b.s - a.s);
    const hits: SearchHit<T>[] = order.map(({ id, s }) => ({
      payload: this.docs[id]!,
      score: s,
      terms: new Set<string>(),
    }));
    this.reset(count);
    // matched terms for the returned docs only
    if (hits.length) {
      const wanted = new Map<number, Set<string>>();
      for (const h of hits) wanted.set(h.payload.doc, h.terms);
      for (const group of groups) {
        for (const { term } of group) {
          const list = this.postings.get(term)!;
          for (let p = 0; p < list.length; p += 2) wanted.get(list[p])?.add(term);
        }
      }
    }
    return hits;
  }

  /**
   * Unranked boolean match: payloads of documents containing every token of `query`
   * (exact terms, plus prefix expansions of every token when `prefix` is set).
   */
  matchAll(query: string, opts: { prefix?: boolean } = {}): T[] {
    const groups: Expansion[][] = [];
    const seen = new Set<string>();
    let unmatched = false;
    scanTerms(query, (token) => {
      if (seen.has(token) || unmatched) return;
      seen.add(token);
      const list: Expansion[] = [];
      if (this.postings.has(token)) list.push({ term: token, weight: 1 });
      if (opts.prefix && token.length >= 2) for (const t of this.prefixTerms(token, PREFIX_SCAN_LIMIT)) list.push({ term: t, weight: 1 });
      if (!list.length) {
        if (!isIndexable(token)) return; // stop word: not required
        unmatched = true;
        return;
      }
      if (groups.length < 32) groups.push(list);
    });
    if (unmatched || !groups.length) return [];
    const full = groups.length >= 32 ? 0xffffffff : (1 << groups.length) - 1;
    const count = this.accumulate(groups);
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.touched[i];
      if (this.masks[id] === full) out.push(this.docs[id]!);
    }
    this.reset(count);
    return out;
  }
}

function swap(ids: number[], scores: number[], a: number, b: number) {
  const ti = ids[a];
  ids[a] = ids[b];
  ids[b] = ti;
  const ts = scores[a];
  scores[a] = scores[b];
  scores[b] = ts;
}

function popcount(x: number): number {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}
