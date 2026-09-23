/**
 * Server-side session lookup.
 *
 * Reads the `sid` cookie via next/headers and forwards it to the API's
 * GET /api/v1/auth/me endpoint. Returns the resolved user or null if the
 * cookie is missing / expired / invalid.
 *
 * Use this in server components / route handlers / layouts to decide
 * whether to render authed UI or redirect to /login.
 */
import { cookies } from 'next/headers';
import { me } from './api-client';
import type { MeResponse } from '@quorum-backoffice/shared';

const COOKIE_NAME = process.env['AUTH_COOKIE_NAME'] ?? 'sid';

export async function getServerSession(): Promise<MeResponse | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const cookieHeader = await getAuthCookieHeader();
    if (!cookieHeader) return null;
    return await me(cookieHeader);
  } catch {
    return null;
  }
}

/**
 * Builds the Cookie header value for forwarding the session token from a
 * server component / route handler to the API. Reads the same
 * `AUTH_COOKIE_NAME` env var as `getServerSession()` so the value can
 * never drift between the layout guard and the data fetches.
 *
 * Use this from any server component that needs to call the API
 * directly (e.g. `/marbetes`, `/dispositivos`, `/audit`). Without it,
 * the API responds 401 in production because the real cookie name is
 * `__Host-sid` (per HANDOFF.md §decisiones-técnicas) and the page code
 * would otherwise hardcode `sid`.
 */
export async function getAuthCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? `${COOKIE_NAME}=${token}` : undefined;
}