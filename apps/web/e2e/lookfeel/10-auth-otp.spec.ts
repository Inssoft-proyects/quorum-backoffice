import { test, expect } from '@playwright/test';

/**
 * Polish WU v6 / A9 — email + OTP login e2e against staging.
 *
 * Coverage (UI-level, no real OTP delivery required):
 *  T10.1: /login renders the email step with the request-OTP button
 *         disabled until a valid email is typed.
 *  T10.2: clicking "Enviar código" advances to the OTP step and shows
 *         the email hint.
 *  T10.3: typing 6 digits and clicking "Ingresar" with an INVALID
 *         code surfaces an inline error and stays on the OTP step.
 *  T10.4: "Cambiar correo" returns to the email step.
 *  T10.5: "Reenviar código" stays on the OTP step (does not crash).
 *  T10.6: the legacy password input is GONE from the DOM (regression
 *         guard for the "credenciales en URL" finding — the form must
 *         never accept a password field).
 *
 * The full happy-path login (typed code → /dashboard) is intentionally
 * NOT covered here because it would require intercepting the SMTP
 * delivery. It runs against the local dev server in CI where the
 * mailer falls back to pino-warn logging and the test reads the code
 * from the API container logs.
 */

test.describe('Auth OTP (Polish WU v6 / A9)', () => {
  test('T10.1 login page shows the email step with disabled request button', async ({ page }) => {
    await page.goto('/backoffice/login');
    await expect(page.getByLabel('Correo')).toBeVisible();
    const requestBtn = page.getByTestId('login-request-otp');
    await expect(requestBtn).toBeVisible();
    await expect(requestBtn).toBeDisabled();
    await expect(page.getByTestId('login-otp')).toHaveCount(0);
  });

  test('T10.6 there is no password field anywhere in the login form', async ({ page }) => {
    await page.goto('/backoffice/login');
    // The page must not contain any <input type="password">. This is
    // the regression guard for the original finding that the URL could
    // be bookmarked with credentials.
    const passwordFields = await page.locator('input[type="password"]').count();
    expect(passwordFields).toBe(0);
  });

  test('T10.2 clicking Enviar código advances to the OTP step', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('admin@quorum.local');
    await page.getByTestId('login-request-otp').click();
    // Wait for the OTP step to render.
    await expect(page.getByTestId('login-otp')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('login-email-hint')).toContainText('admin@quorum.local');
    await expect(page.getByTestId('login-back')).toBeVisible();
    await expect(page.getByTestId('login-resend-otp')).toBeVisible();
  });

  test('T10.3 submitting an invalid OTP surfaces an inline error', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('admin@quorum.local');
    await page.getByTestId('login-request-otp').click();
    await expect(page.getByTestId('login-otp')).toBeVisible({ timeout: 10_000 });
    // Paste a deliberately invalid 6-digit code into the OtpInput's
    // first box; the OtpInput's onPaste handler fills all six boxes in
    // one go.
    const firstBox = page.getByLabel('Digit 1 of 6');
    await firstBox.click();
    await firstBox.fill('0');
    await page.evaluate(() => {
      const input = document.activeElement as HTMLInputElement | null;
      if (input) {
        const dt = new DataTransfer();
        dt.setData('text/plain', '000000');
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      }
    });
    // Submit the OTP; the backend will respond 401 invalid_otp because
    // the mock OTP service only accepts '123456'.
    await page.getByTestId('login-submit-otp').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 10_000 });
    // We never reached the dashboard.
    expect(new URL(page.url()).pathname).not.toContain('/dashboard');
  });

  test('T10.4 Cambiar correo returns to the email step', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('admin@quorum.local');
    await page.getByTestId('login-request-otp').click();
    await expect(page.getByTestId('login-otp')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('login-back').click();
    await expect(page.getByTestId('login-request-otp')).toBeVisible();
    await expect(page.getByTestId('login-otp')).toHaveCount(0);
  });

  test('T10.5 Reenviar código keeps the user on the OTP step', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('admin@quorum.local');
    await page.getByTestId('login-request-otp').click();
    await expect(page.getByTestId('login-otp')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('login-resend-otp').click();
    // Still on the OTP step (the resend triggers a second request but
    // does not navigate).
    await expect(page.getByTestId('login-otp')).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/\/login$/);
  });
});