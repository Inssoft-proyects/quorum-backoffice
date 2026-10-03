/**
 * Hook-level tests for `useOtpGrant` (apps/web/components/inventory).
 *
 * The hook consumes `getMarbeteOtpGrant` and exposes a
 * `{ status, loading, error, refresh }` tuple. Tests cover:
 *
 *  - Initial fetch on mount resolves to the supplied status.
 *  - `refresh()` re-fetches and updates `status`.
 *  - A failing fetch surfaces `error` AND resolves `status` to the
 *    safe default `{ active: false, expiresAt: null }` so the dialogs
 *    degrade to "OTP required" rather than silently no-oping.
 */
import { act, renderHook } from '@testing-library/react';
import { useOtpGrant } from '@/components/inventory/use-otp-grant';

function installFetch(handler: (url: string) => { status: number; body: unknown }): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('useOtpGrant', () => {
  it('starts with a null status and resolves after the initial fetch', async () => {
    installFetch(() => ({
      status: 200,
      body: { active: true, expiresAt: '2025-01-01T12:20:00Z' },
    }));
    const { result } = renderHook(() => useOtpGrant());
    expect(result.current.status).toBeNull();
    await act(async () => {
      // Allow the useEffect-driven initial fetch to settle.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toEqual({
      active: true,
      expiresAt: '2025-01-01T12:20:00Z',
    });
    expect(result.current.error).toBeNull();
  });

  it('refresh() updates status with the freshly-fetched value', async () => {
    let active = false;
    installFetch(() => ({
      status: 200,
      body: { active, expiresAt: active ? '2025-01-01T12:20:00Z' : null },
    }));
    const { result } = renderHook(() => useOtpGrant());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status?.active).toBe(false);

    active = true;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status?.active).toBe(true);
    expect(result.current.status?.expiresAt).toBe('2025-01-01T12:20:00Z');
  });

  it('a transport failure surfaces error and falls back to { active: false, expiresAt: null }', async () => {
    installFetch(() => ({ status: 500, body: { code: 'internal', message: 'boom' } }));
    const { result } = renderHook(() => useOtpGrant());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Status resolved to the safe default.
    expect(result.current.status).toEqual({ active: false, expiresAt: null });
    expect(result.current.error).not.toBeNull();
  });
});