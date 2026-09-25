/**
 * Smoke test for the production 5-minute countdown:
 *   - countdown starts at 5:00 (300 seconds)
 *   - countdown decrements in real time (one tick per second)
 *   - countdown format is MM:SS
 *
 * The full state-machine test (warning + expired + reset) lives in
 * scripts/e2e-countdown-states.mjs, which temporarily shrinks the
 * OTP_TTL_SECONDS to 10 seconds for fast iteration.
 */
import { chromium } from "playwright";

const ORIGIN = "https://backoffice.quorum.asistentepro.mx";

function fmt(text) {
  return text.replace(/\s+/g, " ").trim();
}

(async () => {
  console.log("=".repeat(60));
  console.log("Countdown smoke test — production 5-minute window");
  console.log("=".repeat(60));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}/backoffice/login`, { waitUntil: "networkidle" });

  const t0 = await page.locator('[data-testid="otp-countdown"]').innerText();
  console.log(`  t=0:    "${fmt(t0)}"`);
  if (!t0.includes("5:00")) {
    throw new Error(`FAIL: expected initial countdown '5:00', got '${t0}'`);
  }

  await page.waitForTimeout(3000);
  const t3 = await page.locator('[data-testid="otp-countdown"]').innerText();
  console.log(`  t=3s:   "${fmt(t3)}"`);
  if (t0 === t3) {
    throw new Error("FAIL: countdown not decrementing in real time");
  }
  // The countdown must have decreased by exactly 3 seconds (we wait
  // 3s of wall clock + the tick interval may have fired 3-4 times
  // depending on scheduling).
  const extract = (s) => {
    const m = s.match(/(\d+):(\d+)/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = extract(t0);
  const after = extract(t3);
  if (start === null || after === null) {
    throw new Error("FAIL: countdown text does not match MM:SS format");
  }
  const delta = start - after;
  if (delta < 2 || delta > 5) {
    throw new Error(
      `FAIL: countdown decreased by ${delta}s, expected ~3s`,
    );
  }
  console.log(`  delta:  ${delta}s (expected ~3s)`);

  // Form: no email input, only username + OTP.
  const hasEmail = await page.locator('input[name="email"]').count();
  const hasUsername = await page.locator('input[name="username"]').count();
  const hasOtp = await page.locator('input[name="otp"]').count();
  console.log(`  form:   email=${hasEmail} username=${hasUsername} otp=${hasOtp}`);
  if (hasEmail !== 0 || hasUsername === 0 || hasOtp === 0) {
    throw new Error("FAIL: form must have username + OTP only (no email)");
  }

  console.log("\n" + "=".repeat(60));
  console.log("COUNTDOWN SMOKE PASSED — production 5-minute window OK");
  console.log("=".repeat(60));
  await browser.close();
})().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});