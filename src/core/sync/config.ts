/**
 * Device-local sync configuration. Secrets (sync secret, Git token) live ONLY in the vault's
 * local key/value store (`vault.getLocal/setLocal`), never in a CRDT doc and never in Git.
 *
 * A *join code* bundles everything a second device needs (sync secret, relay URL, Git repo and
 * branch — but never the Git token) into one copy-pasteable string / QR-friendly URL fragment.
 */
import { EncryptedTransport, deriveVaultKeys, parseSyncSecret } from './crypto';
import { RelayTransport, type RelayTransportOptions } from './relay';
import { GitHubRemote } from './git/github';
import { GitLabRemote } from './git/gitlab';
import type { FetchLike, GitRemote } from './git/remote';

export type GitProvider = 'github' | 'gitlab';

export interface GitConfig {
  provider: GitProvider;
  /** personal access token — local only */
  token: string;
  /** "owner/name" (GitHub) or project path "group/sub/name" (GitLab) */
  repo: string;
  branch: string;
  /** API base for GitHub Enterprise (https://ghe.example.com/api/v3) or self-hosted GitLab (https://gitlab.example.com) */
  baseUrl?: string;
  /** also commit source files & images (can be large) */
  syncFiles: boolean;
  enabled: boolean;
}

export interface SyncConfig {
  /** shared vault sync secret (AXM-…), local only */
  secret?: string;
  relayUrl?: string;
  relayEnabled: boolean;
  git?: GitConfig;
}

/** What a join code carries (no token). */
export interface JoinInfo {
  secret: string;
  relayUrl?: string;
  git?: { provider: GitProvider; repo: string; branch: string; baseUrl?: string };
}

/** Minimal slice of Vault used here (keeps this module testable without IndexedDB). */
export interface LocalKV {
  getLocal<T>(key: string): Promise<T | undefined>;
  setLocal(key: string, value: unknown): Promise<void>;
}

export const SYNC_CONFIG_KEY = 'sync-config';
export const DEFAULT_SYNC_CONFIG: SyncConfig = { relayEnabled: false };

export async function loadSyncConfig(vault: LocalKV): Promise<SyncConfig> {
  const saved = await vault.getLocal<Partial<SyncConfig>>(SYNC_CONFIG_KEY);
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_SYNC_CONFIG };
  return normalize(saved);
}

export async function saveSyncConfig(vault: LocalKV, cfg: SyncConfig): Promise<void> {
  await vault.setLocal(SYNC_CONFIG_KEY, normalize(cfg));
}

function normalize(c: Partial<SyncConfig>): SyncConfig {
  const out: SyncConfig = { relayEnabled: !!c.relayEnabled };
  if (c.secret) out.secret = parseSyncSecret(c.secret) ?? c.secret.trim();
  if (c.relayUrl) out.relayUrl = c.relayUrl.trim();
  if (c.git && c.git.repo) {
    out.git = {
      provider: c.git.provider === 'gitlab' ? 'gitlab' : 'github',
      token: c.git.token ?? '',
      repo: c.git.repo.trim().replace(/^\/+|\/+$/g, ''),
      branch: (c.git.branch ?? '').trim() || 'main',
      syncFiles: c.git.syncFiles ?? true,
      enabled: c.git.enabled ?? true,
    };
    if (c.git.baseUrl) out.git.baseUrl = c.git.baseUrl.trim().replace(/\/+$/, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Join codes:  "AXJ1." + base64url(JSON {s, r?, g?: {p, n, b, u?}})
// ---------------------------------------------------------------------------

const CODE_PREFIX = 'AXJ1.';

/** Builds a join code from a config. Throws when the config has no valid sync secret. The token is never included. */
export function buildSyncCode(cfg: Pick<SyncConfig, 'secret' | 'relayUrl' | 'git'>): string {
  const secret = cfg.secret ? parseSyncSecret(cfg.secret) ?? cfg.secret.trim() : '';
  if (!secret) throw new Error('No sync secret configured');
  const payload: { s: string; r?: string; g?: { p: string; n: string; b: string; u?: string } } = { s: secret };
  if (cfg.relayUrl) payload.r = cfg.relayUrl;
  if (cfg.git?.repo) {
    payload.g = { p: cfg.git.provider, n: cfg.git.repo, b: cfg.git.branch || 'main' };
    if (cfg.git.baseUrl) payload.g.u = cfg.git.baseUrl;
  }
  return CODE_PREFIX + b64urlEncode(JSON.stringify(payload));
}

/** `https://app.example/#join=AXJ1.…` — suitable for a QR code; the fragment never reaches a server. */
export function buildJoinUrl(cfg: Pick<SyncConfig, 'secret' | 'relayUrl' | 'git'>, appUrl: string): string {
  return appUrl.split('#')[0] + '#join=' + buildSyncCode(cfg);
}

/**
 * Parses a join code, a URL (or bare fragment) containing `#join=…`, or a bare sync secret.
 * Returns null when nothing valid is found.
 */
export function parseSyncCode(input: string): JoinInfo | null {
  let s = input.trim();
  const m = /[#&?]join=([^&#\s]+)/.exec(s);
  if (m) s = decodeURIComponent(m[1]);
  if (s.startsWith(CODE_PREFIX)) {
    let raw: unknown;
    try {
      raw = JSON.parse(b64urlDecode(s.slice(CODE_PREFIX.length)));
    } catch {
      return null;
    }
    const p = raw as { s?: unknown; r?: unknown; g?: { p?: unknown; n?: unknown; b?: unknown; u?: unknown } };
    if (typeof p?.s !== 'string' || !p.s) return null;
    const out: JoinInfo = { secret: parseSyncSecret(p.s) ?? p.s };
    if (typeof p.r === 'string' && /^(wss?|https?):\/\//.test(p.r)) out.relayUrl = p.r;
    if (p.g && typeof p.g.n === 'string' && (p.g.p === 'github' || p.g.p === 'gitlab')) {
      out.git = { provider: p.g.p, repo: p.g.n, branch: typeof p.g.b === 'string' && p.g.b ? p.g.b : 'main' };
      if (typeof p.g.u === 'string' && /^https?:\/\//.test(p.g.u)) out.git.baseUrl = p.g.u;
    }
    return out;
  }
  const secret = parseSyncSecret(s);
  return secret ? { secret } : null;
}

/** Merges a parsed join code into an existing config (keeps a Git token already present for the same repo). */
export function applyJoinInfo(cfg: SyncConfig, join: JoinInfo): SyncConfig {
  const out: SyncConfig = { ...cfg, secret: join.secret };
  if (join.relayUrl) {
    out.relayUrl = join.relayUrl;
    out.relayEnabled = true;
  }
  if (join.git) {
    const same = cfg.git && cfg.git.provider === join.git.provider && cfg.git.repo === join.git.repo;
    out.git = {
      provider: join.git.provider,
      repo: join.git.repo,
      branch: join.git.branch,
      baseUrl: join.git.baseUrl,
      token: same ? cfg.git!.token : '',
      syncFiles: cfg.git?.syncFiles ?? true,
      // needs a token on this device before it can be enabled
      enabled: same ? cfg.git!.enabled : false,
    };
  }
  return out;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Factories (wiring helpers)
// ---------------------------------------------------------------------------

/**
 * Builds the encrypted relay transport for a config, or null when the relay is disabled or not
 * configured. Add the result to the vault's SyncManager.
 */
export async function createRelayTransport(
  cfg: SyncConfig,
  opts: Omit<RelayTransportOptions, 'url' | 'roomId'> = {},
): Promise<EncryptedTransport | null> {
  if (!cfg.relayEnabled || !cfg.relayUrl || !cfg.secret) return null;
  const { roomId, key } = await deriveVaultKeys(cfg.secret);
  return new EncryptedTransport(new RelayTransport({ ...opts, url: cfg.relayUrl, roomId }), key);
}

/** Builds the Git remote for a config, or null when Git sync is disabled / incomplete. */
export function createGitRemote(git: GitConfig | undefined, fetchFn?: FetchLike): GitRemote | null {
  if (!git || !git.enabled || !git.token || !git.repo) return null;
  if (git.provider === 'gitlab') {
    return new GitLabRemote({ token: git.token, project: git.repo, branch: git.branch, baseUrl: git.baseUrl, fetch: fetchFn });
  }
  return new GitHubRemote({ token: git.token, repo: git.repo, branch: git.branch, baseUrl: git.baseUrl, fetch: fetchFn });
}
