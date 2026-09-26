import type { ProviderId } from './types';
import { AIProviderError, httpError, isAbortError } from './errors';

/** POSTs JSON and returns the parsed response; network and HTTP failures become AIProviderError. */
export async function postJSON<T>(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw e;
    throw new AIProviderError(`network error (${(e as Error).message || 'unreachable'}; offline or blocked by CORS?)`, provider);
  }
  if (!res.ok) throw await httpError(provider, res);
  try {
    return (await res.json()) as T;
  } catch {
    throw new AIProviderError('invalid JSON response', provider, res.status);
  }
}

/** Throws when a provider returned no usable text. */
export function requireText(provider: ProviderId, text: string | undefined, why = 'empty response'): string {
  const t = text?.trim();
  if (!t) throw new AIProviderError(why, provider);
  return t;
}
