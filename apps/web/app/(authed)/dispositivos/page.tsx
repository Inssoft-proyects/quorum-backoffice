import { redirect } from 'next/navigation';
import type { DispositivoStatus } from '@quorum-backoffice/shared';
import { hasAtLeastRole, ListDispositivosFilter } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import { listDispositivos } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { DispositivosFilters } from './_components/dispositivos-filters';
import { DispositivosPageClient } from './_components/dispositivos-page-client';

const VALID_STATUS: ReadonlySet<DispositivoStatus> = new Set(['active', 'revoked']);

/**
 * /dispositivos — list view (WU9).
 *
 * Server component: enforces auth + operator+ role, forwards the session
 * cookie to the API to fetch the first page of dispositivos filtered by
 * `status` and `search` from the URL search params.
 *
 * Mirror of marbetes/page.tsx minus the counters card (dispositivos have
 * no counters endpoint in MVP). Edit + revoke actions are gated to admin
 * inside the table component via `hasAtLeastRole(userRole, 'admin')`.
 */
export default async function DispositivosPage({
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
  const status: DispositivoStatus | undefined = VALID_STATUS.has(rawStatus as DispositivoStatus)
    ? (rawStatus as DispositivoStatus)
    : undefined;

  const filter: z.input<typeof ListDispositivosFilter> = {
    status,
    search: rawSearch || undefined,
    limit: 50,
    offset: 0,
  };

  const list = await listDispositivos(filter, cookie);

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Dispositivos</h1>
      </div>
      <DispositivosFilters />
      <DispositivosPageClient items={list.items} userRole={user.role} total={list.total} />
    </div>
  );
}