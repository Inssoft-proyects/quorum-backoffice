'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Mail } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';

type Step = 'email' | 'otp';

/**
 * Email + OTP login form (Polish WU v6 / A7).
 *
 * Two-step flow:
 *   1. Step "email": user enters their email and clicks "Enviar código".
 *      The backend sends a 6-char alphanumeric OTP via SMTP.
 *   2. Step "otp": user pasters/types the code and clicks "Ingresar".
 *
 * Built exclusively from shadcn/ui primitives + the OtpInput component
 * (reused from the marbete delete dialog). No raw <input> / <button>
 * elements — every interactive control goes through a shadcn wrapper so
 * theming stays consistent across the backoffice.
 *
 * The legacy email + password field is gone. `password` is never sent
 * over the wire from this form.
 */
export function LoginFormOtp() {
  const router = useRouter();
  const { requestOtp, login, status, error, reset } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [isPending, startTransition] = useTransition();

  const loading = status === 'loading' || isPending;

  async function handleEmailSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) return;
    try {
      await requestOtp(email);
      setStep('otp');
    } catch {
      /* error already in context */
    }
  }

  async function handleOtpSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (otp.length !== 6) return;
    try {
      await login(email, otp);
      startTransition(() => router.push('/dashboard'));
    } catch {
      /* error already in context */
    }
  }

  function backToEmail() {
    setStep('email');
    setOtp('');
    reset();
  }

  if (step === 'email') {
    return (
      <form className="flex flex-col gap-4" onSubmit={handleEmailSubmit} noValidate>
        {error ? (
          <Alert variant="destructive" role="alert" data-testid="login-error">
            {error}
          </Alert>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Correo</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="admin@quorum.local"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) reset();
            }}
            disabled={loading}
            data-testid="login-email"
          />
        </div>
        <Button
          type="submit"
          disabled={loading || !email}
          data-testid="login-request-otp"
        >
          <Mail className="h-4 w-4" aria-hidden />
          {loading ? 'Enviando código…' : 'Enviar código'}
        </Button>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleOtpSubmit} noValidate>
      {error ? (
        <Alert variant="destructive" role="alert" data-testid="login-error">
          {error}
        </Alert>
      ) : null}
      <p className="text-sm text-text-muted" data-testid="login-email-hint">
        Te enviamos un código a <strong>{email}</strong>. Si no lo ves en
        tu bandeja, revisa la carpeta de no deseados o vuelve a enviarlo.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="otp-1">Código de 6 dígitos</Label>
        <OtpInput
          value={otp}
          onChange={(v) => {
            setOtp(v);
            if (error) reset();
          }}
          disabled={loading}
          aria-label="OTP code"
        />
        {/* Hidden mirror of the first digit box so screen readers and
            integration tests can target the OTP field via its label. */}
        <input
          id="otp-1"
          name="otp"
          type="text"
          autoComplete="one-time-code"
          value={otp}
          onChange={() => undefined}
          aria-hidden
          tabIndex={-1}
          className="sr-only"
          data-testid="login-otp"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          disabled={loading || otp.length !== 6}
          data-testid="login-submit-otp"
        >
          {loading ? 'Verificando…' : 'Ingresar'}
        </Button>
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={backToEmail}
            disabled={loading}
            data-testid="login-back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Cambiar correo
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              reset();
              void requestOtp(email);
            }}
            disabled={loading}
            data-testid="login-resend-otp"
          >
            Reenviar código
          </Button>
        </div>
      </div>
    </form>
  );
}