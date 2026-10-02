import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevokeDialog } from '@/app/(authed)/dispositivos/_components/revoke-dialog';
import type { DispositivoDetailResponse } from '@quorum-backoffice/shared';

const sample: DispositivoDetailResponse = {
  id: 1,
  serialNumber: 'SN-X',
  brand: 'Apple',
  model: 'iPad',
  status: 'active',
  createdAt: '',
  createdBy: 'tester',
  revokedAt: null,
  revokedReason: null,
};

describe('DispositivosRevokeDialog', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  it('does not render submit when dispositivo is null', () => {
    render(<RevokeDialog dispositivo={null} onClose={() => {}} />);
    expect(screen.queryByTestId('revoke-submit')).toBeNull();
  });

  it('disables submit until reason >= 3 chars and OTP has 6 digits', async () => {
    const user = userEvent.setup();
    render(<RevokeDialog dispositivo={sample} onClose={() => {}} />);
    expect(screen.getByTestId('revoke-submit')).toBeDisabled();
    await user.type(screen.getByTestId('revoke-reason'), 'stolen');
    expect(screen.getByTestId('revoke-submit')).toBeDisabled();
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) await user.type(input, '1');
    expect(screen.getByTestId('revoke-submit')).not.toBeDisabled();
  });

  // D-1 fix: quorum-otp issues uppercase alphanumeric codes. Revoke
  // must forward the typed code unchanged on x-otp-code.
  it('forwards an alphanumeric OTP (3KL9YH) on x-otp-code when typed char-by-char', async () => {
    const captured: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {};
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.method = init?.method ?? '';
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      captured.body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 1,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'revoked',
          createdAt: '',
          createdBy: 'tester',
          revokedAt: '',
          revokedReason: 'stolen',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<RevokeDialog dispositivo={sample} onClose={() => {}} />);
    await user.type(screen.getByTestId('revoke-reason'), 'stolen');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i }) as HTMLInputElement[];
    const code = '3KL9YH';
    for (let i = 0; i < code.length; i += 1) {
      await user.type(otpInputs[i]!, code[i]!);
    }
    expect(otpInputs.map((b) => b.value)).toEqual(['3', 'K', 'L', '9', 'Y', 'H']);
    await user.click(screen.getByTestId('revoke-submit'));
    await waitFor(() => {
      expect(captured.method).toBe('DELETE');
    });
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
    const parsed = JSON.parse(captured.body ?? '{}') as { reason: string };
    expect(parsed.reason).toBe('stolen');
  });

  it('forwards an alphanumeric OTP (3KL9YH) on x-otp-code when pasted', async () => {
    const captured: {
      method?: string;
      headers?: Record<string, string>;
    } = {};
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.method = init?.method ?? '';
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          id: 1,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'revoked',
          createdAt: '',
          createdBy: 'tester',
          revokedAt: '',
          revokedReason: 'lost',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<RevokeDialog dispositivo={sample} onClose={() => {}} />);
    await user.type(screen.getByTestId('revoke-reason'), 'lost');
    const firstBox = screen.getAllByRole('textbox', { name: /Digit/i })[0] as HTMLInputElement;
    await user.click(firstBox);
    await user.paste('3KL9YH');
    await user.click(screen.getByTestId('revoke-submit'));
    await waitFor(() => {
      expect(captured.method).toBe('DELETE');
    });
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
  });

  it('shows conflict error when dispositivo already revoked (API 409)', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'conflict', message: 'already revoked' }), {
        status: 409,
      })) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<RevokeDialog dispositivo={sample} onClose={() => {}} />);
    await user.type(screen.getByTestId('revoke-reason'), 'lost');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) await user.type(input, '1');
    await user.click(screen.getByTestId('revoke-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/revocado/i);
    });
  });
});