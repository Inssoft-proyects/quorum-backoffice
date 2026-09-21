'use client';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Props {
  items: MarbeteDetailResponse[];
  userRole: UserRole;
  onDelete: (item: MarbeteDetailResponse) => void;
  isPending?: boolean;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive';

function statusVariant(status: MarbeteDetailResponse['status']): BadgeVariant {
  if (status === 'active') return 'default';
  if (status === 'inactive') return 'secondary';
  return 'destructive';
}

function statusLabel(status: MarbeteDetailResponse['status']): string {
  if (status === 'active') return 'Activo';
  if (status === 'inactive') return 'Inactivo';
  return 'Revocado';
}

/**
 * Renders the marbetes list as a shadcn table. The delete action is gated
 * by `hasAtLeastRole(userRole, 'admin')` and hidden for already-deleted rows.
 */
export function MarbetesTable({ items, userRole, onDelete, isPending }: Props) {
  const canDelete = hasAtLeastRole(userRole, 'admin');
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
    <div className="rounded-md border border-border bg-card">
      <Table data-testid="marbetes-table">
        <TableHeader>
          <TableRow>
            <TableHead>UID</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Estudiante</TableHead>
            <TableHead>Asignado</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((m) => (
            <TableRow key={m.id} data-testid={`marbete-row-${m.id}`}>
              <TableCell className="font-mono text-sm">{m.maskedCode}</TableCell>
              <TableCell>
                <Badge variant={statusVariant(m.status)}>{statusLabel(m.status)}</Badge>
              </TableCell>
              <TableCell>
                {m.student ? (
                  <div className="flex flex-col">
                    <span className="text-sm">{m.student.fullName}</span>
                    <span className="text-xs text-text-muted">{m.student.email}</span>
                  </div>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm text-text-muted">
                {m.assignedAt ? new Date(m.assignedAt).toLocaleDateString('es') : '—'}
              </TableCell>
              <TableCell className="text-right">
                {canDelete && !m.deletedAt ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => onDelete(m)}
                    disabled={isPending}
                    data-testid={`delete-${m.id}`}
                  >
                    Eliminar
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
