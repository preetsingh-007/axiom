/**
 * Thin promise wrapper around IndexedDB.
 *
 * Stores:
 *  - updates:  { docId, seq, data } — append-only Yjs update log per doc (key: [docId, seq])
 *  - blobs:    source files & images, keyed by content hash
 *  - kv:       local-only key/value (secrets, device settings, sync cursors, derived index)
 */

const DB_VERSION = 1;

/** Random per-connection id; part of every update key so tabs can never overwrite each other's rows. */
const WRITER = Math.random().toString(36).slice(2, 10);

export interface UpdateRow {
  docId: string;
  seq: number;
  writer: string;
  data: Uint8Array;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export class AxiomDB {
  private constructor(private db: IDBDatabase) {}

  static async open(name: string): Promise<AxiomDB> {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('updates')) {
        db.createObjectStore('updates', { keyPath: ['docId', 'seq', 'writer'] });
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    const db = await req(open);
    return new AxiomDB(db);
  }

  close() {
    this.db.close();
  }

  // ---------- update log ----------

  async getUpdates(docId: string): Promise<UpdateRow[]> {
    const tx = this.db.transaction('updates', 'readonly');
    const range = IDBKeyRange.bound([docId, -Infinity], [docId, Infinity]);
    return req(tx.objectStore('updates').getAll(range)) as Promise<UpdateRow[]>;
  }

  private lastSeq = 0;

  /** Monotonic per connection; combined with WRITER the key is globally unique. */
  private nextSeq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, Date.now() * 1000);
    return this.lastSeq;
  }

  async putUpdate(docId: string, data: Uint8Array): Promise<void> {
    const tx = this.db.transaction('updates', 'readwrite');
    tx.objectStore('updates').put({ docId, seq: this.nextSeq(), writer: WRITER, data } satisfies UpdateRow);
    await txDone(tx);
  }

  /**
   * Compacts a doc's update log in ONE readwrite transaction (read + merge + replace), so
   * concurrent appends from other tabs can never be dropped. `merge` must be synchronous.
   * Returns the merged update (or null when there was nothing to compact).
   */
  async compact(docId: string, merge: (updates: Uint8Array[]) => Uint8Array): Promise<Uint8Array | null> {
    const tx = this.db.transaction('updates', 'readwrite');
    const store = tx.objectStore('updates');
    const range = IDBKeyRange.bound([docId, -Infinity], [docId, Infinity]);
    let merged: Uint8Array | null = null;
    const r = store.getAll(range);
    r.onsuccess = () => {
      const rows = r.result as UpdateRow[];
      if (rows.length <= 1) {
        merged = rows[0]?.data ?? null;
        return;
      }
      merged = merge(rows.map((x) => x.data));
      store.delete(range);
      store.put({ docId, seq: this.nextSeq(), writer: WRITER, data: merged } satisfies UpdateRow);
    };
    await txDone(tx);
    return merged;
  }

  async countUpdates(docId: string): Promise<number> {
    const tx = this.db.transaction('updates', 'readonly');
    return req(tx.objectStore('updates').count(IDBKeyRange.bound([docId, -Infinity], [docId, Infinity])));
  }

  /** All doc ids that have persisted state. Uses a key cursor, so it never loads payloads. */
  async listDocIds(): Promise<string[]> {
    const tx = this.db.transaction('updates', 'readonly');
    const ids = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const cur = tx.objectStore('updates').openKeyCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const [docId] = c.key as [string, number, string];
        ids.add(docId);
        // jump to the next doc id
        c.continue([docId, Infinity]);
      };
      cur.onerror = () => reject(cur.error);
    });
    return [...ids];
  }

  async deleteDoc(docId: string): Promise<void> {
    const tx = this.db.transaction('updates', 'readwrite');
    tx.objectStore('updates').delete(IDBKeyRange.bound([docId, -Infinity], [docId, Infinity]));
    await txDone(tx);
  }

  // ---------- blobs ----------

  async putBlob(id: string, blob: Blob): Promise<void> {
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, id);
    await txDone(tx);
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    const tx = this.db.transaction('blobs', 'readonly');
    return req(tx.objectStore('blobs').get(id));
  }

  async hasBlob(id: string): Promise<boolean> {
    const tx = this.db.transaction('blobs', 'readonly');
    const n = await req(tx.objectStore('blobs').count(id));
    return n > 0;
  }

  async listBlobIds(): Promise<string[]> {
    const tx = this.db.transaction('blobs', 'readonly');
    return (await req(tx.objectStore('blobs').getAllKeys())) as string[];
  }

  // ---------- kv ----------

  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('kv', 'readonly');
    return req(tx.objectStore('kv').get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await txDone(tx);
  }

  async del(key: string): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    await txDone(tx);
  }
}
