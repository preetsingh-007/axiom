/** Tiny fetch mock for the GitHub/GitLab remote tests (not used by the app). */
export interface MockCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export interface MockReply {
  status?: number;
  json?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
}

export type MockRoute = [method: string, path: string | RegExp, handler: (c: MockCall) => MockReply | undefined];

export function mockFetch(routes: MockRoute[]) {
  const calls: MockCall[] = [];
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const c: MockCall = {
      method: init.method ?? 'GET',
      url,
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    for (const [method, pattern, h] of routes) {
      if (method !== c.method) continue;
      if (typeof pattern === 'string' ? path !== pattern : !pattern.test(path)) continue;
      const r = h(c);
      if (!r) continue;
      const body = r.raw ? (r.raw as BodyInit) : r.json === undefined ? null : JSON.stringify(r.json);
      return new Response(body, {
        status: r.status ?? 200,
        headers: { 'content-type': r.raw ? 'application/octet-stream' : 'application/json', ...(r.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 });
  };
  return { fetch, calls };
}
