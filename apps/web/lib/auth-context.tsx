'use client';
import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import {
  ApiError,
  login as apiLogin,
  logout as apiLogout,
  requestLoginOtp as apiRequestLoginOtp,
} from './api-client';

type Status = 'idle' | 'loading' | 'error';

interface AuthState {
  user: MeResponse | null;
  status: Status;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Request an OTP email for the given address. Resolves on send; never throws on unknown email. */
  requestOtp: (email: string) => Promise<{ retryAfterSeconds: number }>;
  /** Exchange email + OTP for a session cookie. */
  login: (email: string, otp: string) => Promise<MeResponse>;
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

  const doRequestOtp = useCallback(
    async (email: string): Promise<{ retryAfterSeconds: number }> => {
      setStatus('loading');
      setError(null);
      try {
        const r = await apiRequestLoginOtp({ email });
        setStatus('idle');
        return { retryAfterSeconds: r.retryAfterSeconds };
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.code === 'rate_limited'
              ? 'Demasiados intentos. Intenta más tarde.'
              : err.message
            : 'No se pudo enviar el código. Intenta de nuevo.';
        setError(message);
        setStatus('error');
        throw err;
      }
    },
    [],
  );

  const doLogin = useCallback(
    async (email: string, otp: string): Promise<MeResponse> => {
      setStatus('loading');
      setError(null);
      try {
        const u = await apiLogin({ email, otp });
        setUser(u);
        setStatus('idle');
        return u;
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.code === 'invalid_otp'
              ? 'Código incorrecto o expirado.'
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
      value={{
        user,
        status,
        error,
        requestOtp: doRequestOtp,
        login: doLogin,
        logout: doLogout,
        reset,
      }}
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