import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';
import { BulkUploadDialog } from '@/components/inventory/bulk-upload-dialog';

/**
 * Small render harness that mimics the marbetes-page-client wiring
 * pattern (open state + trigger button + BulkUploadDialog mounted).
 * The actual page-client is too coupled to its data layer to render
 * cheaply in a unit test, so we cover the wiring contract here.
 */
function WiringHarness({ onSaved = () => {} }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        variant="default"
        onClick={() => setOpen(true)}
        data-testid="upload-marbetes-trigger"
      >
        Cargar marbetes
      </Button>
      <BulkUploadDialog open={open} onOpenChange={setOpen} onSaved={onSaved} />
    </div>
  );
}

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Install a fetch mock that returns 200 + a BulkCreateMarbetesResponse
 * and exposes the latest captured request via the returned handle.
 */
function installFetchMock(opts: {
  status?: number;
  body?: unknown;
} = {}): { read(): CapturedRequest } {
  const status = opts.status ?? 200;
  const body =
    opts.body ?? {
      total: 2,
      created: 2,
      failed: 0,
      successes: [
        { id: 1, publicUid: 'm-bulk-1', status: 'active' },
        { id: 2, publicUid: 'm-bulk-2', status: 'active' },
      ],
      failures: [],
      auditId: 42,
    };
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
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
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

describe('BulkUploadDialog', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  // T1 — dialog is closed when open=false (mounted via the wiring harness
  // but never opened by the user). The dialog root testid must NOT be in
  // the document.
  it('does not render the dialog root when open=false', () => {
    render(<WiringHarness />);
    expect(screen.queryByTestId('bulk-upload-dialog')).toBeNull();
  });

  // T2 — wiring test: clicking the upload-marbetes-trigger (the parent
  // button) opens the dialog. Mirrors the marbetes-page-client state
  // pattern: `setBulkOpen(true)` should make the dialog mount.
  it('opens when the parent trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<WiringHarness />);
    expect(screen.queryByTestId('bulk-upload-dialog')).toBeNull();
    await user.click(screen.getByTestId('upload-marbetes-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-dialog')).toBeInTheDocument();
    });
    // Title + form affordances become visible.
    expect(screen.getByTestId('bulk-upload-codes-input')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-stats')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-otp')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-submit')).toBeInTheDocument();
  });

  // T3 — typing 3 lines into the textarea leaves 2 valid + 1 invalid.
  // The stats line should reflect the live count.
  it('parses pasted codes live: 2 valid + 1 invalid shows "2 válidos, 1 inválido"', async () => {
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const textarea = screen.getByTestId('bulk-upload-codes-input');
    // userEvent.type treats `{enter}` as the Enter key, so we use it
    // instead of `\n` to actually produce newline characters in the
    // textarea. Each line uses the allowed alphabet.
    await user.type(textarea, 'CODE12345678{enter}CODE23456789{enter}bad');
    const stats = await screen.findByTestId('bulk-upload-stats');
    expect(stats.textContent).toMatch(/2\s*v[áa]lidos?/);
    expect(stats.textContent).toMatch(/1\s*inv[áa]lidos?/);
  });

  // T4 — reading a CSV file via the file input populates the textarea
  // and the parser reports the row count. We bypass FileReader's
  // async-ness via waitFor on the stats line.
  it('reads a CSV file via the file input and populates the textarea', async () => {
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const file = new File(
      ['CODEFILE0001\nCODEFILE0002\nCODEFILE0003\n'],
      'marbetes.csv',
      { type: 'text/csv' },
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    // After the FileReader resolves and setText runs, the stats should
    // reflect 3 valid rows. We wait for the textarea content to mirror
    // the file body so we are not racing the FileReader promise.
    await waitFor(() => {
      const ta = screen.getByTestId('bulk-upload-codes-input') as HTMLTextAreaElement;
      expect(ta.value).toContain('CODEFILE0001');
    });
    const stats = await screen.findByTestId('bulk-upload-stats');
    expect(stats.textContent).toMatch(/3\s*v[áa]lidos?/);
  });

  // T5 — submit is disabled while validCount === 0, regardless of OTP
  // being filled. It becomes enabled once at least one valid code is
  // present and a 6-digit OTP is typed.
  it('disables submit until at least one valid code AND a 6-digit OTP are present', async () => {
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const submit = screen.getByTestId('bulk-upload-submit');
    // No codes, no OTP → disabled.
    expect(submit).toBeDisabled();
    // Codes present, no OTP → still disabled.
    await user.type(
      screen.getByTestId('bulk-upload-codes-input'),
      'CODEABCDEFG',
    );
    expect(submit).toBeDisabled();
    // Codes + OTP → enabled.
    await typeOtp(user, '123456');
    expect(submit).not.toBeDisabled();
  });

  // T6 — submit fires POST /api/v1/marbetes/bulk with the x-otp-code
  // header and a JSON body of `{ items: [...] }`. On 200 the parent
  // receives onSaved once and the dialog closes (onOpenChange(false)).
  it('submits the bulk request with x-otp-code + items, fires onSaved, and closes', async () => {
    const handle = installFetchMock();
    const onSaved = jest.fn();
    const onOpenChange = jest.fn();
    const user = userEvent.setup();
    render(
      <BulkUploadDialog
        open={true}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );
    await user.type(
      screen.getByTestId('bulk-upload-codes-input'),
      'CODEABCDEFG{enter}CODEBCDEFGH',
    );
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const req = handle.read();
    expect(req.method).toBe('POST');
    expect(req.headers['x-otp-code']).toBe('123456');
    const parsed = JSON.parse(req.body) as { items: Array<{ code: string }> };
    expect(parsed.items).toEqual([
      { code: 'CODEABCDEFG' },
      { code: 'CODEBCDEFGH' },
    ]);
  });
});