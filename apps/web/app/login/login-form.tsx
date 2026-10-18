'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';

/**
 * Client-side login form. Reads/writes via the AuthProvider context and
 * navigates to /dashboard on a successful login.
 */
export function LoginForm() {
  const router = useRouter();
  const { login, status, error, reset } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await login(email, password);
      startTransition(() => router.push('/dashboard'));
    } catch {
      /* error already in context */
    }
  }

  const loading = status === 'loading' || isPending;

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <Field
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        label="Correo"
        placeholder="admin@quorum.local"
        value={email}
        onChange={(value) => {
          setEmail(value);
          if (error) reset();
        }}
        disabled={loading}
      />
      <Field
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        minLength={1}
        label="Contraseña"
        value={password}
        onChange={(value) => {
          setPassword(value);
          if (error) reset();
        }}
        disabled={loading}
      />
      <Button type="submit" disabled={loading || !email || !password}>
        {loading ? 'Ingresando…' : 'Ingresar'}
      </Button>
    </form>
  );
}
