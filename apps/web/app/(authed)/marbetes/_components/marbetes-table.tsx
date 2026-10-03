'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { IdBadge, MaskedNumber, SortHeader, StatusChip, type SortState } from '@/components/inventory';

interface Props {
  items: MarbeteDetailResponse[];
  userRole: UserRole;
  onDelete: (item: MarbeteDetailResponse) => void;
  onEdit: (item: MarbeteDetailResponse) => void;
  isPending?: boolean;
  /** Forces the validity chip rule independent of the current date (used in tests). */
  now?: Date;
}

const THREE_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 3;
const NINETY_DAYS_MS = 1000 * 60 * 60 * 24 * 90;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // DD/MM/YYYY — Maquette uses this format in <time> elements.
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()}`;
}

function computeValidity(createdAt: string, now: Date) {
  const start = new Date(createdAt);
  if (Number.isNaN(start.getTime())) return { dateText: '—', state: 'ok' as const, timestamp: 0 };
  const validity = new Date(start.getTime() + THREE_YEARS_MS);
  const diff = validity.getTime() - now.getTime();
  let state: 'expired' | 'soon' | 'ok' = 'ok';
  if (diff < 0) state = 'expired';
  else if (diff < NINETY_DAYS_MS) state = 'soon';
  return { dateText: formatDate(validity.toISOString()), state, timestamp: validity.getTime() };
}

function statusChip(status: MarbeteDetailResponse['status'], assignedStudentId: number | null) {
  if (status === 'active') {
    return assignedStudentId
      ? { variant: 'assigned' as const, label: 'Asignado' }
      : { variant: 'available' as const, label: 'Disponible' };
  }
  if (status === 'inactive') return { variant: 'danger' as const, label: 'Vencida' };
  return { variant: 'danger' as const, label: 'Revocado' };
}

/**
 * Redesigned marbetes list (maquette v2).
 *
 * Renders ID / No. Marbete / Estado / Estudiante / Fecha de carga /
 * Vigencia / Acciones. The student column is preserved (the maquette
 * omits it but the existing unit test requires the student full name and
 * email to be in the DOM). Action column shows "Revelar" and "Baja"
 * using the canon `.admin-action` icon+label pills and an inline SVG
 * sprite that defines the `icon-reveal` and `icon-deactivate`
 * `<symbol>` blocks (verbatim copies from
 * /planQuorum/dev/quorum-design/design/Inec/Inec/asignacion-marbetes.html
 * and inventario-credenciales.html). Existing data-testid attributes
 * (`reveal-${id}`, `delete-${id}`, `marbete-row-${id}`,
 * `validity-date-${id}`) are preserved so the current test suite keeps
 * passing.
 *
 * Sorting applies client-side to the already-fetched items over the four
 * sortable columns (ID, No. Marbete, Fecha de carga, Vigencia). Cycles
 * through none → asc → desc as in the maquette.
 */
export function MarbetesTable({ items, userRole, onDelete, onEdit, isPending, now }: Props) {
  const canManage = hasAtLeastRole(userRole, 'admin');
  const effectiveNow = now ?? new Date();
  const [sort, setSort] = useState<SortState | null>(null);

  // Decorate items with the validity timestamp so the sort comparator can
  // reach it without recomputing per comparison.
  const decorated = useMemo(
    () =>
      items.map((m) => {
        const validity = computeValidity(m.createdAt, effectiveNow);
        return { item: m, validityTimestamp: validity.timestamp };
      }),
    [items, effectiveNow],
  );

  const sorted = useMemo(() => {
    if (!sort) return decorated;
    const sortedItems = [...decorated].sort((a, b) => {
      const dir = sort.direction === 'asc' ? 1 : -1;
      switch (sort.key) {
        case 'id':
          return a.item.publicUid.localeCompare(b.item.publicUid) * dir;
        case 'credential':
          return a.item.maskedCode.localeCompare(b.item.maskedCode) * dir;
        case 'loadDate':
          return (new Date(a.item.createdAt).getTime() - new Date(b.item.createdAt).getTime()) * dir;
        case 'validity':
          return (a.validityTimestamp - b.validityTimestamp) * dir;
        default:
          return 0;
      }
    });
    return sortedItems;
  }, [decorated, sort]);

  function handleSort(key: string): void {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  }

  if (sorted.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border p-8 text-center text-text-muted"
        data-testid="empty-state"
      >
        No hay marbetes que coincidan con el filtro.
      </div>
    );
  }

  return (
    <div className="table-shell" data-testid="marbetes-table">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader
                label="ID"
                sortKey="id"
                currentSort={sort}
                onSort={handleSort}
                ariaSortDefault="none"
                ariaLabel="Ordenar ID ascendente"
              />
              <SortHeader
                label="No. Marbete"
                sortKey="credential"
                currentSort={sort}
                onSort={handleSort}
                ariaSortDefault="none"
                ariaLabel="Ordenar No. Marbete ascendente"
              />
              <th scope="col">Estado</th>
              <th scope="col">Estudiante</th>
              <SortHeader
                label="Fecha de carga"
                sortKey="loadDate"
                currentSort={sort}
                onSort={handleSort}
                ariaSortDefault="none"
                ariaLabel="Ordenar Fecha de carga ascendente"
              />
              <SortHeader
                label="Vigencia"
                sortKey="validity"
                currentSort={sort}
                onSort={handleSort}
                ariaSortDefault="none"
                ariaLabel="Ordenar Vigencia ascendente"
              />
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ item: m, validityTimestamp }) => {
              const validity = computeValidity(m.createdAt, effectiveNow);
              const chip = statusChip(m.status, m.assignedStudentId);
              return (
                <tr key={m.id} data-testid={`marbete-row-${m.id}`}>
                  <td data-label="ID" className="data-table__id">
                    <IdBadge value={m.publicUid} />
                  </td>
                  <td data-label="No. Marbete" className="data-table__credential">
                    <MaskedNumber value={m.maskedCode} />
                  </td>
                  <td data-label="Estado">
                    <StatusChip variant={chip.variant}>{chip.label}</StatusChip>
                  </td>
                  <td data-label="Estudiante">
                    {m.student ? (
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-text-primary">
                          {m.student.fullName}
                        </span>
                        <span className="text-xs text-text-muted">{m.student.email}</span>
                      </div>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td
                    data-label="Fecha de carga"
                    className="data-table__date"
                  >
                    {formatDate(m.createdAt)}
                  </td>
                  <td data-label="Vigencia" className="data-table__validity">
                    <div className="data-table__validity-content">
                      <time
                        dateTime={m.createdAt}
                        className="data-table__validity-date"
                        data-testid={`validity-date-${m.id}`}
                      >
                        {validity.dateText}
                      </time>
                      {validity.state === 'soon' ? (
                        <StatusChip variant="warning">Próxima a vencer</StatusChip>
                      ) : validity.state === 'expired' ? (
                        <StatusChip variant="danger">Vencida</StatusChip>
                      ) : null}
                    </div>
                  </td>
                  <td data-label="Acciones">
                    {canManage && !m.deletedAt ? (
                      <div className="admin-actions" aria-label={`Acciones para el marbete ${m.publicUid}`}>
                        <button
                          type="button"
                          className="admin-action admin-action--reveal"
                          onClick={() => onEdit(m)}
                          disabled={isPending}
                          data-testid={`reveal-${m.id}`}
                          aria-label="Revelar número completo"
                        >
                          <svg
                            className="admin-action__icon"
                            viewBox="0 0 84.98 61.56"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <use href="#icon-reveal" />
                          </svg>
                          <span className="admin-action__label">Revelar</span>
                        </button>
                        <button
                          type="button"
                          className="admin-action admin-action--danger"
                          onClick={() => onDelete(m)}
                          disabled={isPending}
                          data-testid={`delete-${m.id}`}
                          aria-label="Dar de baja marbete"
                        >
                          <svg
                            className="admin-action__icon admin-action__icon--stroke"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <use href="#icon-deactivate" />
                          </svg>
                          <span className="admin-action__label">Baja</span>
                        </button>
                      </div>
                    ) : null}
                    {/* Render an empty td to preserve grid columns when
                     * there are no admin actions (operator row). */}
                    {!(canManage && !m.deletedAt) ? <span aria-hidden="true">—</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Inline SVG sprite (verbatim from canon and design files).
       * Hidden from a11y so screen readers skip the symbol defs. The
       * <use href="#icon-reveal" /> and <use href="#icon-deactivate" />
       * refs in the row buttons resolve to these blocks. */}
      <svg
        className="icon-sprite"
        aria-hidden="true"
        focusable="false"
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      >
        <symbol id="icon-reveal" viewBox="0 0 84.98 61.56">
          <path d="M75.23,13.48h-5.34l3.78-3.78c1.32-1.32,1.32-3.45,0-4.76-.66-.66-1.52-.99-2.38-.99s-1.72.33-2.38.99l-3.78,3.78V3.37c0-1.86-1.51-3.37-3.37-3.37s-3.37,1.51-3.37,3.37v5.34l-3.78-3.78c-.66-.66-1.52-.99-2.38-.99s-1.72.33-2.38.99c-1.32,1.31-1.32,3.45,0,4.76l3.78,3.78h-5.34c-1.86,0-3.37,1.51-3.37,3.37s1.51,3.37,3.37,3.37h5.34l-3.78,3.78c-1.32,1.32-1.32,3.45,0,4.76.66.66,1.52.99,2.38.99s1.72-.33,2.38-.99l3.78-3.78v5.34c0,1.86,1.51,3.37,3.37,3.37s3.37-1.51,3.37-3.37v-5.34l3.78,3.78c.66.66,1.52.99,2.38.99s1.72-.33,2.38-.99c1.32-1.31,1.32-3.45,0-4.76l-3.78-3.78h5.34c1.86,0,3.37-1.51,3.37-3.37s-1.51-3.37-3.37-3.37Z" />
          <path d="M84.4,39.22c-2.49-3.12-5.4-5.91-8.63-8.33-1.2,1.2-2.8,1.86-4.49,1.86-.8,0-1.58-.16-2.31-.44,3.86,2.34,7.33,5.2,10.25,8.51-4.12,4.69-9.33,8.46-15.2,11.14-2.21,1.01-4.53,1.86-6.91,2.55,3.36-3.58,5.41-8.4,5.41-13.7,0-1.42-.16-2.81-.44-4.15-.11,0-.22.03-.33.03-3,0-5.52-2.09-6.19-4.89-.99.61-2.14.94-3.33.94-1.7,0-3.3-.66-4.5-1.86-1.2-1.2-1.87-2.8-1.87-4.5,0-1.2.33-2.34.94-3.33-1.7-.41-3.13-1.5-4-2.97-.1,0-.21,0-.31,0-8.33,0-16.4,1.79-23.6,5.07-7.22,3.3-13.55,8.1-18.34,14.12-.75.94-.71,2.25.03,3.14,4.79,6,11.1,10.79,18.31,14.08,7.2,3.29,15.28,5.07,23.6,5.07s16.4-1.79,23.6-5.07c7.22-3.3,13.55-8.1,18.34-14.12.75-.94.71-2.25-.03-3.14ZM27.87,27.11c-3.36,3.58-5.41,8.4-5.41,13.7s2.05,10.11,5.41,13.69c-2.39-.69-4.7-1.54-6.91-2.55-5.87-2.68-11.08-6.46-15.2-11.15,4.12-4.69,9.33-8.47,15.2-11.14,2.21-1.01,4.53-1.86,6.91-2.55h0ZM42.49,54.45c-7.54,0-13.64-6.11-13.64-13.64,0-6.95,5.2-12.69,11.92-13.53-1.12,1.44-1.78,3.25-1.78,5.21,0,4.7,3.81,8.52,8.52,8.52,3.45,0,6.41-2.05,7.75-5h0c.56,1.49.87,3.11.87,4.8,0,7.54-6.11,13.64-13.64,13.64Z" />
          <path d="M61.19,33.63c-.7-1.81-1.64-3.5-2.8-5.01v1.7c0,1.67,1.21,3.04,2.8,3.31Z" />
          <path d="M73.24,29.1c-2.26-1.49-4.65-2.83-7.15-3.97-4.17-1.9-8.63-3.28-13.27-4.13l-2.98,2.98c-1.32,1.32-1.32,3.45,0,4.76.66.66,1.52.99,2.38.99s1.72-.33,2.38-.99l3.78-3.78v2.53c1.94.61,3.82,1.33,5.64,2.16.37.17.73.36,1.1.53v-5.22l3.78,3.78c.66.66,1.52.99,2.38.99.69,0,1.37-.22,1.96-.64Z" />
        </symbol>
        <symbol id="icon-deactivate" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M5.64 5.64 18.36 18.36" />
        </symbol>
        <symbol id="icon-eye-off" viewBox="0 0 24 24">
          <path d="M3 3l18 18" />
          <path d="M10.58 10.58a2 2 0 0 0 2.83 2.83" />
          <path d="M9.47 5.18A9.72 9.72 0 0 1 12 4.85c4.58 0 8.16 3.02 10 7.15a11.83 11.83 0 0 1-2.56 3.72" />
          <path d="M6.11 6.11A12.3 12.3 0 0 0 2 12c1.84 4.13 5.42 7.15 10 7.15 1.38 0 2.67-.27 3.84-.76" />
        </symbol>
      </svg>
    </div>
  );
}