'use client';

import * as React from 'react';
import { useMemo } from 'react';
import type {
  AuditEntry,
  DispositivoDetailResponse,
  MarbeteDetailResponse,
  UserRole,
} from '@quorum-backoffice/shared';
import { MetricCard, type DonutSegment } from '@/components/inventory';

/**
 * Per-domain payload assembled by the dashboard server component.
 * `error: true` means the list endpoint returned a 403 / 5xx and the
 * page fell back to an empty dataset. The client renders a neutral
 * MetricCard in that case so the layout never collapses.
 */
export interface DashboardDomainPayload<T> {
  total: number;
  items: T[];
  error: boolean;
}

export interface DashboardData {
  /** Total counts per list endpoint, used to render the 3 domain cards. */
  marbetes: DashboardDomainPayload<MarbeteDetailResponse>;
  dispositivos: DashboardDomainPayload<DispositivoDetailResponse>;
  audit: DashboardDomainPayload<AuditEntry>;
  /** Current authenticated user (used for the header greeting). */
  user: { email: string; role: UserRole };
}

interface Props {
  data: DashboardData;
}

const THREE_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 3;
const NINETY_DAYS_MS = 1000 * 60 * 60 * 24 * 90;

function countMarbeteAttention(items: MarbeteDetailResponse[], now: number) {
  let proximos = 0;
  let vencidos = 0;
  for (const m of items) {
    if (m.deletedAt) continue;
    const start = new Date(m.createdAt);
    if (Number.isNaN(start.getTime())) continue;
    const due = start.getTime() + THREE_YEARS_MS;
    const diff = due - now;
    if (diff < 0) vencidos += 1;
    else if (diff < NINETY_DAYS_MS) proximos += 1;
  }
  return { proximos, vencidos, total: proximos + vencidos };
}

function countDispositivoSinMarca(items: DispositivoDetailResponse[]) {
  return items.filter((d) => d.brand === null).length;
}

function countAuditFailed(items: AuditEntry[]) {
  return items.filter((e) => e.action === 'auth.failed').length;
}

/**
 * The dashboard (Inicio) page client (maquette v2).
 *
 * Renders the inventory-page shell with an h1 + subtitle header and the
 * canonical 4-metric-card grid:
 *
 *   - Marbetes  (Total from `listMarbetes`)
 *   - Dispositivos  (Total from `listDispositivos`)
 *   - Auditoría  (Total from `listAuditEntries`)
 *   - Por atender  (attention summary across the 3 domains)
 *
 * When a list endpoint fails (typically a 403 from RBAC), the
 * corresponding card renders a neutral state (`value=0`, `meta='Sin
 * acceso'`, no chart) so the layout never collapses and the other
 * cards stay visible. The Total card always uses the maquette's white
 * separator bands (`chartVariant="total"`).
 *
 * No table is rendered on the dashboard by design — the brief calls for
 * 4 metric cards only, with the attention card replacing a Maquette's
 * Por-atender in the marbetes context.
 */
export function DashboardPageClient({ data }: Props) {
  const { marbetes, dispositivos, audit, user } = data;
  const now = useMemo(() => Date.now(), []);

  // Donut segments per card: the Total card gets the maquette's
  // 3-band split; the per-domain cards get the percentage of the
  // successful load vs. an error ring.
  const segmentsMarbetes: DonutSegment[] = useMemo(() => {
    if (marbetes.error) {
      return [
        { percent: 100, color: 'var(--color-surface-subtle)' },
      ];
    }
    return [
      { percent: 100, color: 'var(--color-secondary-500)' },
    ];
  }, [marbetes.error]);

  const segmentsDispositivos: DonutSegment[] = useMemo(() => {
    if (dispositivos.error) {
      return [{ percent: 100, color: 'var(--color-surface-subtle)' }];
    }
    return [{ percent: 100, color: 'var(--color-secondary-500)' }];
  }, [dispositivos.error]);

  const segmentsAudit: DonutSegment[] = useMemo(() => {
    if (audit.error) {
      return [{ percent: 100, color: 'var(--color-surface-subtle)' }];
    }
    return [{ percent: 100, color: 'var(--color-secondary-500)' }];
  }, [audit.error]);

  // Compute the attention summary across the 3 domains. Each pill
  // shows when the count is non-zero — zero-state domains just don't
  // appear.
  const attention = useMemo(() => {
    const marbetesAtt = countMarbeteAttention(marbetes.items, now);
    const dispositivosSinMarca = countDispositivoSinMarca(dispositivos.items);
    const auditFailed = countAuditFailed(audit.items);
    const total =
      marbetesAtt.total + dispositivosSinMarca + auditFailed;
    return { marbetesAtt, dispositivosSinMarca, auditFailed, total };
  }, [marbetes.items, dispositivos.items, audit.items, now]);

  const attentionPills = useMemo(() => {
    const pills: Array<{ label: string; variant: 'warning' | 'danger' }> = [];
    if (attention.marbetesAtt.proximos > 0) {
      pills.push({
        label: `${attention.marbetesAtt.proximos} marbetes próximos`,
        variant: 'warning',
      });
    }
    if (attention.marbetesAtt.vencidos > 0) {
      pills.push({
        label: `${attention.marbetesAtt.vencidos} marbetes vencidos`,
        variant: 'danger',
      });
    }
    if (attention.dispositivosSinMarca > 0) {
      pills.push({
        label: `${attention.dispositivosSinMarca} disp. sin marca`,
        variant: 'warning',
      });
    }
    if (attention.auditFailed > 0) {
      pills.push({
        label: `${attention.auditFailed} login fallido`,
        variant: 'danger',
      });
    }
    return pills;
  }, [attention]);

  return (
    <div className="inventory-page" data-testid="dashboard-page">
      <header className="inventory-header">
        <div className="inventory-header__content">
          <h1>Inicio</h1>
          <p>
            Resumen general del inventario y la actividad reciente.
          </p>
        </div>
      </header>

      <section className="metrics-section" aria-label="Resumen general">
        <div className="metrics-grid">
          <MetricCard
            label="Marbetes"
            value={marbetes.error ? '—' : marbetes.total}
            meta={marbetes.error ? 'Sin acceso' : 'Total inventario'}
            segments={segmentsMarbetes}
            centerLabel={marbetes.error ? '—' : '100%'}
            chartVariant="total"
            data-testid="dashboard-card-marbetes"
          />
          <MetricCard
            label="Dispositivos"
            value={dispositivos.error ? '—' : dispositivos.total}
            meta={dispositivos.error ? 'Sin acceso' : 'Total inventario'}
            segments={segmentsDispositivos}
            centerLabel={dispositivos.error ? '—' : '100%'}
            data-testid="dashboard-card-dispositivos"
          />
          <MetricCard
            label="Auditoría"
            value={audit.error ? '—' : audit.total}
            meta={audit.error ? 'Sin acceso' : 'Movimientos'}
            segments={segmentsAudit}
            centerLabel={audit.error ? '—' : '100%'}
            data-testid="dashboard-card-audit"
          />
          <MetricCard
            label="Por atender"
            value={attention.total}
            meta={attention.total === 0 ? 'Sin pendientes' : 'Atención'}
            pills={attentionPills.length > 0 ? attentionPills : undefined}
            percentageLabel={
              attention.total === 0
                ? '0% del total'
                : `${attention.total} pendiente${attention.total === 1 ? '' : 's'}`
            }
            data-testid="dashboard-card-attention"
          />
        </div>
      </section>
    </div>
  );
}