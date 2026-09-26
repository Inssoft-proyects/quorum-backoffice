'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import type { AuditEntry } from '@quorum-backoffice/shared';
import {
  MetricCard,
  Pagination,
  type DonutSegment,
  type PageSize,
  type SortState,
} from '@/components/inventory';
import { AuditTable } from './audit-table';
import { AuditFilters } from './audit-filters';
import { AuditDetailDrawer } from './audit-detail-drawer';

type FilterKey = 'all' | 'marbete' | 'dispositivo' | 'auth';

interface Props {
  items: AuditEntry[];
  /** Server-side total count (API). Used in the count label overflow. */
  total: number;
}

/**
 * The audit log screen client (maquette v2).
 *
 * Composes the four metric cards (Total / Marbetes / Dispositivos /
 * Autenticación), the redesigned search shell + structured filters, the
 * sortable table, pagination, and the existing AuditDetailDrawer.
 *
 * All filtering happens in-memory because the API does not yet expose
 * dedicated counters — we fetch up to 200 items (the API's max limit,
 * see `audit/page.tsx`) and derive the four metric counts on the
 * client. The metric-card filter is local state on top of the URL-driven
 * filters in `AuditFilters`; the URL is the source of truth for the
 * entity/action/actor/since/until/search inputs and triggers a server
 * re-fetch when changed.
 */
export function AuditPageClient({ items, total }: Props) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  // Counts for the metric cards (computed from the source list, not
  // from the search-filtered view, so the cards remain stable while
  // the user types in the search shell).
  const counts = useMemo(() => {
    let marbetes = 0;
    let dispositivos = 0;
    let auth = 0;
    let failed = 0;
    for (const e of items) {
      if (e.action.startsWith('marbete.')) marbetes += 1;
      else if (e.action.startsWith('dispositivo.')) dispositivos += 1;
      else if (e.action.startsWith('auth.')) {
        auth += 1;
        if (e.action === 'auth.failed') failed += 1;
      }
    }
    return { total: items.length, marbetes, dispositivos, auth, failed };
  }, [items]);

  // Filter + sort derivations applied to the source list.
  const filtered = useMemo(() => {
    return items.filter((e) => {
      if (filter === 'marbete') return e.action.startsWith('marbete.');
      if (filter === 'dispositivo') return e.action.startsWith('dispositivo.');
      if (filter === 'auth') return e.action.startsWith('auth.');
      return true;
    });
  }, [items, filter]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sort.key) {
        case 'id':
          av = a.id;
          bv = b.id;
          break;
        case 'occurredAt':
          av = a.occurredAt;
          bv = b.occurredAt;
          break;
        default:
          return 0;
      }
      if (av < bv) return sort.direction === 'asc' ? -1 : 1;
      if (av > bv) return sort.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sort]);

  // Pagination math.
  const totalForPaging = sorted.length;
  const effectiveSize: number =
    pageSize === 'all' ? Math.max(totalForPaging, 1) : pageSize;
  const totalPages =
    pageSize === 'all' || totalForPaging === 0
      ? 1
      : Math.max(1, Math.ceil(totalForPaging / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedItems = useMemo(() => {
    if (pageSize === 'all') return sorted;
    const start = (safePage - 1) * effectiveSize;
    return sorted.slice(start, start + effectiveSize);
  }, [sorted, pageSize, safePage, effectiveSize]);

  // Donut chart segments — same pattern as dispositivos / marbetes:
  // three segments for the Total card (marbete / dispositivo / auth)
  // and two segments each for the others (the metric vs the
  // surface-subtle complement).
  const segmentsTotal: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.marbetes + counts.dispositivos + counts.auth, 1);
    return [
      {
        percent: (counts.marbetes / t) * 100,
        color: 'var(--color-secondary-500)',
      },
      {
        percent: (counts.dispositivos / t) * 100,
        color: 'var(--color-assigned-text)',
      },
      {
        percent: (counts.auth / t) * 100,
        color: 'var(--color-alert-warning-text)',
      },
    ];
  }, [counts]);

  const segmentsMarbetes: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.marbetes / t) * 100,
        color: 'var(--color-secondary-500)',
      },
      {
        percent: 100 - (counts.marbetes / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const segmentsDispositivos: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.dispositivos / t) * 100,
        color: 'var(--color-assigned-text)',
      },
      {
        percent: 100 - (counts.dispositivos / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const segmentsAuth: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.auth / t) * 100,
        color: 'var(--color-alert-warning-text)',
      },
      {
        percent: 100 - (counts.auth / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  // Count label rendered inside the search shell. When the API result
  // was capped at the limit we expose the server-side total too so the
  // user knows there are more items beyond the visible window.
  const countLabel =
    total > items.length ? `(${totalForPaging} / ${total})` : `(${totalForPaging})`;

  return (
    <div className="inventory-page">
      <header className="inventory-header">
        <div className="inventory-header__content">
          <h1>Auditoría</h1>
          <p>
            Trazabilidad completa de los cambios en marbetes, dispositivos y sesiones.
          </p>
        </div>
      </header>

      <section className="metrics-section" aria-label="Resumen de actividad">
        <div className="metrics-grid">
          <MetricCard
            label="Total"
            value={counts.total}
            meta="Movimientos"
            active={filter === 'all'}
            segments={segmentsTotal}
            centerLabel="100%"
            chartVariant="total"
            onClick={() => setFilter('all')}
          />
          <MetricCard
            label="Marbetes"
            value={counts.marbetes}
            meta="Marbete"
            segments={segmentsMarbetes}
            centerLabel={`${Math.round(
              (counts.marbetes / Math.max(counts.total, 1)) * 100,
            )}%`}
            active={filter === 'marbete'}
            onClick={() => setFilter('marbete')}
          />
          <MetricCard
            label="Dispositivos"
            value={counts.dispositivos}
            meta="Dispositivo"
            segments={segmentsDispositivos}
            centerLabel={`${Math.round(
              (counts.dispositivos / Math.max(counts.total, 1)) * 100,
            )}%`}
            active={filter === 'dispositivo'}
            onClick={() => setFilter('dispositivo')}
          />
          <MetricCard
            label="Autenticación"
            value={counts.auth}
            meta="Sesión"
            segments={segmentsAuth}
            active={filter === 'auth'}
            percentageLabel={`${Math.round(
              (counts.auth / Math.max(counts.total, 1)) * 100,
            )}% del total`}
            pills={
              counts.failed > 0
                ? [{ label: `${counts.failed} login fallido`, variant: 'danger' }]
                : undefined
            }
            onClick={() => setFilter('auth')}
          />
        </div>
      </section>

      <section>
        <div className="inventory-section__header">
          <h2>Movimientos</h2>
          <AuditFilters countLabel={countLabel} />
        </div>

        <AuditTable
          items={pagedItems}
          sort={sort}
          onSortChange={setSort}
          onSelect={setSelected}
        />

        <Pagination
          currentPage={safePage}
          pageSize={pageSize}
          totalItems={totalForPaging}
          onPageChange={(p) => setPage(p)}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(1);
          }}
        />
      </section>

      <AuditDetailDrawer entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
