import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { LoginFormOtp } from '@/app/login/login-form-otp';
import { AuthProvider } from '@/lib/auth-context';
import type { ReactNode } from 'react';

// stubRouter exposes jest.fn() spies for push/replace so individual
// tests can assert navigation side effects without the AppRouterContext
// throwing.
const stubRouter = {
  back: jest.fn(),
  bfcacheId: '',
  forward: jest.fn(),
  refresh: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  prefetch: jest.fn(),
} as unknown as AppRouterInstance;

function withRouter(children: ReactNode) {
  return (
    <AppRouterContext.Provider value={stubRouter}>{children}</AppRouterContext.Provider>
  );
}

function renderForm() {
  return render(
    withRouter(
      <AuthProvider>
        <LoginFormOtp />
      </AuthProvider>,
    ),
  );
}

/**
 * Single-step username + pre-issued OTP login (Polish WU v6 / A8+
 * username migration). The BackOffice no longer exposes the email
 * step or a `/auth/login/request` endpoint; the user arrives with a
 * pre-issued 6-char alphanumeric OTP and the form posts
 * `{ username, otp }` in one go.
 */
describe('LoginFormOtp (single-step username + OTP, post-username migration)', () => {
  it('renders the username field with submit disabled until both inputs are valid', () => {
    renderForm();
    const username = screen.getByTestId('login-username') as HTMLInputElement;
    const otp = screen.getByTestId('login-otp') as HTMLInputElement;
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement;
    expect(username).toBeInTheDocument();
    expect(otp).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('keeps submit disabled when only the username is filled in', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('login-username'), 'admin');
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('keeps submit disabled when only the OTP is filled in', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('login-otp'), '654321');
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('uppercases the OTP input as the user types', async () => {
    renderForm();
    const user = userEvent.setup();
    const otp = screen.getByTestId('login-otp') as HTMLInputElement;
    await user.type(otp, 'ab12cd');
    expect(otp.value).toBe('AB12CD');
  });

  it('submits { username, otp } in a single POST to /api/v1/auth/login and navigates on success', async () => {
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : _input.toString();
      if (url.endsWith('/api/v1/auth/login')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.username).toBe('admin');
        expect(body.otp).toBe('AB12CD');
        // No email/password/request fields should leak into the new contract.
        expect(body.email).toBeUndefined();
        expect(body.password).toBeUndefined();
        return new Response(
          JSON.stringify({ user: { id: 1, email: 'admin@quorum.local', role: 'admin' } }),
          { status: 200 },
        );
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    await user.type(screen.getByTestId('login-otp'), 'AB12CD');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(stubRouter.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('surfaces an error when the backend rejects with invalid_credentials', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ code: 'invalid_credentials', message: 'no' }),
        { status: 401 },
      )) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    await user.type(screen.getByTestId('login-otp'), '000000');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(/incorrecto|verifica/i);
  });

  it('surfaces a rate_limited error from the backend', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ code: 'rate_limited', message: 'too many' }),
        { status: 429 },
      )) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    await user.type(screen.getByTestId('login-otp'), 'AB12CD');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(/Demasiados/);
  });

  it('clears the error when the user resumes typing', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ code: 'invalid_credentials', message: 'no' }),
        { status: 401 },
      )) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    await user.type(screen.getByTestId('login-otp'), '000000');
    await user.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    await user.type(screen.getByTestId('login-username'), 'x');
    await waitFor(() => {
      expect(screen.queryByTestId('login-error')).toBeNull();
    });
  });
});