'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { OtpInput } from '@/components/ui/otp-input';

/**
 * Single-step username + pre-issued OTP login form.
 *
 * The user arrives with a dynamic OTP issued by the broader quorum
 * ecosystem (authenticator, kiosk, sister system). BackOffice
 * verifies it under the `quorum-backoffice` HMAC service identity
 * and exchanges it for a session cookie. The OTP TTL is owned by
 * the upstream issuer — BackOffice does not surface it here, so
 * a stale OTP that exceeds the upstream TTL will be rejected by
 * the verify call with a generic invalid_credentials message.
 *
 * The OTP code uses the OTP service's six-character uppercase
 * alphanumeric alphabet. We render it via the shared `OtpInput`
 * in `mode="alphanumeric"`, which forces uppercase, strips
 * non-alphanumeric characters, and exposes `inputMode="text"` /
 * `autoComplete="one-time-code"` for password-manager support.
 */
export function LoginFormOtp() {
  const router = useRouter();
  const { login, status, error, reset } = useAuth();
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [isPending, startTransition] = useTransition();

  const loading = status === 'loading' || isPending;
  // The OtpInput in alphanumeric mode already normalises the wire
  // alphabet (uppercase A–Z0–9) before calling onChange, so the value
  // we receive is already the canonical uppercase string.
  const otpUpper = otp.toUpperCase();
  const otpReady = otpUpper.length === 6 && /^[A-Z0-9]+$/.test(otpUpper);
  const usernameReady = username.trim().length >= 3 && /^[A-Za-z0-9._-]+$/.test(username.trim());

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!usernameReady || !otpReady) return;
    try {
      await login(username.trim(), otpUpper);
      startTransition(() => router.push('/dashboard'));
    } catch {
      /* error already in context */
    }
  }

  return (
    <form
      className="flex flex-col items-stretch gap-5"
      onSubmit={handleSubmit}
      noValidate
    >
      {error ? (
        <Alert variant="destructive" role="alert" data-testid="login-error">
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="username">Usuario</Label>
        <Input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          minLength={3}
          maxLength={32}
          placeholder="admin"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (error) reset();
          }}
          disabled={loading}
          data-testid="login-username"
        />
      </div>

      {/*
        OTP zone, matched to `diseno/design/OPT_Dinamico.png`: centered
        label above the boxes, centered six-box group with gold focus
        ring, and a muted centered hint underneath. The `login-otp`
        testid lives on the OtpInput group wrapper so existing
        Testing Library queries keep working.
      */}
      <div className="flex flex-col items-center gap-2">
        <Label
          htmlFor="otp-1"
          className="self-center text-center text-primary-500"
        >
          Código de acceso
        </Label>
        <OtpInput
          mode="alphanumeric"
          length={6}
          id="otp-1"
          value={otpUpper}
          onChange={(next) => {
            // OtpInput already uppercases + alphabetises; keep a defensive
            // re-normalisation so a future refactor cannot accidentally
            // regress the wire contract (the backend verifies A–Z0–9
            // uppercased only).
            const safe = next.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            setOtp(safe);
            if (error) reset();
          }}
          disabled={loading}
          autoFocus={false}
          aria-label="Código de acceso de 6 caracteres"
          data-testid="login-otp"
        />
        <p
          id="otp-hint"
          className="text-center text-xs text-text-muted"
        >
          Código de 6 caracteres alfanuméricos (mayúsculas y dígitos).
        </p>
      </div>

      <Button
        type="submit"
        className="w-full font-semibold"
        size="lg"
        disabled={loading || !usernameReady || !otpReady}
        data-testid="login-submit"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        {loading ? 'Verificando…' : 'Validar código'}
      </Button>
    </form>
  );
}