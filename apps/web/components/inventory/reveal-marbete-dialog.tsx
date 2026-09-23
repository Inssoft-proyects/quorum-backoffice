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

export interface RevealMarbeteDialogProps {
  marbeteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the (mocked) full code when the user submits the form. */
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
 * NOTE: There is no backend endpoint for the reveal flow yet. This dialog
 * is wired as a UX skeleton — submitting calls `onRevealed` with a derived
 * `ABCDEF-${id}` placeholder, the parent shows a success toast, and the
 * actual API integration will replace this client-side mock. We mark the
 * shape of the request (motivo + comentario) so the future endpoint can be
 * added without changing the UI.
 */
export function RevealMarbeteDialog({
  marbeteId,
  open,
  onOpenChange,
  onRevealed,
}: RevealMarbeteDialogProps) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) {
      setError('Selecciona un motivo antes de continuar.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Backend integration pending — emit a deterministic placeholder so
      // the parent UI can react (toast / row update). The shape of the data
      // matches what the (future) reveal endpoint is expected to accept.
      const placeholder = `CRD-${String(marbeteId).padStart(4, '0')}-${Date.now()}`;
      onRevealed(placeholder);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al revelar.');
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
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="modal-dialog__content" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert">
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
              disabled={!valid || loading}
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
