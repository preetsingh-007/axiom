/**
 * End-to-end encryption for sync transports.
 *
 * A vault's devices share one human-friendly *sync secret* (`AXM-XXXX-…`). From it we derive,
 * with PBKDF2 (slow, brute-force resistant) followed by HKDF (cheap purpose separation):
 *   - `roomId`: 64 hex chars, the only thing a relay ever sees (it cannot be reversed into the
 *     secret, and it is unrelated to the encryption key);
 *   - `key`: a non-extractable AES-256-GCM key used to seal every frame.
 *
 * Wire format of an encrypted frame: [version=1][96-bit random IV][AES-GCM ciphertext+tag]
 * (the version byte is bound as additional authenticated data).
 */
import { Emitter } from '../util/emitter';
import type { Transport, TransportStatus } from './protocol';

const enc = new TextEncoder();

/** Fixed, public application salt. Secrets are high-entropy, so a per-user salt is unnecessary. */
const APP_SALT = 'axiom/sync/v1/pbkdf2-salt/5b0e3c1a9d7f';
export const PBKDF2_ITERATIONS = 250_000;
const FRAME_VERSION = 1;
const IV_BYTES = 12;

const bs = (u: Uint8Array) => u as BufferSource;

export interface VaultKeys {
  /** SHA-256-sized hex room id (64 chars) — safe to reveal to a relay. */
  roomId: string;
  /** AES-GCM-256, non-extractable. */
  key: CryptoKey;
}

// ---------------------------------------------------------------------------
// Sync secret: 140 random bits as 7 groups of 4 Crockford-base32 chars.
// ---------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_GROUPS = 7;
const SECRET_CHARS = SECRET_GROUPS * 4;
export const SYNC_SECRET_PREFIX = 'AXM';

/** Generates a new sync secret like `AXM-7K2D-Q9XH-…` (7 groups, 140 bits of entropy). */
export function generateSyncSecret(): string {
  const bytes = new Uint8Array(SECRET_CHARS);
  crypto.getRandomValues(bytes);
  let s = '';
  // 256 % 32 === 0, so `b % 32` is unbiased
  for (let i = 0; i < SECRET_CHARS; i++) s += B32[bytes[i] % 32];
  return formatSecret(s);
}

function formatSecret(chars: string): string {
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4));
  return [SYNC_SECRET_PREFIX, ...groups].join('-');
}

/**
 * Normalises a user-typed sync secret (any case, spaces or dashes, the `AXM` prefix optional,
 * common look-alikes O→0, I/L→1, U→V). Returns the canonical form or null when invalid.
 */
export function parseSyncSecret(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.startsWith(SYNC_SECRET_PREFIX) && s.length === SECRET_CHARS + SYNC_SECRET_PREFIX.length) {
    s = s.slice(SYNC_SECRET_PREFIX.length);
  }
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (s.length !== SECRET_CHARS) return null;
  for (const c of s) if (!B32.includes(c)) return null;
  return formatSecret(s);
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Promise<VaultKeys>>();

/**
 * Derives the relay room id and the frame encryption key from a sync secret.
 * Secrets in `AXM-…` form are canonicalised first, so typing variations still match.
 * Results are memoised per secret for the session (PBKDF2 is deliberately slow).
 */
export function deriveVaultKeys(secret: string, iterations = PBKDF2_ITERATIONS): Promise<VaultKeys> {
  const canonical = parseSyncSecret(secret) ?? secret.trim();
  if (!canonical) return Promise.reject(new Error('empty sync secret'));
  const cacheKey = iterations + ':' + canonical;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = derive(canonical, iterations);
    keyCache.set(cacheKey, p);
    p.catch(() => keyCache.delete(cacheKey));
  }
  return p;
}

async function derive(secret: string, iterations: number): Promise<VaultKeys> {
  const pw = await crypto.subtle.importKey('raw', bs(enc.encode(secret.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bs(enc.encode(APP_SALT)), iterations },
    pw,
    256,
  );
  const hkdf = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdfParams = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: bs(new Uint8Array(32)),
    info: bs(enc.encode(info)),
  });
  const roomBits = await crypto.subtle.deriveBits(hkdfParams('axiom/sync/v1/room-id'), hkdf, 256);
  const key = await crypto.subtle.deriveKey(
    hkdfParams('axiom/sync/v1/frame-key'),
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { roomId: toHex(new Uint8Array(roomBits)), key };
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------------------
// Frame sealing
// ---------------------------------------------------------------------------

const AAD = new Uint8Array([FRAME_VERSION]);

export async function sealFrame(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(AAD) }, key, bs(plain)),
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = FRAME_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

/** Returns the plaintext, or null when the frame is malformed or sealed with another key. */
export async function openFrame(key: CryptoKey, frame: Uint8Array): Promise<Uint8Array | null> {
  if (frame.length < 1 + IV_BYTES + 16 || frame[0] !== FRAME_VERSION) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(frame.subarray(1, 1 + IV_BYTES)), additionalData: bs(AAD) },
      key,
      bs(frame.subarray(1 + IV_BYTES)),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/**
 * Wraps any Transport so that everything crossing it is AES-GCM encrypted. Frames that fail to
 * authenticate (a device with a different sync secret in the same room, corruption, or a
 * malicious relay) are dropped and counted in `rejectedFrames` / `onRejected`.
 *
 * Order is preserved in both directions (encryption and decryption are serialised).
 */
export class EncryptedTransport implements Transport {
  readonly name: string;
  rejectedFrames = 0;
  lastRejectedAt: number | undefined;
  /** emits the running count of rejected frames */
  readonly onRejected = new Emitter<number>();
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private msgFns = new Set<(d: Uint8Array) => void>();
  private offInner: () => void;
  private closed = false;

  constructor(
    readonly inner: Transport,
    private key: CryptoKey,
  ) {
    this.name = inner.name;
    this.offInner = inner.onMessage((data) => {
      this.recvChain = this.recvChain.then(async () => {
        const plain = await openFrame(this.key, data);
        if (this.closed) return;
        if (!plain) {
          this.rejectedFrames++;
          this.lastRejectedAt = Date.now();
          this.onRejected.emit(this.rejectedFrames);
          return;
        }
        for (const fn of [...this.msgFns]) fn(plain);
      });
    });
  }

  get status(): TransportStatus {
    return this.inner.status;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    this.sendChain = this.sendChain
      .then(async () => {
        const sealed = await sealFrame(this.key, data);
        if (!this.closed) this.inner.send(sealed);
      })
      .catch((e) => console.warn('[axiom sync] encrypt/send failed', e));
  }

  onMessage(fn: (d: Uint8Array) => void): () => void {
    this.msgFns.add(fn);
    return () => this.msgFns.delete(fn);
  }

  onStatus(fn: (s: TransportStatus) => void): () => void {
    return this.inner.onStatus(fn);
  }

  peerCount(): number {
    return this.inner.peerCount?.() ?? 0;
  }

  close(): void {
    this.closed = true;
    this.offInner();
    this.msgFns.clear();
    this.inner.close();
  }
}
