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

describe('LoginFormOtp (Polish WU v6 / A8)', () => {
  it('renders the email step first with the request button disabled until valid', () => {
    renderForm();
    const email = screen.getByLabelText('Correo') as HTMLInputElement;
    const button = screen.getByTestId('login-request-otp') as HTMLButtonElement;
    expect(email).toBeInTheDocument();
    expect(button).toBeDisabled();
    // The OTP step is not visible yet.
    expect(screen.queryByTestId('login-otp')).toBeNull();
  });

  it('advances to the OTP step on a successful OTP request', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ ok: true, retryAfterSeconds: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Correo'), 'admin@quorum.local');
    await user.click(screen.getByTestId('login-request-otp'));

    await waitFor(() => {
      expect(screen.getByTestId('login-otp')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-email-hint').textContent).toMatch(/admin@quorum\.local/);
    expect(screen.getByTestId('login-back')).toBeInTheDocument();
    expect(screen.getByTestId('login-resend-otp')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit-otp')).toBeDisabled();
  });

  it('shows the server error when the OTP request fails with rate_limited', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ code: 'rate_limited', message: 'too many' }), {
        status: 429,
      })) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Correo'), 'admin@quorum.local');
    await user.click(screen.getByTestId('login-request-otp'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(/Demasiados/);
    // Still on the email step.
    expect(screen.queryByTestId('login-otp')).toBeNull();
  });

  it('goes back to the email step when the back button is clicked', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ ok: true, retryAfterSeconds: 60 }), {
        status: 200,
      })) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Correo'), 'admin@quorum.local');
    await user.click(screen.getByTestId('login-request-otp'));
    await waitFor(() => {
      expect(screen.getByTestId('login-otp')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('login-back'));
    await waitFor(() => {
      expect(screen.queryByTestId('login-otp')).toBeNull();
    });
    expect(screen.getByTestId('login-request-otp')).toBeInTheDocument();
  });

  it('submits the OTP and navigates to /dashboard on a successful verify', async () => {
    let call = 0;
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const url = typeof _input === 'string' ? _input : _input.toString();
      if (call === 1 && url.endsWith('/api/v1/auth/login/request')) {
        return new Response(JSON.stringify({ ok: true, retryAfterSeconds: 60 }), { status: 200 });
      }
      if (call === 2 && url.endsWith('/api/v1/auth/login')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body.otp).toBe('654321');
        expect(body.email).toBe('admin@quorum.local');
        // No `password` field should be sent.
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
    await user.type(screen.getByLabelText('Correo'), 'admin@quorum.local');
    await user.click(screen.getByTestId('login-request-otp'));
    await waitFor(() => {
      expect(screen.getByTestId('login-otp')).toBeInTheDocument();
    });
    // Paste a 6-digit code into the first OTP input; the OtpInput's
    // onPaste handler fills all six boxes in one go.
    const firstBox = screen.getByLabelText('Digit 1 of 6') as HTMLInputElement;
    await user.click(firstBox);
    await user.paste('654321');
    await user.click(screen.getByTestId('login-submit-otp'));
    await waitFor(() => {
      expect(stubRouter.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('surfaces invalid_otp from the backend', async () => {
    let call = 0;
    const fetchMock = (async (_input: RequestInfo | URL) => {
      call += 1;
      const url = typeof _input === 'string' ? _input : _input.toString();
      if (call === 1 && url.endsWith('/api/v1/auth/login/request')) {
        return new Response(JSON.stringify({ ok: true, retryAfterSeconds: 60 }), { status: 200 });
      }
      if (call === 2 && url.endsWith('/api/v1/auth/login')) {
        return new Response(
          JSON.stringify({ code: 'invalid_otp', message: 'bad code' }),
          { status: 401 },
        );
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Correo'), 'admin@quorum.local');
    await user.click(screen.getByTestId('login-request-otp'));
    await waitFor(() => {
      expect(screen.getByTestId('login-otp')).toBeInTheDocument();
    });
    const firstBox = screen.getByLabelText('Digit 1 of 6') as HTMLInputElement;
    await user.click(firstBox);
    await user.paste('000000');
    await user.click(screen.getByTestId('login-submit-otp'));
    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(/incorrecto|expirado/);
  });
});