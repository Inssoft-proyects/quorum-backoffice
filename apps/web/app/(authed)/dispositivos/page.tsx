import { redirect } from 'next/navigation';
import type { DispositivoStatus } from '@quorum-backoffice/shared';
import { hasAtLeastRole, ListDispositivosFilter } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import { listDispositivos } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { DispositivosPageClient } from './_components/dispositivos-page-client';

const VALID_STATUS: ReadonlySet<DispositivoStatus> = new Set(['active', 'revoked']);

/**
 * /dispositivos — list view (maquette v2).
 *
 * Server component: enforces auth + operator+ role and forwards the
 * session cookie to the API. We fetch up to 200 items (the API's hard
 * max) so the in-page metric cards can derive their counters from a
 * single source — the maquette keeps counters close to the data they
 * represent.
 *
 * The page client owns the full maquet rendering (header + actions +
 * metric cards + filters + table + pagination + 3 dialogs), mirroring
 * the marbetes v2 split. Filters stay inside the page client because
 * they need URL-driven sync via `useSearchParams`, which is only
 * available on client components.
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
    limit: 200,
    offset: 0,
  };

  const list = await listDispositivos(filter, cookie);

  return (
    <DispositivosPageClient
      items={list.items}
      userRole={user.role}
      total={list.total}
      search={rawSearch}
    />
  );
}