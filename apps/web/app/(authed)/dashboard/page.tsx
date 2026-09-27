import { redirect } from 'next/navigation';
import {
  ListMarbetesFilter,
  ListDispositivosFilter,
  ListAuditFilter,
  type UserRole,
} from '@quorum-backoffice/shared';
import type { z } from 'zod';
import {
  listMarbetes,
  listDispositivos,
  listAuditEntries,
} from '@/lib/api-client';
import { ApiError } from '@/lib/api-client';
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
import {
  DashboardPageClient,
  type DashboardData,
  type DashboardDomainPayload,
} from './_components/dashboard-page-client';

/**
 * /dashboard — landing page (maquette v2).
 *
 * Server component: enforces auth (the parent (authed) layout already
 * does this, but the page reads the session to render the greeting
 * and to forward the cookie to the API). Fetches the three list
 * endpoints defensively — each call is wrapped in try/catch so a 403
 * (role-gated) or a 5xx from any single endpoint degrades to a
 * neutral card on the dashboard without crashing the page.
 *
 * The dashboard is reachable by every authed role (admin, operator,
 * auditor). The list endpoints are gated to operator+ (marbetes,
 * dispositivos) and auditor+ (audit), so an operator sees marbetes +
 * dispositivos counts and an audit-only card; an auditor sees
 * marbetes + dispositivos as neutral and the audit count live.
 */

interface FetchOk<T> {
  ok: true;
  total: number;
  items: T[];
}
interface FetchErr {
  ok: false;
  total: 0;
  items: [];
  error: true;
  code: string;
}

async function safeFetch<T>(
  fn: (cookie: string) => Promise<{ total: number; items: T[] }>,
  cookie: string | undefined,
): Promise<FetchOk<T> | FetchErr> {
  if (!cookie) {
    return { ok: false, total: 0, items: [], error: true, code: 'no_cookie' };
  }
  try {
    const r = await fn(cookie);
    return { ok: true, total: r.total, items: r.items, error: false } as FetchOk<T>;
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    return { ok: false, total: 0, items: [], error: true, code };
  }
}

function payload<T>(r: FetchOk<T> | FetchErr): DashboardDomainPayload<T> {
  return {
    total: r.total,
    items: r.items,
    error: !r.ok,
  };
}

export default async function DashboardPage() {
  const user = await getServerSession();
  if (!user) redirect('/login');
  const cookie = await getAuthCookieHeader();

  // Defensive parallel fetches: each one is independently guarded so a
  // single 403 / 5xx does not collapse the dashboard. The page client
  // renders a neutral MetricCard for any payload where `error: true`.
  const marbetesFilter: z.input<typeof ListMarbetesFilter> = {
    limit: 200,
    offset: 0,
  };
  const dispositivosFilter: z.input<typeof ListDispositivosFilter> = {
    limit: 200,
    offset: 0,
  };
  const auditFilter: z.input<typeof ListAuditFilter> = {
    limit: 200,
    offset: 0,
  };

  const [marbetesRes, dispositivosRes, auditRes] = await Promise.all([
    safeFetch((c) => listMarbetes(marbetesFilter, c), cookie),
    safeFetch((c) => listDispositivos(dispositivosFilter, c), cookie),
    safeFetch((c) => listAuditEntries(auditFilter, c), cookie),
  ]);

  const data: DashboardData = {
    marbetes: payload(marbetesRes),
    dispositivos: payload(dispositivosRes),
    audit: payload(auditRes),
    user: { email: user.email, role: user.role as UserRole },
  };

  return <DashboardPageClient data={data} />;
}