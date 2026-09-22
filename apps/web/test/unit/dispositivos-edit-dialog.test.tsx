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