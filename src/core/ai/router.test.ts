import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIRouter } from './router';
import { AIRouterError, AITimeoutError, AIUnavailableError } from './errors';
import { extractJSON } from './json';
import { DEFAULT_AI_CONFIG, loadAIConfig, normalizeAIConfig, saveAIConfig } from './config';
import { clozeRequest, handwritingRequest, mathOcrRequest, tagsRequest } from './prompts';
import type { AIConfig, AIProvider, AIRequest, ProviderId } from './types';
import { Vault } from '../vault';

function fake(id: ProviderId, impl: (req: AIRequest, signal?: AbortSignal) => Promise<string>, opts: Partial<AIProvider> = {}): AIProvider & { calls: number } {
  const p = {
    id,
    label: id,
    supportsImages: true,
    calls: 0,
    isConfigured: () => true,
    complete(req: AIRequest, signal?: AbortSignal) {
      p.calls++;
      return impl(req, signal);
    },
    ...opts,
  };
  return p;
}

const cfg = (order: ProviderId[]): AIConfig => ({ ...DEFAULT_AI_CONFIG, order });

afterEach(() => vi.useRealTimers());

describe('AIRouter', () => {
  it('tries providers in order and falls through on failure', async () => {
    const gemini = fake('gemini', async () => Promise.reject(new Error('HTTP 429')));
    const anthropic = fake('anthropic', async () => 'from claude');
    const router = new AIRouter(() => cfg(['gemini', 'anthropic', 'openai']), { providers: [gemini, anthropic] });
    expect(await router.complete({ task: 'chat', prompt: 'hi' })).toEqual({ text: 'from claude', provider: 'anthropic' });
    expect(gemini.calls).toBe(1);
  });

  it('skips unconfigured providers and image-incapable ones for image requests', async () => {
    const gemini = fake('gemini', async () => 'g', { isConfigured: () => false });
    const webllm = fake('webllm', async () => 'w', { supportsImages: false });
    const openai = fake('openai', async () => 'o');
    const router = new AIRouter(() => cfg(['gemini', 'webllm', 'openai']), { providers: [gemini, webllm, openai] });
    expect((await router.complete(handwritingRequest({ mime: 'image/png', data: 'x' }))).provider).toBe('openai');
    expect(webllm.calls).toBe(0);
    expect((await router.complete({ task: 'chat', prompt: 'x' })).provider).toBe('webllm');
  });

  it('falls back to local for tasks it supports, even when not listed', async () => {
    const gemini = fake('gemini', async () => Promise.reject(new Error('offline')));
    const router = new AIRouter(() => cfg(['gemini']), { providers: [gemini] });
    const res = await router.complete(tagsRequest('Reinforcement learning and the Bellman equation. The Bellman equation again.'));
    expect(res.provider).toBe('local');
    expect(JSON.parse(res.text)).toContain('bellman equation');
    expect(router.canHandle('tags')).toBe(true);
  });

  it('reports a typed error when nothing can handle the task', async () => {
    const router = new AIRouter(() => cfg(['gemini', 'local']), { providers: [fake('gemini', async () => '', { isConfigured: () => false })] });
    expect(router.canHandle('math-ocr', { images: true })).toBe(false);
    await expect(router.complete(mathOcrRequest({ mime: 'image/png', data: 'x' }))).rejects.toBeInstanceOf(AIUnavailableError);
  });

  it('aggregates errors from every attempt', async () => {
    const router = new AIRouter(() => cfg(['gemini', 'openai']), {
      providers: [fake('gemini', async () => Promise.reject(new Error('quota'))), fake('openai', async () => Promise.reject(new Error('down')))],
    });
    const err = await router.complete({ task: 'chat', prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AIRouterError);
    expect(err.message).toMatch(/gemini: quota.*openai: down/);
    expect(err.attempts).toHaveLength(2);
  });

  it('enforces a per-provider timeout and moves on', async () => {
    let aborted = false;
    const slow = fake('gemini', (_req, signal) => new Promise<string>((_, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); })));
    const fast = fake('openai', async () => 'fast');
    const router = new AIRouter(() => cfg(['gemini', 'openai']), { providers: [slow, fast], timeouts: { gemini: 20 } });
    expect((await router.complete({ task: 'chat', prompt: 'x' })).provider).toBe('openai');
    expect(aborted).toBe(true);
  });

  it('reports the timeout when it was the only candidate', async () => {
    const slow = fake('gemini', () => new Promise<string>(() => {}));
    const router = new AIRouter(() => cfg(['gemini']), { providers: [slow], timeouts: { gemini: 10 } });
    await expect(router.complete({ task: 'chat', prompt: 'x' })).rejects.toBeInstanceOf(AITimeoutError);
  });

  it('stops immediately when the caller aborts', async () => {
    const p1 = fake('gemini', (_r, signal) => new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))));
    const p2 = fake('openai', async () => 'should not run');
    const router = new AIRouter(() => cfg(['gemini', 'openai']), { providers: [p1, p2] });
    const ctrl = new AbortController();
    const pending = router.complete({ task: 'chat', prompt: 'x' }, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toBeDefined();
    expect(p2.calls).toBe(0);
  });

  it('completeJSON extracts, validates and falls through on bad output', async () => {
    const bad = fake('gemini', async () => 'Sure! Here you go: not json');
    const good = fake('anthropic', async () => 'Here:\n```json\n[{"text": "{{c1::x}} y"}]\n```\nHope it helps');
    const router = new AIRouter(() => cfg(['gemini', 'anthropic']), { providers: [bad, good] });
    const res = await router.completeJSON(clozeRequest('x y'), (v) => (Array.isArray(v) ? (v as { text: string }[]) : undefined));
    expect(res).toEqual({ value: [{ text: '{{c1::x}} y' }], provider: 'anthropic' });
  });

  it('lists providers in configured order', () => {
    const router = new AIRouter(() => cfg(['anthropic', 'local']));
    expect(router.providers().map((p) => p.id).slice(0, 2)).toEqual(['anthropic', 'local']);
    expect(router.providers()).toHaveLength(6);
  });
});

describe('extractJSON', () => {
  it('handles plain, fenced, prose-wrapped and slightly broken JSON', () => {
    expect(extractJSON('["a","b"]')).toEqual(['a', 'b']);
    expect(extractJSON('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJSON('Here are the tags: ["x", "y"]. Let me know!')).toEqual(['x', 'y']);
    expect(extractJSON('{"a": [1, 2,],}')).toEqual({ a: [1, 2] });
    expect(extractJSON('Result: [“smart”, “quotes”]')).toEqual(['smart', 'quotes']);
    expect(extractJSON('text {"s": "brace } inside"} more')).toEqual({ s: 'brace } inside' });
    expect(() => extractJSON('no json here')).toThrow(SyntaxError);
  });
});

describe('config', () => {
  it('normalises order and fills defaults', () => {
    const c = normalizeAIConfig({ order: ['local', 'bogus' as ProviderId, 'local', 'gemini'] });
    expect(c.order).toEqual(['local', 'gemini']);
    expect(c.webllm).toEqual(DEFAULT_AI_CONFIG.webllm);
    expect(normalizeAIConfig(undefined).order).toEqual(['gemini', 'anthropic', 'openai', 'webllm', 'bridge', 'local']);
  });

  it('persists in local-only storage, never in the synced index doc', async () => {
    const v = await Vault.open(`test-ai-config-${Date.now()}`);
    expect(await loadAIConfig(v)).toEqual(DEFAULT_AI_CONFIG);
    await saveAIConfig(v, { ...DEFAULT_AI_CONFIG, gemini: { apiKey: 'secret', model: 'gemini-flash-latest' } });
    expect((await loadAIConfig(v)).gemini?.apiKey).toBe('secret');
    expect(JSON.stringify(v.index.toJSON())).not.toContain('secret');
    await v.close();
  });
});
