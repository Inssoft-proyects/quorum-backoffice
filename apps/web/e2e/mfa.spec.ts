import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { issueOtp, otpEnvReady } from './otp-issuer';

/**
 * M2 — `/mfa` page end-to-end against the running stack.
 *
 * Exercises the three-factor flow against the real API + DB so the
 * full M1 service path (marbete lookup → student resolve → device
 * lookup → OTP verify → session cookie set) is validated from the
 * browser side.
 *
 * Prerequisites (mirrors access-flow.spec.ts):
 *   - reachable quorum-otp (E2E_OTP_URL) + E2E_OTP_* env vars,
 *   - reachable Backoffice API (E2E_API_URL) seeded with admin +
 *     a `students_cache` row (canvas_user_id = 9001):
 *
 *       INSERT INTO students_cache
 *         (canvas_user_id, full_name, email, is_active)
 *       VALUES (9001, 'Smoke Student', 'smoke@quorum.local', TRUE);
 *
 *   The test is skipped via `otpEnvReady()` when the OTP service
 *   is not configured so a bare runner surfaces as "skipped"
 *   rather than "failed".
 *
 * Coverage:
 *
 *   1. **Happy path** — admin seeds a marbete + device bound to the
 *      seeded student, the student types the three factors on the
 *      MFA page, and lands on the requested `next` URL.
 *   2. **Invalid OTP** — a wrong 6-char OTP triggers
 *      `deny.otp_invalid` and the page stays on `/mfa` with the
 *      Spanish error visible.
 *   3. **Marbete mismatch** — a marbete code the DB does not know
 *      triggers `deny.marbete_unknown` and the page stays on `/mfa`.
 */

const API = (process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const USERNAME = process.env['E2E_ADMIN_USERNAME'] ?? 'admin';
const EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@quorum.local';
const CANVAS_USER_ID = 9001;

const MARBETE_CODE_PREFIX = 'MFA-E2E';

interface Provisioned {
  marbeteCode: string;
  serialNumber: string;
}

/**
 * Admin logs in through the operator login UI exactly as the
 * access-flow spec does (see `apps/web/e2e/access-flow.spec.ts`).
 * The login form uses the segmented OTP input; `pressSequentially`
 * is required because `fill()` on the group testid does NOT
 * propagate to the individual boxes (see B7b).
 */
async function loginUi(page: Page): Promise<string> {
  const otp = await issueOtp(USERNAME.toLowerCase(), 'login');
  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill(USERNAME);
  const otpBoxes = page.getByTestId('login-otp').getByRole('textbox');
  await otpBoxes.first().click();
  await otpBoxes.first().pressSequentially(otp, { delay: 25 });
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => /sid$/.test(c.name));
  expect(sid, 'operator session cookie after UI login').toBeTruthy();
  return `${sid!.name}=${sid!.value}`;
}

/**
 * Creates a marbete bound to the seeded student and a device bound
 * to the same student, returning the wire-level marbete code and
 * device serial so the MFA form can fill them in.
 *
 * Uses three OTPs (marbete.create, dispositivo.create,
 * dispositivo.assign) issued out of band via the same HMAC wire
 * format the API speaks.
 */
async function provisionStudent(
  request: APIRequestContext,
  sessionCookie: string,
): Promise<Provisioned> {
  const ts = Date.now();
  const marbeteCode = `${MARBETE_CODE_PREFIX}-${ts}-${ts.toString().padStart(13, '0').slice(-5)}`;
  const serialNumber = `SN-MFA-${ts}`;

  const createMarbeteOtp = await issueOtp(EMAIL, 'marbete.create');
  const marbeteRes = await request.post(`${API}/api/v1/marbetes`, {
    headers: {
      cookie: sessionCookie,
      'x-otp-code': createMarbeteOtp,
      'content-type': 'application/json',
    },
    data: { code: marbeteCode, canvasUserId: CANVAS_USER_ID },
  });
  expect(
    marbeteRes.ok(),
    `create marbete failed: HTTP ${marbeteRes.status()} ${await marbeteRes.text()}`,
  ).toBeTruthy();

  const createDeviceOtp = await issueOtp(EMAIL, 'dispositivo.create');
  const deviceRes = await request.post(`${API}/api/v1/dispositivos`, {
    headers: {
      cookie: sessionCookie,
      'x-otp-code': createDeviceOtp,
      'content-type': 'application/json',
    },
    data: { serialNumber, brand: 'E2E', model: 'MfaFlow' },
  });
  expect(
    deviceRes.ok(),
    `create device failed: HTTP ${deviceRes.status()} ${await deviceRes.text()}`,
  ).toBeTruthy();
  const deviceBody = (await deviceRes.json()) as { id: number };

  const assignDeviceOtp = await issueOtp(EMAIL, 'dispositivo.assign');
  const assignRes = await request.post(`${API}/api/v1/dispositivos/${deviceBody.id}/assign`, {
    headers: {
      cookie: sessionCookie,
      'x-otp-code': assignDeviceOtp,
      'content-type': 'application/json',
    },
    data: { canvasUserId: CANVAS_USER_ID },
  });
  expect(
    assignRes.status(),
    `assign device failed: HTTP ${assignRes.status()} ${await assignRes.text()}`,
  ).toBe(200);

  return { marbeteCode, serialNumber };
}

/**
 * Types the three MFA factors into the page. The OTP input is a
 * segmented 6-box group under `mfa-otp`; we type into the first
 * box with `pressSequentially` so each box receives a real
 * onChange + focus advance (the same pattern the lookfeel login
 * helper uses — see `apps/web/e2e/lookfeel/helpers/login.ts`).
 */
async function fillMfaForm(
  page: Page,
  { marbeteCode, serialNumber, otp }: { marbeteCode: string; serialNumber: string; otp: string },
): Promise<void> {
  await page.getByTestId('mfa-marbete').fill(marbeteCode);
  await page.getByTestId('mfa-serial').fill(serialNumber);
  const otpBoxes = page.getByTestId('mfa-otp').getByRole('textbox');
  await otpBoxes.first().click();
  await otpBoxes.first().pressSequentially(otp, { delay: 25 });
}

test.describe('MFA page (E2E, M2)', () => {
  test.beforeEach(() => {
    test.skip(!otpEnvReady(), 'E2E_OTP_SERVICE_TOKEN is not set; skipping the MFA page suite.');
  });

  test('student with valid marbete + device + OTP lands on the requested next URL', async ({
    page,
    request,
  }) => {
    const sessionCookie = await loginUi(page);
    const { marbeteCode, serialNumber } = await provisionStudent(request, sessionCookie);

    // Scope mfa.access is the new value the M0 plan introduced; the
    // subject is the canvas_user_id stringified (matches what the
    // MfaAuthenticateService passes to OtpClient.verify).
    const mfaOtp = await issueOtp(String(CANVAS_USER_ID), 'mfa.access');

    await page.goto('/backoffice/mfa?next=%2Fdashboard');
    await fillMfaForm(page, { marbeteCode, serialNumber, otp: mfaOtp });
    await page.getByTestId('mfa-submit').click();

    // After success the form swaps to the success card and navigates
    // to `/dashboard` → under basePath `/backoffice` the resolved
    // URL is `/backoffice/dashboard`. The (authed) layout requires
    // an operator session, NOT the student MFA session, so a hard
    // redirect to `/login` is the expected fallback for the
    // student-only cookie. We assert the navigation succeeded away
    // from `/mfa` and matched the `next` URL pattern, which is
    // the contract the MFA page owns.
    await page.waitForURL((url) => !url.pathname.startsWith('/backoffice/mfa'), {
      timeout: 15_000,
    });
    expect(page.url()).toMatch(/\/backoffice\/dashboard$/);
  });

  test('invalid OTP keeps the user on /mfa and shows the typed deny.otp_invalid error', async ({
    page,
    request,
  }) => {
    const sessionCookie = await loginUi(page);
    const { marbeteCode, serialNumber } = await provisionStudent(request, sessionCookie);

    // Any non-empty 6-char uppercase alphanumeric is enough to pass
    // the OtpInput client-side validation; the backend will reject
    // it with deny.otp_invalid because it was never issued.
    await page.goto('/backoffice/mfa?next=%2Fdashboard');
    await fillMfaForm(page, { marbeteCode, serialNumber, otp: 'AAAAAA' });
    await page.getByTestId('mfa-submit').click();

    const alert = page.getByTestId('mfa-error');
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText(/Código dinámico incorrecto|expirado/i);
    await expect(page).toHaveURL(/\/backoffice\/mfa/);
  });

  test('unknown marbete code keeps the user on /mfa and shows deny.marbete_unknown', async ({
    page,
    request,
  }) => {
    const sessionCookie = await loginUi(page);
    const { serialNumber } = await provisionStudent(request, sessionCookie);
    const mfaOtp = await issueOtp(String(CANVAS_USER_ID), 'mfa.access');

    // The marbete code is what the DB has never seen — must be a
    // valid-shape string (8..128 chars) so it passes Zod and the
    // service can emit the deny.marbete_unknown code instead of a
    // 400 validation_error.
    const unknownMarbete = `UNKNOWN-CODE-${Date.now()}`;
    await page.goto('/backoffice/mfa?next=%2Fdashboard');
    await fillMfaForm(page, {
      marbeteCode: unknownMarbete,
      serialNumber,
      otp: mfaOtp,
    });
    await page.getByTestId('mfa-submit').click();

    const alert = page.getByTestId('mfa-error');
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText(/Marbete no encontrado/i);
    await expect(page).toHaveURL(/\/backoffice\/mfa/);
  });
});
