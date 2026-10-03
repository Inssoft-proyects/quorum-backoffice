import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditDialog } from '@/app/(authed)/dispositivos/_components/edit-dialog';
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

describe('DispositivosEditDialog', () => {
  it('does not render submit when dispositivo is null', () => {
    render(<EditDialog dispositivo={null} onClose={() => {}} />);
    expect(screen.queryByTestId('edit-submit')).toBeNull();
  });

  // D-1 fix: quorum-otp issues uppercase alphanumeric codes. The edit
  // dialog must forward the typed code unchanged on x-otp-code.
  //
  // Note: the edit dialog uses an inline-setState re-seed that resets
  // `brand` / `model` whenever they differ from props while `otp` is
  // empty. To actually trigger a PATCH we therefore type the OTP first
  // (the re-seed is gated on `otp === ''`) and then mutate the brand.
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
          brand: 'Samsung',
          model: 'iPad',
          status: 'active',
          createdAt: '',
          createdBy: 'tester',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<EditDialog dispositivo={sample} onClose={() => {}} />);
    // Fill the OTP first (alphanumeric, 6 chars) so the re-seed is
    // bypassed for the subsequent brand change.
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i }) as HTMLInputElement[];
    const code = '3KL9YH';
    for (let i = 0; i < code.length; i += 1) {
      await user.type(otpInputs[i]!, code[i]!);
    }
    expect(otpInputs.map((b) => b.value)).toEqual(['3', 'K', 'L', '9', 'Y', 'H']);
    // Now mutate the brand — the re-seed guard (`otp === ''`) is
    // false, so the new value sticks.
    await user.clear(screen.getByTestId('edit-brand'));
    await user.type(screen.getByTestId('edit-brand'), 'Samsung');
    await user.click(screen.getByTestId('edit-submit'));
    await waitFor(() => {
      expect(captured.method).toBe('PATCH');
    });
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
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
          brand: 'Apple',
          model: 'Galaxy Tab',
          status: 'active',
          createdAt: '',
          createdBy: 'tester',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<EditDialog dispositivo={sample} onClose={() => {}} />);
    // Paste the OTP first to bypass the re-seed guard.
    const firstBox = screen.getAllByRole('textbox', { name: /Digit/i })[0] as HTMLInputElement;
    await user.click(firstBox);
    await user.paste('3KL9YH');
    // Now mutate the model.
    await user.clear(screen.getByTestId('edit-model'));
    await user.type(screen.getByTestId('edit-model'), 'Galaxy Tab');
    await user.click(screen.getByTestId('edit-submit'));
    await waitFor(() => {
      expect(captured.method).toBe('PATCH');
    });
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
  });

  it('shows "no changes" error when fields match original and OTP is valid', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<EditDialog dispositivo={sample} onClose={() => {}} />);
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (let i = 0; i < 6; i++) await user.type(otpInputs[i]!, '1');
    await user.click(screen.getByTestId('edit-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/No hay cambios/i);
    });
  });
});