'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Timer } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';

/**
 * Single-step username + pre-issued OTP login form.
 *
 * Replaces the prior email + request-code flow. The user arrives with
 * a dynamic OTP issued by the broader quorum ecosystem (e.g. on their
 * authenticator, from a kiosk, or sent by a sister system); the
 * BackOffice verifies it under the `quorum-backoffice` HMAC service
 * identity and exchanges it for a session cookie. BackOffice does NOT
 * email or issue the code itself.
 *
 * The OTP code uses the OTP service's six-character uppercase
 * alphanumeric alphabet. We normalise typed input to uppercase so the
 * wire request matches what the provider verifies.
 *
 * 5-minute countdown: the OTP service issues codes with a 5-minute
 * TTL (configurable via `OTP_DEFAULT_TTL_SECONDS` on the provider).
 * This form runs a parallel client-side countdown that locks the
 * submit button once the window has elapsed and prompts the user to
 * ask the operator for a new code. The countdown resets when the
 * user edits the OTP field (operator just delivered a fresh code).
 */

// 5 minutes — must match OTP_DEFAULT_TTL_SECONDS on quorum-otp.
const OTP_TTL_SECONDS = 300;

function formatCountdown(remaining: number): string {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function LoginFormOtp() {
  const router = useRouter();
  const { login, status, error, reset } = useAuth();
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [isPending, startTransition] = useTransition();
  // Countdown state — seconds remaining before the OTP window expires.
  const [remaining, setRemaining] = useState(OTP_TTL_SECONDS);

  // Tick the countdown once per second. The server-side TTL is the
  // authoritative gate; this timer is purely UX so the user knows
  // when to ask the operator for a fresh code.
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  const loading = status === 'loading' || isPending;
  const expired = remaining === 0;
  const otpUpper = otp.toUpperCase();
  const otpReady =
    !expired && otpUpper.length === 6 && /^[A-Z0-9]+$/.test(otpUpper);
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
            // Editing the OTP field assumes the operator just
            // delivered a fresh code — restart the 5-minute window.
            if (next.length > 0 && expired) {
              setRemaining(OTP_TTL_SECONDS);
            }
          }}
          disabled={loading || expired}
          className="text-center text-lg font-mono tracking-[0.2em] uppercase"
          aria-describedby="otp-hint"
          data-testid="login-otp"
        />
        <div
          id="otp-hint"
          className="flex items-center justify-between text-xs text-text-muted"
        >
          <span>Código de 6 caracteres alfanuméricos (mayúsculas y dígitos).</span>
          <span
            data-testid="otp-countdown"
            className={
              expired
                ? 'flex items-center gap-1 font-mono text-alert-error-text'
                : remaining <= 60
                  ? 'flex items-center gap-1 font-mono text-alert-warning-text'
                  : 'flex items-center gap-1 font-mono'
            }
            aria-live="polite"
          >
            <Timer className="h-3 w-3" aria-hidden />
            {expired
              ? 'Expirado — solicita un código nuevo'
              : `Expira en ${formatCountdown(remaining)}`}
          </span>
        </div>
      </div>

      <Button
        type="submit"
        disabled={loading || !usernameReady || !otpReady || expired}
        data-testid="login-submit"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        {loading
          ? 'Verificando…'
          : expired
            ? 'Código expirado'
            : 'Ingresar'}
      </Button>
    </form>
  );
}
