/**
 * E2E validation: backoffice login functional against production.
 *
 * Reproduces the user's reported failure (503 otp_issue_failed on
 * POST /api/v1/auth/login/request) and proves the full fix:
 *   - WU #1 nginx: /login redirects to /backoffice/login
 *   - WU #2 quorum-otp: real service listens on 127.0.0.1:4200
 *   - WU #3 HMAC: shared secret between API + otp
 *   - WU #4 configMap: OTP_SERVICE_URL flips to :4200/v1
 *
 * Reads the OTP from the API pod logs (`smtp_dev_mode_otp_logged`
 * event) because no SMTP is configured in staging — the mailer
 * falls back to logged delivery. The operator reads the OTP from the
 * log when validating staging; real production email delivery is a
 * separate follow-up.
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const ORIGIN = "https://backoffice.quorum.asistentepro.mx";
const EMAIL = "admin@quorum.local";

function kubectl(args) {
  return execSync(`kubectl ${args}`, { encoding: "utf-8" });
}

async function waitForOtpInLogs(timeoutMs = 30000) {
  const start = Date.now();
  let lastLog = "";
  while (Date.now() - start < timeoutMs) {
    const logs = kubectl(
      `-n quorum-backoffice logs -l app.kubernetes.io/name=quorum-backoffice-api --tail=200 --since=30s`,
    );
    // Pino format: `code: "ABC123"` (with colon, not JSON's `"code":"..."`).
    // Take the LAST match so we don't replay an older OTP after a retry.
    const matches = [...logs.matchAll(/smtp_dev_mode_otp_logged[\s\S]*?code:\s*"(\w+)"/g)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      return { code: last[1], log: lastLog };
    }
    lastLog = logs;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `OTP not found in logs within ${timeoutMs}ms. Last log:\n${lastLog.slice(-800)}`,
  );
}

(async () => {
  console.log("=".repeat(60));
  console.log("E2E login functional probe — backoffice.quorum.asistentepro.mx");
  console.log("=".repeat(60));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "es-MX",
  });
  const page = await ctx.newPage();

  const apiResponses = [];
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/v1/")) {
      let body = null;
      try { body = await resp.text(); } catch {}
      apiResponses.push({
        method: resp.request().method(),
        status: resp.status(),
        url: resp.url(),
        body: body ? body.slice(0, 400) : null,
      });
    }
  });

  // Step 1: GET /login → expect 302 → /backoffice/login
  console.log("\n[1] GET /login (no /backoffice prefix)");
  const nav1 = await page.goto(`${ORIGIN}/login`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  console.log(`    status: ${nav1.status()}`);
  console.log(`    final:  ${page.url()}`);
  if (!page.url().endsWith("/backoffice/login")) {
    throw new Error(`FAIL: /login did not redirect to /backoffice/login`);
  }
  console.log("    ✓ PASS");

  // Step 2: GET /backoffice/login → expect 200, form present
  console.log("\n[2] GET /backoffice/login");
  const nav2 = await page.goto(`${ORIGIN}/backoffice/login`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  console.log(`    status: ${nav2.status()}`);
  const hasForm = await page.locator(
    'input[name="email"][data-testid="login-email"]',
  ).count();
  console.log(`    form:   ${hasForm ? "present" : "MISSING"}`);
  if (!hasForm) throw new Error("FAIL: login form missing");
  console.log("    ✓ PASS");

  // Step 3: submit email → expect 200 OK (NOT 503 otp_issue_failed)
  console.log(`\n[3] POST /api/v1/auth/login/request (email=${EMAIL})`);
  await page.fill('input[name="email"]', EMAIL);
  await page.waitForFunction(
    () => {
      const b = document.querySelector(
        'button[data-testid="login-request-otp"]',
      );
      return b && !b.disabled;
    },
    { timeout: 5000 },
  );
  // IMPORTANT: set up the wait BEFORE the click, otherwise the response
  // can fire before the listener attaches.
  const reqWait = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/auth/login/request") &&
      r.request().method() === "POST",
    { timeout: 15000 },
  );
  await page.click('button[data-testid="login-request-otp"]');
  const reqRespObj = await reqWait.catch((e) => ({ err: e.message }));
  let reqResp = null;
  if (reqRespObj && reqRespObj.status) {
    let body = null;
    try { body = await reqRespObj.text(); } catch {}
    reqResp = {
      method: "POST",
      status: reqRespObj.status(),
      url: reqRespObj.url(),
      body,
    };
  }
  console.log(`    POST → HTTP ${reqResp?.status}  body=${reqResp?.body}`);
  if (reqResp?.status !== 200) {
    throw new Error(
      `FAIL: expected 200, got ${reqResp?.status} ${reqResp?.body}`,
    );
  }
  const reqBody = JSON.parse(reqResp.body);
  if (reqBody.ok !== true) {
    throw new Error(`FAIL: expected {ok:true}, got ${reqResp.body}`);
  }
  console.log("    ✓ PASS — no 503 otp_issue_failed");

  // Step 4: read OTP from API pod logs (mailer logged-fallback path)
  console.log("\n[4] Read OTP from API pod logs (mailer dev-mode fallback)");
  const { code: otp } = await waitForOtpInLogs(30000);
  console.log(`    OTP: ${otp}`);
  console.log("    ✓ PASS");

  // Step 5: fill OTP and submit second step
  console.log("\n[5] POST /api/v1/auth/login (with OTP)");
  // The OTP input is split into 6 single-digit boxes (aria-label "Digit N of 6").
  const digitInputs = page.locator('input[aria-label^="Digit"]');
  const digitCount = await digitInputs.count();
  if (digitCount !== 6) {
    throw new Error(`FAIL: expected 6 OTP digit inputs, found ${digitCount}`);
  }
  for (let i = 0; i < 6; i += 1) {
    // The OTP component listens for keystroke events, not value-change.
    // Playwright's `fill()` uses `setValue` which doesn't fire keydown.
    await digitInputs.nth(i).click();
    await page.keyboard.type(otp[i]);
  }
  // Give React a moment to re-render and enable the submit button.
  await page.waitForFunction(
    () => {
      const b = document.querySelector(
        'button[data-testid="login-submit-otp"]',
      );
      return b && !b.disabled;
    },
    { timeout: 5000 },
  );
  // Set up the wait BEFORE the click so we don't miss the response.
  const loginWait = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/auth/login") &&
      !r.url().includes("/request") &&
      r.request().method() === "POST",
    { timeout: 15000 },
  );
  const verifyBtn = page.locator('button[data-testid="login-submit-otp"]');
  await verifyBtn.click();
  const loginRespObj = await loginWait.catch((e) => ({ err: e.message }));
  let loginResp = null;
  if (loginRespObj && loginRespObj.status) {
    let body = null;
    try { body = await loginRespObj.text(); } catch {}
    loginResp = {
      method: "POST",
      status: loginRespObj.status(),
      url: loginRespObj.url(),
      body,
    };
  }
  console.log(`    POST → HTTP ${loginResp?.status}  body=${loginResp?.body}`);
  if (loginResp?.status !== 200) {
    throw new Error(
      `FAIL: expected 200 login, got ${loginResp?.status} ${loginResp?.body}`,
    );
  }

  // Verify cookie
  const cookies = await ctx.cookies();
  const sid = cookies.find((c) => c.name === "__Host-sid");
  console.log(`    __Host-sid cookie: ${sid ? "set (" + sid.value.length + " chars)" : "MISSING"}`);
  if (!sid) throw new Error("FAIL: __Host-sid cookie not set");
  console.log("    ✓ PASS — session cookie issued");

  // Step 6: GET /backoffice/dashboard with session cookie
  console.log("\n[6] GET /backoffice/dashboard (with session cookie)");
  apiResponses.length = 0;
  const nav3 = await page.goto(`${ORIGIN}/backoffice/dashboard`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  console.log(`    status: ${nav3.status()}`);
  console.log(`    final:  ${page.url()}`);
  if (page.url().includes("/login")) {
    throw new Error("FAIL: session not honored — redirected to login");
  }
  console.log("    ✓ PASS — session is real");

  console.log("\n" + "=".repeat(60));
  console.log("ALL CHECKS PASSED — backoffice login is functional");
  console.log("=".repeat(60));

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});