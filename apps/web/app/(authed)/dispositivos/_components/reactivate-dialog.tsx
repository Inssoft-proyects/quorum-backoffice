'use client';
import { useState, type FormEvent } from 'react';
import type { DispositivoDetailResponse } from '@quorum-backoffice/shared';
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
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';
import { ApiError, reactivateDispositivo } from '@/lib/api-client';

interface Props {
  /** Dispositivo to reactivate; null closes the dialog. */
  dispositivo: DispositivoDetailResponse | null;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Un-revoke confirmation dialog for a revoked dispositivo (logical-delete
 * model). Bodyless POST to /api/v1/dispositivos/:id/reactivate, gated by a
 * 6-char OTP (x-otp-code header). Reactivation flips status back to `active`
 * and keeps the same row/serial so audit history never dangles.
 */
export function ReactivateDialog({ dispositivo, onClose, onSuccess }: Props) {
  const open = dispositivo !== null;
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
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
    if (!dispositivo) return;
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 caracteres.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await reactivateDispositivo(dispositivo.id, otp);
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
                ? 'Dispositivo no encontrado.'
                : err.code === 'conflict'
                  ? 'Dispositivo ya está activo.'
                  : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = otp.length === 6 && !loading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="reactivate-dialog">
        <DialogHeader>
          <DialogTitle>Reactivar dispositivo</DialogTitle>
          <DialogDescription>
            Vas a reactivar el dispositivo <strong>{dispositivo?.serialNumber ?? ''}</strong>.
            Volverá al estado <strong>Activo</strong> conservando su historial.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="reactivate-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label>Código OTP</Label>
            <OtpInput
              mode="alphanumeric"
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
              variant="default"
              disabled={!canSubmit}
              data-testid="reactivate-submit"
            >
              {loading ? 'Reactivando…' : 'Reactivar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
