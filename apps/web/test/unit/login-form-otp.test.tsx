import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
 * Returns the 6 OTP boxes the form renders. The boxes are the only
 * `textbox` inputs inside the form; the username input is also a
 * `textbox` so we scope the lookup to the `login-otp` group.
 */
function getOtpBoxes(): HTMLInputElement[] {
  const group = screen.getByTestId('login-otp');
  return Array.from(
    group.querySelectorAll<HTMLInputElement>('input'),
  );
}

/**
 * Single-step username + pre-issued OTP login (Polish WU v6 / A8+
 * username migration). The BackOffice no longer exposes the email
 * step or a `/auth/login/request` endpoint; the user arrives with a
 * pre-issued 6-char alphanumeric OTP and the form posts
 * `{ username, otp }` in one go.
 *
 * Polish: the OTP input is now the shared 6-box OtpInput rendered in
 * `mode="alphanumeric"` (gold focus ring + boxy design), matching
 * `diseno/design/OPT_Dinamico.png`.
 */
describe('LoginFormOtp (single-step username + OTP, gold-box restyle)', () => {
  it('renders the username field, the 6 OTP boxes and a submit button disabled until both are valid', () => {
    renderForm();
    const username = screen.getByTestId('login-username') as HTMLInputElement;
    const otpGroup = screen.getByTestId('login-otp');
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement;
    expect(username).toBeInTheDocument();
    expect(otpGroup).toBeInTheDocument();
    expect(getOtpBoxes()).toHaveLength(6);
    expect(submit).toBeDisabled();
  });

  it('shows the "Validar código" submit label and the gold box hint', () => {
    renderForm();
    expect(screen.getByTestId('login-submit').textContent).toMatch(/Validar código/);
    expect(screen.getByText(/6 caracteres alfanuméricos/i)).toBeInTheDocument();
  });

  it('keeps submit disabled when only the username is filled in', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('keeps submit disabled when only the OTP boxes are filled in', async () => {
    const user = userEvent.setup();
    renderForm();
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'A');
    await user.type(boxes[1]!, 'B');
    await user.type(boxes[2]!, 'C');
    await user.type(boxes[3]!, '1');
    await user.type(boxes[4]!, '2');
    await user.type(boxes[5]!, '3');
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('uppercases lowercase OTP input and auto-advances across the 6 boxes', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    const boxes = getOtpBoxes();
    // typing into the first box should auto-advance focus to the next.
    await user.type(boxes[0]!, 'a');
    expect(boxes[0]!.value).toBe('A');
    await user.type(boxes[1]!, 'b');
    await user.type(boxes[2]!, 'c');
    await user.type(boxes[3]!, '1');
    await user.type(boxes[4]!, '2');
    await user.type(boxes[5]!, '3');
    expect(boxes.map((b) => b.value)).toEqual(['A', 'B', 'C', '1', '2', '3']);
    expect(screen.getByTestId('login-submit')).not.toBeDisabled();
  });

  it('strips non-alphanumeric characters and forces uppercase from any single box', async () => {
    const user = userEvent.setup();
    renderForm();
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'a!');
    expect(boxes[0]!.value).toBe('A');
    await user.type(boxes[1]!, '1-');
    expect(boxes[1]!.value).toBe('1');
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
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'A');
    await user.type(boxes[1]!, 'B');
    await user.type(boxes[2]!, '1');
    await user.type(boxes[3]!, '2');
    await user.type(boxes[4]!, 'C');
    await user.type(boxes[5]!, 'D');
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
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
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
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '1');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('login-error').textContent).toMatch(/Demasiados/);
  });

  it('clears the error when the user resumes typing in the username field', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ code: 'invalid_credentials', message: 'no' }),
        { status: 401 },
      )) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    await user.type(screen.getByTestId('login-username'), 'x');
    await waitFor(() => {
      expect(screen.queryByTestId('login-error')).toBeNull();
    });
  });

  it('clears the error when the user types a new character in any OTP box', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ code: 'invalid_credentials', message: 'no' }),
        { status: 401 },
      )) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId('login-username'), 'admin');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    // Typing again in the first OTP box should also dismiss the error.
    // We use fireEvent.change here because userEvent.type on a jsdom
    // controlled input that is already populated by maxLength=1 can drop
    // the keystroke (see https://github.com/testing-library/user-event
    // issues around controlled inputs); the change event is the contract
    // the form cares about.
    fireEvent.change(boxes[0]!, { target: { value: 'A' } });
    await waitFor(() => {
      expect(screen.queryByTestId('login-error')).toBeNull();
    });
  });
});