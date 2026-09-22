import { redirect } from 'next/navigation';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import type { MarbeteStatus } from '@quorum-backoffice/shared';
import { ListMarbetesFilter } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import { listMarbetes, getMarbeteCounters } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { StatusCards } from './_components/status-cards';
import { MarbetesFilters } from './_components/marbetes-filters';
import { MarbetesPageClient } from './_components/marbetes-page-client';

const VALID_STATUS: ReadonlySet<MarbeteStatus> = new Set(['active', 'inactive', 'revoked']);

/**
 * /marbetes — list view (WU8a).
 *
 * Server component: enforces auth + operator+ role, forwards the session
 * cookie to the API to fetch counters and the first page of marbetes
 * filtered by `status` and `search` from the URL search params.
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
    limit: 50,
    offset: 0,
  };

  const [counters, list] = await Promise.all([
    getMarbeteCounters(cookie),
    listMarbetes(filter, cookie),
  ]);

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Marbetes</h1>
      </div>
      <StatusCards counters={counters} />
      <MarbetesFilters />
      <MarbetesPageClient items={list.items} userRole={user.role} total={list.total} />
    </div>
  );
}
