/**
 * E2E validation: backoffice login functional with username + pre-issued OTP.
 *
 * Reproduces the operator-issued OTP flow against production:
 *   - WU #1 nginx: /login redirects to /backoffice/login (already live)
 *   - WU #2 username form: input "username" instead of "email"
 *   - WU #3 5-minute countdown: client-side timer locks submit after expiry
 *   - WU #4 HMAC: API speaks HMAC against quorum-otp
 *
 * The "operator" step (issuing the OTP out-of-band) is simulated here by
 * making the same HMAC-signed POST /v1/otps call that the quorum-otp
 * operator console (POST /v1/operator/otps) would issue; the operator
 * UI is operator-only and not exposed publicly.
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";

const ORIGIN = "https://backoffice.quorum.asistentepro.mx";
const USERNAME = "admin";
const SCOPE = "login";

function kubectl(args) {
  return execSync(`kubectl ${args}`, { encoding: "utf-8" });
}

function getHmacSecret() {
  const b64 = kubectl(
    `-n quorum-backoffice get secret quorum-backoffice-api-secret -o jsonpath='{.data.OTP_SERVICE_TOKEN}'`,
  );
  return Buffer.from(b64, "base64").toString("utf-8");
}

function issueOperatorOtp(secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ subject: USERNAME, scope: SCOPE });
  const sig = createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");
  const authHeader = `HMAC quorum-backoffice ${ts} ${sig}`;
  const out = execSync(
    `curl -sS -X POST http://127.0.0.1:4200/v1/otps ` +
      `-H "authorization: ${authHeader}" ` +
      `-H "content-type: application/json" ` +
      `-d '${body}'`,
    { encoding: "utf-8" },
  );
  const parsed = JSON.parse(out);
  if (!parsed.token) {
    throw new Error(`issue failed: ${out}`);
  }
  return { token: parsed.token, expiresAt: parsed.expires_at, ttlSeconds: parsed.ttl_seconds };
}

(async () => {
  console.log("=".repeat(60));
  console.log("E2E login probe — username + pre-issued OTP (5 min window)");
  console.log("=".repeat(60));

  // Operator step: issue a fresh OTP for subject=admin, scope=login.
  console.log("\n[0] Operator step: issue OTP via quorum-otp /v1/otps (HMAC)");
  const secret = getHmacSecret();
  const otp = issueOperatorOtp(secret);
  console.log(`    token=${otp.token}  ttl=${otp.ttlSeconds}s  expiresAt=${otp.expiresAt}`);
  console.log("    ✓ PASS");

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
    throw new Error("FAIL: /login did not redirect to /backoffice/login");
  }
  console.log("    ✓ PASS");

  // Step 2: GET /backoffice/login → expect 200 + login form with username input
  console.log("\n[2] GET /backoffice/login (username form, NOT email)");
  const nav2 = await page.goto(`${ORIGIN}/backoffice/login`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  console.log(`    status: ${nav2.status()}`);
  const formInfo = await page.evaluate(() => {
    const usernameInput = document.querySelector(
      'input[name="username"][data-testid="login-username"]',
    );
    const emailInput = document.querySelector('input[name="email"]');
    const otpInput = document.querySelector('input[name="otp"][data-testid="login-otp"]');
    const submitBtn = document.querySelector(
      'button[data-testid="login-submit"]',
    );
    const countdown = document.querySelector('[data-testid="otp-countdown"]');
    return {
      hasUsernameInput: !!usernameInput,
      hasEmailInput: !!emailInput,
      hasOtpInput: !!otpInput,
      submitText: submitBtn?.innerText ?? null,
      hasCountdown: !!countdown,
      countdownText: countdown?.innerText ?? null,
    };
  });
  console.log(`    form:   ${JSON.stringify(formInfo)}`);
  if (!formInfo.hasUsernameInput || !formInfo.hasOtpInput) {
    throw new Error("FAIL: expected username + OTP form");
  }
  if (formInfo.hasEmailInput) {
    throw new Error("FAIL: form should not contain email input anymore");
  }
  if (!formInfo.hasCountdown) {
    throw new Error("FAIL: 5-minute countdown missing");
  }
  if (!formInfo.countdownText.includes("Expira en")) {
    throw new Error(
      `FAIL: countdown text should say 'Expira en', got: ${formInfo.countdownText}`,
    );
  }
  console.log("    ✓ PASS — username form + countdown visible");

  // Step 3: fill username + OTP, submit
  console.log(`\n[3] POST /api/v1/auth/login (single-step, username + otp)`);
  await page.fill('input[name="username"]', USERNAME);
  // Type each char of the OTP to fire React state updates
  await page.fill('input[name="otp"]', "");
  for (const ch of otp.token) {
    await page.keyboard.type(ch);
  }
  // Wait for the button to be enabled
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button[data-testid="login-submit"]');
      return b && !b.disabled;
    },
    { timeout: 5000 },
  );
  const loginWait = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/auth/login") &&
      r.request().method() === "POST",
    { timeout: 15000 },
  );
  await page.click('button[data-testid="login-submit"]');
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
  const sessionBody = JSON.parse(loginResp.body);
  if (sessionBody.user?.role !== "admin") {
    throw new Error(`FAIL: expected user.role=admin, got ${JSON.stringify(sessionBody)}`);
  }
  console.log("    ✓ PASS — session issued for user admin");

  // Verify cookie
  const cookies = await ctx.cookies();
  const sid = cookies.find((c) => c.name === "__Host-sid");
  console.log(`    __Host-sid cookie: ${sid ? "set (" + sid.value.length + " chars)" : "MISSING"}`);
  if (!sid) throw new Error("FAIL: __Host-sid cookie not set");
  console.log("    ✓ PASS");

  // Step 4: GET /backoffice/dashboard with session
  console.log("\n[4] GET /backoffice/dashboard (with session cookie)");
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
  console.log("ALL CHECKS PASSED — username + pre-issued OTP login works");
  console.log("=".repeat(60));

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});