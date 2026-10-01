'use client';

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  RefreshCw,
  Search,
  Undo2,
} from 'lucide-react';
import type {
  ListMatriculasStatus,
  MarbeteDetailResponse,
  MatriculasCountersResponse,
  MatriculaListItem,
  UserRole,
} from '@quorum-backoffice/shared';
import {
  ApiError,
  assignMatriculas,
  getMatriculasCounters,
  listMatriculas,
  syncMatriculas,
  unassignMatricula,
} from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  DonutChart,
  type DonutSegment,
  MetricCard,
  Pagination,
  RevealMarbeteDialog,
  StatusChip,
  type PageSize,
} from '@/components/inventory';
import { AssignReviewModal } from './assign-review-modal';
import { UnassignModal } from './unassign-modal';

interface Props {
  /** First-batch matrículas for the active tab (server-rendered). */
  initialMatriculas: MatriculaListItem[];
  /** Header counters (server-rendered). */
  initialCounters: MatriculasCountersResponse;
  /** Pre-fetched available marbetes for the review modal. */
  initialAvailableMarbetes: { id: number; maskedCode: string }[];
  initialStatus: ListMatriculasStatus;
  initialSearch: string;
  userRole: UserRole;
}

interface InfoBanner {
  title: string;
  detail: string;
}

const APP_ALERT_AUTO_DISMISS_MS = 5000;

/** Date formatter used for `dd/MM/yyyy` cells per canon. */
function formatShortDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

/**
 * "Asignación de marbetes" page client.
 *
 * Composes the four metric cards (Total / Marbetes disponibles /
 * Disponibles / Asignados), the two-tab workspace, the per-tab
 * pagination, the two modals (assign review / unassign) and the
 * dismissable success banner.
 *
 * State model:
 *  - `search` is a shared input across both tabs (matches the canon's
 *    "Buscar por matrícula").
 *  - `selection` is a Set<canvasUserId> bounded by the available
 *    marbetes count (the canonical 0..N cap).
 *  - Per-tab `page` + `pageSize` are local state — the API paginates
 *    per tab so the URL stays free of UI noise.
 *  - `infoBanner` is the dismissable success toast used after assign
 *    + unassign.
 *
 * Writes go through the same `useOtpGrant` pattern as
 * add-marbete-dialog / revoke-marbete-dialog / bulk-upload-dialog —
 * the modals own the OTP input + grant refresh, this page only owns
 * the resulting API call.
 */
export function AsociarPageClient({
  initialMatriculas,
  initialCounters,
  initialAvailableMarbetes,
  initialStatus,
  initialSearch,
  userRole,
}: Props): React.ReactElement {
  const router = useRouter();

  // ---- Server-side state (refetched after writes via Promise.all) ----
  const [counters, setCounters] = useState<MatriculasCountersResponse>(initialCounters);
  const [unassignedItems, setUnassignedItems] = useState<MatriculaListItem[]>(
    initialStatus === 'unassigned' ? initialMatriculas : [],
  );
  const [assignedItems, setAssignedItems] = useState<MatriculaListItem[]>(
    initialStatus === 'assigned' ? initialMatriculas : [],
  );
  const [availableMarbetes, setAvailableMarbetes] = useState(initialAvailableMarbetes);
  const [availableMarbetesTotal, setAvailableMarbetesTotal] = useState(
    initialCounters.availableMarbetes,
  );
  const [activeTab, setActiveTab] = useState<'unassigned' | 'assigned'>(
    initialStatus === 'assigned' ? 'assigned' : 'unassigned',
  );
  const [search, setSearch] = useState(initialSearch);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // ---- Pagination (per tab) ----
  const [unassignedPage, setUnassignedPage] = useState(1);
  const [unassignedPageSize, setUnassignedPageSize] = useState<PageSize>(10);
  const [assignedPage, setAssignedPage] = useState(1);
  const [assignedPageSize, setAssignedPageSize] = useState<PageSize>(10);

  // ---- Selection (unassigned tab only; bounded by availableMarbetes count) ----
  const [selection, setSelection] = useState<Set<number>>(new Set());

  // ---- Modal + banner state ----
  const [assignModal, setAssignModal] = useState<{
    open: boolean;
    enrollments: { canvasUserId: number; fullName: string; marbeteId: number | null }[];
  }>({ open: false, enrollments: [] });
  const [unassignCtx, setUnassignCtx] = useState<Props['initialMatriculas'][number] | null>(null);
  const [revealMarbeteId, setRevealMarbeteId] = useState<number | null>(null);
  const [infoBanner, setInfoBanner] = useState<InfoBanner | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showInfoBanner = (banner: InfoBanner): void => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
    }
    setInfoBanner(banner);
    dismissTimer.current = setTimeout(() => {
      setInfoBanner(null);
      dismissTimer.current = null;
    }, APP_ALERT_AUTO_DISMISS_MS);
  };

  const dismissInfoBanner = (): void => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    setInfoBanner(null);
  };

  useEffect(() => {
    return () => {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
      }
    };
  }, []);

  // ---- Role gate: write buttons only for admin + operator ----
  const canWrite = userRole === 'admin' || userRole === 'operator';

  // ---- Tab + metric filter chip sync (canon behavior) ----
  function setActiveTabSync(tab: 'unassigned' | 'assigned'): void {
    setActiveTab(tab);
    // Switch the filter chip on the two metric cards. The cards are
    // data-driven (MetricCard) so we just need to flip their
    // `aria-pressed` state through the React render; the click handler
    // here is fired by the card onClick which calls setActiveTabSync.
  }

  // ---- Refetch after writes ----
  async function refetch(): Promise<void> {
    const [nextCounters, nextUnassigned, nextAssigned] = await Promise.all([
      getMatriculasCounters(),
      listMatriculas({
        status: 'unassigned',
        search: search || undefined,
        isActive: 'true',
        limit: 200,
        offset: 0,
      }),
      listMatriculas({
        status: 'assigned',
        search: search || undefined,
        isActive: 'true',
        limit: 200,
        offset: 0,
      }),
    ]);
    setCounters(nextCounters);
    setAvailableMarbetesTotal(nextCounters.availableMarbetes);
    setUnassignedItems(nextUnassigned.items);
    setAssignedItems(nextAssigned.items);
    setUnassignedPage(1);
    setAssignedPage(1);
    setSelection(new Set());
  }

  // ---- Filtered view per tab ----
  const filteredUnassigned = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return unassignedItems;
    return unassignedItems.filter(
      (m) =>
        String(m.canvasUserId).toLowerCase().includes(q) ||
        m.fullName.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
  }, [unassignedItems, search]);

  const filteredAssigned = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assignedItems;
    return assignedItems.filter(
      (m) =>
        String(m.canvasUserId).toLowerCase().includes(q) ||
        m.fullName.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        (m.marbete?.publicUid.toLowerCase().includes(q) ?? false) ||
        (m.marbete?.maskedCode.toLowerCase().includes(q) ?? false),
    );
  }, [assignedItems, search]);

  // ---- Pagination slices ----
  const totalUnassigned = filteredUnassigned.length;
  const totalAssigned = filteredAssigned.length;
  const pagedUnassigned = useMemo(() => {
    if (unassignedPageSize === 'all') return filteredUnassigned;
    const size = unassignedPageSize;
    const start = (unassignedPage - 1) * size;
    return filteredUnassigned.slice(start, start + size);
  }, [filteredUnassigned, unassignedPage, unassignedPageSize]);
  const pagedAssigned = useMemo(() => {
    if (assignedPageSize === 'all') return filteredAssigned;
    const size = assignedPageSize;
    const start = (assignedPage - 1) * size;
    return filteredAssigned.slice(start, start + size);
  }, [filteredAssigned, assignedPage, assignedPageSize]);

  // ---- Donut chart segments ----
  const segmentsTotal: DonutSegment[] = useMemo(() => {
    const total = Math.max(counters.unassigned + counters.assigned, 1);
    return [
      { percent: (counters.unassigned / total) * 100, color: 'var(--color-secondary-500)' },
      { percent: (counters.assigned / total) * 100, color: 'var(--color-assigned-text)' },
    ];
  }, [counters]);
  const segmentsAvailable: DonutSegment[] = useMemo(() => {
    const total = Math.max(counters.total, 1);
    return [
      { percent: (counters.unassigned / total) * 100, color: 'var(--color-secondary-500)' },
      { percent: 100 - (counters.unassigned / total) * 100, color: 'var(--color-surface-subtle)' },
    ];
  }, [counters]);
  const segmentsAssigned: DonutSegment[] = useMemo(() => {
    const total = Math.max(counters.total, 1);
    return [
      { percent: (counters.assigned / total) * 100, color: 'var(--color-assigned-text)' },
      { percent: 100 - (counters.assigned / total) * 100, color: 'var(--color-surface-subtle)' },
    ];
  }, [counters]);

  // ---- Selection limit ----
  const selectionLimit = availableMarbetesTotal;
  const selectionAtLimit =
    selection.size >= selectionLimit && selectionLimit > 0;

  // ---- Bulk assign modal open ----
  function openBulkAssign(): void {
    if (selection.size === 0) return;
    const enrollments = Array.from(selection)
      .map((canvasUserId) => {
        const item = unassignedItems.find(
          (m) => m.canvasUserId === canvasUserId,
        );
        if (!item) return null;
        return {
          canvasUserId: item.canvasUserId,
          fullName: item.fullName,
          marbeteId: null,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    setAssignModal({ open: true, enrollments });
  }

  function openSingleAssign(canvasUserId: number): void {
    const item = unassignedItems.find((m) => m.canvasUserId === canvasUserId);
    if (!item) return;
    setAssignModal({
      open: true,
      enrollments: [
        { canvasUserId: item.canvasUserId, fullName: item.fullName, marbeteId: null },
      ],
    });
  }

  async function handleAssignConfirm(
    pairs: { canvasUserId: number; marbeteId: number }[],
    otpCode: string | undefined,
  ): Promise<void> {
    await assignMatriculas({ pairs }, otpCode);
    await refetch();
    setAvailableMarbetes(
      availableMarbetes.filter((m) => !pairs.some((p) => p.marbeteId === m.id)),
    );
    if (pairs.length === 1) {
      const [single] = pairs;
      const item = unassignedItems.find(
        (m) => m.canvasUserId === single?.canvasUserId,
      );
      showInfoBanner({
        title: 'Marbete asignado correctamente.',
        detail: item
          ? `${item.fullName} ahora tiene el marbete asignado.`
          : 'La matrícula ahora tiene el marbete asignado.',
      });
    } else {
      showInfoBanner({
        title: `Se asignaron correctamente ${pairs.length} marbetes.`,
        detail: '',
      });
    }
  }

  // ---- Unassign ----
  function openUnassign(item: MatriculaListItem): void {
    setUnassignCtx(item);
  }

  async function handleUnassignConfirm(
    payload: { marbeteId: number; reason: string; comentario?: string },
    otpCode: string | undefined,
  ): Promise<void> {
    await unassignMatricula(
      {
        marbeteId: payload.marbeteId,
        reason: payload.reason,
        comentario: payload.comentario,
      },
      otpCode,
    );
    await refetch();
    setUnassignCtx(null);
    showInfoBanner({
      title: 'Marbete desasignado correctamente.',
      detail: `Motivo registrado: ${payload.reason}${
        payload.comentario ? ` · ${payload.comentario}` : ''
      }`,
    });
  }

  // ---- Sync ----
  async function handleSync(): Promise<void> {
    setSyncing(true);
    setSyncError(null);
    try {
      await syncMatriculas();
      await refetch();
      showInfoBanner({
        title: 'Matrículas sincronizadas.',
        detail: 'La caché local se actualizó con la lista más reciente de Canvas.',
      });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'No se pudo sincronizar.';
      setSyncError(message);
    } finally {
      setSyncing(false);
    }
  }

  // ---- Reveal ----
  const [revealMarbete, setRevealMarbete] = useState<MarbeteDetailResponse | null>(
    null,
  );
  function openReveal(item: MatriculaListItem): void {
    if (!item.marbete) return;
    setRevealMarbeteId(item.marbete.id);
  }
  useEffect(() => {
    // Pull a stub MarbeteDetailResponse when the user clicks reveal.
    // RevealMarbeteDialog only needs the marbeteId; we synthesize a
    // minimal placeholder so the dialog can render its title.
    if (revealMarbeteId === null) {
      setRevealMarbete(null);
      return;
    }
    setRevealMarbete({
      id: revealMarbeteId,
      publicUid: '',
      maskedCode: '',
      status: 'active',
      assignedStudentId: null,
      assignedAt: null,
      createdAt: '',
      createdBy: '',
      deletedAt: null,
      deletionReason: null,
      student: null,
    });
  }, [revealMarbeteId]);

  // Keyboard arrow support for the tab strip (canon behavior).
  function handleTabKeydown(
    e: React.KeyboardEvent<HTMLButtonElement>,
    tab: 'unassigned' | 'assigned',
  ): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next: 'unassigned' | 'assigned' =
      e.key === 'Home'
        ? 'unassigned'
        : e.key === 'End'
          ? 'assigned'
          : tab === 'unassigned'
            ? 'assigned'
            : 'unassigned';
    setActiveTabSync(next);
  }

  // ---- Toggle a single row's selection (bounded by available marbetes) ----
  function toggleSelection(canvasUserId: number): void {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(canvasUserId)) {
        next.delete(canvasUserId);
      } else if (next.size < selectionLimit) {
        next.add(canvasUserId);
      }
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelection((prev) => {
      const filteredIds = filteredUnassigned.map((m) => m.canvasUserId);
      const allSelected =
        filteredIds.length > 0 && filteredIds.every((id) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      const remaining = Math.max(selectionLimit - prev.size, 0);
      const next = new Set(prev);
      let added = 0;
      for (const id of filteredIds) {
        if (!next.has(id) && added < remaining) {
          next.add(id);
          added += 1;
        }
      }
      return next;
    });
  }

  const unassignedRows = pagedUnassigned;
  const assignedRows = pagedAssigned;
  const unassignedEmpty = filteredUnassigned.length === 0;
  const assignedEmpty = filteredAssigned.length === 0;
  const inventoryShortage = availableMarbetesTotal < counters.unassigned;
  const allUnassignedVisibleSelected =
    filteredUnassigned.length > 0 &&
    filteredUnassigned.every((m) => selection.has(m.canvasUserId));

  return (
    <div className="inventory-page assignment-page">
      <header className="inventory-header assignment-page__header">
        <div className="inventory-header__content">
          <h1>Asignación de marbetes</h1>
          <p>Asigna marbetes disponibles a las matrículas activas de INEC-CONECTA.</p>
        </div>
        {userRole === 'admin' ? (
          <div className="inventory-header__actions">
            <Button
              variant="outline"
              onClick={() => void handleSync()}
              disabled={syncing}
              data-testid="sync-matriculas-trigger"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              {syncing ? 'Sincronizando…' : 'Sincronizar matrículas'}
            </Button>
          </div>
        ) : null}
      </header>

      {syncError ? (
        <Alert
          variant="destructive"
          role="alert"
          data-testid="sync-error"
          className="mb-4"
        >
          {syncError}
        </Alert>
      ) : null}

      <section className="metrics-section" aria-labelledby="assignment-metrics-title">
        <h2 className="sr-only" id="assignment-metrics-title">
          Resumen de asignación
        </h2>
        <div className="metrics-grid d-grid gap-4 assignment-metrics">
          <MetricCard
            label="Matrículas totales"
            value={counters.total}
            meta="Activas"
            active={false}
            segments={segmentsTotal}
            centerLabel="100%"
            chartVariant="total"
          />
          <article
            className={
              'metric-card assignment-metric assignment-inventory-card' +
              (inventoryShortage ? ' is-inventory-shortage' : '')
            }
            data-inventory-card
          >
            <span className="metric-card__label">Marbetes disponibles</span>
            <span className="metric-card__value-row">
              <span className="metric-card__value" data-metric="available" data-testid="metric-available">
                {availableMarbetesTotal}
              </span>
              <span
                className="assignment-inventory-status"
                data-inventory-status
                data-testid="metric-inventory-status"
                role="status"
              >
                {inventoryShortage
                  ? `Faltan ${counters.unassigned - availableMarbetesTotal} ${
                      counters.unassigned - availableMarbetesTotal === 1
                        ? 'marbete'
                        : 'marbetes'
                    }`
                  : 'Inventario suficiente'}
              </span>
            </span>
            <span className="metric-card__meta">Asignables</span>
          </article>
          <MetricCard
            label="Disponibles"
            value={counters.unassigned}
            meta="Sin marbete"
            active={activeTab === 'unassigned'}
            segments={segmentsAvailable}
            centerLabel={`${Math.round((counters.unassigned / Math.max(counters.total, 1)) * 100)}%`}
            data-filter-source="metric"
            data-filter="unassigned"
            onClick={() => setActiveTabSync('unassigned')}
          />
          <MetricCard
            label="Asignados"
            value={counters.assigned}
            meta="Con marbete"
            active={activeTab === 'assigned'}
            segments={segmentsAssigned}
            centerLabel={`${Math.round((counters.assigned / Math.max(counters.total, 1)) * 100)}%`}
            data-filter-source="metric"
            data-filter="assigned"
            onClick={() => setActiveTabSync('assigned')}
          />
        </div>
      </section>

      <section className="assignment-workspace" aria-labelledby="assignment-list-title">
        <div
          className="assignment-tabs"
          role="tablist"
          aria-label="Estado de las matrículas"
        >
          <button
            id="tab-unassigned"
            type="button"
            role="tab"
            aria-selected={activeTab === 'unassigned'}
            aria-controls="panel-unassigned"
            tabIndex={activeTab === 'unassigned' ? 0 : -1}
            data-tab="unassigned"
            data-testid="tab-unassigned"
            className={'assignment-tab' + (activeTab === 'unassigned' ? ' is-active' : '')}
            onClick={() => setActiveTabSync('unassigned')}
            onKeyDown={(e) => handleTabKeydown(e, 'unassigned')}
          >
            Sin asignar{' '}
            <span data-testid="tab-count-unassigned">({counters.unassigned})</span>
          </button>
          <button
            id="tab-assigned"
            type="button"
            role="tab"
            aria-selected={activeTab === 'assigned'}
            aria-controls="panel-assigned"
            tabIndex={activeTab === 'assigned' ? 0 : -1}
            data-tab="assigned"
            data-testid="tab-assigned"
            className={'assignment-tab' + (activeTab === 'assigned' ? ' is-active' : '')}
            onClick={() => setActiveTabSync('assigned')}
            onKeyDown={(e) => handleTabKeydown(e, 'assigned')}
          >
            Asignados{' '}
            <span data-testid="tab-count-assigned">({counters.assigned})</span>
          </button>
        </div>

        {/* Unassigned panel */}
        <div
          id="panel-unassigned"
          role="tabpanel"
          aria-labelledby="tab-unassigned"
          data-panel="unassigned"
          data-testid="panel-unassigned"
          className="assignment-panel"
          hidden={activeTab !== 'unassigned'}
        >
          <div className="inventory-section__header assignment-list-header">
            <div>
              <h2 id="assignment-list-title">Matrículas sin marbete</h2>
              <p className="assignment-list-header__hint">
                Selecciona una o varias matrículas para asignarles un marbete disponible.
              </p>
            </div>
            <div className="inventory-search" role="search">
              <label className="sr-only" htmlFor="unassigned-search">
                Buscar por matrícula
              </label>
              <Search
                className="inventory-search__icon"
                aria-hidden
                style={{ display: 'none' }}
              />
              <span className="inventory-search__icon" aria-hidden />
              <input
                id="unassigned-search"
                className="inventory-search__input"
                type="search"
                autoComplete="off"
                placeholder="Buscar por matrícula"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setUnassignedPage(1);
                  setAssignedPage(1);
                }}
                data-testid="unassigned-search"
                aria-label="Buscar por matrícula"
              />
              {search ? (
                <button
                  type="button"
                  className="assignment-search-clear"
                  aria-label="Limpiar búsqueda"
                  data-testid="unassigned-search-clear"
                  onClick={() => setSearch('')}
                >
                  Limpiar
                </button>
              ) : null}
              <span
                className="inventory-search__count"
                data-testid="unassigned-search-count"
                aria-live="polite"
              >
                ({totalUnassigned})
              </span>
            </div>
          </div>

          <div className="assignment-action-bar" data-testid="unassigned-action-bar">
            <div className="assignment-selection-copy">
              <strong data-testid="unassigned-selection-count">
                {selection.size === 1
                  ? '1 matrícula seleccionada'
                  : `${selection.size} matrículas seleccionadas`}
              </strong>
              <span data-testid="unassigned-selection-hint">
                {selection.size > 0
                  ? 'Revisa la propuesta antes de confirmar la asignación.'
                  : availableMarbetesTotal > 0
                    ? 'Selecciona al menos una matrícula para activar esta acción.'
                    : 'No hay marbetes disponibles para asignar.'}
              </span>
            </div>
            <Button
              variant="default"
              onClick={openBulkAssign}
              disabled={selection.size === 0 || availableMarbetesTotal === 0}
              data-testid="open-bulk-assign"
            >
              Asignar marbetes
            </Button>
          </div>
          {selectionAtLimit ? (
            <p
              className="assignment-limit-message"
              role="status"
              data-testid="unassigned-limit-message"
            >
              Solo puedes seleccionar hasta {selectionLimit} matrículas porque hay{' '}
              {selectionLimit} marbetes disponibles.
            </p>
          ) : null}

          <div className="table-shell">
            <div
              className="table-scroll"
              tabIndex={0}
              aria-label="Tabla de matrículas sin marbete"
            >
              <table className="data-table assignment-table" data-testid="unassigned-table">
                <caption className="sr-only">
                  Matrículas activas que no tienen un marbete asignado.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        className="assignment-checkbox"
                        type="checkbox"
                        aria-label="Seleccionar todas las matrículas visibles"
                        data-testid="unassigned-select-all"
                        checked={allUnassignedVisibleSelected}
                        onChange={toggleSelectAll}
                        disabled={availableMarbetesTotal === 0}
                      />
                    </th>
                    <th scope="col">Matrícula</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Fecha de registro</th>
                    <th scope="col">Acción</th>
                  </tr>
                </thead>
                <tbody data-testid="unassigned-body">
                  {unassignedRows.map((item) => {
                    const checked = selection.has(item.canvasUserId);
                    const atLimit =
                      !checked && selection.size >= availableMarbetesTotal;
                    return (
                      <tr
                        key={item.canvasUserId}
                        data-testid={`unassigned-row-${item.canvasUserId}`}
                      >
                        <td data-label="Seleccionar">
                          <input
                            className="assignment-checkbox"
                            type="checkbox"
                            aria-label={`Seleccionar matrícula ${item.fullName}`}
                            data-testid={`unassigned-check-${item.canvasUserId}`}
                            checked={checked}
                            disabled={atLimit || availableMarbetesTotal === 0}
                            onChange={() => toggleSelection(item.canvasUserId)}
                          />
                        </td>
                        <td className="data-table__id" data-label="Matrícula">
                          {item.fullName}
                          <span className="block text-xs font-normal text-text-muted">
                            {item.email}
                          </span>
                        </td>
                        <td data-label="Estado">
                          <StatusChip variant="warning" data-testid={`unassigned-status-${item.canvasUserId}`}>
                            Sin asignar
                          </StatusChip>
                        </td>
                        <td className="data-table__date" data-label="Fecha de registro">
                          {formatShortDate(item.registeredAt)}
                        </td>
                        <td className="assignment-row__action" data-label="Acción">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openSingleAssign(item.canvasUserId)}
                            disabled={
                              !canWrite || availableMarbetesTotal === 0
                            }
                            data-testid={`unassigned-assign-${item.canvasUserId}`}
                          >
                            Asignar marbete
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {unassignedEmpty ? (
              <div className="assignment-empty" data-testid="unassigned-empty">
                <strong>
                  {search
                    ? 'No encontramos coincidencias para esa matrícula.'
                    : '¡Felicidades! Todas las matrículas tienen un marbete asignado.'}
                </strong>
                <span>
                  {search
                    ? 'Prueba con otro número o limpia la búsqueda.'
                    : 'No hay matrículas pendientes de asignación.'}
                </span>
              </div>
            ) : null}
            <Pagination
              currentPage={unassignedPage}
              pageSize={unassignedPageSize}
              totalItems={totalUnassigned}
              onPageChange={(p) => setUnassignedPage(p)}
              onPageSizeChange={(s) => {
                setUnassignedPageSize(s);
                setUnassignedPage(1);
              }}
            />
          </div>
        </div>

        {/* Assigned panel */}
        <div
          id="panel-assigned"
          role="tabpanel"
          aria-labelledby="tab-assigned"
          data-panel="assigned"
          data-testid="panel-assigned"
          className="assignment-panel"
          hidden={activeTab !== 'assigned'}
        >
          <div className="inventory-section__header assignment-list-header">
            <div>
              <h2>Matrículas asignadas</h2>
              <p className="assignment-list-header__hint">
                Consulta la relación actual y desasigna un marbete cuando sea necesario.
              </p>
            </div>
            <div className="inventory-search" role="search">
              <label className="sr-only" htmlFor="assigned-search">
                Buscar por matrícula
              </label>
              <span className="inventory-search__icon" aria-hidden />
              <input
                id="assigned-search"
                className="inventory-search__input"
                type="search"
                autoComplete="off"
                placeholder="Buscar por matrícula"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setUnassignedPage(1);
                  setAssignedPage(1);
                }}
                data-testid="assigned-search"
                aria-label="Buscar por matrícula"
              />
              {search ? (
                <button
                  type="button"
                  className="assignment-search-clear"
                  aria-label="Limpiar búsqueda"
                  data-testid="assigned-search-clear"
                  onClick={() => setSearch('')}
                >
                  Limpiar
                </button>
              ) : null}
              <span
                className="inventory-search__count"
                data-testid="assigned-search-count"
                aria-live="polite"
              >
                ({totalAssigned})
              </span>
            </div>
          </div>

          <div className="table-shell">
            <div
              className="table-scroll"
              tabIndex={0}
              aria-label="Tabla de matrículas asignadas"
            >
              <table className="data-table assignment-table" data-testid="assigned-table">
                <caption className="sr-only">
                  Matrículas activas con marbete asignado.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Matrícula</th>
                    <th scope="col">Marbete</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Fecha de asignación</th>
                    <th scope="col">Usuario</th>
                    <th scope="col">Acción</th>
                  </tr>
                </thead>
                <tbody data-testid="assigned-body">
                  {assignedRows.map((item) => (
                    <tr
                      key={item.canvasUserId}
                      data-testid={`assigned-row-${item.canvasUserId}`}
                    >
                      <td className="data-table__id" data-label="Matrícula">
                        {item.fullName}
                        <span className="block text-xs font-normal text-text-muted">
                          {item.email}
                        </span>
                      </td>
                      <td className="data-table__credential" data-label="Marbete">
                        {item.marbete ? (
                          <span className="credential-cell">
                            <span className="credential-mask">
                              {item.marbete.maskedCode}
                            </span>
                            <span className="privacy-chip" aria-label="Oculto">
                              <EyeOff className="privacy-chip__icon" aria-hidden />
                            </span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label="Estado">
                        <StatusChip variant="assigned" data-testid={`assigned-status-${item.canvasUserId}`}>
                          Asignado
                        </StatusChip>
                      </td>
                      <td className="data-table__date" data-label="Fecha de asignación">
                        {formatShortDate(item.marbete?.assignedAt ?? null)}
                      </td>
                      <td data-label="Usuario">
                        {item.marbete?.assignedBy ?? '—'}
                      </td>
                      <td className="assignment-row__action" data-label="Acción">
                        <div className="admin-actions" aria-label={`Acciones para ${item.fullName}`}>
                          <button
                            className="admin-action admin-action--reveal"
                            type="button"
                            aria-label={`Revelar número completo de ${item.fullName}`}
                            data-testid={`assigned-reveal-${item.canvasUserId}`}
                            disabled={!canWrite || !item.marbete}
                            onClick={() => openReveal(item)}
                          >
                            <Eye className="admin-action__icon admin-action__icon--stroke" aria-hidden />
                            <span className="admin-action__label">Revelar</span>
                          </button>
                          <button
                            className="admin-action admin-action--danger"
                            type="button"
                            aria-label={`Desasignar marbete de ${item.fullName}`}
                            data-testid={`assigned-unassign-${item.canvasUserId}`}
                            disabled={!canWrite || !item.marbete}
                            onClick={() => openUnassign(item)}
                          >
                            <Undo2 className="admin-action__icon admin-action__icon--stroke" aria-hidden />
                            <span className="admin-action__label">Desasignar</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {assignedEmpty ? (
              <div className="assignment-empty" data-testid="assigned-empty">
                <strong>
                  {search
                    ? 'No encontramos coincidencias para esa matrícula.'
                    : 'No hay matrículas asignadas.'}
                </strong>
                <span>
                  {search
                    ? 'Prueba con otro número o limpia la búsqueda.'
                    : 'Las asignaciones confirmadas aparecerán aquí.'}
                </span>
              </div>
            ) : null}
            <Pagination
              currentPage={assignedPage}
              pageSize={assignedPageSize}
              totalItems={totalAssigned}
              onPageChange={(p) => setAssignedPage(p)}
              onPageSizeChange={(s) => {
                setAssignedPageSize(s);
                setAssignedPage(1);
              }}
            />
          </div>
        </div>
      </section>

      {/* Global success banner (mirrors marbetes-page-client behavior). */}
      <div
        className="app-alert app-alert--success"
        role="status"
        aria-live="polite"
        data-testid="app-alert-success"
        hidden={infoBanner === null}
      >
        <span className="app-alert__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="m6.5 12.5 3.5 3.5 7.5-8"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
            />
          </svg>
        </span>
        <p className="app-alert__message">
          <strong data-testid="app-alert-title">{infoBanner?.title ?? ''}</strong>{' '}
          <span data-testid="app-alert-detail">{infoBanner?.detail ?? ''}</span>
        </p>
        <button
          type="button"
          className="app-alert__close"
          aria-label="Cerrar alerta"
          data-testid="app-alert-close"
          onClick={dismissInfoBanner}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="m6 6 12 12M18 6 6 18"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth={2}
            />
          </svg>
        </button>
      </div>

      <AssignReviewModal
        open={assignModal.open}
        onOpenChange={(o) => setAssignModal((prev) => ({ ...prev, open: o }))}
        enrollments={assignModal.enrollments}
        available={availableMarbetes}
        availableMarbetesTotal={availableMarbetesTotal}
        onConfirm={handleAssignConfirm}
      />

      <UnassignModal
        open={unassignCtx !== null}
        onOpenChange={(o) => {
          if (!o) setUnassignCtx(null);
        }}
        context={
          unassignCtx && unassignCtx.marbete
            ? {
                canvasUserId: unassignCtx.canvasUserId,
                fullName: unassignCtx.fullName,
                marbeteId: unassignCtx.marbete.id,
                marbeteMaskedCode: unassignCtx.marbete.maskedCode,
                assignedAt: unassignCtx.marbete.assignedAt,
                assignedBy: unassignCtx.marbete.assignedBy,
              }
            : null
        }
        onConfirm={handleUnassignConfirm}
      />

      <RevealMarbeteDialog
        marbeteId={revealMarbete?.id ?? 0}
        open={revealMarbete !== null}
        onOpenChange={(o) => {
          if (!o) setRevealMarbeteId(null);
        }}
        onRevealed={() => {
          setRevealMarbeteId(null);
          void refetch();
        }}
      />
    </div>
  );
}

// Keep helpers exported for unit tests if needed.
export { formatShortDate };