import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Cosmetic browser smoke.
 *
 * Runs the real standalone build against a deterministic stub API
 * (`e2e/cosmetic/stub-api.mjs`) on loopback. This suite exists because jsdom
 * cannot see the two things this change is about: that the micro-interactions
 * actually run in a browser, and that the login hand-off still works
 * end-to-end after the shadcn primitives were replaced.
 *
 * Ports are fixed and local-only:
 *   - web  http://127.0.0.1:3210/backoffice
 *   - api  http://127.0.0.1:3211
 *
 * The build under test must be produced with
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:3211
 * because Next inlines that value at build time. `npm run test:cosmetic`
 * (scripts/cosmetic-smoke.sh) does the build and the run.
 *
 * Nothing here touches a real host, a database or the OTP issuer.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Origin only: absolute `/backoffice/...` paths are used per navigation,
    // matching how the app is mounted in production.
    baseURL: 'http://127.0.0.1:3210',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: 'node e2e/cosmetic/stub-api.mjs',
      cwd: process.cwd(),
      url: 'http://127.0.0.1:3211/api/v1/auth/me',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node server.js',
      cwd: path.resolve(process.cwd(), '.next/standalone/apps/web'),
      url: 'http://127.0.0.1:3210/backoffice/login',
      env: {
        PORT: '3210',
        HOSTNAME: '127.0.0.1',
        AUTH_COOKIE_NAME: 'sid',
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
