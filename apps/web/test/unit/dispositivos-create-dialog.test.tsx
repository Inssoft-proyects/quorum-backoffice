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