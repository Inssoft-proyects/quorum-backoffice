import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import type { ReactNode } from 'react';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('unused', { status: 404 })) as unknown as typeof fetch;
  });

  it('starts with null user and idle status', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.user).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('login() updates user on success', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({ user: { id: 1, email: 'admin@quorum.local', role: 'admin' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login('admin', 'AB12CD');
    });
    expect(result.current.user).toEqual({
      id: 1,
      email: 'admin@quorum.local',
      role: 'admin',
    });
    expect(result.current.status).toBe('idle');
  });

  it('login() sets error on 401 with invalid_credentials', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'invalid_credentials', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      try {
        await result.current.login('admin', 'AB12CD');
      } catch {
        /* expected */
      }
    });
    expect(result.current.user).toBeNull();
    // Either "Usuario o código incorrecto" (invalid_credentials mapping) or
    // any other Spanish-language rejection — never the raw English message.
    expect(result.current.error).toMatch(/incorrecto|expirado|verifica/i);
    expect(result.current.status).toBe('error');
  });

  it('logout() clears user', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.user).toBeNull();
    expect(result.current.error).toBeNull();
  });
});