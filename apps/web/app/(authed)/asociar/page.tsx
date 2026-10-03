import { redirect } from 'next/navigation';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import type { z } from 'zod';
import {
  ListMatriculasFilter,
  type ListMatriculasStatus,
  type ListMatriculasIsActive,
} from '@quorum-backoffice/shared';
import {
  getMatriculasCounters,
  listMarbetes,
  listMatriculas,
} from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import { AsociarPageClient } from './_components/asociar-page-client';

const VALID_STATUSES: ReadonlyArray<ListMatriculasStatus> = ['assigned', 'unassigned', 'any'];
const VALID_IS_ACTIVE: ReadonlyArray<ListMatriculasIsActive> = ['true', 'false', 'any'];

/**
 * /asociar — "Asignación de marbetes" list view (WU v3).
 *
 * Server component: enforces auth + operator+ role (visible to every
 * session role — the same gate as /marbetes — since the operator
 * surface only needs to read; write buttons remain client-gated by
 * `userRole`). Forwards the session cookie to the matriculas +
 * available-marbetes endpoints so the page can hydrate its
 * selection-state immediately on first render.
 *
 * The page deliberately loads only the unassigned tab on first
 * render (limit 200, the API's hard max) and switches to the
 * assigned tab on-demand via `?status=assigned`. The counters
 * endpoint carries the totals needed by the metric cards.
 */
export default async function AsociarPage({
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
  const rawIsActive = typeof sp.isActive === 'string' ? sp.isActive : '';
  const status: ListMatriculasStatus = (
    VALID_STATUSES as readonly string[]
  ).includes(rawStatus)
    ? (rawStatus as ListMatriculasStatus)
    : 'unassigned';
  const isActive: ListMatriculasIsActive = (
    VALID_IS_ACTIVE as readonly string[]
  ).includes(rawIsActive)
    ? (rawIsActive as ListMatriculasIsActive)
    : 'true';

  // First paint loads whichever tab the URL asks for; the client
  // triggers a refetch on tab change without remounting.
  const filter: z.input<typeof ListMatriculasFilter> = {
    status,
    search: rawSearch || undefined,
    isActive,
    limit: 200,
    offset: 0,
  };

  const [counters, matriculas, available] = await Promise.all([
    getMatriculasCounters(cookie),
    listMatriculas(filter, cookie),
    // Pull the available marbetes so the bulk-assign review modal
    // can pre-populate its per-row picker on first open without a
    // second network round-trip. 200 matches the API cap.
    listMarbetes({ assigned: 'no', limit: 200, offset: 0 }, cookie),
  ]);

  return (
    <AsociarPageClient
      initialMatriculas={matriculas.items}
      initialCounters={counters}
      initialAvailableMarbetes={available.items.map((m) => ({
        id: m.id,
        maskedCode: m.maskedCode,
      }))}
      initialStatus={status}
      initialSearch={rawSearch}
      userRole={user.role}
    />
  );
}