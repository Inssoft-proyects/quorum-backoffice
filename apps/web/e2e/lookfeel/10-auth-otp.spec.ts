import { test, expect, type Route } from '@playwright/test';

/**
 * Polish WU v6 / A9 — username + pre-issued OTP login form (UI only).
 *
 * BackOffice replaced the legacy email + request-code flow with a
 * single-step `username + OTP` form (see `apps/web/app/login/login-form-otp.tsx`).
 * The OTP is delivered out of band by the Quorum OTP service; the form
 * never issues or emails a code itself.
 *
 * Coverage (UI-level — every spec below routes the `/api/v1/auth/login`
 * call to a synthetic Playwright handler so NO real login request is
 * ever sent to the live API):
 *
 *   T10.1: /backoffice/login renders the form with a disabled submit
 *          button until both username and OTP satisfy validation.
 *   T10.2: the form has no email field and no "Enviar código" button —
 *          the request-code step is gone for good.
 *   T10.3: submitting valid {username, otp} posts the exact wire body
 *          to /api/v1/auth/login; the synthetic handler asserts the
 *          payload and replies with a 200 + minimal session shape.
 *   T10.4: an invalid OTP / failed login surfaces an inline error and
 *          stays on /backoffice/login (does not navigate to /dashboard).
 *   T10.5: typing 6 valid OTP characters (A–Z0–9) is normalised to
 *          uppercase before the wire call regardless of input casing.
 *   T10.6: there is no <input type="password"> anywhere in the login
 *          form (regression guard against the legacy password flow).
 *
 * The full happy-path against the live API is intentionally NOT covered
 * here; it is owned by the integration suite that runs with a
 * short-lived OTP issued by Quorum OTP, and by the seeded read-only
 * audit specs that drive `helpers/login.ts` with explicit
 * `E2E_<ROLE>_USERNAME` + `E2E_<ROLE>_OTP` environment variables.
 */

type LoginBody = { username?: unknown; otp?: unknown };

/**
 * Intercept the real `/api/v1/auth/login` request so the spec never
 * reaches the live API. The handler captures the request body so each
 * test can assert the exact `{ username, otp }` wire shape.
 */
async function interceptLogin(
  page: import('@playwright/test').Page,
  status: number,
  body: Record<string, unknown>,
): Promise<{ bodies: LoginBody[] }> {
  const bodies: LoginBody[] = [];
  await page.route('**/api/v1/auth/login', async (route: Route) => {
    const req = route.request();
    try {
      const parsed = JSON.parse(req.postData() ?? '{}') as LoginBody;
      bodies.push(parsed);
    } catch {
      bodies.push({});
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return { bodies };
}

test.describe('Auth OTP (Polish WU v6 / A9)', () => {
  test('T10.1 /backoffice/login renders with submit disabled until inputs are valid', async ({ page }) => {
    await page.goto('/backoffice/login');
    await expect(page.getByTestId('login-username')).toBeVisible();
    await expect(page.getByTestId('login-otp')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeDisabled();
  });

  test('T10.2 there is no email field, no request-code button, and no password input', async ({ page }) => {
    await page.goto('/backoffice/login');
    // The legacy two-step flow left these affordances behind. They must
    // not come back: the BackOffice now only accepts a pre-issued OTP.
    await expect(page.getByLabel('Correo')).toHaveCount(0);
    await expect(page.getByLabel('Contraseña')).toHaveCount(0);
    await expect(page.getByTestId('login-request-otp')).toHaveCount(0);
    await expect(page.getByTestId('login-back')).toHaveCount(0);
    await expect(page.getByTestId('login-resend-otp')).toHaveCount(0);
    const passwordFields = await page.locator('input[type="password"]').count();
    expect(passwordFields).toBe(0);
  });

  test('T10.3 valid {username, otp} posts the exact wire body and the form accepts the response', async ({
    page,
  }) => {
    const { bodies } = await interceptLogin(page, 200, {
      user: { id: 1, email: 'admin@example.test', role: 'admin' },
    });

    await page.goto('/backoffice/login');
    await page.getByTestId('login-username').fill('admin');
    await page.getByTestId('login-otp').fill('ABC123');
    await expect(page.getByTestId('login-submit')).toBeEnabled();
    await page.getByTestId('login-submit').click();

    // Synthetic handler received exactly { username, otp } — no email,
    // no password, no request-code artifacts on the wire.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ username: 'admin', otp: 'ABC123' });

    // The 200 response does NOT surface an inline error (the auth
    // context treats any non-throwing response as accepted). We do not
    // assert navigation because the intercepted handler does not mint
    // a real session cookie — the authed layout's server check would
    // bounce the user back to /login. Wire-shape + accept is the
    // contract under test here; end-to-end navigation lives behind
    // the guarded helper in `helpers/login.ts` with a real OTP.
    await expect(page.getByTestId('login-error')).toHaveCount(0);
  });

  test('T10.4 an invalid OTP surfaces an inline error and stays on /backoffice/login', async ({ page }) => {
    await interceptLogin(page, 401, { error: 'invalid_otp' });

    await page.goto('/backoffice/login');
    await page.getByTestId('login-username').fill('admin');
    await page.getByTestId('login-otp').fill('WRONG1');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe('/backoffice/login');
    // We never reached the dashboard.
    expect(page.url()).not.toContain('/dashboard');
  });

  test('T10.5 OTP input is normalised to uppercase on the wire regardless of input casing', async ({ page }) => {
    const { bodies } = await interceptLogin(page, 200, {
      user: { id: 1, email: 'admin@example.test', role: 'admin' },
    });

    await page.goto('/backoffice/login');
    await page.getByTestId('login-username').fill('admin');
    // Mix of lowercase letters + digits; the form forces uppercase
    // before posting so the wire body always matches the OTP alphabet.
    await page.getByTestId('login-otp').fill('ab12cd');
    await page.getByTestId('login-submit').click();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ username: 'admin', otp: 'AB12CD' });
  });

  test('T10.6 there is no <input type="password"> anywhere in the login form', async ({ page }) => {
    await page.goto('/backoffice/login');
    // Regression guard for the original finding that the URL could be
    // bookmarked with credentials: the form must never accept a
    // password field.
    const passwordFields = await page.locator('input[type="password"]').count();
    expect(passwordFields).toBe(0);
  });
});