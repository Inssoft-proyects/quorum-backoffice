'use client';
import { useState, type FormEvent } from 'react';
import type { CreateMarbeteRequest, MarbeteDetailResponse } from '@quorum-backoffice/shared';
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
import { StudentLookup } from './student-lookup';
import { ApiError, createMarbete } from '@/lib/api-client';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (created: MarbeteDetailResponse) => void;
}

/**
 * Create dialog for a marbete.
 *
 * Requires:
 *   - a code (8-128 chars, DTO-enforced), and
 *   - a 6-digit OTP code (sent via x-otp-code header).
 *
 * Optional: a Canvas student identifier, resolved inline via
 * `<StudentLookup />` before submit. The server is the final authority and
 * returns 422 student_not_found / student_not_active when the assignment
 * is invalid; we map those to friendly Spanish strings.
 */
export function CreateDialog({ open, onClose, onSuccess }: Props) {
  const [code, setCode] = useState('');
  const [canvasUserId, setCanvasUserId] = useState<number | null | ''>('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setCode('');
    setCanvasUserId('');
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
    if (code.length < 8) {
      setError('El código debe tener al menos 8 caracteres.');
      return;
    }
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 dígitos.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const req: CreateMarbeteRequest = { code };
      if (typeof canvasUserId === 'number') req.canvasUserId = canvasUserId;
      const created = await createMarbete(req, otp);
      reset();
      onSuccess?.(created);
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'otp_invalid'
            ? 'Código OTP inválido o expirado.'
            : err.code === 'otp_required'
              ? 'Código OTP requerido.'
              : err.code === 'student_not_found'
                ? 'La matrícula no existe en cache.'
                : err.code === 'student_not_active'
                  ? 'La matrícula está inactiva en Canvas.'
                  : err.code === 'validation_error'
                    ? 'Datos inválidos.'
                    : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="create-dialog">
        <DialogHeader>
          <DialogTitle>Crear marbete</DialogTitle>
          <DialogDescription>
            Asigna un nuevo marbete con su código QR. La asignación a un
            estudiante es opcional.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="create-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-code">Código</Label>
            <Input
              id="create-code"
              type="text"
              minLength={8}
              maxLength={128}
              placeholder="WITH-CODE-1234"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              required
              data-testid="create-code"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Matrícula Canvas (opcional)</Label>
            <StudentLookup
              value={canvasUserId}
              onChange={setCanvasUserId}
              disabled={loading}
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
              disabled={loading || code.length < 8 || otp.length !== 6}
              data-testid="create-submit"
            >
              {loading ? 'Creando…' : 'Crear'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}