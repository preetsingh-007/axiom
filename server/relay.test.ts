// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { startRelay } from './relay-core.mjs';
import { RelayTransport, type WebSocketCtor } from '../src/core/sync/relay';
import { EncryptedTransport, deriveVaultKeys, generateSyncSecret } from '../src/core/sync/crypto';
import { SyncManager } from '../src/core/sync/manager';
import { Vault } from '../src/core/vault';
import { blockIds, blockPlainText, blockText, getBlock, insertBlock } from '../src/core/blocks';
import type { TransportStatus } from '../src/core/sync/protocol';

const WS = WebSocket as unknown as WebSocketCtor;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeout = 5000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(10);
  }
}

const ROOM = 'a'.repeat(64);
const ROOM2 = 'b'.repeat(64);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Relay = Awaited<ReturnType<typeof startRelay>>;
async function relay(opts: Parameters<typeof startRelay>[0] = {}): Promise<Relay> {
  const r = await startRelay({ port: 0, ...opts });
  cleanups.push(() => r.close());
  return r;
}

interface RawClient {
  ws: WebSocket;
  bin: Buffer[];
  text: any[];
  closed?: { code: number; reason: string };
}
function raw(port: number, room: string): Promise<RawClient> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}`);
    const c: RawClient = { ws, bin: [], text: [] };
    ws.on('message', (d, isBinary) => (isBinary ? c.bin.push(d as Buffer) : c.text.push(JSON.parse(String(d)))));
    ws.on('close', (code, reason) => {
      c.closed = { code, reason: String(reason) };
      resolve(c);
    });
    ws.on('open', () => resolve(c));
    ws.on('error', () => {});
    cleanups.push(() => ws.terminate());
  });
}

function relayTransport(port: number, roomId: string, extra: Partial<ConstructorParameters<typeof RelayTransport>[0]> = {}) {
  const t = new RelayTransport({ url: `ws://127.0.0.1:${port}`, roomId, WebSocket: WS, backoffBaseMs: 30, backoffMaxMs: 200, ...extra });
  cleanups.push(() => t.close());
  return t;
}

describe('relay server', () => {
  it('serves /health and forwards binary frames only to other members of the same room', async () => {
    const r = await relay();
    const health = await (await fetch(`http://127.0.0.1:${r.port}/health`)).json();
    expect(health).toEqual({ ok: true, rooms: 0, connections: 0 });

    const a = await raw(r.port, ROOM);
    const b = await raw(r.port, ROOM);
    const other = await raw(r.port, ROOM2);
    await until(() => a.text.some((m) => m.type === 'peers' && m.count === 1));
    expect(b.text.at(-1)).toEqual({ type: 'peers', count: 1 });
    expect(other.text.at(-1)).toEqual({ type: 'peers', count: 0 });
    expect(r.stats()).toEqual({ rooms: 2, connections: 3 });

    a.ws.send(new Uint8Array([1, 2, 3]));
    await until(() => b.bin.length === 1);
    expect([...b.bin[0]]).toEqual([1, 2, 3]);
    await wait(30);
    expect(a.bin).toHaveLength(0); // no echo
    expect(other.bin).toHaveLength(0); // no cross-room leak

    a.ws.send('{"type":"ping"}');
    await until(() => a.text.some((m) => m.type === 'pong'));

    b.ws.close();
    await until(() => a.text.at(-1)?.count === 0);
  });

  it('rejects invalid rooms, full rooms and oversized frames', async () => {
    const r = await relay({ maxRoomSize: 2, maxFrameBytes: 1024 });
    const bad = await raw(r.port, 'not-a-room');
    await until(() => !!bad.closed);
    expect(bad.closed!.code).toBe(4000);
    const upper = await raw(r.port, 'A'.repeat(64));
    await until(() => !!upper.closed);
    expect(upper.closed!.code).toBe(4000);

    const a = await raw(r.port, ROOM);
    await raw(r.port, ROOM);
    const c = await raw(r.port, ROOM);
    await until(() => !!c.closed);
    expect(c.closed!.code).toBe(4008);

    a.ws.send(new Uint8Array(4096));
    await until(() => !!a.closed);
    expect(a.closed!.code).toBe(1009);
  });

  it('rate limits by pausing the socket (no frames dropped)', async () => {
    const r = await relay({ bytesPerSecond: 1024 * 1024, burstBytes: 64 * 1024 });
    const a = await raw(r.port, ROOM);
    const b = await raw(r.port, ROOM);
    const start = Date.now();
    for (let i = 0; i < 10; i++) a.ws.send(new Uint8Array(64 * 1024).fill(i));
    await until(() => b.bin.length === 10);
    expect(b.bin.map((x) => x[0])).toEqual(Array.from({ length: 10 }, (_, i) => i));
    // 640 KiB with a 64 KiB burst at 1 MiB/s needs roughly half a second
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });
});

describe('RelayTransport', () => {
  it('connects, reports peers, flushes frames queued while connecting', async () => {
    const r = await relay();
    const b = relayTransport(r.port, ROOM);
    const got: number[][] = [];
    b.onMessage((d) => got.push([...d]));
    await until(() => b.status === 'open');
    const a = relayTransport(r.port, ROOM);
    const statuses: TransportStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    a.send(new Uint8Array([9, 9])); // queued: not open yet
    expect(a.status).toBe('connecting');
    await until(() => got.length === 1);
    expect(got[0]).toEqual([9, 9]);
    expect(statuses).toEqual(['open']);
    await until(() => a.peerCount() === 1 && b.peerCount() === 1);
    a.close();
    expect(a.status).toBe('closed');
    await until(() => b.peerCount() === 0);
  });

  it('reconnects with backoff after the server restarts', async () => {
    let r = await relay();
    const port = r.port;
    const a = relayTransport(port, ROOM);
    const seen: TransportStatus[] = [];
    a.onStatus((s) => seen.push(s));
    await until(() => a.status === 'open');
    await r.close();
    await until(() => a.status !== 'open');
    expect(a.lastClose?.code).toBe(1001);
    await wait(100); // a few failed attempts while the server is down
    r = await relay({ port });
    await until(() => a.status === 'open', 5000);
    expect(seen.filter((s) => s === 'open').length).toBe(2);
    expect(seen).toContain('error');
    expect(seen).toContain('connecting');
  });

  it('detects a dead connection with the heartbeat', async () => {
    // a "relay" that accepts connections but never answers anything
    const wss = new WebSocketServer({ port: 0 });
    cleanups.push(() => new Promise((res) => wss.close(res)));
    for (const c of wss.clients) c.terminate();
    let connections = 0;
    wss.on('connection', () => connections++);
    await new Promise((res) => wss.once('listening', res));
    const port = (wss.address() as { port: number }).port;
    cleanups.push(() => wss.clients.forEach((c) => c.terminate()));
    const t = relayTransport(port, ROOM, { heartbeatMs: 40, heartbeatTimeoutMs: 40 });
    await until(() => connections >= 2, 4000);
    expect(t.lastClose?.reason).toBe('heartbeat timeout');
  });
});

describe('end-to-end: two vaults over an encrypted relay', () => {
  let n = 0;
  const open = async () => {
    const v = await Vault.open(`test-relay-${Date.now()}-${n++}`);
    cleanups.push(() => v.close());
    return v;
  };

  it('exchanges page edits, survives a relay restart, and the relay only sees ciphertext', async () => {
    let r = await relay();
    const port = r.port;
    const secret = generateSyncSecret();
    const { roomId, key } = await deriveVaultKeys(secret);

    // a spy in the same room (e.g. a malicious relay operator) sees only ciphertext
    const spy = await raw(port, roomId);

    const a = await open();
    const b = await open();
    const pid = a.createPage({ title: 'Markov decision process' });
    const { doc: da } = await a.openPage(pid);
    const bid = insertBlock(da, { type: 'text', text: 'value iteration' });

    const sa = new SyncManager(a.store, { id: 'A', name: 'Laptop' });
    const sb = new SyncManager(b.store, { id: 'B', name: 'Tablet' });
    cleanups.push(() => sa.destroy(), () => sb.destroy());
    const ta = new EncryptedTransport(relayTransport(port, roomId), key);
    const tb = new EncryptedTransport(relayTransport(port, roomId), key);
    sa.add(ta);
    sb.add(tb);

    await until(() => b.getPage(pid)?.title === 'Markov decision process');
    const { doc: db } = await b.openPage(pid);
    await until(() => blockIds(db).length === 1 && blockPlainText(getBlock(db, bid)!) === 'value iteration');
    expect(sb.peerList().map((p) => p.name)).toContain('Laptop');
    expect(ta.peerCount()).toBe(2); // B + spy

    // live edit
    blockText(getBlock(db, bid)!)!.insert(0, 'Bellman: ');
    await until(() => blockPlainText(getBlock(da, bid)!) === 'Bellman: value iteration');

    const allSpy = Buffer.concat(spy.bin).toString('latin1');
    expect(spy.bin.length).toBeGreaterThan(0);
    expect(allSpy).not.toContain('Markov');
    expect(allSpy).not.toContain('value iteration');
    expect(allSpy).not.toContain('manifest');

    // relay goes down; both devices edit offline; relay comes back → they reconcile
    await r.close();
    await until(() => ta.status !== 'open' && tb.status !== 'open');
    blockText(getBlock(da, bid)!)!.insert(blockText(getBlock(da, bid)!)!.length, ' [A]');
    const pb = b.createPage({ title: 'Created while the relay was down' });
    r = await relay({ port });
    await until(() => ta.status === 'open' && tb.status === 'open', 5000);
    await until(() => blockPlainText(getBlock(db, bid)!) === 'Bellman: value iteration [A]', 5000);
    await until(() => a.getPage(pb)?.title === 'Created while the relay was down', 5000);
  });

  it('a device with a different key in the same room is rejected and counted', async () => {
    const r = await relay();
    const { roomId, key } = await deriveVaultKeys(generateSyncSecret());
    const { key: wrongKey } = await deriveVaultKeys(generateSyncSecret());
    const a = await open();
    const b = await open();
    a.createPage({ title: 'private' });
    const sa = new SyncManager(a.store, { id: 'A', name: 'A' });
    const sb = new SyncManager(b.store, { id: 'B', name: 'B' });
    cleanups.push(() => sa.destroy(), () => sb.destroy());
    const ta = new EncryptedTransport(relayTransport(r.port, roomId), key);
    const tb = new EncryptedTransport(relayTransport(r.port, roomId), wrongKey);
    sa.add(ta);
    sb.add(tb);
    await until(() => tb.rejectedFrames > 0 && ta.rejectedFrames > 0);
    await wait(50);
    expect(b.listPages()).toHaveLength(0);
    const idx = new Y.Doc();
    Y.applyUpdate(idx, (await b.store.getState('index')) ?? Y.encodeStateAsUpdate(new Y.Doc()));
    expect(idx.getMap('pages').size).toBe(0);
  });
});
