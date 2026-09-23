import '@testing-library/jest-dom';

/**
 * Minimal WHATWG fetch polyfill for jsdom test environment.
 *
 * Jest 30 + jest-environment-jsdom 30 does NOT expose `Response`, `Request`,
 * `fetch`, or `Headers` on the test `globalThis`. We add a minimal subset
 * sufficient for `apps/web/lib/api-client.ts` (the only consumer of these
 * globals in tests) and its tests, which only need to construct
 * `Response`-shaped mocks and read `.status` / `.statusText` / `.json()`.
 *
 * Real `fetch` calls are stubbed in tests via `globalThis.fetch = ...`,
 * so this polyfill is not invoked at runtime by the application code —
 * it exists only so `new Response(...)` works inside the test files.
 */

class PolyfillHeaders {
  private readonly map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
}

class PolyfillResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: PolyfillHeaders;
  private readonly body: string;

  constructor(body: unknown, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
    this.body = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new PolyfillHeaders(init.headers ?? {});
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }

  async text(): Promise<string> {
    return this.body;
  }
}

if (typeof (globalThis as { Response?: unknown }).Response === 'undefined') {
  (globalThis as unknown as { Response: typeof PolyfillResponse }).Response = PolyfillResponse;
}
if (typeof (globalThis as { Headers?: unknown }).Headers === 'undefined') {
  (globalThis as unknown as { Headers: typeof PolyfillHeaders }).Headers = PolyfillHeaders;
}