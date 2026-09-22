'use client';
import type { AuditEntry } from '@quorum-backoffice/shared';
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
  items: AuditEntry[];
  onSelect: (entry: AuditEntry) => void;
}

/**
 * Maps the AuditAction value to a Badge variant. Destructive actions
 * (delete / revoke / failed logins) get the destructive variant; writes
 * (create / assign / login) get default; everything else is secondary.
 */
function actionVariant(
  action: AuditEntry['action'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (
    action.endsWith('.delete') ||
    action.endsWith('.revoke') ||
    action === 'auth.failed'
  ) {
    return 'destructive';
  }
  if (
    action.endsWith('.create') ||
    action.endsWith('.assign') ||
    action === 'auth.login'
  ) {
    return 'default';
  }
  return 'secondary';
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
 * Audit log table (WU10). Read-only; the action column is the row's
 * "Ver" button which opens the detail drawer with the full before/after
 * JSON. Rows expose data-testid hooks for both the row and the detail
 * trigger so tests can target them directly.
 */
export function AuditTable({ items, onSelect }: Props) {
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
    <div className="rounded-md border border-border bg-card">
      <Table data-testid="audit-table">
        <TableHeader>
          <TableRow>
            <TableHead>Fecha</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Acción</TableHead>
            <TableHead>Entidad</TableHead>
            <TableHead>OTP</TableHead>
            <TableHead className="text-right">Detalle</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((e) => (
            <TableRow key={e.id} data-testid={`audit-row-${e.id}`}>
              <TableCell className="text-sm">{formatDate(e.occurredAt)}</TableCell>
              <TableCell>
                <div className="flex flex-col">
                  <span className="text-sm">{e.actorEmail ?? e.actorId}</span>
                  {e.actorEmail ? (
                    <span className="text-xs text-text-muted">{e.actorId}</span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={actionVariant(e.action)}>{e.action}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {e.entityType ?? '—'}
                {e.entityId ? ` · ${e.entityId}` : ''}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {e.otpId ?? '—'}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onSelect(e)}
                  data-testid={`audit-detail-${e.id}`}
                >
                  Ver
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}