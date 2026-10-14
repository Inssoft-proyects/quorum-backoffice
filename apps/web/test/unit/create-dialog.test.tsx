import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateDialog } from '@/app/(authed)/marbetes/_components/create-dialog';

const createdCapture: { value: unknown } = { value: null };
function onSuccess(created: unknown): void {
  createdCapture.value = created;
}

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Install a fetch mock that returns 201 + a MarbeteDetailResponse and
 * expose the latest captured request via the returned handle.
 */
function installFetchMock(): { read(): CapturedRequest } {
  const holder: { current: CapturedRequest | null } = { current: null };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    holder.current = {
      method: init?.method ?? '',
      headers,
      body: String(init?.body ?? ''),
    };
    return new Response(
      JSON.stringify({
        id: 99,
        publicUid: 'm-NEW',
        maskedCode: '9***99',
        status: 'active',
        assignedStudentId: null,
        assignedAt: null,
        createdAt: '',
        createdBy: 'tester',
        deletedAt: null,
        deletionReason: null,
        student: null,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return {
    read(): CapturedRequest {
      if (!holder.current) throw new Error('fetch was not called');
      return holder.current;
    },
  };
}

async function typeOtp(
  user: ReturnType<typeof userEvent.setup>,
  code: string,
): Promise<void> {
  const inputs = screen.getAllByRole('textbox', { name: /Digit/i });
  for (let i = 0; i < code.length; i += 1) {
    await user.type(inputs[i]!, code[i]!);
  }
}

describe('CreateDialog', () => {
  beforeEach(() => {
    createdCapture.value = null;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  it('does not render submit when closed', () => {
    render(<CreateDialog open={false} onClose={() => {}} onSuccess={onSuccess} />);
    expect(screen.queryByTestId('create-submit')).toBeNull();
  });

  it('calls createMarbete with code, x-otp-code header, and onSuccess on 201', async () => {
    const handle = installFetchMock();
    const user = userEvent.setup();
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);

    await user.type(screen.getByTestId('create-code'), 'ABCDEFGH');
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('create-submit'));

    await waitFor(() => {
      expect(createdCapture.value).not.toBeNull();
    });

    const req = handle.read();
    expect(req.method).toBe('POST');
    expect(req.headers['x-otp-code']).toBe('123456');
    expect(JSON.parse(req.body).code).toBe('ABCDEFGH');
  });

  it('disables submit until code and OTP are valid', () => {
    render(<CreateDialog open={true} onClose={() => {}} onSuccess={onSuccess} />);
    const submit = screen.getByTestId('create-submit');
    expect(submit).toBeDisabled();
  });
});