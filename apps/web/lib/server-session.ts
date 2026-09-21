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
    return await me(`sid=${token}`);
  } catch {
    return null;
  }
}