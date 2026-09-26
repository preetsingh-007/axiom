/** Small fetch helpers shared by the citation clients (timeouts + cancellation). */

export interface HttpOptions {
  signal?: AbortSignal;
  /** default 12 s */
  timeoutMs?: number;
  /** injectable fetch (tests, proxies) */
  fetch?: typeof fetch;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly response?: Response,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** fetch with a timeout that also honours an outer AbortSignal. */
export async function fetchWithTimeout(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<Response> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new DOMException('Timed out', 'TimeoutError')), opts.timeoutMs ?? 12000);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
