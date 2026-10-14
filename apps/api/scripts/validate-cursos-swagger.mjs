// Validates the /cursos/ Swagger UI render end-to-end with a real
// Chromium. Checks: page status, title, Swagger UI elements
// (info title, operation blocks, paths, summaries, tags), and
// captures console / page / network errors. Saves a full-page
// screenshot for visual inspection.
//
// Run from the repo root:
//   node apps/api/scripts/validate-cursos-swagger.mjs
//
// Optional override (defaults to the production host):
//   CURSOS_SWAGGER_URL=https://backoffice.inecuni.com/cursos/ \
//     node apps/api/scripts/validate-cursos-swagger.mjs
import { chromium } from 'playwright';

const URL = (process.env.CURSOS_SWAGGER_URL ?? 'https://backoffice.inecuni.com/cursos/').replace(/\/+$/, '');
const SPEC_URL = `${URL}/openapi.yaml`;
const SCREENSHOT = '/tmp/cursos-swagger.png';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const requestFailures = [];
const specResponseStatus = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
  if (msg.type() === 'warning') consoleWarnings.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('requestfailed', (req) => {
  requestFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`);
});
page.on('response', (resp) => {
  if (resp.url() === SPEC_URL) {
    specResponseStatus.push(resp.status());
  }
});

const response = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for Swagger UI to render at least one operation block.
let opCount = 0;
let renderTimedOut = false;
try {
  await page.waitForSelector('.opblock', { timeout: 25000 });
  opCount = await page.locator('.opblock').count();
} catch {
  renderTimedOut = true;
}
// Give the UI a moment to fully populate (info, tags, deep links).
await page.waitForTimeout(2000);

const pageTitle = await page.title();
const infoTitle = (await page.locator('.info .title').first().textContent().catch(() => null))?.trim() ?? null;
const infoVersion = (await page.locator('.info .version').first().textContent().catch(() => null))?.trim() ?? null;
const opPaths = (await page.locator('.opblock-summary-path').allTextContents().catch(() => [])).map((s) => s.trim()).filter(Boolean);
const opSummaries = (await page.locator('.opblock-summary-description').allTextContents().catch(() => [])).map((s) => s.trim()).filter(Boolean);
const tagNames = (await page.locator('.opblock-tag').allTextContents().catch(() => [])).map((s) => s.trim()).filter(Boolean);
const bodyText = (await page.locator('body').innerText().catch(() => '')) ?? '';

const hasFetchError = /failed to fetch|fetch failed|loading remote.*failed|not a valid.*spec/i.test(bodyText);
const hasNotFound = /not found|404/i.test(bodyText) && !/Lista el catálogo/.test(bodyText);

await page.screenshot({ path: SCREENSHOT, fullPage: true });
await browser.close();

const report = {
  pageStatus: response?.status() ?? null,
  pageTitle,
  infoTitle,
  infoVersion,
  opCount,
  tagNames,
  opPaths,
  opSummaries,
  specResponseStatus,
  renderTimedOut,
  consoleErrors,
  consoleWarnings,
  pageErrors,
  requestFailures,
  hasFetchError,
  hasNotFound,
  bodyExcerpt: bodyText.slice(0, 500).replace(/\s+/g, ' ').trim(),
  screenshot: SCREENSHOT,
};

console.log(JSON.stringify(report, null, 2));

const passed =
  report.pageStatus === 200 &&
  /Quorum Cursos/.test(report.pageTitle ?? '') &&
  /Quorum Cursos/.test(report.infoTitle ?? '') &&
  report.opCount >= 2 &&
  report.opPaths.some((p) => /\/api\/v1\/cursos$/.test(p)) &&
  report.opPaths.some((p) => /\/api\/v1\/cursos\/\{id\}/.test(p)) &&
  report.opSummaries.some((s) => /Lista el catálogo/.test(s)) &&
  report.opSummaries.some((s) => /Detalle de un curso/.test(s)) &&
  report.consoleErrors.length === 0 &&
  report.pageErrors.length === 0 &&
  report.requestFailures.length === 0 &&
  !report.hasFetchError &&
  !report.hasNotFound &&
  report.specResponseStatus.every((s) => s >= 200 && s < 400);

console.log(passed ? '\nVALIDATION PASSED' : '\nVALIDATION FAILED');
process.exit(passed ? 0 : 1);
