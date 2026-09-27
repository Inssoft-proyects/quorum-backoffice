import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,        // shared DB state across tests
  workers: 1,                  // serialize against the same DB
  retries: 0,                  // don't auto-retry; explicit failures
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL,
    actionTimeout: 5_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Next standalone output is served by its generated server.js; `next start`
    // explicitly refuses output: 'standalone' and would leave Playwright waiting.
    command:
      'npm run build && mkdir -p .next/standalone/apps/web/.next && cp -R .next/static .next/standalone/apps/web/.next/static && PORT=3100 HOSTNAME=127.0.0.1 node .next/standalone/apps/web/server.js',
    url: `${baseURL}/backoffice/login`,
    timeout: 120_000,
    reuseExistingServer: !process.env['CI'],
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
