'use client';

import * as React from 'react';
import { useState, type FormEvent } from 'react';
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
 */
export function RevokeMarbeteDialog({
  marbeteId,
  open,
  onOpenChange,
  onRevoked,
}: RevokeMarbeteDialogProps) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The API requires >= 3 chars in `reason`; we reject entirely empty
  // values at the dialog level so the maquette's "Motivo obligatorio"
  // expectation maps to a single selectable reason (maquette behavior).
  const valid = reason.length > 0;

  function reset() {
    setReason('');
    setComment('');
    setError(null);
    setLoading(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) {
      setError('Selecciona un motivo para dar de baja el marbete.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Append the user's comment to the official deletion reason so the
      // backend (which only persists `reason`) keeps the audit trail.
      const composed = comment.trim()
        ? `${REASONS.find((r) => r.value === reason)?.label ?? reason}: ${comment.trim()}`
        : REASONS.find((r) => r.value === reason)?.label ?? reason;
      await deleteMarbete(marbeteId, { reason: composed }, '');
      reset();
      onRevoked();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_required'
            ? 'Esta acción requiere un código OTP. Configura el módulo OTP en el entorno.'
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
              disabled={!valid || loading}
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
