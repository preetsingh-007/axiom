import { describe, expect, it } from 'vitest';
import {
  applyJoinInfo,
  buildJoinUrl,
  buildSyncCode,
  createGitRemote,
  createRelayTransport,
  loadSyncConfig,
  parseSyncCode,
  saveSyncConfig,
  type SyncConfig,
} from './config';
import { generateSyncSecret } from './crypto';
import { Vault } from '../vault';

function memKV() {
  const m = new Map<string, unknown>();
  return {
    m,
    getLocal: async <T,>(k: string) => m.get('local:' + k) as T | undefined,
    setLocal: async (k: string, v: unknown) => void m.set('local:' + k, structuredClone(v)),
  };
}

describe('sync config', () => {
  it('defaults, normalises and round-trips through local storage', async () => {
    const kv = memKV();
    expect(await loadSyncConfig(kv)).toEqual({ relayEnabled: false });
    const secret = generateSyncSecret();
    await saveSyncConfig(kv, {
      secret: secret.toLowerCase(),
      relayEnabled: true,
      relayUrl: ' wss://relay.example ',
      git: { provider: 'github', token: 'ghp_x', repo: '/me/notes/', branch: '', syncFiles: false, enabled: true },
    });
    expect(await loadSyncConfig(kv)).toEqual({
      secret,
      relayEnabled: true,
      relayUrl: 'wss://relay.example',
      git: { provider: 'github', token: 'ghp_x', repo: 'me/notes', branch: 'main', syncFiles: false, enabled: true },
    });
  });

  it('stores secrets in the vault local kv, never in the index CRDT', async () => {
    const v = await Vault.open(`test-cfg-${Date.now()}`);
    await saveSyncConfig(v, { secret: generateSyncSecret(), relayEnabled: false, git: { provider: 'gitlab', token: 'glpat-SECRET', repo: 'g/p', branch: 'main', syncFiles: true, enabled: true } });
    expect((await loadSyncConfig(v)).git?.token).toBe('glpat-SECRET');
    expect(JSON.stringify(v.index.toJSON())).not.toContain('glpat-SECRET');
    await v.close();
  });

  it('builds and parses join codes without the token', () => {
    const cfg: SyncConfig = {
      secret: generateSyncSecret(),
      relayEnabled: true,
      relayUrl: 'wss://relay.example/axiom',
      git: { provider: 'gitlab', token: 'glpat-SECRET', repo: 'grp/sub/vault', branch: 'notes', baseUrl: 'https://git.example', syncFiles: true, enabled: true },
    };
    const code = buildSyncCode(cfg);
    expect(code.startsWith('AXJ1.')).toBe(true);
    expect(code).not.toMatch(/[+/=\s]/);
    expect(atob(code.slice(5).replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('glpat');
    const info = parseSyncCode(code)!;
    expect(info).toEqual({
      secret: cfg.secret,
      relayUrl: 'wss://relay.example/axiom',
      git: { provider: 'gitlab', repo: 'grp/sub/vault', branch: 'notes', baseUrl: 'https://git.example' },
    });
    const url = buildJoinUrl(cfg, 'https://axiom.app/#/today');
    expect(url.startsWith('https://axiom.app/#join=AXJ1.')).toBe(true);
    expect(parseSyncCode(url)).toEqual(info);
    expect(parseSyncCode('  ' + cfg.secret!.toLowerCase() + ' ')).toEqual({ secret: cfg.secret });
    expect(parseSyncCode('nonsense')).toBeNull();
    expect(parseSyncCode('AXJ1.%%%')).toBeNull();
    expect(() => buildSyncCode({ relayUrl: 'wss://x' })).toThrow();
  });

  it('applies join info, keeping a token only for the same repo', () => {
    const secret = generateSyncSecret();
    const joined = applyJoinInfo({ relayEnabled: false }, { secret, relayUrl: 'wss://r', git: { provider: 'github', repo: 'me/v', branch: 'main' } });
    expect(joined).toMatchObject({ secret, relayUrl: 'wss://r', relayEnabled: true, git: { token: '', enabled: false, repo: 'me/v' } });
    const kept = applyJoinInfo(
      { relayEnabled: true, git: { provider: 'github', repo: 'me/v', branch: 'main', token: 't', syncFiles: false, enabled: true } },
      { secret, git: { provider: 'github', repo: 'me/v', branch: 'main' } },
    );
    expect(kept.git).toMatchObject({ token: 't', enabled: true, syncFiles: false });
  });

  it('factories respect enabled flags', async () => {
    expect(await createRelayTransport({ relayEnabled: false, relayUrl: 'wss://x', secret: generateSyncSecret() })).toBeNull();
    expect(createGitRemote(undefined)).toBeNull();
    expect(createGitRemote({ provider: 'github', repo: 'a/b', branch: 'main', token: '', syncFiles: true, enabled: true })).toBeNull();
    expect(createGitRemote({ provider: 'gitlab', repo: 'a/b', branch: 'main', token: 't', syncFiles: true, enabled: true })!.id).toContain('gitlab:');
  });
});
