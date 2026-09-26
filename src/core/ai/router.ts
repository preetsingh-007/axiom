import type { AIConfig, AIProvider, AIRequest, AIResult, AITask, ProviderId } from './types';
import { AIRouterError, AITimeoutError, AIUnavailableError, isAbortError } from './errors';
import { extractJSON } from './json';
import { LocalProvider } from './local';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { WebLLMProvider } from './webllm';
import { BridgeProvider } from './bridge';

/** Default per-provider time budgets (ms). The bridge waits for a human; WebLLM may download weights. */
export const DEFAULT_TIMEOUTS: Record<ProviderId, number> = {
  local: 10_000,
  gemini: 60_000,
  openai: 90_000,
  anthropic: 60_000,
  webllm: 600_000,
  bridge: 900_000,
};

export interface AIRouterOptions {
  timeouts?: Partial<Record<ProviderId, number>>;
  /** replace built-in providers (tests, custom engines) */
  providers?: AIProvider[];
}

/**
 * Tries providers in `config.order` that are configured and capable (image requests need
 * `supportsImages`), with a per-provider timeout, then falls back to the offline 'local'
 * provider for the tasks it supports. Errors from every attempt are reported together.
 */
export class AIRouter {
  private readonly byId = new Map<ProviderId, AIProvider>();
  private readonly timeouts: Record<ProviderId, number>;

  constructor(
    private readonly getConfig: () => AIConfig,
    opts: AIRouterOptions = {},
  ) {
    const builtIn: AIProvider[] = [
      new LocalProvider(),
      new GeminiProvider(() => getConfig().gemini),
      new OpenAIProvider(() => getConfig().openai),
      new AnthropicProvider(() => getConfig().anthropic),
      new WebLLMProvider(() => getConfig().webllm),
      new BridgeProvider(() => getConfig().bridge),
    ];
    for (const p of builtIn) this.byId.set(p.id, p);
    for (const p of opts.providers ?? []) this.byId.set(p.id, p);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  /** Every provider, in the configured preference order (unlisted ones last). */
  providers(): AIProvider[] {
    const order = this.getConfig().order ?? [];
    const seen = new Set<ProviderId>();
    const out: AIProvider[] = [];
    for (const id of [...order, ...this.byId.keys()]) {
      const p = this.byId.get(id);
      if (p && !seen.has(id)) {
        seen.add(id);
        out.push(p);
      }
    }
    return out;
  }

  provider<T extends AIProvider = AIProvider>(id: ProviderId): T | undefined {
    return this.byId.get(id) as T | undefined;
  }

  /** Providers that would be tried for this request, in order. */
  candidates(req: Pick<AIRequest, 'task' | 'images'>): AIProvider[] {
    const needsImages = !!req.images?.length;
    const capable = (p: AIProvider) =>
      (!needsImages || p.supportsImages) && (p.supportsTask?.(req.task) ?? true) && p.isConfigured();
    const order = this.getConfig().order ?? [];
    const list = this.providers().filter((p) => order.includes(p.id) && capable(p));
    const local = this.byId.get('local');
    if (local && !list.includes(local) && capable(local)) list.push(local);
    return list;
  }

  /** Whether any provider could handle the task right now. */
  canHandle(task: AITask, opts: { images?: boolean } = {}): boolean {
    return this.candidates({ task, images: opts.images ? [{ mime: '', data: '' }] : undefined }).length > 0;
  }

  /** Completes a request with the first provider that succeeds. */
  complete(req: AIRequest, signal?: AbortSignal): Promise<AIResult> {
    return this.run(req, signal, (text) => text).then(({ value, provider }) => ({ text: value, provider }));
  }

  /**
   * Completes a JSON request: extracts JSON from fenced/unfenced output and validates it.
   * `validate` returns the typed value, or undefined (or throws) to reject it — in which
   * case the next provider is tried.
   */
  completeJSON<T>(
    req: AIRequest,
    validate: (value: unknown) => T | undefined,
    signal?: AbortSignal,
  ): Promise<{ value: T; provider: ProviderId }> {
    return this.run({ ...req, json: true }, signal, (text) => {
      const value = validate(extractJSON(text));
      if (value === undefined || value === null) throw new Error('answer did not have the expected shape');
      return value;
    });
  }

  private async run<T>(
    req: AIRequest,
    signal: AbortSignal | undefined,
    accept: (text: string) => T,
  ): Promise<{ value: T; provider: ProviderId }> {
    const list = this.candidates(req);
    if (!list.length) {
      throw new AIUnavailableError(
        req.images?.length
          ? `No configured AI provider can read images for "${req.task}". Add a free Gemini API key in Settings → AI.`
          : `No configured AI provider can handle "${req.task}". Configure one in Settings → AI.`,
        req.task,
      );
    }
    const attempts: { provider: ProviderId; error: Error }[] = [];
    for (const p of list) {
      signal?.throwIfAborted();
      const ms = this.timeouts[p.id];
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal!.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(new AITimeoutError(p.id, ms)), ms);
      try {
        const text = await Promise.race([
          p.complete(req, ctrl.signal),
          new Promise<never>((_, reject) =>
            ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true }),
          ),
        ]);
        return { value: accept(text), provider: p.id };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        const error = e instanceof Error ? e : new Error(String(e));
        attempts.push({ provider: p.id, error: isAbortError(error) && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    if (attempts.length === 1) throw attempts[0].error;
    throw new AIRouterError(req.task, attempts);
  }
}
