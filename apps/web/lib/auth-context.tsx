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
} from './api-client';

type Status = 'idle' | 'loading' | 'error';

interface AuthState {
  user: MeResponse | null;
  status: Status;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Exchange (username, otp) for a session cookie. Throws on failure. */
  login: (username: string, otp: string) => Promise<MeResponse>;
  logout: () => Promise<void>;
  reset: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * User-visible Spanish messages. Mapping centralised here so the
 * form stays focused on inputs and accessibility.
 *
 * The dependency-failure case (`service_unavailable`, 503) is split
 * out from the invalid-OTP path so a misconfigured HMAC identity
 * does not look like "wrong code" to the operator.
 */
function explain(err: unknown, kind: 'login'): string {
  if (!(err instanceof ApiError)) {
    return kind === 'login'
      ? 'No se pudo iniciar sesión. Intenta de nuevo.'
      : 'Error de red. Intenta de nuevo.';
  }
  switch (err.code) {
    case 'invalid_credentials':
      return 'Usuario o código incorrecto. Verifica tu código dinámico e inténtalo de nuevo.';
    case 'rate_limited':
      return 'Demasiados intentos. Intenta más tarde.';
    case 'user_disabled':
      return 'Esta cuenta está deshabilitada. Contacta al administrador.';
    case 'user_unmapped':
      return 'Esta cuenta aún no tiene un usuario asignado. Contacta al administrador.';
    case 'service_unavailable':
      return 'El servicio de verificación no está disponible. Intenta más tarde o avisa al equipo técnico.';
    case 'validation_error':
      return 'Verifica que el usuario y el código tengan el formato correcto.';
    default:
      return err.message || 'Error desconocido. Intenta de nuevo.';
  }
}

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
    async (username: string, otp: string): Promise<MeResponse> => {
      setStatus('loading');
      setError(null);
      try {
        const u = await apiLogin({ username, otp });
        setUser(u);
        setStatus('idle');
        return u;
      } catch (err) {
        setError(explain(err, 'login'));
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
