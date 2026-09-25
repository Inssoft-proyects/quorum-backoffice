import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the read-only UI/UX audit suite.
 *
 * - The BackOffice is deployed on the dedicated subdomain
 *   `backoffice.quorum.asistentepro.mx` (see
 *   `apps/web/next.config.ts`, `infra/nginx/backoffice.quorum.asistentepro.mx.conf`
 *   and `odd/tasks/backoffice-cors-same-origin.md`). The Next.js app
 *   still uses `basePath: '/backoffice'` so the canonical login URL is
 *   `https://backoffice.quorum.asistentepro.mx/backoffice/login`. Specs
 *   MUST keep navigating via `/backoffice/...` (e.g. `/backoffice/login`,
 *   `/backoffice/dashboard`); the login helper in `helpers/login.ts`
 *   uses `/backoffice/login` as the single canonical login path.
 *   The retired path `https://quorum.asistentepro.mx/backoffice` is no
 *   longer served by the BackOffice — Jitsi owns that vhost now.
 * - Hits the LIVE production host (no local webServer).
 * - Single chromium project with a desktop viewport by default.
 * - Per-spec viewport overrides happen in `03-responsive.spec.ts`.
 * - Artifacts land under `apps/web/e2e/lookfeel/artifacts/` (gitignored).
 */
export default defineConfig({
  testDir: './',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e/lookfeel/artifacts/html-report', open: 'never' }],
  ],
  use: {
    // BackOffice subdomain (Next.js basePath '/backoffice' is appended
    // per spec, e.g. `/backoffice/login` → the deployed login page).
    baseURL: 'https://backoffice.quorum.asistentepro.mx',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});