import type { AIConfig, AIProvider, AIRequest } from './types';
import { AIProviderError } from './errors';
import { requireText } from './http';
import { Emitter } from '../util/emitter';

export const DEFAULT_WEBLLM_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
/** Loaded at runtime from a CDN so the (large) library never enters the app bundle. */
export const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm';

export interface WebLLMProgress {
  model: string;
  /** 0..1 */
  progress: number;
  text: string;
}

/** Engine download / compile progress (the first run downloads the model weights). */
export const webllmProgress = new Emitter<WebLLMProgress>();

interface WebLLMEngine {
  chat: {
    completions: {
      create(req: {
        messages: { role: 'system' | 'user'; content: string }[];
        temperature?: number;
        max_tokens?: number;
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
  interruptGenerate(): void;
}

export interface WebLLMModule {
  CreateMLCEngine(
    model: string,
    config: { initProgressCallback?: (r: { progress: number; text: string }) => void },
  ): Promise<WebLLMEngine>;
}

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** On-device model via WebGPU (MLC WebLLM). Text-only, fully offline once the weights are cached. */
export class WebLLMProvider implements AIProvider {
  readonly id = 'webllm' as const;
  readonly label = 'On-device model (WebGPU)';
  readonly supportsImages = false;
  private engine: { model: string; ready: Promise<WebLLMEngine> } | null = null;

  constructor(
    private readonly getConfig: () => AIConfig['webllm'],
    private readonly loadModule: () => Promise<WebLLMModule> = () => import(/* @vite-ignore */ WEBLLM_URL),
  ) {}

  isConfigured(): boolean {
    return !!this.getConfig()?.enabled && hasWebGPU();
  }

  /** Starts (or returns) the engine for the configured model; progress goes to `webllmProgress`. */
  init(): Promise<WebLLMEngine> {
    const model = this.getConfig()?.model?.trim() || DEFAULT_WEBLLM_MODEL;
    if (this.engine?.model === model) return this.engine.ready;
    const ready = this.loadModule().then((mod) =>
      mod.CreateMLCEngine(model, {
        initProgressCallback: (r) => webllmProgress.emit({ model, progress: r.progress, text: r.text }),
      }),
    );
    this.engine = { model, ready };
    ready.catch(() => {
      if (this.engine?.ready === ready) this.engine = null;
    });
    return ready;
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    let engine: WebLLMEngine;
    try {
      engine = await this.init();
    } catch (e) {
      throw new AIProviderError(`could not start the on-device model (${(e as Error).message})`, this.id);
    }
    signal?.throwIfAborted();
    const onAbort = () => engine.interruptGenerate();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const messages: { role: 'system' | 'user'; content: string }[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.prompt });
      const res = await engine.chat.completions.create({
        messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens ?? 1024,
      });
      signal?.throwIfAborted();
      return requireText(this.id, res.choices[0]?.message.content ?? undefined);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
