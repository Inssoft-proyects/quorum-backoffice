/**
 * API client for the backoffice.
 *
 * Two flavours:
 *   - `login`, `logout`, `me`: called from the browser; the browser
 *     handles the session cookie automatically via credentials: 'include'.
 *   - `login`, `logout`, `me` also accept an optional `cookie` string and
 *     forward it as the `cookie` header. This is how server components /
 *     route handlers / layouts talk to the API, since the browser cookie
 *     store is not available in the Node runtime.
 *
 * The base URL comes from NEXT_PUBLIC_API_URL (default http://127.0.0.1:3100).
 */

import type { LoginRequest, MeResponse } from '@quorum-backoffice/shared';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3100';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorEnvelope | null = null;
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(body?.code ?? 'unknown', body?.message ?? res.statusText, res.status);
}

export async function login(body: LoginRequest, cookie?: string): Promise<MeResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  const data = (await res.json()) as { user: MeResponse };
  return data.user;
}

export async function logout(cookie?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(`${API_BASE}/api/v1/auth/logout`, {
    method: 'POST',
    headers,
    credentials: 'include',
  });
  // 200 or 401 both mean "logged out" from the caller's perspective.
  if (res.status !== 200 && res.status !== 401) throw await parseError(res);
}

export async function me(cookie?: string): Promise<MeResponse | null> {
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
    method: 'GET',
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status === 401) return null;
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as MeResponse;
}