'use client';
import { useState, type FormEvent } from 'react';
import type {
  MarbeteDetailResponse,
  MarbeteStatus,
  UpdateMarbeteRequest,
} from '@quorum-backoffice/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';
import { StudentLookup } from './student-lookup';
import { ApiError, updateMarbete } from '@/lib/api-client';

interface Props {
  /** Marbete being edited; null closes the dialog. */
  marbete: MarbeteDetailResponse | null;
  onClose: () => void;
  onSuccess?: (updated: MarbeteDetailResponse) => void;
}

const STATUS_OPTIONS: Array<{ value: MarbeteStatus; label: string }> = [
  { value: 'active', label: 'Activo' },
  { value: 'inactive', label: 'Inactivo' },
];

/**
 * Edit dialog for a marbete.
 *
 * Lets the operator change:
 *   - the assigned Canvas student (set, change, or unassign with null), and
 *   - the status (active / inactive).
 *
 * Both edits are diffed against the original `marbete` prop; if nothing
 * changed the submit is blocked with a "No hay cambios" error instead of
 * making an empty PATCH. OTP is mandatory (sent via x-otp-code).
 *
 * The marbete.id is the stable identity used to PATCH; the maskedCode is
 * shown read-only so the operator can identify which row is being edited.
 */
export function EditDialog({ marbete, onClose, onSuccess }: Props) {
  const open = marbete !== null;
  const initialCanvasId = marbete?.student?.canvasUserId ?? null;
  const [canvasUserId, setCanvasUserId] = useState<number | null | ''>(initialCanvasId);
  const [status, setStatus] = useState<MarbeteStatus>(marbete?.status ?? 'active');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setOtp('');
    setError(null);
    setLoading(false);
  }

  // Re-seed local state when a different marbete is opened.
  // Inline setState during render is acceptable here because the guard
  // (otp empty, no error, not loading) ensures it only fires once per
  // marbete.id transition. If lint warns, refactor to useEffect keyed on
  // marbete?.id.
  if (
    marbete &&
    (canvasUserId as number | null) !== (marbete.student?.canvasUserId ?? null) &&
    otp === '' &&
    !error &&
    !loading
  ) {
    setCanvasUserId(marbete.student?.canvasUserId ?? null);
    setStatus(marbete.status);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      reset();
      onClose();
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!marbete) return;
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 dígitos.');
      return;
    }
    const originalCanvasId = marbete.student?.canvasUserId ?? null;
    const originalStatus = marbete.status;
    const currentCanvasId = typeof canvasUserId === 'number' ? canvasUserId : null;
    const req: UpdateMarbeteRequest = {};
    if (currentCanvasId !== originalCanvasId) req.canvasUserId = currentCanvasId;
    if (status !== originalStatus) req.status = status;
    if (Object.keys(req).length === 0) {
      setError('No hay cambios para guardar.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const updated = await updateMarbete(marbete.id, req, otp);
      reset();
      onSuccess?.(updated);
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_invalid'
            ? 'Código OTP inválido o expirado.'
            : err.code === 'otp_required'
              ? 'Código OTP requerido.'
              : err.code === 'student_not_found'
                ? 'La matrícula no existe en cache.'
                : err.code === 'student_not_active'
                  ? 'La matrícula está inactiva en Canvas.'
                  : err.code === 'not_found'
                    ? 'Marbete no encontrado.'
                    : err.code === 'conflict'
                      ? 'Conflicto (marbete revocado o eliminado).'
                      : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="edit-dialog">
        <DialogHeader>
          <DialogTitle>Editar marbete</DialogTitle>
          <DialogDescription>
            Cambia la asignación al estudiante y/o el estado. Requiere OTP.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="edit-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-code">UID</Label>
            <Input
              id="edit-code"
              type="text"
              value={marbete?.maskedCode ?? ''}
              disabled
              data-testid="edit-uid"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Matrícula Canvas</Label>
            <StudentLookup
              value={canvasUserId}
              onChange={setCanvasUserId}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-status">Estado</Label>
            <select
              id="edit-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as MarbeteStatus);
                if (error) setError(null);
              }}
              disabled={loading}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="edit-status"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Código OTP</Label>
            <OtpInput
              value={otp}
              onChange={(v) => {
                setOtp(v);
                if (error) setError(null);
              }}
              disabled={loading}
              aria-label="Código OTP"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={loading || otp.length !== 6}
              data-testid="edit-submit"
            >
              {loading ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}