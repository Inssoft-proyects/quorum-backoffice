'use client';
import type { DispositivoDetailResponse, UserRole } from '@quorum-backoffice/shared';
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
  items: DispositivoDetailResponse[];
  userRole: UserRole;
  onEdit: (item: DispositivoDetailResponse) => void;
  onRevoke: (item: DispositivoDetailResponse) => void;
  isPending?: boolean;
}

type BadgeVariant = 'default' | 'destructive';

function statusVariant(status: DispositivoDetailResponse['status']): BadgeVariant {
  return status === 'active' ? 'default' : 'destructive';
}

function statusLabel(status: DispositivoDetailResponse['status']): string {
  return status === 'active' ? 'Activo' : 'Revocado';
}

/**
 * Renders the dispositivos list as a shadcn table.
 *
 * Differences vs MarbetesTable:
 *   - Serial number is shown in FULL (not masked); the serial is the
 *     identification token and is not a secret.
 *   - No student column (dispositivos are not assigned to students).
 *   - Status enum is active/revoked only (no inactive).
 *   - Edit + Revoke actions are gated by admin role; Revoke is hidden for
 *     already-revoked rows.
 */
export function DispositivosTable({ items, userRole, onEdit, onRevoke, isPending }: Props) {
  const canManage = hasAtLeastRole(userRole, 'admin');
  if (items.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border p-8 text-center text-text-muted"
        data-testid="empty-state"
      >
        No hay dispositivos que coincidan con el filtro.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card">
      <Table data-testid="dispositivos-table">
        <TableHeader>
          <TableRow>
            <TableHead>Serial</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Marca</TableHead>
            <TableHead>Modelo</TableHead>
            <TableHead>Creado por</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((d) => (
            <TableRow key={d.id} data-testid={`dispositivo-row-${d.id}`}>
              <TableCell className="font-mono text-sm">{d.serialNumber}</TableCell>
              <TableCell>
                <Badge variant={statusVariant(d.status)}>{statusLabel(d.status)}</Badge>
              </TableCell>
              <TableCell>
                {d.brand ? d.brand : <span className="text-text-muted">—</span>}
              </TableCell>
              <TableCell>
                {d.model ? d.model : <span className="text-text-muted">—</span>}
              </TableCell>
              <TableCell className="text-sm text-text-muted">{d.createdBy}</TableCell>
              <TableCell className="text-right">
                {canManage ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(d)}
                      disabled={isPending}
                      data-testid={`edit-${d.id}`}
                    >
                      Editar
                    </Button>
                    {d.status === 'active' ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onRevoke(d)}
                        disabled={isPending}
                        data-testid={`revoke-${d.id}`}
                      >
                        Revocar
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}