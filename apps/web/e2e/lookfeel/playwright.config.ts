import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the read-only UI/UX audit suite.
 *
 * - Hits the LIVE production URL (no local webServer).
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
    baseURL: 'https://quorum.asistentepro.mx',
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
