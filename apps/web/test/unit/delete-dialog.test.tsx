import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteDialog } from '@/app/(authed)/marbetes/_components/delete-dialog';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';

const sample: MarbeteDetailResponse = {
  id: 1,
  publicUid: 'm-ABC123',
  maskedCode: '1***23',
  status: 'active',
  assignedStudentId: null,
  assignedAt: null,
  createdAt: '',
  createdBy: 'tester',
  deletedAt: null,
  deletionReason: null,
  student: null,
};

describe('DeleteDialog', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  it('does not render the submit button when marbete is null', () => {
    render(<DeleteDialog marbete={null} onClose={() => {}} />);
    expect(screen.queryByTestId('delete-submit')).toBeNull();
  });

  it('disables submit until reason is valid and OTP has 6 digits', async () => {
    const user = userEvent.setup();
    render(<DeleteDialog marbete={sample} onClose={() => {}} />);
    const submit = await screen.findByTestId('delete-submit');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('delete-reason'), 'lost');
    expect(submit).toBeDisabled();
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    expect(otpInputs).toHaveLength(6);
    for (const input of otpInputs) {
      await user.type(input, '1');
    }
    expect(submit).not.toBeDisabled();
  });

  it('shows error when API returns 401 (OTP invalid)', async () => {
    const user = userEvent.setup();
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'otp_invalid', message: 'no' }), {
        status: 401,
      })) as unknown as typeof fetch;
    render(<DeleteDialog marbete={sample} onClose={() => {}} />);
    await user.type(screen.getByTestId('delete-reason'), 'lost');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) {
      await user.type(input, '1');
    }
    await user.click(screen.getByTestId('delete-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/OTP/i);
    });
  });
});
