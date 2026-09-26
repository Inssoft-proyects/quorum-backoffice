'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ChangeEvent } from 'react';
import type { DispositivoDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  MetricCard,
  Pagination,
  type DonutSegment,
  type PageSize,
  type SortState,
} from '@/components/inventory';
import { DispositivosTable } from './dispositivos-table';
import { DispositivosFilters } from './dispositivos-filters';
import { CreateDialog } from './create-dialog';
import { EditDialog } from './edit-dialog';
import { RevokeDialog } from './revoke-dialog';

type FilterKey = 'all' | 'active' | 'revoked' | 'no-brand';

interface Props {
  items: DispositivoDetailResponse[];
  userRole: UserRole;
  /** Server-side total count (API), used in the search count display. */
  total: number;
  /** Current search param (server-derived). Source of truth for the search input. */
  search: string;
}

/**
 * The dispositivos list screen client (maquette v2).
 *
 * Composes the four metric cards (Total / Activos / Revocados / Sin
 * marca), the redesigned filters + table, pagination, and the three
 * dialogs (Create / Edit / Revoke). All filtering happens in-memory
 * because the API does not yet expose dedicated counters — we fetch
 * up to 200 items (the API's max limit) and derive the four metric
 * counts on the client.
 *
 * The metric-card filter (`all` / `active` / `revoked` / `no-brand`) is
 * purely local state on top of the URL status filter; the URL is the
 * source of truth for the status and search inputs and triggers a
 * server re-fetch when changed.
 */
export function DispositivosPageClient({ items, userRole, total, search }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/dispositivos?${next.toString()}`));
  }
  function handleSearchChange(e: ChangeEvent<HTMLInputElement>) {
    updateParam('search', e.target.value);
  }
  const [filter, setFilter] = useState<FilterKey>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [sort, setSort] = useState<SortState | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DispositivoDetailResponse | null>(null);
  const [toRevoke, setToRevoke] = useState<DispositivoDetailResponse | null>(null);

  // Counts for the metric cards (computed from the source list, not the
  // search-filtered view, so the cards remain stable while the user types).
  const counts = useMemo(() => {
    let activos = 0;
    let revocados = 0;
    let sinMarca = 0;
    for (const d of items) {
      if (d.status === 'active') activos += 1;
      else if (d.status === 'revoked') revocados += 1;
      if (d.brand === null) sinMarca += 1;
    }
    return { total: items.length, activos, revocados, sinMarca };
  }, [items]);

  // Filter + sort derivations.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((d) => {
      const matchesSearch =
        q.length === 0 ||
        String(d.id).includes(q) ||
        d.serialNumber.toLowerCase().includes(q) ||
        (d.brand?.toLowerCase().includes(q) ?? false) ||
        (d.model?.toLowerCase().includes(q) ?? false);
      if (!matchesSearch) return false;
      if (filter === 'active') return d.status === 'active';
      if (filter === 'revoked') return d.status === 'revoked';
      if (filter === 'no-brand') return d.brand === null;
      return true;
    });
  }, [items, search, filter]);

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
        case 'serial':
          av = a.serialNumber;
          bv = b.serialNumber;
          break;
        case 'brand':
          av = a.brand ?? '';
          bv = b.brand ?? '';
          break;
        case 'model':
          av = a.model ?? '';
          bv = b.model ?? '';
          break;
        case 'status':
          av = a.status;
          bv = b.status;
          break;
        case 'createdAt':
          av = a.createdAt;
          bv = b.createdAt;
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

  // Donut chart segments: 3 segments for the Total card (active /
  // revoked / no-brand), 2 segments each for the other three cards
  // (the metric vs the surface-subtle complement).
  const segmentsTotal: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.activos + counts.revocados + counts.sinMarca, 1);
    return [
      {
        percent: (counts.activos / t) * 100,
        color: 'var(--color-secondary-500)',
      },
      {
        percent: (counts.revocados / t) * 100,
        color: 'var(--color-alert-error-text)',
      },
      {
        percent: (counts.sinMarca / t) * 100,
        color: 'var(--color-alert-warning-text)',
      },
    ];
  }, [counts]);

  const segmentsActivos: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.activos / t) * 100,
        color: 'var(--color-secondary-500)',
      },
      {
        percent: 100 - (counts.activos / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const segmentsRevocados: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.revocados / t) * 100,
        color: 'var(--color-alert-error-text)',
      },
      {
        percent: 100 - (counts.revocados / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const segmentsSinMarca: DonutSegment[] = useMemo(() => {
    const t = Math.max(counts.total, 1);
    return [
      {
        percent: (counts.sinMarca / t) * 100,
        color: 'var(--color-alert-warning-text)',
      },
      {
        percent: 100 - (counts.sinMarca / t) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const isAdmin = userRole === 'admin';

  // Count label rendered inside the search input shell. When the API
  // result was capped at the limit (200) we expose the server-side
  // total too so the user knows there are more items beyond the visible
  // window. `total` is referenced here to keep the prop wired end-to-end.
  const countLabel =
    total > items.length ? `(${totalForPaging} / ${total})` : `(${totalForPaging})`;

  return (
    <div className="inventory-page">
      <header className="inventory-header">
        <div className="inventory-header__content">
          <h1>Inventario de dispositivos</h1>
          <p>Consulta y administra los dispositivos físicos del sistema.</p>
        </div>
        {isAdmin ? (
          <div className="inventory-header__actions">
            <Button
              variant="outline"
              onClick={() => setCreating(true)}
              data-testid="open-create"
            >
              <PlusCircle className="h-4 w-4" aria-hidden />
              Registrar dispositivo
            </Button>
          </div>
        ) : null}
      </header>

      <section className="metrics-section" aria-label="Resumen del inventario">
        <div className="metrics-grid">
          <MetricCard
            label="Total"
            value={counts.total}
            meta="Inventario"
            active={filter === 'all'}
            segments={segmentsTotal}
            centerLabel="100%"
            chartVariant="total"
            onClick={() => setFilter('all')}
          />
          <MetricCard
            label="Activos"
            value={counts.activos}
            meta="En uso"
            segments={segmentsActivos}
            centerLabel={`${Math.round(
              (counts.activos / Math.max(counts.total, 1)) * 100,
            )}%`}
            active={filter === 'active'}
            onClick={() => setFilter('active')}
          />
          <MetricCard
            label="Revocados"
            value={counts.revocados}
            meta="Dados de baja"
            segments={segmentsRevocados}
            centerLabel={`${Math.round(
              (counts.revocados / Math.max(counts.total, 1)) * 100,
            )}%`}
            active={filter === 'revoked'}
            onClick={() => setFilter('revoked')}
          />
          <MetricCard
            label="Sin marca"
            value={counts.sinMarca}
            meta="Pendiente de inventario"
            segments={segmentsSinMarca}
            active={filter === 'no-brand'}
            percentageLabel={`${Math.round(
              (counts.sinMarca / Math.max(counts.total, 1)) * 100,
            )}% del total`}
            pills={
              counts.sinMarca > 0
                ? [{ label: 'Pendiente', variant: 'warning' }]
                : undefined
            }
            onClick={() => setFilter('no-brand')}
          />
        </div>
      </section>

      <section>
        <div className="inventory-section__header">
          <h2>Dispositivos registrados</h2>
          <div className="inventory-search" role="search">
            <span className="inventory-search__icon" aria-hidden />
            <input
              className="inventory-search__input"
              type="search"
              autoComplete="off"
              placeholder="Buscar por serial, marca o modelo"
              defaultValue={search}
              onChange={handleSearchChange}
              disabled={isPending}
              data-testid="dispositivos-search"
              aria-label="Buscar dispositivo"
            />
            <span className="inventory-search__count" aria-live="polite">
              {countLabel}
            </span>
          </div>
        </div>

        <div
          className="mt-3 flex flex-wrap items-center gap-3"
          data-testid="dispositivos-filters"
        >
          <DispositivosFilters isPending={isPending} />
        </div>

        <DispositivosTable
          items={pagedItems}
          userRole={userRole}
          sort={sort}
          onSortChange={setSort}
          onEdit={setEditing}
          onRevoke={setToRevoke}
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

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSuccess={() => router.refresh()}
      />
      <EditDialog
        dispositivo={editing}
        onClose={() => setEditing(null)}
        onSuccess={() => router.refresh()}
      />
      <RevokeDialog
        dispositivo={toRevoke}
        onClose={() => setToRevoke(null)}
        onSuccess={() => router.refresh()}
      />
    </div>
  );
}