import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { WebLLMProvider, webllmProgress, type WebLLMModule } from './webllm';
import { BridgeProvider, bridgeRequests, bridgeSettled, cleanPastedAnswer } from './bridge';
import { AIProviderError, AIUnavailableError } from './errors';
import type { AIRequest } from './types';

const img = { mime: 'image/png', data: 'iVBORw0KGgo=' };

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}
const sent = (fn: ReturnType<typeof mockFetch>, i = 0) => {
  const [url, init] = fn.mock.calls[i];
  return { url, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) };
};

afterEach(() => vi.unstubAllGlobals());

describe('gemini', () => {
  const p = new GeminiProvider(() => ({ apiKey: 'KEY', model: '' }));

  it('builds a multimodal generateContent request with JSON mode', async () => {
    const fn = mockFetch({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '["a"]' }] } }] });
    const req: AIRequest = { task: 'tags', prompt: 'P', system: 'S', images: [img], json: true, temperature: 0.1, maxTokens: 50 };
    expect(await p.complete(req)).toBe('["a"]');
    const { url, body } = sent(fn);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=KEY');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'P' }, { inline_data: { mime_type: 'image/png', data: img.data } }] }]);
    expect(body.system_instruction).toEqual({ parts: [{ text: 'S' }] });
    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 50, responseMimeType: 'application/json' });
  });

  it('is configured only with a key; surfaces HTTP errors and blocks', async () => {
    expect(new GeminiProvider(() => undefined).isConfigured()).toBe(false);
    expect(p.isConfigured()).toBe(true);
    mockFetch({ error: { message: 'Quota exceeded' } }, 429);
    await expect(p.complete({ task: 'chat', prompt: 'x' })).rejects.toThrow(/429.*quota.*Quota exceeded/i);
    mockFetch({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(p.complete({ task: 'chat', prompt: 'x' })).rejects.toThrow(/SAFETY/);
  });
});

describe('openai-compatible', () => {
  it('posts chat/completions with data-URL image parts and bearer auth', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'hello' } }] });
    const p = new OpenAIProvider(() => ({ baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk', model: 'm' }));
    expect(await p.complete({ task: 'handwriting', prompt: 'P', system: 'S', images: [img], maxTokens: 9 })).toBe('hello');
    const { url, headers, body } = sent(fn);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers.authorization).toBe('Bearer sk');
    expect(body).toMatchObject({ model: 'm', max_tokens: 9, stream: false });
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'P' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${img.data}` } },
        ],
      },
    ]);
  });

  it('works keyless (Ollama) with plain string content', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'ok' } }] });
    const p = new OpenAIProvider(() => ({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }));
    expect(p.isConfigured()).toBe(true);
    await p.complete({ task: 'chat', prompt: 'P' });
    const { headers, body } = sent(fn);
    expect(headers.authorization).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'P' }]);
  });

  it('reports network failures as provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const p = new OpenAIProvider(() => ({ baseUrl: 'http://localhost:1234/v1', model: 'x' }));
    await expect(p.complete({ task: 'chat', prompt: 'P' })).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe('anthropic', () => {
  it('posts to the Messages API with browser-access headers and base64 images', async () => {
    const fn = mockFetch({ content: [{ type: 'text', text: '\\frac{a}{b}' }], stop_reason: 'end_turn' });
    const p = new AnthropicProvider(() => ({ apiKey: 'ak', model: '' }));
    expect(await p.complete({ task: 'math-ocr', prompt: 'P', system: 'S', images: [img], temperature: 0 })).toBe('\\frac{a}{b}');
    const { url, headers, body } = sent(fn);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers).toMatchObject({
      'x-api-key': 'ak',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(body).toMatchObject({ model: 'claude-haiku-4-5', system: 'S', temperature: 0 });
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } },
          { type: 'text', text: 'P' },
        ],
      },
    ]);
  });

  it('maps 401 to a helpful message', async () => {
    mockFetch({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    const p = new AnthropicProvider(() => ({ apiKey: 'bad', model: 'claude-haiku-4-5' }));
    await expect(p.complete({ task: 'chat', prompt: 'P' })).rejects.toThrow(/401.*API key.*invalid x-api-key/);
  });
});

describe('webllm', () => {
  it('requires enabled + WebGPU; lazily creates the engine once and reports progress', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'local answer' } }] }));
    const CreateMLCEngine = vi.fn(async (_m: string, cfg: { initProgressCallback?: (r: { progress: number; text: string }) => void }) => {
      cfg.initProgressCallback?.({ progress: 1, text: 'ready' });
      return { chat: { completions: { create } }, interruptGenerate: vi.fn() };
    });
    const mod: WebLLMModule = { CreateMLCEngine };
    const p = new WebLLMProvider(() => ({ enabled: true, model: 'M' }), async () => mod);
    expect(p.isConfigured()).toBe(false); // no navigator.gpu in happy-dom
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });
    expect(p.isConfigured()).toBe(true);
    const progress: number[] = [];
    const off = webllmProgress.on((e) => progress.push(e.progress));
    expect(await p.complete({ task: 'summarize', prompt: 'P', system: 'S' })).toBe('local answer');
    await p.complete({ task: 'summarize', prompt: 'P2' });
    off();
    expect(CreateMLCEngine).toHaveBeenCalledTimes(1);
    expect(CreateMLCEngine.mock.calls[0][0]).toBe('M');
    expect(progress).toEqual([1]);
    expect(create.mock.calls[0]).toEqual([{ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }], temperature: undefined, max_tokens: 1024 }]);
  });
});

describe('bridge', () => {
  it('emits a pending request and resolves with the pasted answer', async () => {
    const p = new BridgeProvider(() => ({ enabled: true, target: 'chatgpt' }));
    const settled: string[] = [];
    const offS = bridgeSettled.on((id) => settled.push(id));
    const off = bridgeRequests.on((r) => {
      expect(r.target).toBe('chatgpt');
      expect(r.prompt).toContain('Summarize this');
      expect(r.prompt).toContain('answer only');
      r.resolve('```\nThe summary.\n```');
    });
    expect(await p.complete({ task: 'summarize', prompt: 'Summarize this' })).toBe('The summary.');
    expect(settled).toHaveLength(1);
    off();
    offS();
  });

  it('rejects when cancelled, aborted, or no dialog is mounted', async () => {
    const p = new BridgeProvider(() => ({ enabled: true, target: 'claude' }));
    await expect(p.complete({ task: 'chat', prompt: 'x' })).rejects.toBeInstanceOf(AIUnavailableError);
    const off = bridgeRequests.on((r) => r.cancel());
    await expect(p.complete({ task: 'chat', prompt: 'x' })).rejects.toThrow(/cancelled/);
    off();
    const off2 = bridgeRequests.on(() => {});
    const ctrl = new AbortController();
    const pending = p.complete({ task: 'chat', prompt: 'x' }, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toBeDefined();
    off2();
  });

  it('cleans pasted answers', () => {
    expect(cleanPastedAnswer('```json\n["a"]\n```')).toBe('["a"]');
    expect(cleanPastedAnswer('  plain  ')).toBe('plain');
  });
});
