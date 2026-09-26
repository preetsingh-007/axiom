import type { AITask, ProviderId } from './types';

/** A provider (or the whole router) cannot perform this task at all — not a transient failure. */
export class AIUnavailableError extends Error {
  override readonly name = 'AIUnavailableError';
  constructor(
    message: string,
    readonly task?: AITask,
    readonly provider?: ProviderId,
  ) {
    super(message);
  }
}

/** A provider call failed (HTTP error, network error, empty or blocked answer). */
export class AIProviderError extends Error {
  override readonly name = 'AIProviderError';
  constructor(
    message: string,
    readonly provider: ProviderId,
    /** HTTP status when the failure came from an HTTP response */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A provider did not answer within its time budget. */
export class AITimeoutError extends Error {
  override readonly name = 'AITimeoutError';
  constructor(
    readonly provider: ProviderId,
    readonly ms: number,
  ) {
    super(`${provider} timed out after ${Math.round(ms / 1000)}s`);
  }
}

/** Every candidate provider failed; `attempts` lists each provider's error in order. */
export class AIRouterError extends Error {
  override readonly name = 'AIRouterError';
  constructor(
    readonly task: AITask,
    readonly attempts: { provider: ProviderId; error: Error }[],
  ) {
    super(
      `AI ${task} failed: ` + attempts.map((a) => `${a.provider}: ${a.error.message}`).join(' · '),
    );
  }
}

/** Builds an AIProviderError from a non-OK fetch Response, including the API's error message when present. */
export async function httpError(provider: ProviderId, res: Response): Promise<AIProviderError> {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? '';
    } catch {
      detail = body.slice(0, 200);
    }
  } catch {
    /* body unreadable */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ' (check the API key)'
      : res.status === 429
        ? ' (rate limit or free-tier quota reached)'
        : '';
  return new AIProviderError(`HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`, provider, res.status);
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string })?.name === 'AbortError';
}
