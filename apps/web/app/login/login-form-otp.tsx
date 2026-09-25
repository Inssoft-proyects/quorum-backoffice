'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';

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
 * alphanumeric alphabet. We normalise typed input to uppercase so
 * the wire request matches what the provider verifies.
 */
export function LoginFormOtp() {
  const router = useRouter();
  const { login, status, error, reset } = useAuth();
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [isPending, startTransition] = useTransition();

  const loading = status === 'loading' || isPending;
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
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
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

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="otp">Código dinámico</Label>
        <Input
          id="otp"
          name="otp"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          required
          minLength={6}
          maxLength={6}
          pattern="[A-Z0-9]{6}"
          placeholder="ABC123"
          value={otpUpper}
          onChange={(e) => {
            // Force uppercase and strip anything that is not in the
            // wire alphabet. The OTP service issues 6-char uppercase
            // alphanumeric; uppercasing on input keeps the wire body
            // identical regardless of caps-lock state.
            const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            setOtp(next);
            if (error) reset();
          }}
          disabled={loading}
          className="text-center text-lg font-mono tracking-[0.2em] uppercase"
          aria-describedby="otp-hint"
          data-testid="login-otp"
        />
        <p id="otp-hint" className="text-xs text-text-muted">
          Código de 6 caracteres alfanuméricos (mayúsculas y dígitos).
        </p>
      </div>

      <Button
        type="submit"
        disabled={loading || !usernameReady || !otpReady}
        data-testid="login-submit"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        {loading ? 'Verificando…' : 'Ingresar'}
      </Button>
    </form>
  );
}