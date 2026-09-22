'use client';
import { useState, type FormEvent } from 'react';
import type { DispositivoDetailResponse, UpdateDispositivoRequest } from '@quorum-backoffice/shared';
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
import { ApiError, updateDispositivo } from '@/lib/api-client';

interface Props {
  /** Dispositivo being edited; null closes the dialog. */
  dispositivo: DispositivoDetailResponse | null;
  onClose: () => void;
  onSuccess?: (updated: DispositivoDetailResponse) => void;
}

/**
 * Edit dialog for a dispositivo.
 *
 * Lets the operator change the brand and/or model. The serial number is
 * read-only (it's the device's hardware identifier). Both edits are diffed
 * against the original `dispositivo` prop; if nothing changed the submit
 * is blocked with a "No hay cambios" error instead of making an empty
 * PATCH. OTP is mandatory (sent via x-otp-code).
 *
 * Mirror of marbetes/edit-dialog.tsx, adapted to the dispositivos fields.
 */
export function EditDialog({ dispositivo, onClose, onSuccess }: Props) {
  const open = dispositivo !== null;
  const initialBrand = dispositivo?.brand ?? '';
  const initialModel = dispositivo?.model ?? '';
  const [brand, setBrand] = useState(initialBrand);
  const [model, setModel] = useState(initialModel);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setOtp('');
    setError(null);
    setLoading(false);
  }

  // Re-seed local state when a different dispositivo is opened. The guard
  // (otp empty, no error, not loading) ensures it only fires once per
  // dispositivo.id transition. Inline setState during render is the
  // pattern used by marbetes/edit-dialog.tsx for the same purpose.
  if (
    dispositivo &&
    (brand !== (dispositivo.brand ?? '') || model !== (dispositivo.model ?? '')) &&
    otp === '' &&
    !error &&
    !loading
  ) {
    setBrand(dispositivo.brand ?? '');
    setModel(dispositivo.model ?? '');
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
    if (otp.length !== 6) {
      setError('Ingresa el código OTP de 6 dígitos.');
      return;
    }
    const originalBrand = dispositivo.brand ?? '';
    const originalModel = dispositivo.model ?? '';
    const req: UpdateDispositivoRequest = {};
    if (brand !== originalBrand) req.brand = brand;
    if (model !== originalModel) req.model = model;
    if (Object.keys(req).length === 0) {
      setError('No hay cambios para guardar.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const updated = await updateDispositivo(dispositivo.id, req, otp);
      reset();
      onSuccess?.(updated);
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
                  ? 'Conflicto (dispositivo revocado).'
                  : err.message
          : 'Error de red. Intenta de nuevo.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="edit-dialog">
        <DialogHeader>
          <DialogTitle>Editar dispositivo</DialogTitle>
          <DialogDescription>
            Cambia la marca o el modelo. Requiere código OTP.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="edit-error">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-serial">Serial</Label>
            <Input
              id="edit-serial"
              type="text"
              value={dispositivo?.serialNumber ?? ''}
              disabled
              data-testid="edit-serial"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-brand">Marca</Label>
              <Input
                id="edit-brand"
                type="text"
                maxLength={64}
                value={brand}
                onChange={(e) => {
                  setBrand(e.target.value);
                  if (error) setError(null);
                }}
                disabled={loading}
                data-testid="edit-brand"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-model">Modelo</Label>
              <Input
                id="edit-model"
                type="text"
                maxLength={128}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  if (error) setError(null);
                }}
                disabled={loading}
                data-testid="edit-model"
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
              disabled={loading || otp.length !== 6}
              data-testid="edit-submit"
            >
              {loading ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}