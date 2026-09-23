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