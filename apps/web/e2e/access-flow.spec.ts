import { test, expect, type Page } from '@playwright/test';
import { issueOtp, otpEnvReady, signedAccessDecision } from './otp-issuer';

/**
 * E2E access flow — the user-visible vertical for the Canvas/Jitsi
 * federated access prerequisites shipped in B1-B3:
 *
 *   1. Access: single-step `username + pre-issued OTP` login.
 *   2. B2: admin-only, OTP-gated device → student assignment with audit.
 *   3. B3: machine-to-machine access decision (HMAC) with typed denials.
 *
 * Prerequisites (see RUNBOOK §"E2E test setup" and §"Manual smoke"):
 *   - a reachable `quorum-otp` (E2E_OTP_URL) and the E2E_OTP_* env vars,
 *   - the Backoffice API (E2E_API_URL) with
 *     `BACKOFFICE_SERVICE_TOKENS=demo-caller:demo-secret`,
 *   - seeded users (`npm run seed:e2e`) and one active student:
 *       INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
 *       VALUES (9001, 'Smoke Student', 'smoke@quorum.local', TRUE);
 *
 * Every OTP is issued out of band through the real quorum-otp HMAC API
 * with the exact (subject, scope) the API will verify:
 *   - login:               (lower(username), 'login')
 *   - destructive actions: (actor email, 'dispositivo.*')
 *   - access decision:     (String(canvas_user_id), 'access.decision')
 */

const API = (process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const USERNAME = process.env['E2E_ADMIN_USERNAME'] ?? 'admin';
const EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@quorum.local';
const CANVAS_USER_ID = 9001;

let device: { id: number; serialNumber: string } | null = null;

/**
 * Logs in through the real UI form and returns the session cookie
 * header value. The Playwright `request` fixture does not reliably
 * share the browser context cookie jar across origins, so the cookie
 * is captured here and forwarded explicitly on API calls.
 */
async function loginUi(page: Page): Promise<string> {
  const otp = await issueOtp(USERNAME.toLowerCase(), 'login');
  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill(USERNAME);
  // The OTP field is a segmented 6-box input (auto-advancing focus per
  // keystroke), so the code is typed into the first box instead of
  // fill()ing the wrapping group element.
  const otpBoxes = page.getByTestId('login-otp').getByRole('textbox');
  await otpBoxes.first().click();
  await otpBoxes.first().pressSequentially(otp, { delay: 25 });
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  const cookies = await page.context().cookies();
  const sid = cookies.find((c) => /sid$/.test(c.name));
  expect(sid, 'session cookie after UI login').toBeTruthy();
  return `${sid!.name}=${sid!.value}`;
}

test.describe('access flow (E2E)', () => {
  test.beforeEach(() => {
    test.skip(!otpEnvReady(), 'E2E_OTP_SERVICE_TOKEN is not set; skipping the access flow.');
  });

  test('username + issued OTP login lands on the dashboard', async ({ page }) => {
    await loginUi(page);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('admin assigns a device to the seeded student and the audit trail records it', async ({
    page,
    request,
  }) => {
    const sessionCookie = await loginUi(page);

    const serialNumber = `SN-E2E-${Date.now()}`;
    const createOtp = await issueOtp(EMAIL, 'dispositivo.create');
    const created = await request.post(`${API}/api/v1/dispositivos`, {
      headers: { cookie: sessionCookie, 'x-otp-code': createOtp, 'content-type': 'application/json' },
      data: { serialNumber, brand: 'E2E', model: 'AccessFlow' },
    });
    expect(created.ok(), `create device failed: HTTP ${created.status()} ${await created.text()}`).toBeTruthy();
    const createdBody = (await created.json()) as { id: number; serialNumber: string };
    expect(createdBody.serialNumber).toBe(serialNumber);
    device = { id: createdBody.id, serialNumber };

    // Negative first: no OTP header -> 401 otp_required, no state change.
    const noOtp = await request.post(`${API}/api/v1/dispositivos/${device.id}/assign`, {
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      data: { canvasUserId: CANVAS_USER_ID },
    });
    expect(noOtp.status()).toBe(401);
    expect(((await noOtp.json()) as { code: string }).code).toBe('otp_required');

    const assignOtp = await issueOtp(EMAIL, 'dispositivo.assign');
    const assigned = await request.post(`${API}/api/v1/dispositivos/${device.id}/assign`, {
      headers: { cookie: sessionCookie, 'x-otp-code': assignOtp, 'content-type': 'application/json' },
      data: { canvasUserId: CANVAS_USER_ID },
    });
    expect(assigned.status()).toBe(200);
    const assignedBody = (await assigned.json()) as { assignedStudentId: number | null };
    expect(assignedBody.assignedStudentId).toBeGreaterThan(0);

    // Audit: the API must expose the audited action with the OTP id.
    const audit = await request.get(`${API}/api/v1/audit?limit=100`, {
      headers: { cookie: sessionCookie },
    });
    expect(audit.ok()).toBeTruthy();
    const auditBody = (await audit.json()) as {
      items?: Array<{ action?: string; entityId?: string | number }>;
    };
    const rows = auditBody.items ?? [];
    expect(
      rows.some(
        (r) => r.action === 'dispositivo.assign' && String(r.entityId) === String(device!.id),
      ),
    ).toBeTruthy();

    // And the operator sees it on the audit screen.
    await page.goto('/backoffice/audit');
    await expect(page.getByText('dispositivo.assign').first()).toBeVisible({ timeout: 10_000 });
  });

  test('access decision allows the owner device and denies after unassign', async ({
    page,
    request,
  }) => {
    const sessionCookie = await loginUi(page);
    expect(device, 'device from the assignment test').not.toBeNull();
    const serialNumber = device!.serialNumber;

    // Allow: a fresh single-use OTP bound to (canvas_user_id, access.decision).
    const otpProof = await issueOtp(String(CANVAS_USER_ID), 'access.decision');
    const allow = signedAccessDecision({
      device_id: serialNumber,
      otp_proof: otpProof,
      canvas_user_id: CANVAS_USER_ID,
    });
    const allowRes = await request.post(`${API}/api/v1/access-decisions`, {
      headers: { authorization: allow.authorization, 'content-type': 'application/json' },
      data: allow.rawBody,
    });
    expect(allowRes.status()).toBe(200);
    const allowBody = (await allowRes.json()) as { decision: string; student_id: number | null };
    expect(allowBody.decision).toBe('allow');
    expect(allowBody.student_id).toBeGreaterThan(0);

    // Transport auth: a bad signature is a 401 deny.idp_untrusted.
    const badSig = await request.post(`${API}/api/v1/access-decisions`, {
      headers: {
        authorization: `HMAC demo-caller ${Math.floor(Date.now() / 1000)} deadbeef`,
        'content-type': 'application/json',
      },
      data: JSON.stringify({ device_id: serialNumber, otp_proof: 'AAAAAA', canvas_user_id: CANVAS_USER_ID }),
    });
    expect(badSig.status()).toBe(401);
    expect(((await badSig.json()) as { code: string }).code).toBe('deny.idp_untrusted');

    // Policy denial: empty otp_proof -> deny.otp_missing (no serial leakage).
    const missing = signedAccessDecision({
      device_id: serialNumber,
      otp_proof: '',
      canvas_user_id: CANVAS_USER_ID,
    });
    const missingRes = await request.post(`${API}/api/v1/access-decisions`, {
      headers: { authorization: missing.authorization, 'content-type': 'application/json' },
      data: missing.rawBody,
    });
    expect(missingRes.status()).toBe(200);
    const missingBody = (await missingRes.json()) as { decision: string; denial: string };
    expect(missingBody.decision).toBe('deny');
    expect(missingBody.denial).toBe('deny.otp_missing');

    // Unassign (audited), then the SAME device is denied uniformly.
    const unassignOtp = await issueOtp(EMAIL, 'dispositivo.unassign');
    const unassigned = await request.post(`${API}/api/v1/dispositivos/${device!.id}/unassign`, {
      headers: { cookie: sessionCookie, 'x-otp-code': unassignOtp, 'content-type': 'application/json' },
    });
    expect(unassigned.status()).toBe(200);
    expect(((await unassigned.json()) as { assignedStudentId: number | null }).assignedStudentId).toBeNull();

    const denyProof = await issueOtp(String(CANVAS_USER_ID), 'access.decision');
    const deny = signedAccessDecision({
      device_id: serialNumber,
      otp_proof: denyProof,
      canvas_user_id: CANVAS_USER_ID,
    });
    const denyRes = await request.post(`${API}/api/v1/access-decisions`, {
      headers: { authorization: deny.authorization, 'content-type': 'application/json' },
      data: deny.rawBody,
    });
    expect(denyRes.status()).toBe(200);
    const denyBody = (await denyRes.json()) as { decision: string; denial: string };
    expect(denyBody.decision).toBe('deny');
    expect(denyBody.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(denyBody)).not.toContain(serialNumber);
  });
});
