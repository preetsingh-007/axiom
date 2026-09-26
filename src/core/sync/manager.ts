import * as Y from 'yjs';
import { DocStore } from '../storage/docstore';
import { hash64 } from '../util/ids';
import { Emitter } from '../util/emitter';
import { decodeFrame, encodeFrame, type SyncHeader, type Transport, type TransportStatus } from './protocol';

const MANIFEST_CHUNK = 500;

/**
 * Digest of a doc's full CRDT state: state vector PLUS delete set. Deletions do not advance the
 * state vector, so hashing it alone would hide offline deletions from reconciliation.
 */
export function stateDigest(state: Uint8Array | null): string {
  if (!state) return 'empty';
  const sv = Y.encodeStateVectorFromUpdate(state);
  let s = '';
  for (let i = 0; i < sv.length; i++) s += String.fromCharCode(sv[i]);
  const { ds } = Y.decodeUpdate(state);
  const clients = [...ds.clients.keys()].sort((a, b) => a - b);
  for (const c of clients) {
    // canonical: sorted, coalesced ranges (fragmentation differs between merged update sets)
    const items = [...ds.clients.get(c)!].sort((a, b) => a.clock - b.clock);
    let start = -1;
    let end = -1;
    s += `|${c}:`;
    for (const it of items) {
      if (it.clock <= end) end = Math.max(end, it.clock + it.len);
      else {
        if (start >= 0) s += `${start}-${end},`;
        start = it.clock;
        end = it.clock + it.len;
      }
    }
    if (start >= 0) s += `${start}-${end}`;
  }
  return hash64(s);
}

export interface PeerInfo {
  device: string;
  name: string;
  transport: string;
  seenAt: number;
}

/**
 * Connects a DocStore to any number of transports. Handles initial reconciliation
 * (manifest → sync1 → sync2) and live update fan-out. Loops are prevented by tagging
 * every update with the transport it arrived on.
 */
export class SyncManager {
  private transports = new Map<string, { t: Transport; off: (() => void)[] }>();
  private digestCache = new Map<string, string>();
  readonly onStatus = new Emitter<{ transport: string; status: TransportStatus }>();
  readonly onPeers = new Emitter<PeerInfo[]>();
  private peers = new Map<string, PeerInfo>();
  private offStore: () => void;
  private offChanged: () => void;
  stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 };

  constructor(
    private store: DocStore,
    private device: { id: string; name: string },
  ) {
    this.offStore = store.onUpdate.on(({ docId, update, from }) => {
      for (const [name, { t }] of this.transports) {
        if (name === from || t.status !== 'open') continue;
        this.send(t, { t: 'update', doc: docId }, update);
      }
    });
    this.offChanged = store.onDocChanged.on(({ docId }) => this.digestCache.delete(docId));
  }

  add(t: Transport) {
    this.remove(t.name);
    const off: (() => void)[] = [];
    off.push(
      t.onMessage((data) => {
        this.stats.framesIn++;
        this.stats.bytesIn += data.byteLength;
        void this.handle(t, data).catch((e) => console.warn('[axiom sync] bad frame', e));
      }),
    );
    off.push(
      t.onStatus((status) => {
        this.onStatus.emit({ transport: t.name, status });
        if (status === 'open') void this.greet(t);
        else {
          // forget peers of a dropped transport so they are greeted again after reconnecting
          let changed = false;
          for (const [k, p] of this.peers) if (p.transport === t.name) changed = this.peers.delete(k) || changed;
          if (changed) this.onPeers.emit([...this.peers.values()]);
        }
      }),
    );
    this.transports.set(t.name, { t, off });
    if (t.status === 'open') void this.greet(t);
  }

  remove(name: string) {
    const e = this.transports.get(name);
    if (!e) return;
    e.off.forEach((f) => f());
    e.t.close();
    this.transports.delete(name);
    for (const [k, p] of this.peers) if (p.transport === name) this.peers.delete(k);
    this.onPeers.emit([...this.peers.values()]);
  }

  get(name: string): Transport | undefined {
    return this.transports.get(name)?.t;
  }

  list(): Transport[] {
    return [...this.transports.values()].map((e) => e.t);
  }

  peerList(): PeerInfo[] {
    return [...this.peers.values()];
  }

  destroy() {
    for (const name of [...this.transports.keys()]) this.remove(name);
    this.offStore();
    this.offChanged();
  }

  /** Re-announce everything on every open transport (e.g. after a Git pull). */
  async resync() {
    for (const { t } of this.transports.values()) if (t.status === 'open') await this.greet(t);
  }

  private send(t: Transport, header: SyncHeader, payload?: Uint8Array) {
    const frame = encodeFrame(header, payload);
    this.stats.framesOut++;
    this.stats.bytesOut += frame.byteLength;
    try {
      t.send(frame);
    } catch (e) {
      console.warn('[axiom sync] send failed', e);
    }
  }

  private async digest(docId: string): Promise<string> {
    let d = this.digestCache.get(docId);
    if (!d) {
      d = stateDigest(await this.store.getState(docId));
      this.digestCache.set(docId, d);
    }
    return d;
  }

  private async greet(t: Transport) {
    this.send(t, { t: 'hello', device: this.device.id, name: this.device.name });
    const ids = await this.store.listDocIds();
    for (let i = 0; i < ids.length; i += MANIFEST_CHUNK) {
      const chunk = ids.slice(i, i + MANIFEST_CHUNK);
      const entries: [string, string][] = [];
      for (const id of chunk) entries.push([id, await this.digest(id)]);
      this.send(t, { t: 'manifest', entries });
    }
  }

  private async handle(t: Transport, data: Uint8Array) {
    const { header, payload } = decodeFrame(data);
    switch (header.t) {
      case 'hello': {
        const isNew = !this.peers.has(header.device);
        this.peers.set(header.device, { device: header.device, name: header.name, transport: t.name, seenAt: Date.now() });
        this.onPeers.emit([...this.peers.values()]);
        // a newly seen peer might have joined after our greeting: greet it back once
        if (isNew && header.device !== this.device.id) void this.greet(t);
        return;
      }
      case 'manifest': {
        for (const [docId, theirDigest] of header.entries) {
          const mine = await this.digest(docId);
          if (mine !== theirDigest) {
            this.send(t, { t: 'sync1', doc: docId }, await this.store.getStateVector(docId));
          }
        }
        return;
      }
      case 'sync1': {
        const diff = await this.store.diff(header.doc, payload);
        if (diff && diff.length > 2) this.send(t, { t: 'sync2', doc: header.doc }, diff);
        // symmetric: if the peer has something we lack, ask for it too
        const mySv = await this.store.getStateVector(header.doc);
        const mine = Y.decodeStateVector(mySv);
        for (const [client, clock] of Y.decodeStateVector(payload)) {
          if ((mine.get(client) ?? 0) < clock) {
            this.send(t, { t: 'sync1', doc: header.doc }, mySv);
            break;
          }
        }
        return;
      }
      case 'sync2':
      case 'update': {
        await this.store.applyRemote(header.doc, payload, t.name);
        return;
      }
    }
  }
}
