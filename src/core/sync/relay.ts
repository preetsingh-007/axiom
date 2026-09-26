/**
 * WebSocket client for the tiny stateless Axiom relay (server/relay-core.mjs).
 *
 * The relay only forwards opaque binary frames between members of a room; wrap this transport
 * in an EncryptedTransport so the relay never sees plaintext, and use `deriveVaultKeys(secret)
 * .roomId` as the room so it never learns anything meaningful.
 *
 * Features: exponential reconnect backoff with jitter (capped, reset on success), reconnect on
 * `online` / tab becoming visible, application-level heartbeat to detect dead connections,
 * bounded send queue while (re)connecting, relay presence → `peerCount()`.
 */
import { Emitter } from '../util/emitter';
import type { Transport, TransportStatus } from './protocol';

/** Minimal WebSocket surface we rely on (browser WebSocket, Node 22 global, or `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface RelayTransportOptions {
  /** ws:// or wss:// (http(s):// is accepted and converted) base URL of the relay */
  url: string;
  /** 64-char hex room id (see deriveVaultKeys) */
  roomId: string;
  /** transport name, default 'relay' */
  name?: string;
  /** WebSocket implementation; defaults to globalThis.WebSocket */
  WebSocket?: WebSocketCtor;
  /** heartbeat interval (ms), default 25s */
  heartbeatMs?: number;
  /** connection is considered dead if nothing was received for this long after a ping, default 10s */
  heartbeatTimeoutMs?: number;
  /** first reconnect delay (ms), default 1000 */
  backoffBaseMs?: number;
  /** maximum reconnect delay (ms), default 30000 */
  backoffMaxMs?: number;
  /** frames kept while not connected (oldest dropped first), default 512 */
  maxQueue?: number;
  /** connect immediately (default true) */
  autoConnect?: boolean;
}

/** Close codes used by the relay (4000–4999 are application codes). */
export const RelayCloseCode = {
  InvalidRoom: 4000,
  RoomFull: 4008,
  TooManyConnections: 4009,
  FrameTooLarge: 1009,
  ServerShutdown: 1001,
} as const;

const OPEN = 1;
const CONNECTING = 0;

export class RelayTransport implements Transport {
  readonly name: string;
  status: TransportStatus = 'closed';
  /** Close code/reason of the last disconnect (for diagnostics in the UI). */
  lastClose: { code: number; reason: string } | undefined;
  /** When the next reconnect attempt is scheduled (epoch ms), if any. */
  nextRetryAt: number | undefined;
  readonly onPeers = new Emitter<number>();

  private opts: Required<Omit<RelayTransportOptions, 'WebSocket' | 'name' | 'autoConnect'>>;
  private WS: WebSocketCtor | undefined;
  private ws: WebSocketLike | null = null;
  private msgFns = new Set<(d: Uint8Array) => void>();
  private statusFns = new Set<(s: TransportStatus) => void>();
  private queue: Uint8Array[] = [];
  private attempts = 0;
  private peers = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private deadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRecvAt = 0;
  /** a presence message was received on the current socket */
  private presenceSeen = false;
  private stopped = false;
  private removeListeners: (() => void)[] = [];

  constructor(options: RelayTransportOptions) {
    this.name = options.name ?? 'relay';
    this.WS = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.opts = {
      url: options.url,
      roomId: options.roomId,
      heartbeatMs: options.heartbeatMs ?? 25_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 10_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      maxQueue: options.maxQueue ?? 512,
    };
    if (!/^[0-9a-f]{64}$/.test(this.opts.roomId)) throw new Error('RelayTransport: roomId must be 64 hex chars');
    this.installEnvListeners();
    if (options.autoConnect !== false) this.connect();
  }

  /** Full URL (with room) the transport connects to. */
  get endpoint(): string {
    return relayEndpoint(this.opts.url, this.opts.roomId);
  }

  peerCount(): number {
    return this.peers;
  }

  send(data: Uint8Array): void {
    if (this.stopped) return;
    const ws = this.ws;
    if (ws && ws.readyState === OPEN && this.status === 'open') {
      try {
        ws.send(data);
        return;
      } catch {
        // fall through to queue; the close handler will reconnect
      }
    }
    this.queue.push(data);
    // The SyncManager re-greets on every 'open', so dropping the oldest frames is safe.
    if (this.queue.length > this.opts.maxQueue) this.queue.splice(0, this.queue.length - this.opts.maxQueue);
  }

  onMessage(fn: (d: Uint8Array) => void): () => void {
    this.msgFns.add(fn);
    return () => this.msgFns.delete(fn);
  }

  onStatus(fn: (s: TransportStatus) => void): () => void {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }

  /** Starts (or restarts) a connection attempt now, resetting the backoff. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.attempts = 0;
    if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) return;
    this.connect();
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    for (const off of this.removeListeners) off();
    this.removeListeners = [];
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000, 'client closed');
      } catch {
        /* ignore */
      }
    }
    this.setPeers(0);
    this.setStatus('closed');
  }

  // ------------------------------------------------------------------

  private connect() {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
    if (this.ws) {
      detach(this.ws);
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (!this.WS) {
      this.setStatus('error');
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.endpoint);
    } catch (e) {
      console.warn('[axiom relay] cannot connect', e);
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.presenceSeen = false;
    ws.binaryType = 'arraybuffer';
    this.setStatus('connecting');

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.lastRecvAt = Date.now();
      this.startHeartbeat();
      // flush the queue before announcing 'open' (the manager greets right after)
      const q = this.queue;
      this.queue = [];
      for (const f of q) {
        try {
          ws.send(f);
        } catch {
          /* socket died; onclose will handle it */
        }
      }
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRecvAt = Date.now();
      if (this.deadTimer) {
        clearTimeout(this.deadTimer);
        this.deadTimer = undefined;
      }
      const d = ev.data;
      if (typeof d === 'string') this.handleControl(d);
      else if (d instanceof ArrayBuffer) this.deliver(new Uint8Array(d));
      else if (ArrayBuffer.isView(d)) this.deliver(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      else if (typeof Blob !== 'undefined' && d instanceof Blob) {
        void d.arrayBuffer().then((b) => this.ws === ws && this.deliver(new Uint8Array(b)));
      }
    };
    ws.onerror = () => {
      // onclose always follows; nothing to do here (never log the URL: it contains the room id)
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      detach(ws);
      this.ws = null;
      this.lastClose = { code: ev?.code ?? 0, reason: ev?.reason ?? '' };
      this.stopHeartbeat();
      this.setPeers(0);
      if (this.stopped) return;
      this.setStatus('error');
      this.scheduleReconnect(ev?.code);
    };
  }

  private deliver(d: Uint8Array) {
    for (const fn of [...this.msgFns]) fn(d);
  }

  private handleControl(text: string) {
    let msg: { type?: string; count?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'peers' && typeof msg.count === 'number') {
      const prev = this.peers;
      const next = Math.max(0, msg.count);
      this.setPeers(next);
      // A peer joined after we opened: announce 'open' again so the SyncManager re-greets.
      // (The manager only greets back devices it has never seen, so a known device that
      // reconnected — e.g. after a relay restart — would otherwise never get our manifest.)
      if (this.presenceSeen && next > prev && this.status === 'open') {
        for (const fn of [...this.statusFns]) fn('open');
      }
      this.presenceSeen = true;
    }
    // 'pong' needs no handling: any received message refreshes liveness
  }

  private setPeers(n: number) {
    if (n === this.peers) return;
    this.peers = n;
    this.onPeers.emit(n);
  }

  private scheduleReconnect(code?: number) {
    if (this.stopped || this.retryTimer) return;
    const { backoffBaseMs, backoffMaxMs } = this.opts;
    // server-side policy rejections (room full, invalid room…) → back off to the cap directly
    if (code !== undefined && code >= 4000 && code < 5000) this.attempts = Math.max(this.attempts, 30);
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(this.attempts, 30));
    const delay = Math.round(exp / 2 + (Math.random() * exp) / 2); // "equal jitter"
    this.attempts++;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.ping(), this.opts.heartbeatMs);
  }

  /** Sends a ping and tears the socket down if nothing comes back in time. */
  private ping() {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    try {
      ws.send('{"type":"ping"}');
    } catch {
      return;
    }
    if (this.deadTimer) return;
    const sentAt = Date.now();
    this.deadTimer = setTimeout(() => {
      this.deadTimer = undefined;
      if (this.ws !== ws || this.lastRecvAt >= sentAt) return;
      // dead connection: drop it and reconnect
      detach(ws);
      this.ws = null;
      try {
        ws.close(4001, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
      this.stopHeartbeat();
      this.setPeers(0);
      this.lastClose = { code: 0, reason: 'heartbeat timeout' };
      this.setStatus('error');
      this.scheduleReconnect();
    }, this.opts.heartbeatTimeoutMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.heartbeatTimer = undefined;
    this.deadTimer = undefined;
  }

  private clearTimers() {
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
  }

  private installEnvListeners() {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOnline = () => this.reconnectNow();
      window.addEventListener('online', onOnline);
      this.removeListeners.push(() => window.removeEventListener('online', onOnline));
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVis = () => {
        if (document.visibilityState !== 'visible') return;
        if (this.status === 'open') this.ping(); // verify quickly after sleep / background
        else this.reconnectNow();
      };
      document.addEventListener('visibilitychange', onVis);
      this.removeListeners.push(() => document.removeEventListener('visibilitychange', onVis));
    }
  }

  private setStatus(s: TransportStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of [...this.statusFns]) fn(s);
  }
}

function detach(ws: WebSocketLike) {
  ws.onopen = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
}

/** Builds `wss://host/path?room=<id>` from a relay base URL. */
export function relayEndpoint(base: string, roomId: string): string {
  let url = base.trim();
  if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
  else if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
  else if (!/^wss?:\/\//.test(url)) url = 'wss://' + url;
  const u = new URL(url);
  u.searchParams.set('room', roomId);
  return u.toString();
}
