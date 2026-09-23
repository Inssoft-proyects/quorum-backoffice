import type { Page } from '@playwright/test';

/**
 * Seeded users from the production backoffice (read-only audit).
 * Hard-coded because the audit must run against prod without depending on
 * CI-only environment variables that might differ across runners.
 */
export const SEED_USERS = {
  admin: { email: 'admin@quorum.local', password: 'admin1234' },
  auditor: { email: 'auditor@quorum.local', password: 'auditor1234' },
  operator: { email: 'operator@quorum.local', password: 'operator1234' },
} as const;

export type Role = keyof typeof SEED_USERS;

/** Authed screens reachable from the app shell sidebar. */
export const AUTHED_SCREENS: ReadonlyArray<string> = [
  '/dashboard',
  '/marbetes',
  '/dispositivos',
  '/audit',
];

/**
 * Logs the page in as the given role using the public login form.
 *
 * Navigates to `/backoffice/login`, fills the labelled Correo/Contraseña
 * inputs, clicks "Ingresar", and waits for the URL to reach `/dashboard`.
 * Throws if the URL never reaches `/dashboard` within the actionTimeout.
 *
 * The caller is responsible for clearing cookies between roles if multiple
 * roles are exercised in the same browser context (see `clearSession`).
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  const user = SEED_USERS[role];
  await page.goto('/backoffice/login');
  await page.getByLabel('Correo').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: /Ingresar/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/**
 * Clears the auth cookie so the next login is a fresh session. Use between
 * role tests when reusing a browser context for speed.
 */
export async function clearSession(page: Page): Promise<void> {
  await page.context().clearCookies();
}
