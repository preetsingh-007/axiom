// Axiom relay — a tiny, stateless WebSocket broadcast hub.
//
// Clients connect to `/?room=<64 hex chars>` and every binary frame a client sends is forwarded,
// untouched, to the other members of the same room. Frames are end-to-end encrypted by the
// clients, and the room id is a one-way derivation of the vault's sync secret, so the relay
// learns nothing about the notes it carries. Nothing is ever persisted.
//
// Control messages (JSON text frames):
//   server → client  {"type":"peers","count":N}   N = other members currently in the room
//   client → server  {"type":"ping"}              server answers {"type":"pong"}
//
// Only dependency: `ws`.

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const ROOM_RE = /^[0-9a-f]{64}$/;

export const CloseCode = Object.freeze({
  InvalidRoom: 4000,
  RoomFull: 4008,
  TooManyConnections: 4009,
  ServerShutdown: 1001,
});

/**
 * @typedef {object} RelayOptions
 * @property {number} [port]              TCP port (0 = random free port). Default 8787.
 * @property {string} [host]              Bind address. Default: all interfaces.
 * @property {number} [maxFrameBytes]     Max binary frame size. Default 8 MiB.
 * @property {number} [maxRoomSize]       Max members per room. Default 32.
 * @property {number} [maxConnections]    Max concurrent sockets. Default 2000.
 * @property {number} [bytesPerSecond]    Per-connection sustained inbound rate. Default 2 MiB/s.
 * @property {number} [burstBytes]        Per-connection burst allowance. Default 32 MiB.
 * @property {number} [framesPerSecond]   Per-connection sustained frame rate. Default 300/s.
 * @property {number} [burstFrames]       Per-connection frame burst. Default 5000.
 * @property {number} [maxBufferedBytes]  Slow receivers above this backlog are dropped. Default 64 MiB.
 * @property {number} [pingIntervalMs]    Protocol-level keepalive. Default 30 s.
 * @property {(msg: string) => void} [log] Logger (never receives payloads). Default: silent.
 */

/**
 * @typedef {object} RelayHandle
 * @property {number} port
 * @property {() => Promise<void>} close
 * @property {() => {rooms: number, connections: number}} stats
 * @property {http.Server} server
 */

/**
 * Starts a relay in-process.
 * @param {RelayOptions} [options]
 * @returns {Promise<RelayHandle>}
 */
export async function startRelay(options = {}) {
  const o = {
    port: options.port ?? 8787,
    host: options.host,
    maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024,
    maxRoomSize: options.maxRoomSize ?? 32,
    maxConnections: options.maxConnections ?? 2000,
    bytesPerSecond: options.bytesPerSecond ?? 2 * 1024 * 1024,
    burstBytes: options.burstBytes ?? 32 * 1024 * 1024,
    framesPerSecond: options.framesPerSecond ?? 300,
    burstFrames: options.burstFrames ?? 5000,
    maxBufferedBytes: options.maxBufferedBytes ?? 64 * 1024 * 1024,
    pingIntervalMs: options.pingIntervalMs ?? 30_000,
    log: options.log ?? (() => {}),
  };

  /** @type {Map<string, Set<WebSocket>>} */
  const rooms = new Map();
  /** @type {WeakMap<WebSocket, Conn>} */
  const conns = new WeakMap();
  let connections = 0;
  let closing = false;

  /**
   * @typedef {object} Conn
   * @property {string} room
   * @property {boolean} alive
   * @property {number} bytes    token bucket (bytes)
   * @property {number} frames   token bucket (frames)
   * @property {number} refillAt last refill timestamp
   * @property {ReturnType<typeof setTimeout> | undefined} resumeTimer
   */

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections }));
      return;
    }
    res.writeHead(url.pathname === '/' ? 426 : 404, { 'content-type': 'text/plain' });
    res.end(url.pathname === '/' ? 'Axiom relay: connect with a WebSocket to /?room=<id>\n' : 'not found\n');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxFrameBytes, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    if (closing) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  /** @param {Set<WebSocket>} members */
  function announce(members) {
    for (const m of members) {
      if (m.readyState === WebSocket.OPEN) m.send(JSON.stringify({ type: 'peers', count: members.size - 1 }));
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {http.IncomingMessage} req
   */
  function onConnection(ws, req) {
    const url = new URL(req.url ?? '/', 'http://relay');
    const room = url.searchParams.get('room') ?? '';
    if (!ROOM_RE.test(room)) {
      ws.close(CloseCode.InvalidRoom, 'invalid room');
      return;
    }
    if (connections >= o.maxConnections) {
      ws.close(CloseCode.TooManyConnections, 'relay full');
      return;
    }
    let members = rooms.get(room);
    if (members && members.size >= o.maxRoomSize) {
      ws.close(CloseCode.RoomFull, 'room full');
      return;
    }
    if (!members) {
      members = new Set();
      rooms.set(room, members);
    }
    members.add(ws);
    connections++;
    /** @type {Conn} */
    const conn = { room, alive: true, bytes: o.burstBytes, frames: o.burstFrames, refillAt: Date.now(), resumeTimer: undefined };
    conns.set(ws, conn);
    announce(members);

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      const size = byteLength(data);
      if (!isBinary) {
        // control channel: tiny JSON only
        if (size > 1024) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg && msg.type === 'ping' && ws.readyState === WebSocket.OPEN) ws.send('{"type":"pong"}');
        } catch {
          /* ignore */
        }
        return;
      }
      const peers = rooms.get(conn.room);
      if (peers) {
        for (const peer of peers) {
          if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
          if (peer.bufferedAmount > o.maxBufferedBytes) {
            // hopelessly slow receiver: drop it; it will reconnect and re-sync
            peer.terminate();
            continue;
          }
          peer.send(data, { binary: true });
        }
      }
      throttle(ws, conn, size);
    });

    ws.on('close', () => {
      if (conn.resumeTimer) clearTimeout(conn.resumeTimer);
      connections--;
      const set = rooms.get(conn.room);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) rooms.delete(conn.room);
      else announce(set);
    });

    ws.on('error', () => {
      /* 'close' follows */
    });
  }

  /**
   * Token-bucket rate limiting via TCP backpressure: when a connection exceeds its budget we stop
   * reading from its socket until enough tokens have been refilled. Nothing is dropped.
   * @param {WebSocket} ws
   * @param {Conn} conn
   * @param {number} size
   */
  function throttle(ws, conn, size) {
    const now = Date.now();
    const dt = (now - conn.refillAt) / 1000;
    conn.refillAt = now;
    conn.bytes = Math.min(o.burstBytes, conn.bytes + dt * o.bytesPerSecond) - size;
    conn.frames = Math.min(o.burstFrames, conn.frames + dt * o.framesPerSecond) - 1;
    if ((conn.bytes >= 0 && conn.frames >= 0) || conn.resumeTimer) return;
    const waitMs = Math.max(
      conn.bytes < 0 ? (-conn.bytes / o.bytesPerSecond) * 1000 : 0,
      conn.frames < 0 ? (-conn.frames / o.framesPerSecond) * 1000 : 0,
    );
    ws.pause();
    conn.resumeTimer = setTimeout(() => {
      conn.resumeTimer = undefined;
      if (ws.readyState === WebSocket.OPEN) ws.resume();
    }, Math.ceil(waitMs));
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = conns.get(ws);
      if (!conn) continue;
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, o.pingIntervalMs);
  pinger.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  o.log(`[axiom relay] listening on :${port}`);

  return {
    port,
    server,
    stats: () => ({ rooms: rooms.size, connections }),
    close: () =>
      new Promise((resolve) => {
        if (closing) return resolve(undefined);
        closing = true;
        clearInterval(pinger);
        for (const ws of wss.clients) {
          try {
            ws.close(CloseCode.ServerShutdown, 'server shutting down');
          } catch {
            /* ignore */
          }
        }
        // give clients a moment to receive the close frame, then force it
        const force = setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          server.closeAllConnections?.();
        }, 500);
        force.unref?.();
        wss.close(() => {
          server.close(() => {
            clearTimeout(force);
            o.log('[axiom relay] stopped');
            resolve(undefined);
          });
          server.closeIdleConnections?.();
        });
      }),
  };
}

/** @param {import('ws').RawData} data */
function byteLength(data) {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}
