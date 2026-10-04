import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeProviders } from './probe';
import { hasModelProvider, normalizeAIConfig } from './config';

afterEach(() => vi.unstubAllGlobals());

describe('probeProviders', () => {
  it('checks each configured remote provider directly and reports failures per provider', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('generativelanguage')
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetch);
    const cfg = normalizeAIConfig({ gemini: { apiKey: 'G', model: '' }, anthropic: { apiKey: 'A', model: '' } });
    let t = 0;
    const res = await probeProviders(cfg, undefined, () => (t += 100));
    expect(res.map((r) => [r.provider, r.ok])).toEqual([
      ['gemini', true],
      ['anthropic', false],
    ]);
    expect(res[0].detail).toBe('OK');
    expect(res[0].ms).toBeGreaterThan(0);
    expect(res[1].detail).toMatch(/401|invalid/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns nothing when no remote provider is configured (never falls back to heuristics)', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await probeProviders(normalizeAIConfig({ webllm: { model: 'm', enabled: true } }))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('hasModelProvider', () => {
  it('needs a real model, not just heuristics or the bridge', () => {
    expect(hasModelProvider(normalizeAIConfig({}))).toBe(false);
    expect(hasModelProvider(normalizeAIConfig({ bridge: { target: 'claude', enabled: true } }))).toBe(false);
    expect(hasModelProvider(normalizeAIConfig({ gemini: { apiKey: '  ', model: '' } }))).toBe(false);
    expect(hasModelProvider(normalizeAIConfig({ gemini: { apiKey: 'k', model: '' } }))).toBe(true);
    expect(hasModelProvider(normalizeAIConfig({ openai: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' } }))).toBe(true);
  });
});
