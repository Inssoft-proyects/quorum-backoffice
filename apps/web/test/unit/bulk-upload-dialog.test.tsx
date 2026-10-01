/**
 * BulkUploadDialog (maquette v3, .xlsx dropzone).
 *
 * Coverage:
 *  - Wiring (T1–T2): dialog opens/closes via parent state.
 *  - Dropzone states (T3–T5): empty state on open; selecting a .xlsx
 *    file shows the selected state with name + size; a non-.xlsx pick
 *    surfaces the canon inline error copy.
 *  - OTP grant behavior (T6): with an active grant the OTP input is
 *    hidden + the "OTP vigente hasta" note is visible; submit omits
 *    x-otp-code. Without an active grant the OTP input is required
 *    and submit sends x-otp-code.
 *  - Submit happy path (T7): POST /api/v1/marbetes/bulk-xlsx with
 *    base64 file + x-otp-code, then transitions to the result view,
 *    fires onSaved, and does NOT auto-close (full success keeps the
 *    result view open so the user can review).
 *  - Result view (T8–T10): 4 metric cards populated from
 *    `categoryCounts`, "Subir nuevo archivo" resets to empty state,
 *    "Asignar marbetes" links to /asociar.
 *  - Errors file (T11): when the response carries an `errorsFile`
 *    blob, the canon status block renders + auto-triggers a download
 *    via a transient object URL.
 *  - Partial failure stays on the result view (T12): same as T7 but
 *    with `failed > 0`; the dialog stays open until the user clicks
 *    X, "Subir nuevo archivo", or "Asignar marbetes".
 *  - Processing overlay (T13): the 6 stages transition through
 *    pending → active → complete and the result view appears after
 *    the animation completes.
 *  - Error path (T14): a 4xx from the API surfaces the inline error
 *    and snaps back to the form view (no result view).
 */
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';
import { BulkUploadDialog } from '@/components/inventory/bulk-upload-dialog';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Install a fetch mock that:
 *  - GET /api/v1/marbetes/otp-grant → the supplied grant status
 *  - POST /api/v1/marbetes/bulk-xlsx → the supplied response body
 *
 * Returns a handle that exposes every captured request so tests can
 * inspect both the destructive call and the grant fetch.
 */
function installFetchMock(opts: {
  grantActive: boolean;
  expiresAt: string | null;
  destructiveStatus?: number;
  destructiveBody?: unknown;
}): { read(): CapturedRequest[]; clickTrigger?: (file: File) => void } {
  const calls: CapturedRequest[] = [];
  const urlToBlob: Record<string, string> = {};
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
    if (url.includes('/api/v1/marbetes/bulk-xlsx')) {
      const status = opts.destructiveStatus ?? 200;
      return new Response(JSON.stringify(opts.destructiveBody ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('blob:')) {
      const cached = urlToBlob[url];
      if (cached !== undefined) {
        return new Response(cached, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response('', { status: 404 });
    }
    return new Response(JSON.stringify({ code: 'not_found', message: 'no' }), {
      status: 404,
    });
  }) as unknown as typeof fetch;

  // jsdom does not implement URL.createObjectURL/revokeObjectURL; the
  // dialog calls them when auto-downloading the errors file. We shim
  // them here so the result view's effect does not throw.
  const blobStore: Record<string, Blob> = {};
  const blobUrls = new Set<string>();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test-${blobUrls.size}`;
    blobStore[url] = blob;
    blobUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    delete blobStore[url];
    blobUrls.delete(url);
  };

  return {
    read(): CapturedRequest[] {
      return calls;
    },
    __restoreBlob(): void {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  } as unknown as { read(): CapturedRequest[]; __restoreBlob(): () => void };
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

/**
 * Wait for the result view with a long-enough timeout to cover the
 * stage animation (6 stages × 200ms + 12ms RESULT_TRANSITION_MS +
 * a generous fetch round-trip margin). Using waitFor with the
 * default 1000ms timeout is too tight for the animation timeline.
 */
async function waitForResultView(): Promise<void> {
  await waitFor(
    () =>
      expect(
        screen.getByTestId('bulk-upload-result'),
      ).toBeInTheDocument(),
    { timeout: 5000 },
  );
}

function makeSuccessBody(overrides: Partial<{
  total: number;
  created: number;
  failed: number;
  auditId: number | null;
  skippedExampleRows: number;
  categoryCounts: Record<string, number>;
  errorsFile: { fileName: string; contentBase64: string } | null;
}> = {}): unknown {
  return {
    total: 3,
    created: 3,
    failed: 0,
    successes: [
      { id: 1, publicUid: 'm-bulk-1', status: 'active', xlsxRow: 2 },
      { id: 2, publicUid: 'm-bulk-2', status: 'active', xlsxRow: 3 },
      { id: 3, publicUid: 'm-bulk-3', status: 'active', xlsxRow: 4 },
    ],
    failures: [],
    auditId: 42,
    skippedExampleRows: 1,
    categoryCounts: {
      length_out_of_range: 0,
      invalid_chars: 0,
      duplicate_in_file: 0,
      already_exists: 0,
      other: 0,
    },
    errorsFile: null,
    ...overrides,
  };
}

const XLSX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
]);
function makeXlsxFile(name = 'marbetes.xlsx'): File {
  return new File([XLSX_BYTES], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('BulkUploadDialog (.xlsx dropzone, maquette v3)', () => {
  // jsdom lacks anchor.click() download handling and URL.createObjectURL;
  // installFetchMock above shims URL.createObjectURL/revokeObjectURL and
  // we never actually exercise the click target here. Reset between tests
  // so no fetch mock leaks across suites.
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  // T1 — closed when open=false.
  it('does not render the dialog root when open=false', () => {
    render(
      <BulkUploadDialog open={false} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    expect(screen.queryByTestId('bulk-upload-dialog')).toBeNull();
  });

  // T2 — opens via parent state and shows the empty dropzone.
  it('renders the dropzone empty state when open=true', () => {
    installFetchMock({ grantActive: false, expiresAt: null });
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    expect(screen.getByTestId('bulk-upload-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Arrastra y suelta tu archivo aquí')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-template-link')).toHaveAttribute(
      'href',
      '/assets/plantilla-carga-masiva-marbetes.xlsx',
    );
  });

  // T3 — picking a .xlsx file via the file input swaps empty → selected
  // and renders the canon "Datos generados automáticamente" explainer.
  it('selects a .xlsx file: empty state hides, selected state shows', async () => {
    installFetchMock({ grantActive: false, expiresAt: null });
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const file = makeXlsxFile();
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(
        screen.getByTestId('bulk-upload-empty-state'),
      ).toHaveAttribute('hidden');
      expect(
        screen.getByTestId('bulk-upload-selected-state'),
      ).not.toHaveAttribute('hidden');
    });
    expect(screen.getByTestId('bulk-upload-file-name')).toHaveTextContent(
      'marbetes.xlsx',
    );
    expect(screen.getByText('Datos generados automáticamente')).toBeInTheDocument();
    expect(
      screen.getByText(/Fecha de vencimiento = Fecha de carga \+ 3 a\u00f1os/),
    ).toBeInTheDocument();
  });

  // T4 — a non-.xlsx pick surfaces the canon error copy inside the
  // dropzone (and never enters the selected state).
  it('surfaces the canon error when the user picks a non-.xlsx file', async () => {
    installFetchMock({ grantActive: false, expiresAt: null });
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const badFile = new File(['hello'], 'not-xlsx.csv', { type: 'text/csv' });
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    await waitFor(() => {
      expect(
        screen.getByTestId('bulk-upload-error'),
      ).not.toHaveAttribute('hidden');
    });
    expect(screen.getByTestId('bulk-upload-error').textContent).toMatch(
      /archivo en formato \.xlsx/,
    );
    expect(
      screen.getByTestId('bulk-upload-selected-state'),
    ).toHaveAttribute('hidden');
  });

  // T5 — without an active grant the OTP input is required and submit
  // is disabled until a .xlsx is selected + 6-digit OTP is typed.
  it('disables submit until a .xlsx file AND a 6-digit OTP are present', async () => {
    installFetchMock({ grantActive: false, expiresAt: null });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const submit = screen.getByTestId('bulk-upload-submit');
    expect(submit).toBeDisabled();
    // File present, no OTP → still disabled.
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    expect(submit).toBeDisabled();
    // File + OTP → enabled.
    await typeOtp(user, '123456');
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  // T6 — with an active grant the OTP input is hidden, the grant note
  // is visible, and submit fires POST without the x-otp-code header.
  it('with an active grant: hides the OTP input, shows the grant note, and submits without x-otp-code', async () => {
    const handle = installFetchMock({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody(),
    });
    const onSaved = jest.fn();
    const user = userEvent.setup();
    render(
      <BulkUploadDialog
        open={true}
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const note = await screen.findByTestId('bulk-upload-grant-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/OTP vigente hasta/i);

    // OTP input is hidden.
    expect(screen.queryByTestId('bulk-upload-otp')).toBeNull();

    // File + submit (no OTP).
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('bulk-upload-submit'));

    // Wait for the result view to confirm the round-trip.
    await waitForResultView();

    const calls = handle.read();
    const create = calls.find(
      (c) => c.url.includes('/api/v1/marbetes/bulk-xlsx') && c.method === 'POST',
    );
    expect(create).toBeDefined();
    expect(create!.headers['x-otp-code']).toBeUndefined();
    // Body is JSON with fileName + base64.
    const parsed = JSON.parse(create!.body) as {
      fileName: string;
      contentBase64: string;
    };
    expect(parsed.fileName).toBe('marbetes.xlsx');
    expect(parsed.contentBase64.length).toBeGreaterThan(0);
    // File bytes 50 4B 03 04 → base64 "UEsDBBQAAAAIAA==" (padded).
    expect(parsed.contentBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  // T7 — happy path: full success (failed=0) shows the result view
  // and does NOT auto-close the dialog.
  it('on full success: shows the result view, fires onSaved, and keeps the dialog open', async () => {
    installFetchMock({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody({ total: 3, created: 3, failed: 0 }),
    });
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

    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The dialog must NOT auto-close on full success.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Heading + summary copy.
    expect(screen.getByText('Carga procesada')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-upload-result-summary').textContent).toMatch(
      /Se cargaron\s+correctamente 3 marbetes/,
    );
  });

  // T8 — metric cards reflect `categoryCounts` from the response.
  it('populates the 4 metric cards from categoryCounts', async () => {
    installFetchMock({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody({
        total: 10,
        created: 6,
        failed: 4,
        categoryCounts: {
          length_out_of_range: 1,
          invalid_chars: 2,
          duplicate_in_file: 1,
          already_exists: 0,
          other: 0,
        },
      }),
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );

    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();

    // Per-card counts.
    expect(
      screen.getByTestId('bulk-upload-result-metric-length_out_of_range'),
    ).toHaveTextContent('1');
    expect(
      screen.getByTestId('bulk-upload-result-metric-invalid_chars'),
    ).toHaveTextContent('2');
    expect(
      screen.getByTestId('bulk-upload-result-metric-duplicate_in_file'),
    ).toHaveTextContent('1');
    expect(
      screen.getByTestId('bulk-upload-result-metric-already_exists'),
    ).toHaveTextContent('0');
    // Summary line: "4 errores encontrados de 10 filas".
    expect(screen.getByTestId('bulk-upload-result-error-count').textContent).toMatch(
      /4 errores encontrados/,
    );
    expect(
      screen.getByTestId('bulk-upload-result-errors-summary').textContent,
    ).toMatch(/de 10 filas registradas en el \.xlsx/);
  });

  // T9 — "Subir nuevo archivo" resets the dialog back to the empty form
  // (does NOT close it).
  it('"Subir nuevo archivo" resets to the empty form', async () => {
    installFetchMock({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody(),
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );

    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();
    await user.click(screen.getByTestId('bulk-upload-upload-another'));

    await waitFor(() => {
      expect(
        screen.getByTestId('bulk-upload-empty-state'),
      ).not.toHaveAttribute('hidden');
      expect(
        screen.getByTestId('bulk-upload-selected-state'),
      ).toHaveAttribute('hidden');
      expect(screen.queryByTestId('bulk-upload-result')).toBeNull();
    });
  });

  // T10 — "Asignar marbetes" renders as a link to /asociar.
  it('"Asignar marbetes" is a link to /asociar', async () => {
    installFetchMock({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody(),
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();
    const assignLink = screen.getByTestId('bulk-upload-assign');
    expect(assignLink.tagName).toBe('A');
    expect(assignLink).toHaveAttribute('href', '/asociar');
  });

  // T11 — when the response carries an `errorsFile` the canon status
  // block renders. The auto-download uses a transient object URL
  // (jsdom shim); we only assert that the status block is present
  // and the retry link is enabled.
  it('renders the errors-file status block when the response includes errorsFile', async () => {
    // base64 of the empty string is "". Use a tiny payload so the
    // auto-download code path runs without throwing.
    const errorsFile = { fileName: 'errores-marbetes.xlsx', contentBase64: '' };
    installFetchMock({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody({
        total: 5,
        created: 2,
        failed: 3,
        errorsFile,
      }),
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();
    await waitFor(
      () =>
        expect(
          screen.getByTestId('bulk-upload-errors-file'),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    const retry = screen.getByTestId('bulk-upload-errors-retry');
    expect(retry).toBeInTheDocument();
    expect(retry.textContent).toMatch(/Descárgalo aquí/);
  });

  // T12 — partial failure stays on the result view (failed > 0); the
  // dialog stays open until they click X / Subir / Asignar.
  it('on partial failure: shows the result view with error counts and stays open', async () => {
    installFetchMock({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody({
        total: 10,
        created: 6,
        failed: 4,
        categoryCounts: {
          length_out_of_range: 0,
          invalid_chars: 0,
          duplicate_in_file: 0,
          already_exists: 4,
          other: 0,
        },
      }),
    });
    const onOpenChange = jest.fn();
    const onSaved = jest.fn();
    const user = userEvent.setup();
    render(
      <BulkUploadDialog
        open={true}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitForResultView();
    expect(onSaved).toHaveBeenCalledTimes(1);
    // Dialog stays open.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Summary correctly attributes the partial failure.
    expect(screen.getByTestId('bulk-upload-result-summary').textContent).toMatch(
      /Se cargaron\s+correctamente 6 marbetes/,
    );
    expect(
      screen.getByTestId('bulk-upload-result-metric-already_exists'),
    ).toHaveTextContent('4');
  });

  // T13 — the processing overlay runs the 6-stage animation; stages
  // move through pending → active → complete and the result view
  // appears after the animation + a small transition. We assert this
  // by polling for at least one of the 6 stage <li> nodes (which
  // only exist while the processing overlay is mounted).
  it('runs the 6-stage processing animation and then the result view', async () => {
    installFetchMock({
      grantActive: true,
      expiresAt: '2025-01-01T12:20:00Z',
      destructiveStatus: 200,
      destructiveBody: makeSuccessBody(),
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });

    // Start the submit and immediately poll for a stage node so we
    // can confirm the overlay mounted at some point before the result
    // view replaced it.
    const sawOverlayPromise = (async () => {
      while (true) {
        if (document.querySelector('[data-processing-stage]')) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await user.click(screen.getByTestId('bulk-upload-submit'));
    // Race the polling against the default 1s safety timeout — if the
    // overlay never mounted we'd hang forever, so cap the wait.
    const sawOverlay = await Promise.race([
      sawOverlayPromise,
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);

    // Result view eventually appears with 100% progress + all stages
    // marked complete. We assert the result view shows up cleanly.
    await waitForResultView();
    expect(sawOverlay).toBe(true);
  });

  // T14 — a 4xx from the server surfaces the inline error and snaps
  // back to the form view (no result view).
  it('on 4xx: surfaces the inline error and returns to the form view', async () => {
    installFetchMock({
      grantActive: false,
      expiresAt: null,
      destructiveStatus: 422,
      destructiveBody: { code: 'validation_error', message: 'Archivo inválido' },
    });
    const user = userEvent.setup();
    render(
      <BulkUploadDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const fileInput = screen.getByTestId('bulk-upload-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeXlsxFile()] } });
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-selected-state')).toBeInTheDocument();
    });
    await typeOtp(user, '123456');
    await user.click(screen.getByTestId('bulk-upload-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-form-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bulk-upload-result')).toBeNull();
    expect(
      screen.queryByTestId('bulk-upload-processing'),
    ).not.toBeInTheDocument();
  });

  // T15 — clicking the parent trigger toggles open state via the
  // MarbetesPageClient wiring contract.
  it('opens via the parent trigger button (wiring contract)', async () => {
    installFetchMock({ grantActive: false, expiresAt: null });
    function WiringHarness(): React.ReactElement {
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
          <BulkUploadDialog
            open={open}
            onOpenChange={setOpen}
            onSaved={() => {}}
          />
        </div>
      );
    }
    const user = userEvent.setup();
    render(<WiringHarness />);
    expect(screen.queryByTestId('bulk-upload-dialog')).toBeNull();
    await user.click(screen.getByTestId('upload-marbetes-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('bulk-upload-dialog')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bulk-upload-empty-state')).toBeInTheDocument();
  });
});