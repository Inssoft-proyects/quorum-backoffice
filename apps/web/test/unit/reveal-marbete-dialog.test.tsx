/**
 * Tests for the RevealMarbeteDialog (WU v3 "Asignación de marbetes").
 *
 * Reveal is the per-op destructive endpoint that surfaces the unmasked
 * marbete number. Unlike other destructive writes it is NEVER
 * grant-eligible (reveal never mints or consumes a grant — by
 * design the upstream canonical flow wants an explicit OTP every
 * time, so the audit trail is unambiguous). The dialog must:
 *  - ALWAYS render the OtpInput, even if the actor has an active grant
 *    (so the upstream contract is preserved);
 *  - require a 6-char alphanumeric OTP before submit;
 *  - forward the OTP on the x-otp-code header.
 *
 * D-4: prior to the fix the dialog submitted revealMarbete(...) with
 * an empty OTP string, making reveal unusable as soon as
 * AUTH_OTP_REQUIRED was on.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevealMarbeteDialog } from '@/components/inventory/reveal-marbete-dialog';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FetchHandlers {
  grant?: { active: boolean; expiresAt: string | null };
  revealStatus?: number;
  revealBody?: unknown;
}

function installFetchMock(handlers: FetchHandlers = {}): {
  read(): CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? '');
    calls.push({ url, method: init?.method ?? '', headers, body });

    if (url.includes('/api/v1/marbetes/otp-grant')) {
      return new Response(
        JSON.stringify(handlers.grant ?? { active: false, expiresAt: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.match(/\/api\/v1\/marbetes\/\d+\/reveal$/)) {
      const status = handlers.revealStatus ?? 200;
      return new Response(
        JSON.stringify(
          handlers.revealBody ?? {
            code: 'CRD-0001-ABCD1234',
          },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ code: 'not_found', message: 'no' }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return {
    read(): CapturedRequest[] {
      return calls;
    },
  };
}

describe('RevealMarbeteDialog — OTP input is always required (D-4)', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  it('renders the OTP input when no grant is active', () => {
    installFetchMock();
    render(
      <RevealMarbeteDialog
        marbeteId={1}
        open
        onOpenChange={jest.fn()}
        onRevealed={jest.fn()}
      />,
    );
    expect(screen.getByTestId('reveal-marbete-otp')).toBeInTheDocument();
    const otpInputs = screen.getAllByRole("textbox", { name: /Digit/i }) as HTMLInputElement[];
    expect(otpInputs).toHaveLength(6);
  });

  it('renders the OTP input EVEN when an active grant is present (reveal is never grant-eligible)', async () => {
    installFetchMock({
      grant: { active: true, expiresAt: '2030-01-01T12:20:00Z' },
    });
    render(
      <RevealMarbeteDialog
        marbeteId={1}
        open
        onOpenChange={jest.fn()}
        onRevealed={jest.fn()}
      />,
    );
    // The grant fetch resolves but the OTP input is still visible.
    await waitFor(() => {
      expect(screen.getByTestId('reveal-marbete-otp')).toBeInTheDocument();
    });
    // No grant-note: reveal does not consume the grant window.
    expect(screen.queryByTestId('reveal-marbete-grant-note')).toBeNull();
  });

  it('disables submit until a reason AND a 6-char alphanumeric OTP are present', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <RevealMarbeteDialog
        marbeteId={1}
        open
        onOpenChange={jest.fn()}
        onRevealed={jest.fn()}
      />,
    );
    expect(screen.getByTestId('reveal-marbete-submit')).toBeDisabled();

    // Reason only — still disabled.
    await user.selectOptions(
      screen.getByTestId('reveal-reason-select'),
      'auditoria',
    );
    expect(screen.getByTestId('reveal-marbete-submit')).toBeDisabled();

    // Reason + 5 char OTP — still disabled.
    const otpInputs = screen.getAllByRole("textbox", { name: /Digit/i }) as HTMLInputElement[];
    for (let i = 0; i < 5; i += 1) {
      await user.type(otpInputs[i]!, 'A');
    }
    expect(screen.getByTestId('reveal-marbete-submit')).toBeDisabled();

    // Reason + 6 char alphanumeric OTP — enabled.
    await user.type(otpInputs[5]!, 'B');
    await waitFor(() => {
      expect(screen.getByTestId('reveal-marbete-submit')).not.toBeDisabled();
    });
  });

  it('forwards the OTP on x-otp-code and fires onRevealed with the unmasked code', async () => {
    const handle = installFetchMock({
      revealBody: { code: 'CRD-0001-ABCD1234' },
    });
    const user = userEvent.setup();
    const onRevealed = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <RevealMarbeteDialog
        marbeteId={1}
        open
        onOpenChange={onOpenChange}
        onRevealed={onRevealed}
      />,
    );
    await user.selectOptions(
      screen.getByTestId('reveal-reason-select'),
      'auditoria',
    );
    const otpInputs = screen.getAllByRole("textbox", { name: /Digit/i }) as HTMLInputElement[];
    for (let i = 0; i < 'AB12CD'.length; i += 1) {
      await user.type(otpInputs[i]!, 'AB12CD'[i]!);
    }
    await user.click(screen.getByTestId('reveal-marbete-submit'));

    await waitFor(() => {
      expect(onRevealed).toHaveBeenCalledTimes(1);
    });
    expect(onRevealed).toHaveBeenCalledWith('CRD-0001-ABCD1234');
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const captured = handle.read();
    const reveal = captured.find(
      (c) => c.url.match(/\/api\/v1\/marbetes\/1\/reveal$/) && c.method === 'POST',
    );
    expect(reveal).toBeDefined();
    expect(reveal!.headers['x-otp-code']).toBe('AB12CD');
  });

  it('surfaces the server error and does not call onRevealed', async () => {
    installFetchMock({
      revealStatus: 401,
      revealBody: { code: 'otp_invalid', message: 'OTP inválido o expirado.' },
    });
    const user = userEvent.setup();
    const onRevealed = jest.fn();
    render(
      <RevealMarbeteDialog
        marbeteId={1}
        open
        onOpenChange={jest.fn()}
        onRevealed={onRevealed}
      />,
    );
    await user.selectOptions(
      screen.getByTestId('reveal-reason-select'),
      'auditoria',
    );
    const otpInputs = screen.getAllByRole("textbox", { name: /Digit/i }) as HTMLInputElement[];
    for (let i = 0; i < 'AB12CD'.length; i += 1) {
      await user.type(otpInputs[i]!, 'AB12CD'[i]!);
    }
    await user.click(screen.getByTestId('reveal-marbete-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/OTP inválido/);
    });
    expect(onRevealed).not.toHaveBeenCalled();
  });
});