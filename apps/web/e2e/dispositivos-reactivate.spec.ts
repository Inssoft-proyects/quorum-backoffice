import { test, expect, type Page } from '@playwright/test';
import { issueOtp, otpEnvReady } from './otp-issuer';

/**
 * E2E: dispositivos logical-delete reactivation (UI).
 *
 * Validates the fix for "a revoked device loses all action buttons":
 * a revoked row must expose a "Reactivar" action, and clicking it (with a
 * fresh OTP) flips the device back to Activo and restores the Revocar action.
 *
 * Prerequisites (same as access-flow.spec.ts):
 *   - Backoffice API reachable at E2E_API_URL with seeded E2E users.
 *   - quorum-otp reachable at E2E_OTP_URL with E2E_OTP_SERVICE_NAME registered.
 */

const API = (process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const USERNAME = process.env['E2E_ADMIN_USERNAME'] ?? 'admin';
/** Destructive-action OTP subject = the canonical username (actorFromRequest). */
const ACTOR = USERNAME.toLowerCase();

/**
 * Logs in through the real UI form and returns the session cookie header
 * value. Mirrors access-flow.spec.ts (the login OTP field is a segmented
 * 6-box input; the code is typed into the first box and auto-advances).
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
  expect(sid, 'session cookie after UI login').toBeTruthy();
  return `${sid!.name}=${sid!.value}`;
}

test.describe('dispositivos reactivate (E2E)', () => {
  test.beforeEach(() => {
    test.skip(!otpEnvReady(), 'E2E_OTP_SERVICE_TOKEN is not set; skipping.');
  });

  test('revoked device exposes Reactivar and returns to Activo', async ({ page, request }) => {
    const sessionCookie = await loginUi(page);

    // Setup through the API (deterministic): create then revoke a device.
    const serialNumber = `SN-REACT-E2E-${Date.now()}`;
    const createOtp = await issueOtp(ACTOR, 'dispositivo.create');
    const created = await request.post(`${API}/api/v1/dispositivos`, {
      headers: { cookie: sessionCookie, 'x-otp-code': createOtp, 'content-type': 'application/json' },
      data: { serialNumber, brand: 'E2E', model: 'Reactivate' },
    });
    expect(created.ok(), `create failed: HTTP ${created.status()} ${await created.text()}`).toBeTruthy();
    const { id } = (await created.json()) as { id: number };

    const revokeOtp = await issueOtp(ACTOR, 'dispositivo.revoke');
    const revoked = await request.delete(`${API}/api/v1/dispositivos/${id}`, {
      headers: { cookie: sessionCookie, 'x-otp-code': revokeOtp, 'content-type': 'application/json' },
      data: { reason: 'e2e reactivate flow' },
    });
    expect(revoked.ok(), `revoke failed: HTTP ${revoked.status()} ${await revoked.text()}`).toBeTruthy();

    // UI: the revoked row must keep an action — the Reactivar button.
    await page.goto('/backoffice/dispositivos');
    const row = page.getByTestId(`dispositivo-row-${id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Revocado')).toBeVisible();
    const reactivateBtn = page.getByTestId(`reactivate-${id}`);
    await expect(reactivateBtn).toBeVisible();

    // Reactivate through the dialog with a fresh OTP.
    await reactivateBtn.click();
    const dialog = page.getByTestId('reactivate-dialog');
    await expect(dialog).toBeVisible();
    const reactivateOtp = await issueOtp(ACTOR, 'dispositivo.reactivate');
    const otpBoxes = dialog.getByRole('group', { name: 'Código OTP' }).getByRole('textbox');
    await otpBoxes.first().click();
    await otpBoxes.first().pressSequentially(reactivateOtp, { delay: 25 });
    await page.getByTestId('reactivate-submit').click();

    // The row flips back to Activo and the Revocar action is restored.
    await expect(row.getByText('Activo')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`revoke-${id}`)).toBeVisible();
    await expect(page.getByTestId(`reactivate-${id}`)).toBeHidden();
  });
});
