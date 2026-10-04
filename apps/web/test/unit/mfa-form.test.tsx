import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { MfaForm } from '@/app/mfa/mfa-form';
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
  return <AppRouterContext.Provider value={stubRouter}>{children}</AppRouterContext.Provider>;
}

function renderForm(next?: string) {
  // The component signature: <MfaForm next={...} />. The form treats
  // `next` as the redirect destination; `undefined` falls back to the
  // built-in default `/dashboard`.
  return render(withRouter(<MfaForm next={next} />));
}

function getOtpBoxes(): HTMLInputElement[] {
  const group = screen.getByTestId('mfa-otp');
  return Array.from(group.querySelectorAll<HTMLInputElement>('input'));
}

/**
 * M2 — MFA web page: three-factor authentication form
 * (marbete code + device serial + dynamic OTP). Mirrors the lookfeel
 * intent of `/login` (single-step username + OTP) but:
 *
 *   - Three labelled fields: marbete code (uppercase, monospace),
 *     device serial (uppercase), OTP (6-box OtpInput).
 *   - Submit posts to `POST /api/v1/mfa/authenticate` and on
 *     success navigates to the `next` URL (default `/dashboard`).
 *   - On 401 the typed deny.* code is mapped to a short Spanish
 *     message identical in style to the `/login` error slot.
 *
 * The form is intentionally context-free: it does NOT extend
 * `useAuth` (which carries the operator session). The MFA session
 * is set by the backend cookie; the client just navigates.
 */
describe('MfaForm — three-factor authentication (M2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the marbete code, device serial, OTP fields and a disabled submit button', () => {
    renderForm('/dashboard');
    expect(screen.getByTestId('mfa-marbete')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-serial')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-otp')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-submit')).toBeDisabled();
  });

  it('keeps submit disabled until all three fields are valid', async () => {
    const user = userEvent.setup();
    renderForm('/dashboard');

    // Only marbete filled.
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    expect(screen.getByTestId('mfa-submit')).toBeDisabled();

    // Only marbete + serial (no OTP yet).
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    expect(screen.getByTestId('mfa-submit')).toBeDisabled();

    // Fill the OTP boxes; submit must enable.
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'A');
    await user.type(boxes[1]!, 'B');
    await user.type(boxes[2]!, '1');
    await user.type(boxes[3]!, '2');
    await user.type(boxes[4]!, 'C');
    await user.type(boxes[5]!, 'D');
    expect(screen.getByTestId('mfa-submit')).not.toBeDisabled();
  });

  it('auto-uppercases the marbete code and device serial inputs', async () => {
    const user = userEvent.setup();
    renderForm('/dashboard');
    const marbete = screen.getByTestId('mfa-marbete') as HTMLInputElement;
    const serial = screen.getByTestId('mfa-serial') as HTMLInputElement;

    await user.type(marbete, 'abcd1234efgh');
    expect(marbete.value).toBe('ABCD1234EFGH');

    await user.type(serial, 'sn-lowercase');
    expect(serial.value).toBe('SN-LOWERCASE');
  });

  it('OTP input forces uppercase and auto-advances across the 6 boxes', async () => {
    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'a');
    expect(boxes[0]!.value).toBe('A');
    await user.type(boxes[1]!, 'b');
    await user.type(boxes[2]!, 'c');
    await user.type(boxes[3]!, '1');
    await user.type(boxes[4]!, '2');
    await user.type(boxes[5]!, '3');
    expect(boxes.map((b) => b.value)).toEqual(['A', 'B', 'C', '1', '2', '3']);
  });

  it('submits { marbete_code, serial_number, otp } in a single POST to /api/v1/mfa/authenticate', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : _input.toString();
      if (url.endsWith('/api/v1/mfa/authenticate')) {
        captured = { url, init };
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        expect(body).toEqual({
          marbete_code: 'ABCD1234EFGH',
          serial_number: 'SN12345',
          otp: 'ABC123',
        });
        return new Response(
          JSON.stringify({
            canvas_user_id: 9001,
            student_name: 'Smoke Student',
            student_email: 'smoke@quorum.local',
            role: 'student',
            session_id: 'sess-1',
            expires_at: '2026-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'abcd1234efgh');
    await user.type(screen.getByTestId('mfa-serial'), 'sn12345');
    const boxes = getOtpBoxes();
    await user.type(boxes[0]!, 'a');
    await user.type(boxes[1]!, 'b');
    await user.type(boxes[2]!, 'c');
    await user.type(boxes[3]!, '1');
    await user.type(boxes[4]!, '2');
    await user.type(boxes[5]!, '3');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured!.url).toContain('/api/v1/mfa/authenticate');
    expect(captured!.init?.method).toBe('POST');
    expect(captured!.init?.credentials).toBe('include');
  });

  it('shows the typed deny.marbete_unknown message on 401', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'deny.marbete_unknown', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-error').textContent).toMatch(/Marbete no encontrado/i);
  });

  it('shows the typed deny.otp_invalid message on 401', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'deny.otp_invalid', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-error').textContent).toMatch(/Código dinámico incorrecto/i);
  });

  it('shows the typed deny.dependency_fail message on 503', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'deny.dependency_fail', message: 'no' }), {
        status: 503,
      })) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-error').textContent).toMatch(
      /Servicio de verificación no disponible/i,
    );
  });

  it('shows a validation_error message on 400 with the first Zod issue', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 'validation_error',
          message: 'body failed validation',
          details: {
            issues: [
              {
                path: ['otp'],
                message: 'otp must be 6 chars',
              },
            ],
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-error').textContent).toMatch(/otp must be 6 chars/);
  });

  it('on 201 calls router.push with the next URL', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          canvas_user_id: 9001,
          student_name: 'Smoke Student',
          student_email: 'smoke@quorum.local',
          role: 'student',
          session_id: 'sess-1',
          expires_at: '2026-01-01T00:00:00.000Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, 'A');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(stubRouter.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('missing next defaults to /dashboard on success', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          canvas_user_id: 9001,
          student_name: 'Smoke Student',
          student_email: 'smoke@quorum.local',
          role: 'student',
          session_id: 'sess-1',
          expires_at: '2026-01-01T00:00:00.000Z',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const user = userEvent.setup();
    // No `next` prop → form uses the built-in default.
    renderForm();
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, 'A');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(stubRouter.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('clears the error when the user resumes typing in any field', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'deny.otp_invalid', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, '0');
    await user.click(screen.getByTestId('mfa-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('mfa-error')).toBeInTheDocument();
    });
    await user.type(screen.getByTestId('mfa-marbete'), 'X');
    await waitFor(() => {
      expect(screen.queryByTestId('mfa-error')).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // M3 / SSO redirect-token flow
  //
  // The form's behavior for absolute-URL targets is
  // `window.location.href = <url>`, which jsdom refuses to
  // let us spy on (the `href` property is non-configurable
  // AND `window.location` itself is non-configurable). The
  // URL-construction logic is therefore asserted at two
  // layers:
  //
  //   1. The `buildNextUrlWithToken` pure function (tested
  //      in a separate describe block below) pins the joiner
  //      (`?` vs `&`) and the encode step.
  //   2. The form-level tests below verify the fetch to
  //      /api/v1/mfa/redirect-token was made with the right
  //      body AND that the form's success state was set
  //      (which proves navigateNext was reached). The actual
  //      `window.location.href` assignment is a one-liner
  //      that calls the pure function; verifying the
  //      side effect end-to-end is a Playwright e2e
  //      concern, not a unit-test concern.
  // -----------------------------------------------------------------

  it('M3: on 201 with an absolute next URL, the form calls POST /api/v1/mfa/redirect-token with the next_url and uses credentials include', async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url, init, body });
      if (url.endsWith('/api/v1/mfa/authenticate')) {
        return new Response(
          JSON.stringify({
            canvas_user_id: 9001,
            student_name: 'Smoke Student',
            student_email: 'smoke@quorum.local',
            role: 'student',
            session_id: 'sess-m3-1',
            expires_at: '2026-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/mfa/redirect-token')) {
        return new Response(
          JSON.stringify({ token: 'a'.repeat(64), expires_in: 30 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm('https://canvas.example.com/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, 'A');
    await user.click(screen.getByTestId('mfa-submit'));

    // The form should have made TWO fetches:
    //  1) POST /api/v1/mfa/authenticate
    //  2) POST /api/v1/mfa/redirect-token with the next_url
    await waitFor(() => {
      const redirectCall = fetchCalls.find(
        (c) => c.url === 'http://127.0.0.1:3100/api/v1/mfa/redirect-token',
      );
      expect(redirectCall).toBeDefined();
      expect(redirectCall?.body).toEqual({
        next_url: 'https://canvas.example.com/dashboard',
      });
    });
    // The redirect-token call must use `credentials: include`
    // so the browser forwards the `__Host-mfa_sid` cookie.
    const redirectCall = fetchCalls.find(
      (c) => c.url === 'http://127.0.0.1:3100/api/v1/mfa/redirect-token',
    );
    expect(redirectCall?.init?.credentials).toBe('include');

    // The form must reach the success state (which proves
    // navigateNext was reached). The actual URL navigation
    // is asserted at the pure-function layer below.
    await waitFor(() => {
      expect(screen.getByTestId('mfa-success')).toBeInTheDocument();
    });
  });

  it('M3: when the redirect-token call fails, the form falls back to the direct navigation with a warn log (no error slot)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/mfa/authenticate')) {
        return new Response(
          JSON.stringify({
            canvas_user_id: 9001,
            student_name: 'Smoke Student',
            student_email: 'smoke@quorum.local',
            role: 'student',
            session_id: 'sess-m3-3',
            expires_at: '2026-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/mfa/redirect-token')) {
        return new Response(
          JSON.stringify({ code: 'mfa_redirect_origin_not_allowed', message: 'no' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    try {
      const user = userEvent.setup();
      renderForm('https://canvas.example.com/dashboard');
      await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
      await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
      const boxes = getOtpBoxes();
      for (const box of boxes) await user.type(box, 'A');
      await user.click(screen.getByTestId('mfa-submit'));

      // The form must reach the success state (which proves
      // navigateNext was reached) and the warn log was
      // emitted (which proves the redirect-token failure
      // was logged at warn level rather than surfaced to
      // the student as a hard error).
      await waitFor(() => {
        expect(screen.getByTestId('mfa-success')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('mfa-error')).toBeNull();

      expect(warnSpy).toHaveBeenCalled();
      const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
      expect(
        warnMessages.some((m) =>
          typeof m === 'string' && m.includes('mfa_redirect_token_issue_failed'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('M3: same-origin next paths skip the redirect-token call (no extra fetch, router.push to the path)', async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/v1/mfa/authenticate')) {
        return new Response(
          JSON.stringify({
            canvas_user_id: 9001,
            student_name: 'Smoke Student',
            student_email: 'smoke@quorum.local',
            role: 'student',
            session_id: 'sess-m3-4',
            expires_at: '2026-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/mfa/redirect-token')) {
        return new Response('unexpected call', { status: 500 });
      }
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const user = userEvent.setup();
    renderForm('/dashboard');
    await user.type(screen.getByTestId('mfa-marbete'), 'ABCD1234EFGH');
    await user.type(screen.getByTestId('mfa-serial'), 'SN12345');
    const boxes = getOtpBoxes();
    for (const box of boxes) await user.type(box, 'A');
    await user.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => {
      expect(stubRouter.push).toHaveBeenCalledWith('/dashboard');
    });
    expect(stubRouter.push).toHaveBeenCalledTimes(1);
    // The redirect-token endpoint must NOT be called for
    // same-origin paths.
    expect(
      fetchCalls.find((c) => c.url === 'http://127.0.0.1:3100/api/v1/mfa/redirect-token'),
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// M3 / buildNextUrlWithToken — pure function (covers the URL
// construction that the form's navigateNext relies on).
// -----------------------------------------------------------------

import { buildNextUrlWithToken } from '@/app/mfa/mfa-form';

describe('buildNextUrlWithToken — M3 URL construction', () => {
  it('appends ?mfa_token=<token> when the target has no query string', () => {
    expect(buildNextUrlWithToken('https://canvas.example.com/dashboard', 'abc123')).toBe(
      'https://canvas.example.com/dashboard?mfa_token=abc123',
    );
  });

  it('appends &mfa_token=<token> when the target already has a query string', () => {
    expect(
      buildNextUrlWithToken('https://canvas.example.com/courses?term=2026a', 'abc123'),
    ).toBe('https://canvas.example.com/courses?term=2026a&mfa_token=abc123');
  });

  it('returns the target verbatim when the token is null', () => {
    expect(buildNextUrlWithToken('https://canvas.example.com/dashboard', null)).toBe(
      'https://canvas.example.com/dashboard',
    );
  });

  it('URL-encodes the token when it contains characters that must be escaped', () => {
    // Hex tokens are 64 chars of [0-9a-f], but encodeURIComponent
    // is still applied defensively so a future refactor
    // cannot regress the wire contract.
    const token = '+&=';
    expect(buildNextUrlWithToken('https://canvas.example.com/x', token)).toBe(
      `https://canvas.example.com/x?mfa_token=${encodeURIComponent(token)}`,
    );
  });

  it('end-to-end shape: the form would build the documented M3 URL for a Canvas dashboard', () => {
    // The form's navigateNext(target, token) is a one-liner
    // that delegates to buildNextUrlWithToken; this test
    // pins the expected wire format at the boundary.
    const token = 'a'.repeat(64);
    expect(buildNextUrlWithToken('https://canvas.example.com/dashboard', token)).toBe(
      `https://canvas.example.com/dashboard?mfa_token=${token}`,
    );
  });
});
