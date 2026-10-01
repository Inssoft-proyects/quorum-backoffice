'use client';

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { OtpInput } from '@/components/ui/otp-input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOtpGrant } from '@/components/inventory/use-otp-grant';

export interface UnassignModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The matricula + marbete context being unassigned. `null` when closed. */
  context: {
    canvasUserId: number;
    fullName: string;
    marbeteId: number;
    marbeteMaskedCode: string;
    assignedAt: string | null;
    assignedBy: string | null;
  } | null;
  /**
   * Called with the resolved payload once the operator confirms.
   * `otpCode` is `undefined` when the grant is active.
   */
  onConfirm: (
    payload: { marbeteId: number; reason: string; comentario?: string },
    otpCode: string | undefined,
  ) => void | Promise<void>;
}

const REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'extravio', label: 'Extravío reportado' },
  { value: 'dano-fisico', label: 'Daño físico' },
  { value: 'reposicion', label: 'Reposición emitida' },
  { value: 'baja-administrativa', label: 'Baja administrativa' },
  { value: 'duplicada', label: 'Marbete duplicado' },
];

/**
 * Unassign modal ("Desasignar marbete").
 *
 * Per canon (asignacion-marbetes.html): danger icon + 3-up context
 * (Matrícula / Marbete / Fecha de asignación) + required Motivo
 * custom-select + optional Comentario textarea. Confirm is disabled
 * until a reason is chosen; the inline error only appears on submit
 * attempt without a reason. OTP grant-aware: hides the OTP input when
 * the session actor has an active 20-minute window.
 */
export function UnassignModal({
  open,
  onOpenChange,
  context,
  onConfirm,
}: UnassignModalProps): React.ReactElement {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasonError, setShowReasonError] = useState(false);
  const grant = useOtpGrant();

  useEffect(() => {
    if (open) {
      setReason('');
      setComment('');
      setOtp('');
      setError(null);
      setSubmitting(false);
      setShowReasonError(false);
      void grant.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grantActive = grant.status?.active === true;

  const expiresLabel = useMemo(() => {
    const exp = grant.status?.expiresAt;
    if (!exp) return null;
    return new Date(exp).toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [grant.status?.expiresAt]);

  const valid = reason.length > 0;
  const canSubmit = valid && !submitting && (grantActive || otp.length === 6);

  const assignedAtLabel = useMemo(() => {
    if (!context?.assignedAt) return '—';
    try {
      return new Date(context.assignedAt).toLocaleDateString('es-MX', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    } catch {
      return '—';
    }
  }, [context?.assignedAt]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!context) return;
    if (!valid) {
      setShowReasonError(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resolvedCode: string | undefined = grantActive ? undefined : otp;
      const reasonLabel =
        REASONS.find((r) => r.value === reason)?.label ?? reason;
      await onConfirm(
        {
          marbeteId: context.marbeteId,
          reason: reasonLabel,
          comentario: comment.length > 0 ? comment : undefined,
        },
        resolvedCode,
      );
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo desasignar el marbete.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="assignment-modal assignment-modal--narrow"
        data-testid="unassign-modal"
      >
        <DialogHeader>
          <div className="modal-dialog__icon modal-dialog__icon--danger" aria-hidden>
            <AlertTriangle />
          </div>
          <DialogTitle
            className="modal-dialog__title"
            data-testid="unassign-title"
          >
            Desasignar marbete
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="unassign-description"
          >
            El marbete volverá a estar disponible para una asignación posterior.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="modal-dialog__content"
          noValidate
          data-testid="unassign-form"
        >
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="unassign-error">
              {error}
            </Alert>
          ) : null}

          <dl className="assignment-context" data-testid="unassign-context">
            <div>
              <dt>Matrícula</dt>
              <dd data-testid="unassign-enrollment">
                {context?.fullName ?? '—'}
              </dd>
            </div>
            <div>
              <dt>Marbete</dt>
              <dd data-testid="unassign-marbete">
                {context?.marbeteMaskedCode ?? '—'}
              </dd>
            </div>
            <div>
              <dt>Fecha de asignación</dt>
              <dd data-testid="unassign-date">{assignedAtLabel}</dd>
            </div>
          </dl>

          <div className="form-field">
            <label
              htmlFor="unassign-reason"
              className="form-field__label form-field__label--row"
            >
              <span>Motivo</span>
              <span className="form-field__required">Obligatorio</span>
            </label>
            <select
              id="unassign-reason"
              className="form-field__input"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (showReasonError) setShowReasonError(false);
                if (error) setError(null);
              }}
              disabled={submitting}
              data-testid="unassign-reason-select"
            >
              <option value="">Selecciona un motivo</option>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="form-field__hint" id="unassign-reason-help">
              El motivo permite documentar por qué el marbete deja de estar en circulación.
            </p>
            <span
              className="assignment-field-error"
              role="alert"
              data-testid="unassign-reason-error"
              hidden={!showReasonError}
            >
              Selecciona un motivo para continuar.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="unassign-comment" className="form-field__label">
              Comentario <span className="form-field__optional">(opcional)</span>
            </label>
            <Textarea
              id="unassign-comment"
              name="unassign-comment"
              rows={4}
              placeholder="Agrega contexto adicional si aplica."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={submitting}
              data-testid="unassign-comment"
            />
          </div>

          {grantActive && expiresLabel ? (
            <p
              role="status"
              className="bulk-upload__grant-note"
              data-testid="unassign-grant-note"
            >
              OTP vigente hasta {expiresLabel}. No necesitas capturar un código nuevo.
            </p>
          ) : (
            <div className="form-field">
              <span className="form-field__label form-field__label--row">
                <span>Código OTP</span>
                <span className="form-field__required">Obligatorio</span>
              </span>
              <div data-testid="unassign-otp">
                <OtpInput
                  value={otp}
                  onChange={(v) => {
                    setOtp(v);
                    if (error) setError(null);
                  }}
                  disabled={submitting}
                  aria-label="Código OTP"
                />
              </div>
            </div>
          )}

          <DialogFooter className="modal-dialog__actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="unassign-cancel"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="outline"
              className="btn--danger-quiet"
              disabled={!canSubmit}
              data-testid="unassign-confirm"
            >
              {submitting ? 'Desasignando…' : 'Desasignar marbete'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}