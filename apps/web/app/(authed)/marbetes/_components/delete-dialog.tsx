'use client';
import { useState, type FormEvent } from 'react';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';
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
import { ApiError, deleteMarbete } from '@/lib/api-client';

interface Props {
  /** Marbete to delete; null closes the dialog. */
  marbete: MarbeteDetailResponse | null;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Soft-delete confirmation dialog for a marbete. Requires:
 *   - a justification (>= 3 chars, DTO-enforced), and
 *   - a 6-digit OTP code (sent via x-otp-code header).
 *
 * Errors are mapped to human-readable Spanish strings; the server-side
 * error code drives which message is shown.
 */
export function DeleteDialog({ marbete, onClose, onSuccess }: Props) {
  const open = marbete !== null;
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setReason('');
    setOtp('');
    setError(null);
    setLoading(false);
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
    if (reason.length < 3) {
      setError('La justificación debe tener al menos 3 caracteres.');
      return;
    }
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 dígitos.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await deleteMarbete(marbete.id, { reason }, otp);
      reset();
      onSuccess?.();
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_invalid'
            ? 'Código OTP inválido o expirado.'
            : err.code === 'otp_required'
              ? 'Código OTP requerido.'
              : err.code === 'not_found'
                ? 'Marbete no encontrado.'
                : err.code === 'conflict'
                  ? 'Marbete ya eliminado.'
                  : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = reason.length >= 3 && otp.length === 6 && !loading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="delete-dialog">
        <DialogHeader>
          <DialogTitle>Eliminar marbete</DialogTitle>
          <DialogDescription>
            Vas a eliminar el marbete <strong>{marbete?.maskedCode ?? ''}</strong>. Esta
            operación requiere justificación y un código OTP.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="delete-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-reason">Justificación</Label>
            <Input
              id="delete-reason"
              type="text"
              minLength={3}
              maxLength={500}
              placeholder="Motivo de la eliminación"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              required
              data-testid="delete-reason"
            />
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
              variant="destructive"
              disabled={!canSubmit}
              data-testid="delete-submit"
            >
              {loading ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
