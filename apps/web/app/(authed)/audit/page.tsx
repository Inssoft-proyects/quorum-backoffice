import { redirect } from 'next/navigation';
import { hasAtLeastRole, ListAuditFilter } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import { listAuditEntries } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { AuditFilters } from './_components/audit-filters';
import { AuditPageClient } from './_components/audit-page-client';

const VALID_ENTITY_TYPES = new Set(['marbete', 'dispositivo', 'session']);
const VALID_ACTIONS = new Set([
  'marbete.create',
  'marbete.update',
  'marbete.delete',
  'marbete.assign',
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
  'auth.login',
  'auth.logout',
  'auth.failed',
]);

function pickString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * /audit — read-only audit log screen (WU10).
 *
 * Server component: enforces session + auditor+ role, forwards the session
 * cookie to the API to fetch the first page filtered by the URL params
 * (entityType, actorId, action, since, until, search). The page only
 * surfaces GET /api/v1/audit; there are no OTP-gated writes.
 *
 * Mirrors the dispositivos/marbetes server components, gated to auditor+
 * instead of operator+. The `auditor` role can read everything but cannot
 * write. `admin` and `auditor` both reach this screen; `operator` does
 * not (redirected to /dashboard).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const user = await getServerSession();
  if (!user) redirect('/login');
  if (!hasAtLeastRole(user.role, 'auditor')) redirect('/dashboard');

  const sp = await searchParams;
  const cookie = await getAuthCookieHeader();

  const rawEntityType = pickString(sp.entityType);
  const rawActorId = pickString(sp.actorId);
  const rawAction = pickString(sp.action);
  const rawSince = pickString(sp.since);
  const rawUntil = pickString(sp.until);
  const rawSearch = pickString(sp.search);

  const filter: z.input<typeof ListAuditFilter> = {
    limit: 100,
    offset: 0,
  };
  if (VALID_ENTITY_TYPES.has(rawEntityType)) {
    filter.entityType = rawEntityType as 'marbete' | 'dispositivo' | 'session';
  }
  if (rawActorId) filter.actorId = rawActorId;
  if (VALID_ACTIONS.has(rawAction)) {
    filter.action = rawAction as z.input<typeof ListAuditFilter>['action'];
  }
  if (rawSince) filter.since = rawSince;
  if (rawUntil) filter.until = rawUntil;
  if (rawSearch) filter.search = rawSearch;

  const list = await listAuditEntries(filter, cookie);

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Auditoría</h1>
      </div>
      <AuditFilters />
      <AuditPageClient items={list.items} total={list.total} />
    </div>
  );
}