'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { ApiError, mfaAuthenticate } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';

/**
 * M2 — MFA web form (client component).
 *
 * Three-factor authentication matching the M1 endpoint at
 * `POST /api/v1/mfa/authenticate` (apps/api/src/routes/mfa.ts).
 * The form mirrors the lookfeel intent of `/login` (single-step
 * username + OTP) but with three labelled inputs:
 *
 *   1. **Marbete code** — the physical security token code
 *      (uppercase, monospace; 8..128 chars per the M1 DTO).
 *   2. **Device serial** — the device's printed identifier
 *      (uppercase; 3..128 chars per the M1 DTO).
 *   3. **Dynamic OTP** — the 6-character uppercase alphanumeric
 *      code issued out of band by the operator. Uses the shared
 *      `OtpInput` in `mode="alphanumeric"`.
 *
 * The form is intentionally context-free: it does NOT extend
 * `useAuth` (which carries the operator session). The MFA session
 * is set by the backend cookie; the client just navigates.
 *
 * After a successful POST (201) the form swaps to a "Acceso
 * concedido" card with a "Continuar" button. The button calls
 * `router.push(next)` for same-origin paths (so Next.js honours
 * the `basePath: '/backoffice'` config) and falls back to
 * `window.location.href` for absolute URLs (the Canvas redirect
 * in the federated flow is cross-origin). Missing `next` defaults
 * to `/dashboard`.
 *
 * Error mapping mirrors the deny.* taxonomy
 * (`packages/shared/src/dto/access-decision.ts`) the M1 endpoint
 * emits:
 *   - `deny.marbete_unknown`               — "Marbete no encontrado o inactivo."
 *   - `deny.student_inactive`              — "Estudiante inactivo o sin marbete asignado."
 *   - `deny.device_unknown`                — "Dispositivo no encontrado, revocado o asignado a otro estudiante."
 *   - `deny.device_not_bound_to_student`   — "El dispositivo no está asignado a este estudiante."
 *   - `deny.otp_invalid` / `deny.otp_missing` — "Código dinámico incorrecto o expirado."
 *   - `deny.dependency_fail` (503)         — "Servicio de verificación no disponible. Intenta más tarde."
 *   - `validation_error` (400)             — first Zod issue message (English from the
 *                                           server, surfaced verbatim; matches the
 *                                           operator-friendly tone of `apps/web/lib/auth-context.tsx`).
 */
const MFA_DEFAULT_NEXT = '/dashboard';

function explainMfaError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return 'No se pudo validar el acceso. Intenta de nuevo.';
  }
  switch (err.code) {
    case 'deny.marbete_unknown':
      return 'Marbete no encontrado o inactivo.';
    case 'deny.student_inactive':
      return 'Estudiante inactivo o sin marbete asignado.';
    case 'deny.device_unknown':
      return 'Dispositivo no encontrado, revocado o asignado a otro estudiante.';
    case 'deny.device_not_bound_to_student':
      return 'El dispositivo no está asignado a este estudiante.';
    case 'deny.otp_invalid':
    case 'deny.otp_missing':
      return 'Código dinámico incorrecto o expirado.';
    case 'deny.dependency_fail':
      return 'Servicio de verificación no disponible. Intenta más tarde.';
    case 'validation_error': {
      const details = err.details as { issues?: Array<{ message?: string }> } | undefined;
      const firstIssue = details?.issues?.[0]?.message;
      return firstIssue ?? err.message ?? 'Datos inválidos. Verifica el formulario.';
    }
    default:
      return err.message || 'Error desconocido. Intenta de nuevo.';
  }
}

/**
 * Navigate to `next`. Same-origin paths use Next.js `router.push`
 * so the configured `basePath` is honoured automatically; absolute
 * URLs (the Canvas/Jitsi SSO redirect) use `window.location.href`
 * because the Next.js router cannot leave the app.
 *
 * The two paths are exposed separately so the unit test can stub
 * `router.push` and assert navigation side effects without a
 * browser navigation actually happening.
 */
function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveNext(next: string | undefined): string {
  if (!next || next.length === 0) return MFA_DEFAULT_NEXT;
  return next;
}

interface MfaFormProps {
  /**
   * Optional URL the user was trying to reach before being sent to
   * `/mfa`. When omitted (or empty) it defaults to `/dashboard`.
   */
  next?: string;
}

export function MfaForm({ next }: MfaFormProps) {
  const router = useRouter();
  const [marbeteCode, setMarbeteCode] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // The OtpInput already uppercases + alphabetises; keep a defensive
  // re-normalisation so a future refactor cannot regress the wire
  // contract (the M1 endpoint verifies uppercase A–Z0–9 only).
  const otpUpper = otp
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  // The marbete code and serial number have NO character restrictions
  // in the M1 DTO (only length 8..128 and 3..128). We force uppercase
  // for readability (and so a student typing it on a phone keypad
  // does not silently fail) but we do NOT strip characters the DTO
  // would otherwise accept.
  const marbeteUpper = marbeteCode.toUpperCase();
  const serialUpper = serialNumber.toUpperCase();
  // Wire bounds mirror the M1 DTO (packages/shared/src/dto/mfa.ts).
  const marbeteReady = marbeteUpper.length >= 8 && marbeteUpper.length <= 128;
  const serialReady = serialUpper.length >= 3 && serialUpper.length <= 128;
  const otpReady = otpUpper.length === 6;
  const ready = marbeteReady && serialReady && otpReady;
  const loading = status === 'submitting';

  const targetNext = resolveNext(next);

  function clearError() {
    if (error !== null) setError(null);
  }

  function navigateNext(target: string): void {
    if (isAbsoluteUrl(target)) {
      window.location.href = target;
      return;
    }
    router.push(target);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || loading) return;
    setStatus('submitting');
    setError(null);
    try {
      await mfaAuthenticate({
        marbete_code: marbeteUpper,
        serial_number: serialUpper,
        otp: otpUpper,
      });
      setStatus('success');
      navigateNext(targetNext);
    } catch (err) {
      setError(explainMfaError(err));
      setStatus('error');
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-5" data-testid="mfa-form">
      {status === 'success' ? (
        <div className="flex flex-col items-center gap-4" data-testid="mfa-success">
          <Alert variant="success" role="status">
            <span className="text-sm font-medium">Acceso concedido</span>
          </Alert>
          <Button
            type="button"
            className="w-full font-semibold"
            size="lg"
            onClick={() => navigateNext(targetNext)}
            data-testid="mfa-continue"
          >
            Continuar
          </Button>
        </div>
      ) : (
        <form className="flex flex-col items-stretch gap-5" onSubmit={handleSubmit} noValidate>
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="mfa-error">
              {error}
            </Alert>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mfa-marbete">Marbete</Label>
            <Input
              id="mfa-marbete"
              name="marbete_code"
              type="text"
              autoComplete="off"
              required
              minLength={8}
              maxLength={128}
              placeholder="ABCD-1234-EFGH"
              value={marbeteCode}
              onChange={(e) => {
                setMarbeteCode(e.target.value.toUpperCase());
                clearError();
              }}
              disabled={loading}
              data-testid="mfa-marbete"
              className="font-mono uppercase tracking-wider"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mfa-serial">Número de serie</Label>
            <Input
              id="mfa-serial"
              name="serial_number"
              type="text"
              autoComplete="off"
              required
              minLength={3}
              maxLength={128}
              placeholder="SN-12345"
              value={serialNumber}
              onChange={(e) => {
                setSerialNumber(e.target.value.toUpperCase());
                clearError();
              }}
              disabled={loading}
              data-testid="mfa-serial"
              className="font-mono uppercase tracking-wider"
            />
          </div>

          <div className="flex flex-col items-center gap-2">
            <Label htmlFor="mfa-otp-1" className="self-center text-center text-primary-500">
              Código dinámico
            </Label>
            <OtpInput
              mode="alphanumeric"
              length={6}
              id="mfa-otp-1"
              value={otpUpper}
              onChange={(nextValue) => {
                setOtp(
                  nextValue
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 6),
                );
                clearError();
              }}
              disabled={loading}
              autoFocus={false}
              aria-label="Código dinámico de 6 caracteres"
              data-testid="mfa-otp"
            />
            <p id="mfa-otp-hint" className="text-center text-xs text-text-muted">
              Código de 6 caracteres alfanuméricos (mayúsculas y dígitos).
            </p>
          </div>

          <Button
            type="submit"
            className="w-full font-semibold"
            size="lg"
            disabled={loading || !ready}
            data-testid="mfa-submit"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {loading ? 'Verificando…' : 'Validar acceso'}
          </Button>
        </form>
      )}
    </div>
  );
}
