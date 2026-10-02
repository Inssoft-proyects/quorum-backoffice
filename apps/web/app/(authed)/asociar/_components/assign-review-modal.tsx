'use client';

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { OtpInput } from '@/components/ui/otp-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOtpGrant } from '@/components/inventory/use-otp-grant';

export interface AssignReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The matrículas to assign, in display order. The modal builds its
   * review Map from `canvasUserId` so the same data drives the
   * confirmation payload.
   */
  enrollments: ReadonlyArray<{
    canvasUserId: number;
    fullName: string;
    marbeteId: number | null;
  }>;
  /** Available marbetes to assign (id + maskedCode). */
  available: ReadonlyArray<{ id: number; maskedCode: string }>;
  /** Total available marbetes on the server (counter), for the summary copy. */
  availableMarbetesTotal: number;
  /**
   * Called with the finalised pairs and the resolved OTP code. The
   * resolved code is `undefined` when the grant is active (parent
   * should submit without the x-otp-code header) and the 6-digit
   * string otherwise.
   */
  onConfirm: (
    pairs: { canvasUserId: number; marbeteId: number }[],
    otpCode: string | undefined,
  ) => void | Promise<void>;
}

/**
 * Bulk / single assign review modal ("Confirmar asignación de marbetes").
 *
 * Per canon (asignacion-marbetes.html): lists the selected matrículas
 * in a scrollable review with a per-row marbete select. Selecting a
 * marbete that is already proposed for ANOTHER row swaps the two
 * (so the operator can fix conflicts inline). The summary bar validates
 * that every row has a distinct proposed marbete; only then is the
 * confirm button enabled.
 *
 * OTP grant: when the session actor has an unexpired 20-minute grant
 * for the marbete scope, the input is hidden + a "OTP vigente hasta
 * HH:MM" note is shown and the parent submits without the
 * `x-otp-code` header. Otherwise the operator enters a 6-digit code
 * that the parent passes to `assignMatriculas`.
 */
export function AssignReviewModal({
  open,
  onOpenChange,
  enrollments,
  available,
  availableMarbetesTotal,
  onConfirm,
}: AssignReviewModalProps): React.ReactElement {
  const [review, setReview] = useState<Map<number, number | null>>(
    () => new Map(enrollments.map((e) => [e.canvasUserId, e.marbeteId])),
  );
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grant = useOtpGrant();

  // Reset the per-row proposals every time the modal opens with a new
  // set of enrolments. The page rebuilds the `enrollments` prop whenever
  // the selection changes; the modal treats it as the canonical
  // starting state for the current batch.
  useEffect(() => {
    if (open) {
      setReview(new Map(enrollments.map((e) => [e.canvasUserId, e.marbeteId])));
      setOtp('');
      setError(null);
      setSubmitting(false);
      void grant.refresh();
    }
    // grant.refresh is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, enrollments]);

  const grantActive = grant.status?.active === true;

  // Map marbeteId → maskedCode for the picker labels.
  const labelById = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of available) map.set(m.id, m.maskedCode);
    return map;
  }, [available]);

  // Conflict detection: every proposed marbete must appear at most
  // once across all rows AND every row must have a proposal.
  const validity = useMemo(() => {
    const allAssigned = Array.from(review.values()).every(
      (v) => typeof v === 'number',
    );
    if (!allAssigned) {
      return { valid: false };
    }
    const values = Array.from(review.values()).filter(
      (v): v is number => typeof v === 'number',
    );
    const distinct = new Set(values);
    if (distinct.size !== values.length) {
      return { valid: false };
    }
    return { valid: true };
  }, [review]);

  /**
   * Apply a per-row selection. If the chosen marbeteId is already
   * proposed for another row, swap the two (the canon's selectReviewOption
   * semantics). Otherwise just set it on the current row.
   */
  function selectMarbete(canvasUserId: number, nextMarbeteId: number): void {
    setReview((prev) => {
      const next = new Map(prev);
      let conflicting: number | null = null;
      for (const [otherCanvasId, otherMarbeteId] of prev.entries()) {
        if (
          otherCanvasId !== canvasUserId &&
          otherMarbeteId === nextMarbeteId
        ) {
          conflicting = otherCanvasId;
          break;
        }
      }
      const previous = prev.get(canvasUserId) ?? null;
      next.set(canvasUserId, nextMarbeteId);
      if (conflicting !== null) {
        next.set(conflicting, previous);
      }
      return next;
    });
  }

  const reviewCount = review.size;
  const canSubmit = validity.valid && !submitting && (grantActive || otp.length === 6);

  const expiresLabel = useMemo(() => {
    const exp = grant.status?.expiresAt;
    if (!exp) return null;
    return new Date(exp).toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [grant.status?.expiresAt]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!validity.valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const resolvedCode: string | undefined = grantActive ? undefined : otp;
      const pairs = Array.from(review.entries())
        .filter((pair): pair is [number, number] => typeof pair[1] === 'number')
        .map(([canvasUserId, marbeteId]) => ({ canvasUserId, marbeteId }));
      await onConfirm(pairs, resolvedCode);
      // Parent owns the close; only close here if the parent hasn't
      // already done so (the parent's promise might reject and keep
      // the modal open with an error visible).
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo asignar el marbete.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="assignment-modal"
        data-testid="assign-review-modal"
      >
        <DialogHeader>
          <div className="modal-dialog__icon" aria-hidden>
            <CheckCircle2 />
          </div>
          <DialogTitle
            className="modal-dialog__title"
            data-testid="assign-review-title"
          >
            {enrollments.length === 1
              ? 'Confirmar asignación de marbete'
              : 'Confirmar asignación automática de marbetes'}
          </DialogTitle>
          <DialogDescription
            className="modal-dialog__description"
            id="assign-review-description"
          >
            {enrollments.length === 1
              ? 'Revisa el marbete seleccionado antes de confirmarlo. La matrícula se actualizará únicamente después de aceptar esta operación.'
              : 'Revisa la asignación propuesta antes de confirmarla. Los marbetes se asignarán únicamente después de aceptar esta operación.'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="modal-dialog__content"
          noValidate
          data-testid="assign-review-form"
        >
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="assign-review-error">
              {error}
            </Alert>
          ) : null}

          <div className="assignment-review" data-testid="assign-review-list">
            <div className="assignment-review__header" aria-hidden>
              <span>Matrícula</span>
              <span>Marbete propuesto</span>
            </div>
            {Array.from(review.entries()).map(([canvasUserId, marbeteId]) => {
              const enrollment = enrollments.find(
                (e) => e.canvasUserId === canvasUserId,
              );
              const fullName = enrollment?.fullName ?? `Matrícula ${canvasUserId}`;
              const label =
                typeof marbeteId === 'number'
                  ? (labelById.get(marbeteId) ?? 'Sin disponibilidad')
                  : 'Selecciona un marbete';
              const controlId = `review-marbete-${canvasUserId}`;
              return (
                <div
                  key={canvasUserId}
                  className="assignment-review__row"
                  data-testid={`assign-review-row-${canvasUserId}`}
                >
                  <span
                    className="assignment-review__enrollment"
                    data-testid={`assign-review-enrollment-${canvasUserId}`}
                  >
                    {fullName}
                  </span>
                  <div className="assignment-review__tag">
                    <label
                      htmlFor={controlId}
                      className="sr-only"
                    >{`Marbete propuesto para ${fullName}`}</label>
                    <select
                      id={controlId}
                      className="assignment-review__select"
                      data-testid={`assign-review-select-${canvasUserId}`}
                      value={marbeteId === null ? '' : String(marbeteId)}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        if (!Number.isNaN(next) && next > 0) {
                          selectMarbete(canvasUserId, next);
                        }
                      }}
                      disabled={submitting}
                      aria-label={`Marbete propuesto para ${fullName}`}
                    >
                      <option value="" disabled>
                        Selecciona un marbete
                      </option>
                      {available.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.maskedCode}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            className="assignment-modal-summary"
            role="status"
            data-testid="assign-review-summary"
          >
            <strong data-testid="assign-review-count">
              {reviewCount === 1
                ? '1 matrícula seleccionada'
                : `${reviewCount} matrículas seleccionadas`}
            </strong>
            <span data-testid="assign-review-availability">
              {availableMarbetesTotal} marbetes disponibles para esta asignación
            </span>
            <span
              className={
                'assignment-validation' + (validity.valid ? '' : ' is-invalid')
              }
              data-testid="assign-review-validation"
            >
              {validity.valid ? 'Propuesta válida' : 'Revisa los marbetes seleccionados'}
            </span>
          </div>

          {grantActive && expiresLabel ? (
            <p
              role="status"
              className="bulk-upload__grant-note"
              data-testid="assign-review-grant-note"
            >
              OTP vigente hasta {expiresLabel}. No necesitas capturar un código nuevo.
            </p>
          ) : (
            <div className="form-field">
              <span className="form-field__label form-field__label--row">
                <span>Código OTP</span>
                <span className="form-field__required">Obligatorio</span>
              </span>
              <div data-testid="assign-review-otp">
                <OtpInput
                  mode="alphanumeric"
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
              data-testid="assign-review-cancel"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={!canSubmit}
              data-testid="assign-review-confirm"
            >
              {submitting ? 'Asignando…' : 'Aceptar asignación'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}