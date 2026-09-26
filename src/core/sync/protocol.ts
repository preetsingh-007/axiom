/**
 * Multiplexed sync protocol: many Yjs docs over one transport.
 *
 * Frame: [u32 header length][header JSON (utf-8)][binary payload]
 *
 *  manifest  { t, entries: [docId, digest][] }  — "here is what I have"; peers diff digests
 *  sync1     { t, doc } payload = state vector   — "send me what I'm missing"
 *  sync2     { t, doc } payload = update         — answer to sync1
 *  update    { t, doc } payload = update         — live incremental change
 *  hello     { t, device, name }                 — presence
 */

export type SyncHeader =
  | { t: 'manifest'; entries: [string, string][] }
  | { t: 'sync1'; doc: string }
  | { t: 'sync2'; doc: string }
  | { t: 'update'; doc: string }
  | { t: 'hello'; device: string; name: string };

export interface SyncFrame {
  header: SyncHeader;
  payload: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(header: SyncHeader, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export function decodeFrame(data: Uint8Array): SyncFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0);
  const header = JSON.parse(dec.decode(data.subarray(4, 4 + len))) as SyncHeader;
  // copy so the payload does not pin a larger buffer
  const payload = data.slice(4 + len);
  return { header, payload };
}

export type TransportStatus = 'connecting' | 'open' | 'closed' | 'error';

/** A bidirectional, broadcast-style message pipe (BroadcastChannel, WebSocket relay, ...). */
export interface Transport {
  readonly name: string;
  readonly status: TransportStatus;
  send(data: Uint8Array): void;
  onMessage(fn: (data: Uint8Array) => void): () => void;
  onStatus(fn: (s: TransportStatus) => void): () => void;
  /** other peers currently reachable, when the transport knows */
  peerCount?(): number;
  close(): void;
}
