import { describe, expect, it } from 'vitest';
import { EncryptedTransport, deriveVaultKeys, generateSyncSecret, openFrame, parseSyncSecret, sealFrame } from './crypto';
import { memoryTransportPair } from './broadcast';
import type { TransportStatus } from './protocol';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(5);
  }
}

describe('sync secret', () => {
  it('generates canonical, high-entropy secrets', () => {
    const a = generateSyncSecret();
    expect(a).toMatch(/^AXM(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(generateSyncSecret()).not.toBe(a);
    expect(parseSyncSecret(a)).toBe(a);
  });

  it('parses sloppy input and rejects garbage', () => {
    const s = 'AXM-7K2D-Q9XH-ABCD-EFGH-JKMN-PQRS-TVWX';
    expect(parseSyncSecret(s.toLowerCase().replace(/-/g, ' '))).toBe(s);
    expect(parseSyncSecret(s.slice(4))).toBe(s); // without prefix
    expect(parseSyncSecret('axm 7k2d q9xh abcd efgh jkmn pqrs tvwx')).toBe(s);
    expect(parseSyncSecret('AXM-OOOO-IIII-LLLL-0000-1111-2222-3333')).toBe('AXM-0000-1111-1111-0000-1111-2222-3333');
    expect(parseSyncSecret('AXM-1234')).toBeNull();
    expect(parseSyncSecret('AXM-7K2D-Q9XH-ABCD-EFGH-JKMN-PQRS-TVW!')).toBeNull();
  });
});

describe('deriveVaultKeys', () => {
  it('is deterministic, input-normalised, and separates room id from key', async () => {
    const s = generateSyncSecret();
    const a = await deriveVaultKeys(s);
    const b = await deriveVaultKeys(s.toLowerCase());
    expect(a.roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(b.roomId).toBe(a.roomId);
    const other = await deriveVaultKeys(generateSyncSecret());
    expect(other.roomId).not.toBe(a.roomId);
    expect(a.key.extractable).toBe(false);
    expect(a.key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    // room id must not be a plain hash of the secret
    const plain = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    expect(a.roomId).not.toBe([...plain].map((x) => x.toString(16).padStart(2, '0')).join(''));
  });

  it('seals and opens frames; tampering and wrong keys fail', async () => {
    const { key } = await deriveVaultKeys(generateSyncSecret());
    const { key: wrong } = await deriveVaultKeys(generateSyncSecret());
    const msg = new TextEncoder().encode('Bellman equation');
    const f1 = await sealFrame(key, msg);
    const f2 = await sealFrame(key, msg);
    expect(f1[0]).toBe(1);
    expect(f1.length).toBe(1 + 12 + msg.length + 16);
    expect(f1).not.toEqual(f2); // random IV
    expect(await openFrame(key, f1)).toEqual(msg);
    expect(await openFrame(wrong, f1)).toBeNull();
    const tampered = f1.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await openFrame(key, tampered)).toBeNull();
    const badVersion = f1.slice();
    badVersion[0] = 2;
    expect(await openFrame(key, badVersion)).toBeNull();
    expect(await openFrame(key, new Uint8Array(5))).toBeNull();
  });
});

describe('EncryptedTransport', () => {
  it('round-trips in order over an inner transport and never exposes plaintext', async () => {
    const secret = generateSyncSecret();
    const { key } = await deriveVaultKeys(secret);
    const [ia, ib] = memoryTransportPair();
    const wire: Uint8Array[] = [];
    ib.onMessage((d) => wire.push(d));
    const a = new EncryptedTransport(ia, key);
    const b = new EncryptedTransport(ib, key);
    const statuses: TransportStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    const got: string[] = [];
    b.onMessage((d) => got.push(new TextDecoder().decode(d)));
    await until(() => a.status === 'open' && b.status === 'open');
    expect(statuses).toContain('open');
    for (let i = 0; i < 20; i++) a.send(new TextEncoder().encode('secret note ' + i));
    await until(() => got.length === 20);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => 'secret note ' + i));
    for (const w of wire) expect(new TextDecoder().decode(w)).not.toContain('secret note');
    expect(b.rejectedFrames).toBe(0);
    a.close();
    b.close();
  });

  it('drops and counts frames sealed with a different key', async () => {
    const [ia, ib] = memoryTransportPair();
    const a = new EncryptedTransport(ia, (await deriveVaultKeys(generateSyncSecret())).key);
    const b = new EncryptedTransport(ib, (await deriveVaultKeys(generateSyncSecret())).key);
    const got: Uint8Array[] = [];
    const rejected: number[] = [];
    b.onMessage((d) => got.push(d));
    b.onRejected.on((n) => rejected.push(n));
    await until(() => a.status === 'open');
    a.send(new Uint8Array([1, 2, 3]));
    a.send(new Uint8Array([4, 5, 6]));
    await until(() => b.rejectedFrames === 2);
    expect(got).toHaveLength(0);
    expect(rejected).toEqual([1, 2]);
    expect(b.lastRejectedAt).toBeTypeOf('number');
    a.close();
    b.close();
  });
});
