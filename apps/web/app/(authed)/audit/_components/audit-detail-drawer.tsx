'use client';
import type { AuditEntry } from '@quorum-backoffice/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Props {
  entry: AuditEntry | null;
  onClose: () => void;
}

/**
 * Renders the full metadata for a single audit entry plus the parsed
 * before / after JSON payloads. The original spec called for a "drawer"
 * (Sheet); the installed primitive is Dialog, so we use a wide Dialog
 * with `max-w-3xl` to give the verbose JSON enough room. Behaviour-wise
 * it still opens on selection and closes on overlay click or onClose.
 */
function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString();
  } catch {
    return iso;
  }
}

export function AuditDetailDrawer({ entry, onClose }: Props) {
  const open = entry !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-3xl" data-testid="audit-detail">
        <DialogHeader>
          <DialogTitle>
            {entry ? <span>Detalle de auditoría #{entry.id}</span> : null}
          </DialogTitle>
        </DialogHeader>
        {entry ? (
          <div className="grid gap-4 max-h-[70vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-text-muted">ID:</span>{' '}
                <span className="font-mono">{entry.id}</span>
              </div>
              <div>
                <span className="text-text-muted">Fecha:</span>{' '}
                {formatDate(entry.occurredAt)}
              </div>
              <div>
                <span className="text-text-muted">Actor ID:</span> {entry.actorId}
              </div>
              <div>
                <span className="text-text-muted">Email:</span>{' '}
                {entry.actorEmail ?? '—'}
              </div>
              <div>
                <span className="text-text-muted">Acción:</span>{' '}
                <Badge>{entry.action}</Badge>
              </div>
              <div>
                <span className="text-text-muted">Entidad:</span>{' '}
                {entry.entityType ?? '—'}
                {entry.entityId ? ` · ${entry.entityId}` : ''}
              </div>
              <div>
                <span className="text-text-muted">OTP ID:</span>{' '}
                <span className="font-mono">{entry.otpId ?? '—'}</span>
              </div>
              <div>
                <span className="text-text-muted">IP:</span>{' '}
                <span className="font-mono">{entry.ip ?? '—'}</span>
              </div>
              <div className="col-span-2">
                <span className="text-text-muted">User-Agent:</span>{' '}
                <span className="text-xs break-all">{entry.userAgent ?? '—'}</span>
              </div>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-text-primary">
                Before
              </h3>
              <pre
                className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs"
                data-testid="before-json"
              >
                {formatJson(entry.beforeJson)}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-text-primary">
                After
              </h3>
              <pre
                className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs"
                data-testid="after-json"
              >
                {formatJson(entry.afterJson)}
              </pre>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}