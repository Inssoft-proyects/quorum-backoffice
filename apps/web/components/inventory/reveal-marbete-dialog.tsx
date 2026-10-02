'use client';

import * as React from 'react';
import { useState } from 'react';
import { Eye } from 'lucide-react';
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
import { ApiError, revealMarbete } from '@/lib/api-client';

export interface RevealMarbeteDialogProps {
  marbeteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the full publicUid once the server confirms the reveal. */
  onRevealed: (fullCode: string) => void;
}

const REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auditoria', label: 'Auditoría interna' },
  { value: 'reclamo', label: 'Reclamo de estudiante' },
  { value: 'verificacion', label: 'Verificación de inventario' },
  { value: 'otro', label: 'Otro' },
];

/**
 * "Revelar marbete" dialog (maquette v2).
 *
 * WU #1 (HANDOFF): Calls POST /api/v1/marbetes/:id/reveal and returns
 * the full publicUid via onRevealed. The original scanned code is
 * never recoverable (only code_hash is stored), so "reveal" simply
 * lifts the mask applied by maskCode(publicUid). The motivation is
 * recorded in audit_log; the response carries the unmasked publicUid.
 *
 * D-4 (per-op OTP by design): reveal is NEVER grant-eligible — even
 * when the session actor holds an active 20-minute grant for the
 * marbete scope, the server requires a fresh OTP for every reveal so
 * the audit trail is unambiguous. The dialog therefore ALWAYS renders
 * the OtpInput in alphanumeric mode (matching the quorum-otp 31-char
 * alphabet) and forwards the 6-char code on the `x-otp-code` header
 * of the destructive call. There is no grant fetch and no grant note.
 */
export function RevealMarbeteDialog({
  marbeteId,
  open,
  onOpenChange,
  onRevealed,
}: RevealMarbeteDialogProps) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonValid = reason.length > 0;
  const otpReady = otp.length === 6;
  const canSubmit = reasonValid && otpReady && !loading;

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reasonValid) {
      setError('Selecciona un motivo antes de continuar.');
      return;
    }
    if (!otpReady) return;
    setLoading(true);
    setError(null);
    try {
      const response = await revealMarbete(
        marbeteId,
        { motivo: reason, comentario: comment.length > 0 ? comment : undefined },
        otp,
      );
      onRevealed(response.code);
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_invalid'
            ? 'Código OTP inválido o expirado.'
            : err.message
          : err instanceof Error
            ? err.message
            : 'No se pudo revelar el marbete.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="reveal-marbete-dialog">
        <DialogHeader>
          <div className="modal-dialog__icon" aria-hidden>
            <Eye />
          </div>
          <DialogTitle className="modal-dialog__title" data-testid="reveal-marbete-title">
            Revelar marbete
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="reveal-marbete-description"
          >
            Selecciona el motivo antes de revelar el número completo del marbete{' '}
            <strong data-testid="reveal-marbete-id">CRD-{String(marbeteId).padStart(4, '0')}</strong>.
            Por política de auditoría se solicita un código OTP fresco para cada revelación,
            incluso si tienes una ventana de OTP vigente para marbetes.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="modal-dialog__content" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="reveal-marbete-error">
              {error}
            </Alert>
          ) : null}
          <div className="form-field">
            <label htmlFor="reveal-reason" className="form-field__label form-field__label--row">
              <span>Motivo</span>
              <span className="form-field__required">Obligatorio</span>
            </label>
            <select
              id="reveal-reason"
              className="form-field__input"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              data-testid="reveal-reason-select"
            >
              <option value="">Selecciona un motivo</option>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="form-field__hint" id="reveal-reason-help">
              El motivo sirve para tener un seguimiento más puntual de cada revelación.
            </p>
          </div>

          <div className="form-field">
            <label htmlFor="reveal-comment" className="form-field__label">
              Comentario <span className="form-field__optional">(opcional)</span>
            </label>
            <Textarea
              id="reveal-comment"
              name="reveal-comment"
              rows={4}
              placeholder="Agrega contexto adicional si aplica."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={loading}
              data-testid="reveal-comment"
            />
          </div>

          <div className="form-field reveal-marbete__otp">
            <span className="form-field__label form-field__label--row">
              <span>Código OTP</span>
              <span className="form-field__required">Obligatorio</span>
            </span>
            <div data-testid="reveal-marbete-otp">
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
            <p className="form-field__hint" id="reveal-otp-help">
              La revelación nunca consume la ventana de OTP vigente; ingresa un código fresco.
            </p>
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
              disabled={!canSubmit}
              data-testid="reveal-marbete-submit"
            >
              {loading ? 'Revelando…' : 'Revelar marbete'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}