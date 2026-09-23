'use client';

import * as React from 'react';
import type { AuditEntry } from '@quorum-backoffice/shared';
import { IdBadge, SortHeader, StatusChip, type SortState } from '@/components/inventory';

interface Props {
  items: AuditEntry[];
  /** Current sort applied to the table. Optional for test-render parity. */
  sort?: SortState | null;
  /** Notifies the parent of a sort cycle. */
  onSortChange?: (s: SortState | null) => void;
  onSelect: (entry: AuditEntry) => void;
}

/**
 * Maps the AuditAction value to a StatusChip variant. Reads `succesful`
 * writes as the green "available" variant, destructive actions as
 * "danger", and meta actions (update, reveal, logout) as the neutral
 * "assigned" variant (border + no bullet). The full set of AuditAction
 * values is covered.
 */
function actionToVariant(
  action: AuditEntry['action'],
): 'available' | 'assigned' | 'warning' | 'danger' {
  if (
    action.endsWith('.delete') ||
    action.endsWith('.revoke') ||
    action === 'auth.failed'
  ) {
    return 'danger';
  }
  if (
    action.endsWith('.create') ||
    action.endsWith('.assign') ||
    action.endsWith('.bulk_create') ||
    action === 'auth.login'
  ) {
    return 'available';
  }
  // update / reveal / logout → neutral chip
  return 'assigned';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es', {
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  } catch {
    return iso;
  }
}

/**
 * The audit log table (v2 — maquette pattern).
 *
 * Renders ID (AUD-####) / Fecha / Actor / Acción / Entidad / OTP /
 * Detalle. Uses the inventory shell (.table-shell + .data-table), the
 * sortable header primitive (SortHeader), the IdBadge for the ID column,
 * and the StatusChip for the action label. The row carries an onClick
 * that opens the drawer so the T6 interaction-flow spec can target the
 * `<tr>` directly via the existing testid.
 *
 * `sort` and `onSortChange` are mandatory; the page-client owns the
 * sort state.
 */
export function AuditTable({ items, sort, onSortChange, onSelect }: Props) {
  const currentSort: SortState | null = sort ?? null;
  const changeSort = onSortChange ?? (() => {});

  function handleSort(key: string) {
    let next: SortState | null;
    if (!currentSort || currentSort.key !== key) {
      // First click on a column: default direction is DESC for date
      // columns (most recent first) and ASC for everything else.
      const direction = key === 'occurredAt' ? 'desc' : 'asc';
      next = { key, direction };
    } else {
      // Same column clicked again: 2-state toggle.
      next = {
        key,
        direction: currentSort.direction === 'asc' ? 'desc' : 'asc',
      };
    }
    changeSort(next);
  }

  if (items.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border p-8 text-center text-text-muted"
        data-testid="empty-state"
      >
        No hay entradas que coincidan con el filtro.
      </div>
    );
  }

  return (
    <div className="table-shell" data-testid="audit-table">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader
                label="ID"
                sortKey="id"
                currentSort={currentSort}
                onSort={handleSort}
              />
              <SortHeader
                label="Fecha"
                sortKey="occurredAt"
                currentSort={currentSort}
                onSort={handleSort}
              />
              <th scope="col">Actor</th>
              <th scope="col">Acción</th>
              <th scope="col">Entidad</th>
              <th scope="col">OTP</th>
              <th scope="col" className="text-right">
                Detalle
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => {
              const variant = actionToVariant(e.action);
              const audId = `AUD-${String(e.id).padStart(4, '0')}`;
              return (
                <tr
                  key={e.id}
                  data-testid={`audit-row-${e.id}`}
                  onClick={() => onSelect(e)}
                  style={{ cursor: 'pointer' }}
                >
                  <td data-label="ID">
                    <IdBadge value={audId} />
                  </td>
                  <td data-label="Fecha" className="text-sm">
                    {formatDate(e.occurredAt)}
                  </td>
                  <td data-label="Actor">
                    <div className="flex flex-col">
                      <span className="text-sm">{e.actorEmail ?? e.actorId}</span>
                      {e.actorEmail ? (
                        <span className="text-xs text-text-muted">{e.actorId}</span>
                      ) : null}
                    </div>
                  </td>
                  <td data-label="Acción">
                    <StatusChip variant={variant}>{e.action}</StatusChip>
                  </td>
                  <td data-label="Entidad" className="font-mono text-xs">
                    {e.entityType ?? '—'}
                    {e.entityId ? ` · ${e.entityId}` : ''}
                  </td>
                  <td data-label="OTP" className="font-mono text-xs">
                    {e.otpId ?? '—'}
                  </td>
                  <td data-label="Detalle" className="text-right">
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => onSelect(e)}
                      data-testid={`audit-detail-${e.id}`}
                      aria-label="Ver detalle"
                    >
                      Ver
                    </button>
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
