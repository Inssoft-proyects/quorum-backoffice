import { getMarbeteCounters, listMarbetes, deleteMarbete } from '@/lib/api-client';

describe('marbetes api-client wrappers', () => {
  it('getMarbeteCounters returns counters', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ ok: 5, ko: 2 }), { status: 200 })) as unknown as typeof fetch;
    expect(await getMarbeteCounters()).toEqual({ ok: 5, ko: 2 });
  });

  it('listMarbetes encodes filter params in querystring', async () => {
    let lastUrl = '';
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      lastUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({ total: 0, limit: 50, offset: 0, items: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await listMarbetes({ status: 'active', search: 'AB', limit: 50, offset: 0 });
    expect(lastUrl).toMatch(/status=active/);
    expect(lastUrl).toMatch(/search=AB/);
  });

  it('deleteMarbete sends x-otp-code and reason body', async () => {
    const captured: {
      value: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string;
      } | null;
    } = { value: null };
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.value = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        headers,
        body: String(init?.body ?? ''),
      };
      return new Response(
        JSON.stringify({ id: 1, publicUid: 'm-X', status: 'revoked' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await deleteMarbete(1, { reason: 'test reason' }, '123456');
    expect(captured.value).not.toBeNull();
    expect(captured.value?.method).toBe('DELETE');
    expect(captured.value?.url).toMatch(/api\/v1\/marbetes\/1/);
    expect(captured.value?.headers['x-otp-code']).toBe('123456');
    expect(captured.value?.body).toBe(JSON.stringify({ reason: 'test reason' }));
  });
});
