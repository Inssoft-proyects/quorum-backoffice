import { login, logout, me, ApiError } from '@/lib/api-client';

describe('api-client', () => {
  it('login posts to /api/v1/auth/login and returns the user', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe(JSON.stringify({ email: 'a@b.com', password: 'pw' }));
      return new Response(JSON.stringify({ user: { id: 1, email: 'a@b.com', role: 'admin' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const u = await login({ email: 'a@b.com', password: 'pw' });
    expect(u).toEqual({ id: 1, email: 'a@b.com', role: 'admin' });
  });

  it('login throws ApiError on 401', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'invalid_credentials', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(login({ email: 'a@b.com', password: 'pw' })).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
  });

  it('me returns null on 401', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'unauthorized', message: 'no session' }), {
        status: 401,
      })) as unknown as typeof fetch;
    expect(await me()).toBeNull();
  });

  it('me returns user on 200', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ id: 1, email: 'a@b.com', role: 'auditor' }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await me()).toEqual({ id: 1, email: 'a@b.com', role: 'auditor' });
  });

  it('logout succeeds on 200 and on 401', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(logout()).resolves.toBeUndefined();
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(logout()).resolves.toBeUndefined();
  });

  it('ApiError carries code, message, status', () => {
    const e = new ApiError('invalid_credentials', 'bad', 401);
    expect(e.code).toBe('invalid_credentials');
    expect(e.status).toBe(401);
    expect(e.message).toBe('bad');
    expect(e.name).toBe('ApiError');
  });
});