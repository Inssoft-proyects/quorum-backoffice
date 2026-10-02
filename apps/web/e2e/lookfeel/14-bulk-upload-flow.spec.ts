import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loginAs } from './helpers/login';

/**
 * T14 — Redesigned .xlsx bulk-upload modal (maquette v3,
 * carga-masiva-marbetes.html).
 *
 * Coverage:
 *  - Modal opens from the /marbetes inventory via the "Cargar
 *    marbetes" trigger with the canon heading + the template-link
 *    href pinned to /backoffice/assets/plantilla-carga-masiva-marbetes.xlsx.
 *  - Dropzone renders the empty state (drag prompt + select button)
 *    and flips to the selected state once a .xlsx is picked; the
 *    canon "Datos generados automáticamente" explainer is visible.
 *  - Submit transitions through the 6-stage processing checklist
 *    (read → rows → format → duplicates → existing → result) and
 *    lands on the result view "Carga procesada".
 *  - Result view shows the 4 error-category cards (length_out_of_range
 *    / invalid_chars / duplicate_in_file / already_exists) and the
 *    summary "M errores encontrados de N filas registradas".
 *  - "Subir nuevo archivo" resets the dialog back to the empty
 *    dropzone state.
 *
 * Safety:
 *  - The .xlsx upload IS a destructive write on the live env (it
 *    inserts rows into the inventory). The fixture uses an isolated
 *    13-digit 80000* code range so the run never collides with
 *    production data; the codes are also surfaced to the spec
 *    stdout + annotations for cleanup.
 *  - When E2E_BULK_WRITE is not "1", the destructive spec is
 *    skipped; the structural specs (dropzone empty / selected
 *    state, template link, cancel button) still run so the modal
 *    coverage is non-zero on every CI run.
 */

const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures/carga-masiva-fija.xlsx',
);

/**
 * The three 80000* codes the fixture creates; reported in stdout +
 * annotations so a follow-up `marbete.bulk_create` cleanup pass can
 * sweep them out. The codes are intentionally committed alongside
 * this spec so the spec is self-documenting.
 */
const FIXTURE_CREATED_CODES = [
  '8000012345678',
  '8000023456789',
  '8000034567890',
] as const;

/** Codes the fixture fails: 1 invalid_chars + 1 duplicate_in_file. */
const FIXTURE_FAILED_EXPECTED = {
  invalid_chars: 1,
  duplicate_in_file: 1,
} as const;

function fixtureAvailable(): boolean {
  return fs.existsSync(FIXTURE_PATH);
}

test.beforeAll(() => {
  if (!fixtureAvailable()) {
    test.skip(
      true,
      `fixture not found at ${FIXTURE_PATH}; regenerate with node apps/web/e2e/lookfeel/fixtures/generate.mjs`,
    );
  }
});

test.describe('T14 — bulk upload modal flow', () => {
  test('open the modal: dropzone empty state + template-link href', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    const trigger = page.getByTestId('upload-marbetes-trigger');
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Modal renders with the canon heading + description.
    const dialog = page.getByTestId('bulk-upload-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('bulk-upload-title')).toHaveText(
      'Carga masiva de marbetes',
    );

    // Dropzone renders the empty state (no file picked yet).
    const dropzone = page.getByTestId('bulk-upload-dropzone');
    await expect(dropzone).toBeVisible();
    await expect(page.getByTestId('bulk-upload-empty-state')).toBeVisible();
    await expect(page.getByTestId('bulk-upload-selected-state')).toBeHidden();

    // Template link points at the canonical asset path the API
    // packages declare (apps/web/public/assets/...). The backoffice
    // app uses basePath: '/backoffice', so the link href must
    // resolve to '/backoffice/assets/...'. We compare with
    // `String.endsWith` so the spec is robust to query strings +
    // cache busters the build might append.
    const templateLink = page.getByTestId('bulk-upload-template-link');
    await expect(templateLink).toBeVisible();
    const href = await templateLink.getAttribute('href');
    expect(href?.endsWith('/backoffice/assets/plantilla-carga-masiva-marbetes.xlsx')).toBe(
      true,
    );

    // Cancel closes the modal without firing any destructive call.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
  });

  test('dropzone flips to the selected state once a .xlsx is picked', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    await page.getByTestId('upload-marbetes-trigger').click();

    const dialog = page.getByTestId('bulk-upload-dialog');
    await expect(dialog).toBeVisible();

    // Wire setInputFiles via the hidden file input. We pick the
    // committed fixture (no UI selection flow needed) so the spec
    // is deterministic.
    const fileInput = page.locator('[data-testid="bulk-upload-file-input"]');
    await fileInput.setInputFiles(FIXTURE_PATH);

    // Selected state surfaces + empty state hides.
    await expect(page.getByTestId('bulk-upload-selected-state')).toBeVisible();
    await expect(page.getByTestId('bulk-upload-empty-state')).toBeHidden();
    await expect(page.getByTestId('bulk-upload-file-name')).toHaveText(
      'carga-masiva-fija.xlsx',
    );

    // Submit is gated by the OTP grant or a 6-digit OTP — without
    // either the button stays disabled. We do NOT type an OTP
    // here because the destructive test below is the only path
    // allowed to mint a write.
    await expect(page.getByTestId('bulk-upload-submit')).toBeDisabled();

    // Close the dialog without writing.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
  });

  /**
   * Destructive write path. Off by default — the upload creates
   * marbetes in the live inventory. Enable with E2E_BULK_WRITE=1.
   *
   * The fixture uses an isolated 13-digit 80000* code range so the
   * run never collides with production data. The created codes are
   * surfaced to stdout + annotations for cleanup.
   */
  test('upload the fixture and assert the processing overlay + result view', async ({ page }) => {
    if (process.env['E2E_BULK_WRITE'] !== '1') {
      test.skip(
        true,
        'set E2E_BULK_WRITE=1 to enable the destructive bulk upload',
      );
      return;
    }
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    await page.getByTestId('upload-marbetes-trigger').click();

    const dialog = page.getByTestId('bulk-upload-dialog');
    await expect(dialog).toBeVisible();

    // Pick the fixture.
    await page
      .locator('[data-testid="bulk-upload-file-input"]')
      .setInputFiles(FIXTURE_PATH);
    await expect(page.getByTestId('bulk-upload-selected-state')).toBeVisible();

    // Report the created codes for cleanup.
    console.log(`[bulk-write] created_codes=${FIXTURE_CREATED_CODES.join(',')}`);
    for (const code of FIXTURE_CREATED_CODES) {
      test.info().annotations.push({
        type: 'created-marbete-code',
        description: code,
      });
    }

    // The dialog gates the submit on either a 20-minute grant OR a
    // 6-digit OTP. Mint a fresh OTP per spec so reusing one across
    // runs doesn't burn the OTP service. We type it into the 6-box
    // OtpInput that the form renders.
    //
    // Fill pattern: focus the first box (aria-label "Digit 1 of 6")
    // and drive the shared keyboard so the OtpInput's auto-advance
    // handler fills the remaining five boxes. Mirrors the contract
    // already used by helpers/login.ts (`loginAs`) and the canonical
    // `fillOtpBoxes` helper in 10-auth-otp.spec.ts. The previous
    // pattern (`.fill(firstChar)` + per-character `keyboard.type`
    // for the rest) raced the React state update after `.fill()`:
    // the first box accepted the character but the parent state had
    // not yet advanced focus to box 2, so `keyboard.type` typed
    // into the still-focused box 1 and the OtpInput's per-field
    // maxLength swallowed the second character — submit stayed
    // disabled. The click+keyboard.type workflow avoids the race by
    // typing the full string against the live focus shifts.
    const firstOtpBox = page.getByRole('textbox', { name: 'Digit 1 of 6' });
    if ((await firstOtpBox.count()) > 0) {
      const freshOtp = await fetchFreshOtp();
      await firstOtpBox.click();
      await page.keyboard.type(freshOtp);
    }

    await page.getByTestId('bulk-upload-submit').click();

    // Processing overlay shows the 6-stage checklist.
    const overlay = page.getByTestId('bulk-upload-processing');
    await expect(overlay).toBeVisible();
    const stages = [
      'read',
      'rows',
      'format',
      'duplicates',
      'existing',
      'result',
    ] as const;
    for (const stage of stages) {
      await expect(
        page.getByTestId(`bulk-upload-stage-${stage}`),
      ).toBeVisible();
    }

    // The result view replaces the overlay once the server responds.
    const result = page.getByTestId('bulk-upload-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result).toContainText('Carga procesada');

    // Errors summary line — the fixture yields exactly 2 failures
    // (invalid_chars + duplicate_in_file), 8 total rows registered
    // (header + example + 6 data rows, with row 2 skipped). The
    // summary format is canon ("M errores encontrados de N filas").
    const errorsSummary = page.getByTestId('bulk-upload-result-errors-summary');
    await expect(errorsSummary).toContainText(
      `${Object.values(FIXTURE_FAILED_EXPECTED).reduce((a, b) => a + b, 0)} errores encontrados`,
    );

    // The 4 error-category cards with the expected counts.
    await expect(
      page.getByTestId('bulk-upload-result-metric-length_out_of_range'),
    ).toContainText('0');
    await expect(
      page.getByTestId('bulk-upload-result-metric-invalid_chars'),
    ).toContainText(String(FIXTURE_FAILED_EXPECTED.invalid_chars));
    await expect(
      page.getByTestId('bulk-upload-result-metric-duplicate_in_file'),
    ).toContainText(String(FIXTURE_FAILED_EXPECTED.duplicate_in_file));
    await expect(
      page.getByTestId('bulk-upload-result-metric-already_exists'),
    ).toContainText('0');

    // "Subir nuevo archivo" resets the dialog back to the empty
    // dropzone state. We do NOT actually upload a second file
    // here — the destructive write flow is over.
    await page.getByTestId('bulk-upload-upload-another').click();
    await expect(page.getByTestId('bulk-upload-empty-state')).toBeVisible();
    await expect(page.getByTestId('bulk-upload-selected-state')).toBeHidden();
  });
});

/**
 * Fetch a fresh admin OTP from the helper script. Mirrors the same
 * mint-a-fresh-OTP contract used by 12-maquette-parity.spec.ts: the
 * BackOffice OTPs are single-use, so reusing an env-provided one
 * would burn the first code across this spec's tests.
 *
 * The script lives at the repo root; resolve it via __dirname so the
 * spec is robust to `cd apps/web && npx playwright ...` invocations.
 */
async function fetchFreshOtp(): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const script = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'get-admin-otp.sh',
  );
  return execFileSync(script, [], {
    encoding: 'utf-8',
    // quorum-otp matches subject + scope on verify (pg-otp-repo). The
    // API derives the actor from the session EMAIL (actorFromRequest →
    // req.session.user.email = admin@quorum.local) and verifies with
    // scope marbete.bulk_create — so the token must be minted for that
    // exact subject+scope pair, not the script's login/admin defaults.
    env: {
      ...process.env,
      E2E_OTP_SUBJECT: 'admin@quorum.local',
      E2E_OTP_SCOPE: 'marbete.bulk_create',
    },
  }).trim();
}