import type { AIConfig, ProviderId } from './types';
import { AIRouter } from './router';

/** Providers a "Test" button can check quickly (WebLLM would download ~1 GB; the bridge needs a human). */
export const PROBE_PROVIDERS = ['gemini', 'anthropic', 'openai'] as const satisfies readonly ProviderId[];

export interface ProbeResult {
  provider: ProviderId;
  label: string;
  ok: boolean;
  ms: number;
  /** the provider's reply on success, the error message on failure */
  detail: string;
}

/**
 * Sends a tiny request straight to each configured remote provider in `cfg` (which may be an
 * unsaved draft), bypassing the router's fallbacks so a bad key can't hide behind them.
 */
export async function probeProviders(cfg: AIConfig, signal?: AbortSignal, now: () => number = () => performance.now()): Promise<ProbeResult[]> {
  const router = new AIRouter(() => cfg);
  const targets = PROBE_PROVIDERS.map((id) => router.provider(id)!).filter((p) => p.isConfigured());
  return Promise.all(
    targets.map(async (p) => {
      const t0 = now();
      try {
        const text = await p.complete({ task: 'chat', prompt: 'Reply with exactly the word OK.', temperature: 0 }, signal);
        return { provider: p.id, label: p.label, ok: true, ms: Math.round(now() - t0), detail: text.trim().slice(0, 60) };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { provider: p.id, label: p.label, ok: false, ms: Math.round(now() - t0), detail: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}
