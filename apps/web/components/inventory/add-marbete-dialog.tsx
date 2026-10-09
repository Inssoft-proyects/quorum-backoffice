'use client';

import * as React from 'react';
import { useEffect, useState, type FormEvent } from 'react';
import { PlusCircle } from 'lucide-react';
import { ApiError, createMarbete } from '@/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';
import { useOtpGrant } from './use-otp-grant';

export interface AddMarbeteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the marbete is persisted; the parent should re-fetch. */
  onSaved: () => void;
}

/**
 * "Agregar marbete" dialog (maquette v2).
 *
 * WU #5 (v3 destroy grant): the dialog consumes `useOtpGrant` and,
 * while the session actor has an active 20-minute window for the
 * marbete scope family, the OTP input is replaced by an
 * "OTP vigente hasta HH:MM" note and the request is submitted without
 * the `x-otp-code` header. When the grant is missing the dialog
 * renders the OTP input (mode alphanumeric — same alphabet as the
 * quorum-otp service) and submits with the captured 6-char code on
 * `x-otp-code`.
 *
 * Validation mirror: matches CreateMarbeteRequest (code 8-128 chars, all
 * digits per the maquette's input pattern). Submit is disabled while the
 * input fails the rule OR the OTP requirement (when no grant is active).
 */
export function AddMarbeteDialog({ open, onOpenChange, onSaved }: AddMarbeteDialogProps) {
  const [code, setCode] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grant = useOtpGrant();

  const codeValid = /^\d{8,128}$/.test(code);
  const grantActive = grant.status?.active === true;
  // OTP is required only when no grant is active. The grant-aware
  // hidden input contract matches the bulk-upload / assign-review /
  // unassign modals so the dialogs share one OTP surface.
  const otpReady = grantActive || otp.length === 6;
  const canSubmit = codeValid && otpReady && !loading;

  // Refresh grant status whenever the dialog is opened. The hook also
  // fires on mount, but a parent that toggles `open` rapidly without
  // unmounting would otherwise read the stale status from the last
  // successful op.
  useEffect(() => {
    if (open) {
      void grant.refresh();
    }
    // grant.refresh is stable per the hook contract; depending on it
    // would re-run the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setCode('');
    setOtp('');
    setError(null);
    setLoading(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!codeValid) {
      setError('Ingresa un número de marbete válido (8-128 dígitos).');
      return;
    }
    if (!otpReady) return;
    setLoading(true);
    setError(null);
    try {
      // Submit without the x-otp-code header when a grant is active;
      // otherwise pass the captured 6-char OTP code (modes alphanumeric).
      const otpCode: string | undefined = grantActive ? undefined : otp;
      await createMarbete({ code }, otpCode);
      reset();
      // Refresh grant status before unmount so the next dialog open
      // reads a fresh value (the destructive op may have minted a
      // grant). The dialog closes immediately so the refresh happens
      // in the background.
      void grant.refresh();
      onSaved();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_required'
            ? 'Esta acción requiere un código OTP. Configura el módulo OTP en el entorno.'
            : err.code === 'otp_invalid'
              ? 'Código OTP inválido o expirado.'
              : err.code === 'validation_error'
                ? 'Datos inválidos.'
                : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const expiresAt = grant.status?.expiresAt ?? null;
  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="add-marbete-dialog">
        <DialogHeader>
          <div className="modal-dialog__icon" aria-hidden>
            <PlusCircle />
          </div>
          <DialogTitle className="modal-dialog__title" data-testid="add-marbete-title">
            Agregar marbete
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="add-marbete-description"
          >
            Registra un marbete físico en el inventario.{' '}
            <b>El sistema calculará la vigencia y lo asignará en el estado Disponible</b>{' '}
            automáticamente.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="modal-dialog__content" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="add-marbete-error">
              {error}
            </Alert>
          ) : null}
          <div className="form-field">
            <label htmlFor="credential-number" className="form-field__label">
              Número de marbete
            </label>
            <Input
              id="credential-number"
              name="credential-number"
              type="text"
              autoComplete="off"
              aria-describedby="credential-number-help"
              placeholder="VALIDO-2609982468"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.trim());
                if (error) setError(null);
              }}
              disabled={loading}
              className="form-field__input"
              data-testid="credential-number-input"
            />
            <p className="form-field__hint" id="credential-number-help">
              Código alfanumérico del marbete. Se enmascarará una vez registrado por seguridad.
            </p>
          </div>

          {grantActive && expiresLabel ? (
            <Alert
              variant="success"
              role="status"
              data-testid="add-marbete-grant-note"
            >
              OTP vigente hasta {expiresLabel}. No necesitas capturar un código nuevo.
            </Alert>
          ) : (
            <div className="form-field add-marbete__otp">
              <span className="form-field__label form-field__label--row">
                <span>Código OTP</span>
                <span className="form-field__required">Obligatorio</span>
              </span>
              <div data-testid="add-marbete-otp">
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
            </div>
          )}

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
              variant="default"
              disabled={!canSubmit}
              data-testid="add-marbete-submit"
            >
              {loading ? 'Guardando…' : 'Guardar en inventario'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}