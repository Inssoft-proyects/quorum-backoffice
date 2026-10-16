'use client';
import { useState, type FormEvent } from 'react';
import { Ban } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';
import { ApiError, revokeDispositivo } from '@/lib/api-client';

interface Props {
  /** Dispositivo to revoke; null closes the dialog. */
  dispositivo: DispositivoDetailResponse | null;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Soft-revoke confirmation dialog for a dispositivo. Requires:
 *   - a justification (>= 3 chars, DTO-enforced), and
 *   - a 6-digit OTP code (sent via x-otp-code header).
 *
 * On the server side, DELETE on /api/v1/dispositivos/:id is a soft-revoke
 * (sets status='revoked', revoked_at=now(), revoked_reason). Errors are
 * mapped to human-readable Spanish strings; the server-side error code
 * drives which message is shown.
 */
export function RevokeDialog({ dispositivo, onClose, onSuccess }: Props) {
  const open = dispositivo !== null;
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
    if (!dispositivo) return;
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
      await revokeDispositivo(dispositivo.id, { reason }, otp);
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
                  ? 'Dispositivo ya revocado.'
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
      <DialogContent
        className="app-modal"
        overlayClassName="app-modal__overlay"
        data-testid="revoke-dialog"
      >
        <DialogHeader className="app-modal__header">
          <div className="modal-dialog__icon modal-dialog__icon--danger" aria-hidden>
            <Ban />
          </div>
          <DialogTitle className="modal-dialog__title">Revocar dispositivo</DialogTitle>
          <DialogDescription className="modal-dialog__description">
            Vas a revocar el dispositivo <strong>{dispositivo?.serialNumber ?? ''}</strong>.
            Esta operación requiere justificación y un código OTP.
          </DialogDescription>
        </DialogHeader>
        <form className="modal-dialog__content" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="revoke-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="revoke-reason" className="form-field__label--row">
              <span>Justificación</span>
              <span className="form-field__required">Obligatorio</span>
            </Label>
            <Input
              className="form-field__input"
              id="revoke-reason"
              type="text"
              minLength={3}
              maxLength={500}
              placeholder="Ej. Dispositivo extraviado"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              required
              data-testid="revoke-reason"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="revoke-otp-1" className="form-field__label--row">
              <span>Código OTP</span>
              <span className="form-field__required">Obligatorio</span>
            </Label>
            <OtpInput
              id="revoke-otp-1"
              mode="alphanumeric"
              autoFocus={false}
              value={otp}
              onChange={(v) => {
                setOtp(v);
                if (error) setError(null);
              }}
              disabled={loading}
              aria-label="Código OTP"
            />
          </div>
          <DialogFooter className="modal-dialog__actions">
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
              className="app-modal__destructive-action"
              disabled={!canSubmit}
              data-testid="revoke-submit"
            >
              {loading ? 'Revocando…' : 'Revocar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
