'use client';
import { useState, type FormEvent } from 'react';
import type { CreateDispositivoRequest, DispositivoDetailResponse } from '@quorum-backoffice/shared';
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
import { ApiError, createDispositivo } from '@/lib/api-client';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (created: DispositivoDetailResponse) => void;
}

/**
 * Create dialog for a dispositivo.
 *
 * Requires:
 *   - a serial number (>= 3 chars, <= 128, DTO-enforced), and
 *   - a 6-digit OTP code (sent via x-otp-code header).
 *
 * Optional: brand and model (max 64 / 128 chars respectively).
 *
 * Mirror of marbetes/create-dialog.tsx, minus the student lookup (the
 * dispositivos entity is not assigned to students).
 */
export function CreateDialog({ open, onClose, onSuccess }: Props) {
  const [serial, setSerial] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setSerial('');
    setBrand('');
    setModel('');
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
    if (serial.length < 3) {
      setError('El serial debe tener al menos 3 caracteres.');
      return;
    }
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 dígitos.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const req: CreateDispositivoRequest = { serialNumber: serial };
      if (brand) req.brand = brand;
      if (model) req.model = model;
      const created = await createDispositivo(req, otp);
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
              : err.code === 'conflict'
                ? 'Ya existe un dispositivo con ese serial.'
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
          <DialogTitle>Registrar dispositivo</DialogTitle>
          <DialogDescription>
            Asocia un nuevo dispositivo autorizado. Requiere código OTP.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="create-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-serial">Serial</Label>
            <Input
              id="create-serial"
              type="text"
              minLength={3}
              maxLength={128}
              placeholder="SN-XXXX-1234"
              value={serial}
              onChange={(e) => {
                setSerial(e.target.value);
                if (error) setError(null);
              }}
              disabled={loading}
              required
              data-testid="create-serial"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-brand">Marca (opcional)</Label>
              <Input
                id="create-brand"
                type="text"
                maxLength={64}
                placeholder="Apple"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                disabled={loading}
                data-testid="create-brand"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-model">Modelo (opcional)</Label>
              <Input
                id="create-model"
                type="text"
                maxLength={128}
                placeholder="iPad Pro"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
                data-testid="create-model"
              />
            </div>
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
              disabled={loading || serial.length < 3 || otp.length !== 6}
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