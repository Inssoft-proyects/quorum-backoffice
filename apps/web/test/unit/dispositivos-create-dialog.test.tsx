import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateDialog } from '@/app/(authed)/dispositivos/_components/create-dialog';

const created: { value: unknown } = { value: null };
function onSuccess(c: unknown) {
  created.value = c;
}

describe('DispositivosCreateDialog', () => {
  beforeEach(() => {
    created.value = null;
  });

  it('does not render submit when closed', () => {
    render(<CreateDialog open={false} onClose={() => {}} onSuccess={onSuccess} />);
    expect(screen.queryByTestId('create-submit')).toBeNull();
  });

  it('disables submit until serial and OTP valid', () => {
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    expect(screen.getByTestId('create-submit')).toBeDisabled();
  });

  it('submits with serial, brand, model, and x-otp-code header', async () => {
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
          id: 99,
          serialNumber: 'SN-X',
          brand: 'B',
          model: 'M',
          status: 'active',
          createdAt: '',
          createdBy: 'x',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    await user.type(screen.getByTestId('create-serial'), 'SN-ABCD-1234');
    await user.type(screen.getByTestId('create-brand'), 'Apple');
    await user.type(screen.getByTestId('create-model'), 'iPad');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (let i = 0; i < 6; i++) await user.type(otpInputs[i]!, String(i + 1));
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(created.value).not.toBeNull();
    });
    expect(captured.method).toBe('POST');
    expect(captured.headers?.['x-otp-code']).toBe('123456');
    const parsed = JSON.parse(captured.body ?? '{}') as {
      serialNumber: string;
      brand?: string;
      model?: string;
    };
    expect(parsed.serialNumber).toBe('SN-ABCD-1234');
    expect(parsed.brand).toBe('Apple');
    expect(parsed.model).toBe('iPad');
  });

  // D-1 fix: quorum-otp issues uppercase alphanumeric codes (31-char
  // alphabet = A-Z0-9). OtpInput must default-forward every character
  // typed/pasted by the operator to the x-otp-code header unchanged.
  // Prior to the fix the OtpInput stripped letters, leaving the header
  // empty / short and making the destructive flow fail server-side with
  // `otp_invalid`.
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
          id: 99,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'active',
          createdAt: '',
          createdBy: 'x',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    await user.type(screen.getByTestId('create-serial'), 'SN-ABCD-1234');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i }) as HTMLInputElement[];
    const code = '3KL9YH';
    for (let i = 0; i < code.length; i += 1) {
      await user.type(otpInputs[i]!, code[i]!);
    }
    // Every box should render its character (no letter-stripping).
    expect(otpInputs.map((b) => b.value)).toEqual(['3', 'K', 'L', '9', 'Y', 'H']);
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(created.value).not.toBeNull();
    });
    expect(captured.method).toBe('POST');
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
  });

  it('forwards an alphanumeric OTP (3KL9YH) on x-otp-code when pasted into the first box', async () => {
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
          id: 99,
          serialNumber: 'SN-X',
          brand: null,
          model: null,
          status: 'active',
          createdAt: '',
          createdBy: 'x',
          revokedAt: null,
          revokedReason: null,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    await user.type(screen.getByTestId('create-serial'), 'SN-ABCD-1234');
    const firstBox = screen.getAllByRole('textbox', { name: /Digit/i })[0] as HTMLInputElement;
    await user.click(firstBox);
    await user.paste('3KL9YH');
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(created.value).not.toBeNull();
    });
    expect(captured.headers?.['x-otp-code']).toBe('3KL9YH');
  });

  it('shows conflict error when serial already exists', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'conflict', message: 'serial exists' }), {
        status: 409,
      })) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    await user.type(screen.getByTestId('create-serial'), 'SN-DUP-9999');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (let i = 0; i < 6; i++) await user.type(otpInputs[i]!, '1');
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/serial/i);
    });
  });
});