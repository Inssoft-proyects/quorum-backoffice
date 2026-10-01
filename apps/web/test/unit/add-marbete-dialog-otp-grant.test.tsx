/**
 * Dialog-level tests for the 20-minute OTP grant window.
 *
 * Coverage:
 *  - With an active grant (GET /api/v1/marbetes/otp-grant → active):
 *   * the "OTP vigente hasta ..." Alert is visible;
 *   * submit does NOT send the x-otp-code header;
 *   * submit still POSTs to /api/v1/marbetes.
 *  - Without an active grant (status.active = false):
 *   * the grant note is NOT visible;
 *   * submit does send an x-otp-code header (or empty).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddMarbeteDialog } from '@/components/inventory/add-marbete-dialog';
import { RevokeMarbeteDialog } from '@/components/inventory/revoke-marbete-dialog';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Install a fetch mock that responds to GET /api/v1/marbetes/otp-grant
 * with the supplied grant status and POSTs /api/v1/marbetes with a
 * canned 201 response. Captures every request for later inspection.
 */
function installGrantAwareFetch(opts: {
  grantActive: boolean;
  expiresAt: string | null;
  destructiveStatus?: number;
  destructiveBody?: unknown;
}): { read(): CapturedRequest[] } {
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
        JSON.stringify({ active: opts.grantActive, expiresAt: opts.expiresAt }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (
      url.match(/\/api\/v1\/marbetes$/) ||
      url.match(/\/api\/v1\/marbetes\/\d+\/?$/)
    ) {
      const status = opts.destructiveStatus ?? 200;
      return new Response(JSON.stringify(opts.destructiveBody ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
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

const detailResponseBody = {
  id: 99,
  publicUid: 'm-NEW',
  maskedCode: '9***W',
  status: 'active',
  assignedStudentId: null,
  assignedAt: null,
  createdAt: '2025-01-01T00:00:00Z',
  createdBy: 'tester',
  deletedAt: null,
  deletionReason: null,
  student: null,
};

describe('AddMarbeteDialog — OTP grant window', () => {
  it('with an active grant: shows the "OTP vigente hasta" note and submits without x-otp-code', async () => {
    const handle = installGrantAwareFetch({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 201,
      destructiveBody: detailResponseBody,
    });
    const user = userEvent.setup();
    render(
      <AddMarbeteDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );

    const note = await screen.findByTestId('add-marbete-grant-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/OTP vigente hasta/i);

    await user.type(screen.getByTestId('credential-number-input'), '91234567');
    await user.click(screen.getByTestId('add-marbete-submit'));

    await waitFor(() => {
      const captured = handle.read();
      expect(captured.find((c) => c.url.includes('/api/v1/marbetes') && c.method === 'POST')).toBeDefined();
    });

    const captured = handle.read();
    const create = captured.find((c) => c.url.match(/\/api\/v1\/marbetes$/) && c.method === 'POST');
    expect(create).toBeDefined();
    expect(create!.headers['x-otp-code']).toBeUndefined();
  });

  it('without an active grant: the grant note is NOT rendered; submit does send x-otp-code', async () => {
    const handle = installGrantAwareFetch({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 201,
      destructiveBody: detailResponseBody,
    });
    const user = userEvent.setup();
    render(
      <AddMarbeteDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );

    // Wait for the grant fetch to resolve (status loaded as inactive).
    await waitFor(() => {
      expect(screen.queryByTestId('add-marbete-grant-note')).toBeNull();
    });

    await user.type(screen.getByTestId('credential-number-input'), '91234567');
    await user.click(screen.getByTestId('add-marbete-submit'));

    await waitFor(() => {
      const captured = handle.read();
      expect(captured.find((c) => c.url.match(/\/api\/v1\/marbetes$/) && c.method === 'POST')).toBeDefined();
    });

    const captured = handle.read();
    const create = captured.find((c) => c.url.match(/\/api\/v1\/marbetes$/) && c.method === 'POST');
    expect(create).toBeDefined();
    // Today's behaviour: the dialog passes an empty string when the
    // grant is missing; the API client sends the x-otp-code header
    // even when the value is empty so the server can surface the
    // otp_required error.
    expect(create!.headers['x-otp-code']).toBe('');
  });

  it('refreshes the grant status when the dialog is opened', async () => {
    const handle = installGrantAwareFetch({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 201,
      destructiveBody: detailResponseBody,
    });
    // First close: status reads “no grant”.
    const { rerender } = render(
      <AddMarbeteDialog open={false} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    // Open the dialog: useEffect kicks in.
    rerender(<AddMarbeteDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />);
    await waitFor(() => {
      const captured = handle.read();
      expect(captured.some((c) => c.url.includes('/api/v1/marbetes/otp-grant'))).toBe(true);
    });
  });
});

describe('RevokeMarbeteDialog — OTP grant window', () => {
  it('with an active grant: shows the "OTP vigente hasta" note and submits without x-otp-code', async () => {
    const handle = installGrantAwareFetch({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: detailResponseBody,
    });
    const user = userEvent.setup();
    render(
      <RevokeMarbeteDialog
        marbeteId={1}
        open={true}
        onOpenChange={() => {}}
        onRevoked={() => {}}
      />,
    );

    const note = await screen.findByTestId('revoke-marbete-grant-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/OTP vigente hasta/i);

    await user.selectOptions(screen.getByTestId('deactivate-reason-select'), 'danado');
    await user.click(screen.getByTestId('revoke-marbete-submit'));

    await waitFor(() => {
      const captured = handle.read();
      expect(
        captured.find(
          (c) => c.url.match(/\/api\/v1\/marbetes\/1$/) && c.method === 'DELETE',
        ),
      ).toBeDefined();
    });

    const captured = handle.read();
    const del = captured.find(
      (c) => c.url.match(/\/api\/v1\/marbetes\/1$/) && c.method === 'DELETE',
    );
    expect(del).toBeDefined();
    expect(del!.headers['x-otp-code']).toBeUndefined();
  });

  it('without an active grant: the grant note is NOT rendered; submit does send x-otp-code', async () => {
    const handle = installGrantAwareFetch({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 200,
      destructiveBody: detailResponseBody,
    });
    const user = userEvent.setup();
    render(
      <RevokeMarbeteDialog
        marbeteId={1}
        open={true}
        onOpenChange={() => {}}
        onRevoked={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('revoke-marbete-grant-note')).toBeNull();
    });

    await user.selectOptions(screen.getByTestId('deactivate-reason-select'), 'danado');
    await user.click(screen.getByTestId('revoke-marbete-submit'));

    await waitFor(() => {
      const captured = handle.read();
      expect(
        captured.find(
          (c) => c.url.match(/\/api\/v1\/marbetes\/1$/) && c.method === 'DELETE',
        ),
      ).toBeDefined();
    });

    const captured = handle.read();
    const del = captured.find(
      (c) => c.url.match(/\/api\/v1\/marbetes\/1$/) && c.method === 'DELETE',
    );
    expect(del).toBeDefined();
    expect(del!.headers['x-otp-code']).toBe('');
  });
});