'use client';

import * as React from 'react';
import type { DispositivoDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { Ban, Pencil } from 'lucide-react';
import { IdBadge, SortHeader, StatusChip, type SortState } from '@/components/inventory';

interface Props {
  items: DispositivoDetailResponse[];
  userRole: UserRole;
  /** Current sort applied to the table. Optional for test-render parity. */
  sort?: SortState | null;
  /** Notifies the parent of a sort cycle (asc → desc → none). */
  onSortChange?: (s: SortState | null) => void;
  onEdit: (item: DispositivoDetailResponse) => void;
  onRevoke: (item: DispositivoDetailResponse) => void;
  isPending?: boolean;
}

function statusChip(status: DispositivoDetailResponse['status']) {
  if (status === 'active') return { variant: 'available' as const, label: 'Activo' };
  return { variant: 'danger' as const, label: 'Revocado' };
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Maquet uses the es-MX short month + 4-digit year pattern.
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Redesigned dispositivos list (maquette v2).
 *
 * Renders ID (DIS-####) / Serial / Marca / Modelo / Estado / Registrado
 * / Acciones. The serial is shown in full (it's the device's hardware
 * identifier, not a secret). Action column shows "Editar" and "Revocar"
 * (the maquet icons) and is gated by admin role. Edit + Revoke are
 * hidden for revoked rows — only "Activo" rows are mutable.
 *
 * `sort` and `onSortChange` are optional so existing tests can render
 * the table with the pre-v2 prop shape. In production the page client
 * always wires them.
 */
export function DispositivosTable({
  items,
  userRole,
  sort,
  onSortChange,
  onEdit,
  onRevoke,
  isPending,
}: Props) {
  const canManage = hasAtLeastRole(userRole, 'admin');
  const currentSort: SortState | null = sort ?? null;
  const changeSort = onSortChange ?? (() => {});

  function handleSort(key: string) {
    let next: SortState | null;
    if (!currentSort || currentSort.key !== key) {
      next = { key, direction: 'asc' };
    } else if (currentSort.direction === 'asc') {
      next = { key, direction: 'desc' };
    } else {
      next = null;
    }
    changeSort(next);
  }

  if (items.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border p-8 text-center text-text-muted"
        data-testid="empty-state"
      >
        No hay dispositivos registrados.
      </div>
    );
  }

  return (
    <div className="table-shell" data-testid="dispositivos-table">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader label="ID" sortKey="id" currentSort={currentSort} onSort={handleSort} />
              <SortHeader label="Serial" sortKey="serial" currentSort={currentSort} onSort={handleSort} />
              <SortHeader label="Marca" sortKey="brand" currentSort={currentSort} onSort={handleSort} />
              <SortHeader label="Modelo" sortKey="model" currentSort={currentSort} onSort={handleSort} />
              <SortHeader label="Estado" sortKey="status" currentSort={currentSort} onSort={handleSort} />
              <SortHeader
                label="Registrado"
                sortKey="createdAt"
                currentSort={currentSort}
                onSort={handleSort}
              />
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => {
              const chip = statusChip(d.status);
              const disId = `DIS-${String(d.id).padStart(4, '0')}`;
              return (
                <tr key={d.id} data-testid={`dispositivo-row-${d.id}`}>
                  <td data-label="ID">
                    <IdBadge value={disId} />
                  </td>
                  <td data-label="Serial" className="data-table__credential">
                    {d.serialNumber}
                  </td>
                  <td data-label="Marca">
                    {d.brand ? d.brand : <span className="text-text-muted">—</span>}
                  </td>
                  <td data-label="Modelo">
                    {d.model ? d.model : <span className="text-text-muted">—</span>}
                  </td>
                  <td data-label="Estado">
                    <StatusChip variant={chip.variant}>{chip.label}</StatusChip>
                  </td>
                  <td
                    data-label="Registrado"
                    className="data-table__validity-date"
                  >
                    {formatDate(d.createdAt)}
                  </td>
                  <td data-label="Acciones">
                    {canManage && d.status === 'active' ? (
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => onEdit(d)}
                          disabled={isPending}
                          data-testid={`edit-${d.id}`}
                          aria-label="Editar"
                        >
                          <Pencil className="row-action__icon" aria-hidden />
                          Editar
                        </button>
                        <button
                          type="button"
                          className="row-action row-action--danger"
                          onClick={() => onRevoke(d)}
                          disabled={isPending}
                          data-testid={`revoke-${d.id}`}
                          aria-label="Revocar"
                        >
                          <Ban className="row-action__icon" aria-hidden />
                          Revocar
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}