/** Minimal LRU map with an eviction callback. */
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(
    private capacity: number,
    private onEvict?: (key: K, value: V) => boolean | void,
  ) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    this.trim();
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  get size(): number {
    return this.map.size;
  }

  private trim() {
    if (this.map.size <= this.capacity) return;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.capacity) break;
      // onEvict may veto (return false) e.g. when the doc is pinned by a view.
      if (this.onEvict && this.onEvict(k, v) === false) continue;
      this.map.delete(k);
    }
  }
}
