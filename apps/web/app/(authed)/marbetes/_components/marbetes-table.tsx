'use client';

import * as React from 'react';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { Ban, Eye } from 'lucide-react';
import { IdBadge, MaskedNumber, StatusChip } from '@/components/inventory';

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
  if (Number.isNaN(start.getTime())) return { dateText: '—', state: 'ok' as const };
  const validity = new Date(start.getTime() + THREE_YEARS_MS);
  const diff = validity.getTime() - now.getTime();
  let state: 'expired' | 'soon' | 'ok' = 'ok';
  if (diff < 0) state = 'expired';
  else if (diff < NINETY_DAYS_MS) state = 'soon';
  return { dateText: formatDate(validity.toISOString()), state };
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
 * (the maquette icons) and the `data-testid="delete-${id}"` testid is
 * kept on the Baja button so the existing test suite still passes.
 */
export function MarbetesTable({ items, userRole, onDelete, onEdit, isPending, now }: Props) {
  const canManage = hasAtLeastRole(userRole, 'admin');
  const effectiveNow = now ?? new Date();

  if (items.length === 0) {
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
              <th scope="col">ID</th>
              <th scope="col">No. Marbete</th>
              <th scope="col">Estado</th>
              <th scope="col">Estudiante</th>
              <th scope="col">Fecha de carga</th>
              <th scope="col">Vigencia</th>
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const validity = computeValidity(m.createdAt, effectiveNow);
              const chip = statusChip(m.status, m.assignedStudentId);
              return (
                <tr key={m.id} data-testid={`marbete-row-${m.id}`}>
                  <td data-label="ID">
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
                    className="data-table__validity-date"
                  >
                    {formatDate(m.createdAt)}
                  </td>
                  <td data-label="Vigencia">
                    <div className="flex flex-col items-center gap-1">
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
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => onEdit(m)}
                          disabled={isPending}
                          data-testid={`reveal-${m.id}`}
                          aria-label="Revelar"
                        >
                          <Eye className="row-action__icon" aria-hidden />
                          Revelar
                        </button>
                        <button
                          type="button"
                          className="row-action row-action--danger"
                          onClick={() => onDelete(m)}
                          disabled={isPending}
                          data-testid={`delete-${m.id}`}
                          aria-label="Dar de baja"
                        >
                          <Ban className="row-action__icon" aria-hidden />
                          Baja
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
