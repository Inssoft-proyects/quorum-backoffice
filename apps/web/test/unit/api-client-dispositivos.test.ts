import { listDispositivos, createDispositivo, revokeDispositivo } from '@/lib/api-client';

describe('dispositivos api-client wrappers', () => {
  it('listDispositivos encodes filter params in querystring', async () => {
    let lastUrl = '';
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      lastUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ total: 0, limit: 50, offset: 0, items: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await listDispositivos({ status: 'active', search: 'SN-AB', limit: 50, offset: 0 });
    expect(lastUrl).toMatch(/status=active/);
    expect(lastUrl).toMatch(/search=SN-AB/);
  });

  it('createDispositivo sends POST + x-otp-code + JSON body with serialNumber', async () => {
    const captured: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {};
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.method = init?.method ?? '';
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      captured.body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 1,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'active',
          createdAt: '',
          createdBy: 'x',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    await createDispositivo({ serialNumber: 'SN-XYZ', brand: 'Apple' }, '123456');
    expect(captured.method).toBe('POST');
    expect(captured.headers?.['x-otp-code']).toBe('123456');
    const parsed = JSON.parse(captured.body ?? '{}') as {
      serialNumber: string;
      brand?: string;
    };
    expect(parsed.serialNumber).toBe('SN-XYZ');
    expect(parsed.brand).toBe('Apple');
  });

  it('revokeDispositivo sends DELETE + x-otp-code + reason body', async () => {
    const captured: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {};
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.method = init?.method ?? '';
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      captured.body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 1,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'revoked',
          createdAt: '',
          createdBy: 'x',
          revokedAt: '',
          revokedReason: 'lost',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await revokeDispositivo(1, { reason: 'device lost' }, '123456');
    expect(captured.method).toBe('DELETE');
    expect(captured.headers?.['x-otp-code']).toBe('123456');
    const parsed = JSON.parse(captured.body ?? '{}') as { reason: string };
    expect(parsed.reason).toBe('device lost');
  });
});