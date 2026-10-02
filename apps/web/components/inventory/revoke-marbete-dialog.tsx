'use client';

import * as React from 'react';
import { useEffect, useState, type FormEvent } from 'react';
import { Ban } from 'lucide-react';
import { ApiError, deleteMarbete } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OtpInput } from '@/components/ui/otp-input';
import { useOtpGrant } from './use-otp-grant';

export interface RevokeMarbeteDialogProps {
  marbeteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the marbete is deleted; the parent should re-fetch. */
  onRevoked: () => void;
}

const REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'danado', label: 'Marbete dañado' },
  { value: 'extraviado', label: 'Marbete extraviado' },
  { value: 'baja-estudiante', label: 'Estudiante dado de baja' },
  { value: 'reemplazo', label: 'Reemplazo programado' },
  { value: 'otro', label: 'Otro' },
];

/**
 * "Dar de baja marbete" dialog (maquette v2) — replaces the previous
 * delete-dialog. Reuses the same `deleteMarbete` API contract (still
 * gated by OTP) but with the redesign's motivo / comment shape and
 * maquette styling.
 *
 * WU #5 (v3 destroy grant): the dialog consumes `useOtpGrant` and,
 * while the session actor has an active 20-minute window for the
 * marbete scope family, the request is submitted without the
 * `x-otp-code` header and a green "OTP vigente hasta HH:MM" note is
 * rendered. When the grant is missing the dialog renders the OTP
 * input (mode alphanumeric — same alphabet as the quorum-otp service)
 * and submits with the captured 6-char code on `x-otp-code`.
 *
 * D-3-class fix (mirrors AddMarbeteDialog): previously the dialog
 * submitted `x-otp-code: ''` when no grant was active, which always
 * failed server-side with `otp_required` as soon as AUTH_OTP_REQUIRED
 * was on. Now the dialog collects a 6-char OTP before submit.
 */
export function RevokeMarbeteDialog({
  marbeteId,
  open,
  onOpenChange,
  onRevoked,
}: RevokeMarbeteDialogProps) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grant = useOtpGrant();

  // The API requires >= 3 chars in `reason`; we reject entirely empty
  // values at the dialog level so the maquette's "Motivo obligatorio"
  // expectation maps to a single selectable reason (maquette behavior).
  const reasonReady = reason.length > 0;
  const grantActive = grant.status?.active === true;
  // OTP is required only when no grant is active.
  const otpReady = grantActive || otp.length === 6;
  const canSubmit = reasonReady && otpReady && !loading;

  // Refresh grant status whenever the dialog is opened. See the matching
  // hook in add-marbete-dialog.tsx for the rationale.
  useEffect(() => {
    if (open) {
      void grant.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setReason('');
    setComment('');
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
    if (!reasonReady) {
      setError('Selecciona un motivo para dar de baja el marbete.');
      return;
    }
    if (!otpReady) return;
    setLoading(true);
    setError(null);
    try {
      // Append the user's comment to the official deletion reason so the
      // backend (which only persists `reason`) keeps the audit trail.
      const composed = comment.trim()
        ? `${REASONS.find((r) => r.value === reason)?.label ?? reason}: ${comment.trim()}`
        : REASONS.find((r) => r.value === reason)?.label ?? reason;
      // Submit without the x-otp-code header when a grant is active;
      // otherwise forward the captured 6-char OTP (modes alphanumeric).
      const otpCode: string | undefined = grantActive ? undefined : otp;
      await deleteMarbete(marbeteId, { reason: composed }, otpCode);
      reset();
      // Refresh grant status before unmount so the next dialog open
      // reads a fresh value (the destructive op may have minted a
      // grant). The dialog closes immediately so the refresh happens
      // in the background.
      void grant.refresh();
      onRevoked();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_required'
            ? 'Esta acción requiere un código OTP. Configura el módulo OTP en el entorno.'
            : err.code === 'otp_invalid'
              ? 'Código OTP inválido o expirado.'
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

  const expiresAt = grant.status?.expiresAt ?? null;
  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="revoke-marbete-dialog">
        <DialogHeader>
          <div className="modal-dialog__icon modal-dialog__icon--danger" aria-hidden>
            <Ban />
          </div>
          <DialogTitle className="modal-dialog__title" data-testid="revoke-marbete-title">
            Dar de baja marbete
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="revoke-marbete-description"
          >
            Selecciona el motivo para quitar de circulación el marbete{' '}
            <strong data-testid="revoke-marbete-id">CRD-{String(marbeteId).padStart(4, '0')}</strong>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="modal-dialog__content" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="revoke-marbete-error">
              {error}
            </Alert>
          ) : null}
          <div className="form-field">
            <label htmlFor="deactivate-reason" className="form-field__label form-field__label--row">
              <span>Motivo</span>
              <span className="form-field__required">Obligatorio</span>
            </label>
            <select
              id="deactivate-reason"
              className="form-field__input"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              data-testid="deactivate-reason-select"
            >
              <option value="">Selecciona un motivo</option>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="form-field__hint" id="deactivate-reason-help">
              El motivo permite documentar por qué el marbete deja de estar en circulación.
            </p>
          </div>

          <div className="form-field">
            <label htmlFor="deactivate-comment" className="form-field__label">
              Comentario <span className="form-field__optional">(opcional)</span>
            </label>
            <Textarea
              id="deactivate-comment"
              name="deactivate-comment"
              rows={4}
              placeholder="Agrega contexto adicional si aplica."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={loading}
              data-testid="deactivate-comment"
            />
          </div>

          {grantActive && expiresLabel ? (
            <Alert
              variant="success"
              role="status"
              data-testid="revoke-marbete-grant-note"
            >
              OTP vigente hasta {expiresLabel}. No necesitas capturar un código nuevo.
            </Alert>
          ) : (
            <div className="form-field revoke-marbete__otp">
              <span className="form-field__label form-field__label--row">
                <span>Código OTP</span>
                <span className="form-field__required">Obligatorio</span>
              </span>
              <div data-testid="revoke-marbete-otp">
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
              data-testid="revoke-marbete-submit"
            >
              {loading ? 'Procesando…' : 'Dar de baja'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}