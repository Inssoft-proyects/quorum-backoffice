'use client';
import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { ApiError, login as apiLogin, logout as apiLogout } from './api-client';

type Status = 'idle' | 'loading' | 'error';

interface AuthState {
  user: MeResponse | null;
  status: Status;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<MeResponse>;
  logout: () => Promise<void>;
  reset: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: MeResponse | null;
}) {
  const [user, setUser] = useState<MeResponse | null>(initialUser);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const doLogin = useCallback(
    async (email: string, password: string): Promise<MeResponse> => {
      setStatus('loading');
      setError(null);
      try {
        const u = await apiLogin({ email, password });
        setUser(u);
        setStatus('idle');
        return u;
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.code === 'invalid_credentials'
              ? 'Email o contraseña incorrectos'
              : err.code === 'rate_limited'
                ? 'Demasiados intentos. Intenta más tarde.'
                : err.code === 'user_disabled'
                  ? 'Esta cuenta está deshabilitada.'
                  : err.message
            : 'Error de red. Intenta de nuevo.';
        setError(message);
        setStatus('error');
        throw err;
      }
    },
    [],
  );

  const doLogout = useCallback(async () => {
    setStatus('loading');
    try {
      await apiLogout();
    } finally {
      setUser(null);
      setStatus('idle');
      setError(null);
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, status, error, login: doLogin, logout: doLogout, reset }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}