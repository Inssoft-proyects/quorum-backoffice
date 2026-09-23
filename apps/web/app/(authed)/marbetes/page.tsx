import { redirect } from 'next/navigation';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import type { MarbeteStatus } from '@quorum-backoffice/shared';
import { ListMarbetesFilter } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import { listMarbetes, getMarbeteCounters } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { MarbetesPageClient } from './_components/marbetes-page-client';

const VALID_STATUS: ReadonlySet<MarbeteStatus> = new Set(['active', 'inactive', 'revoked']);

/**
 * /marbetes — list view (maquette v2).
 *
 * Server component: enforces auth + operator+ role (same as the prior
 * implementation) and forwards the session cookie to both endpoints. We
 * fetch up to 200 items (the API's hard max) so the in-page metric cards
 * can compute their counters from a single source; the maquette keeps
 * counters close to the data they represent.
 */
export default async function MarbetesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const user = await getServerSession();
  if (!user) redirect('/login');
  if (!hasAtLeastRole(user.role, 'operator')) redirect('/dashboard');

  const sp = await searchParams;
  const cookie = await getAuthCookieHeader();

  const rawStatus = typeof sp.status === 'string' ? sp.status : '';
  const rawSearch = typeof sp.search === 'string' ? sp.search : '';
  const status: MarbeteStatus | undefined = VALID_STATUS.has(rawStatus as MarbeteStatus)
    ? (rawStatus as MarbeteStatus)
    : undefined;

  const filter: z.input<typeof ListMarbetesFilter> = {
    status,
    search: rawSearch || undefined,
    limit: 200,
    offset: 0,
  };

  const [counters, list] = await Promise.all([
    getMarbeteCounters(cookie),
    listMarbetes(filter, cookie),
  ]);

  // Counters are still fetched so the API contract stays covered, but the
  // redesigned page derives its metric counts from the in-memory list so
  // the four cards remain consistent with the visible rows.
  void counters;

  return (
    <MarbetesPageClient items={list.items} userRole={user.role} />
  );
}
