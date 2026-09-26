'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { PlusCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AddMarbeteDialog,
  BulkUploadDialog,
  MetricCard,
  Pagination,
  RevealMarbeteDialog,
  RevokeMarbeteDialog,
  type DonutSegment,
  type PageSize,
} from '@/components/inventory';
import { MarbetesTable } from './marbetes-table';

interface Props {
  items: MarbeteDetailResponse[];
  userRole: UserRole;
}

/**
 * The marbetes list screen client (maquette v2).
 *
 * Composes the four metric cards, the search bar, the redesigned table,
 * pagination and the three dialogs (Add / Reveal / Revoke). All filtering
 * happens in-memory because the API does not yet expose dedicated
 * counters — we fetch up to 200 items (the API's max limit) and derive
 * the four metric counts on the client.
 *
 * Validity is derived: createdAt + 3 years. Anything within 90 days flips
 * to "warning" ("Próxima a vencer"), anything past due flips to "danger"
 * ("Vencida") — matching the maquette's column chip pattern.
 */
export function MarbetesPageClient({ items, userRole }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'available' | 'assigned' | 'attention'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [adding, setAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [revealing, setRevealing] = useState<MarbeteDetailResponse | null>(null);
  const [revoking, setRevoking] = useState<MarbeteDetailResponse | null>(null);

  const now = useMemo(() => new Date(), []);

  // Filtered + paginated view.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((m) => {
      const matchesSearch =
        q.length === 0 ||
        m.maskedCode.toLowerCase().includes(q) ||
        String(m.id).includes(q);
      if (!matchesSearch) return false;
      if (filter === 'available')
        return m.status === 'active' && m.assignedStudentId === null;
      if (filter === 'assigned')
        return m.status === 'active' && m.assignedStudentId !== null;
      if (filter === 'attention') {
        const validity = new Date(m.createdAt);
        const due = validity.getTime() + 1000 * 60 * 60 * 24 * 365 * 3;
        const ninetyDays = 1000 * 60 * 60 * 24 * 90;
        return due - now.getTime() < ninetyDays;
      }
      return true;
    });
  }, [items, search, filter, now]);

  // Counts for the metric cards (computed from the source list, not the
  // search-filtered view, so the cards remain stable while the user types).
  const counts = useMemo(() => {
    let disponibles = 0;
    let asignados = 0;
    let porAtender = 0;
    let proximos = 0;
    let vencidos = 0;
    for (const m of items) {
      if (m.deletedAt) continue;
      if (m.status === 'active' && m.assignedStudentId === null) disponibles += 1;
      else if (m.status === 'active' && m.assignedStudentId !== null) asignados += 1;
      const validity = new Date(m.createdAt);
      const due = validity.getTime() + 1000 * 60 * 60 * 24 * 365 * 3;
      const diff = due - now.getTime();
      if (diff < 0) vencidos += 1;
      else if (diff < 1000 * 60 * 60 * 24 * 90) {
        proximos += 1;
        porAtender += 1;
      }
    }
    return {
      total: items.filter((m) => !m.deletedAt).length,
      disponibles,
      asignados,
      porAtender,
      proximos,
      vencidos,
    };
  }, [items, now]);

  const totalForPaging = filtered.length;
  const effectiveSize: number = pageSize === 'all' ? Math.max(totalForPaging, 1) : pageSize;
  const totalPages = pageSize === 'all' || totalForPaging === 0
    ? 1
    : Math.max(1, Math.ceil(totalForPaging / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedItems = useMemo(() => {
    if (pageSize === 'all') return filtered;
    const start = (safePage - 1) * effectiveSize;
    return filtered.slice(start, start + effectiveSize);
  }, [filtered, pageSize, safePage, effectiveSize]);

  // Donut chart segments: deterministic relative to the active counts.
  const segmentsTotal: DonutSegment[] = useMemo(() => {
    const total = Math.max(counts.disponibles + counts.asignados + counts.porAtender, 1);
    return [
      { percent: (counts.disponibles / total) * 100, color: 'var(--color-secondary-500)' },
      { percent: (counts.asignados / total) * 100, color: 'var(--color-assigned-text)' },
      {
        percent: (counts.porAtender / total) * 100,
        color: 'var(--color-alert-warning-text)',
      },
    ];
  }, [counts]);

  const segmentsDisponibles: DonutSegment[] = useMemo(() => {
    const total = Math.max(counts.total, 1);
    return [
      { percent: (counts.disponibles / total) * 100, color: 'var(--color-secondary-500)' },
      {
        percent: 100 - (counts.disponibles / total) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  const segmentsAsignados: DonutSegment[] = useMemo(() => {
    const total = Math.max(counts.total, 1);
    return [
      { percent: (counts.asignados / total) * 100, color: 'var(--color-assigned-text)' },
      {
        percent: 100 - (counts.asignados / total) * 100,
        color: 'var(--color-surface-subtle)',
      },
    ];
  }, [counts]);

  function refresh() {
    router.refresh();
  }

  function handleAddClick() {
    setAdding(true);
  }
  function handleUploadClick() {
    setBulkOpen(true);
  }

  const [lastRevealedCode, setLastRevealedCode] = useState<string | null>(null);

  const handleRevealed = (fullCode: string) => {
    setLastRevealedCode(fullCode);
    refresh();
  };

  const handleRevoked = () => {
    refresh();
  };

  return (
    <div className="inventory-page">
      <header className="inventory-header">
        <div className="inventory-header__content">
          <h1>Inventario de marbetes</h1>
          <p>Consulta la disponibilidad y vigencia de los marbetes físicos.</p>
        </div>
        {userRole === 'admin' || userRole === 'operator' ? (
          <div className="inventory-header__actions">
            <Button
              variant="outline"
              onClick={handleAddClick}
              data-testid="add-marbete-trigger"
            >
              <PlusCircle className="h-4 w-4" aria-hidden />
              Agregar marbete
            </Button>
            <Button variant="default" onClick={handleUploadClick} data-testid="upload-marbetes-trigger">
              <Upload className="h-4 w-4" aria-hidden />
              Cargar marbetes
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
            label="Disponibles"
            value={counts.disponibles}
            meta="Almacén"
            segments={segmentsDisponibles}
            centerLabel={`${Math.round((counts.disponibles / Math.max(counts.total, 1)) * 100)}%`}
            active={filter === 'available'}
            onClick={() => setFilter('available')}
          />
          <MetricCard
            label="Asignados"
            value={counts.asignados}
            meta="Funcionando"
            segments={segmentsAsignados}
            centerLabel={`${Math.round((counts.asignados / Math.max(counts.total, 1)) * 100)}%`}
            active={filter === 'assigned'}
            onClick={() => setFilter('assigned')}
          />
          <MetricCard
            label="Por atender"
            value={counts.porAtender}
            meta="Atención"
            active={filter === 'attention'}
            percentageLabel={`${Math.round((counts.porAtender / Math.max(counts.total, 1)) * 100)}% del total`}
            pills={
              counts.porAtender > 0
                ? [
                    { label: `${counts.proximos} próximos`, variant: 'warning' },
                    { label: `${counts.vencidos} vencidos`, variant: 'danger' },
                  ]
                : undefined
            }
            onClick={() => setFilter('attention')}
          />
        </div>
      </section>

      <section>
        <div className="inventory-section__header">
          <h2>Marbetes registrados</h2>
          <div className="inventory-search" role="search">
            <span className="inventory-search__icon" aria-hidden />
            <input
              className="inventory-search__input"
              type="search"
              autoComplete="off"
              placeholder="Buscar por ID o no. marbete"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              data-testid="marbetes-search"
              aria-label="Buscar marbete"
            />
            <span className="inventory-search__count" aria-live="polite">
              ({totalForPaging})
            </span>
          </div>
        </div>

        <MarbetesTable
          items={pagedItems}
          userRole={userRole}
          now={now}
          onDelete={(m) => setRevoking(m)}
          onEdit={(m) => setRevealing(m)}
        />

      {lastRevealedCode !== null ? (
        <div
          className="mt-4 rounded-md border border-secondary-500 bg-success-bg p-3 text-success-text"
          role="status"
          aria-live="polite"
          data-testid="reveal-confirmation-banner"
        >
          Código revelado: <strong data-testid="reveal-confirmation-code">{lastRevealedCode}</strong>
        </div>
      ) : null}

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

      <AddMarbeteDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={refresh}
      />
      <RevealMarbeteDialog
        marbeteId={revealing?.id ?? 0}
        open={revealing !== null}
        onOpenChange={(o) => {
          if (!o) setRevealing(null);
        }}
        onRevealed={handleRevealed}
      />
      <RevokeMarbeteDialog
        marbeteId={revoking?.id ?? 0}
        open={revoking !== null}
        onOpenChange={(o) => {
          if (!o) setRevoking(null);
        }}
        onRevoked={handleRevoked}
      />
      <BulkUploadDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onSaved={refresh}
      />
    </div>
  );
}
