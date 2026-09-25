/**
 * Validates the countdown transitions:
 *   - Normal state at start
 *   - Warning state at <= remaining/3 (yellow styling)
 *   - Expired state at 0:00 (submit locks, button text changes)
 *
 * NOTE: this probe runs against a temporary 10-second OTP_TTL_SECONDS
 * build of the web app (see apps/web/app/login/login-form-otp.tsx).
 * The component asserts at the 1/3 boundary, which corresponds to
 * 1:00 of warning in the real 5-minute build. Revert the TTL after
 * the probe lands.
 */
import { chromium } from "playwright";

const ORIGIN = "https://backoffice.quorum.asistentepro.mx";

function fmt(text) {
  return text.replace(/\s+/g, " ").trim();
}

(async () => {
  console.log("=".repeat(60));
  console.log("E2E countdown states — 5-minute window transition probe");
  console.log("=".repeat(60));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "es-MX",
  });
  const page = await ctx.newPage();

  await page.goto(`${ORIGIN}/backoffice/login`, { waitUntil: "domcontentloaded" });

  // Helper: read the countdown text + its computed colour class token
  // + submit button state + button text.
  async function snapshot(label) {
    const data = await page.evaluate(() => {
      const cd = document.querySelector('[data-testid="otp-countdown"]');
      const btn = document.querySelector('button[data-testid="login-submit"]');
      return {
        countdownText: cd ? cd.innerText : null,
        countdownClass: cd ? cd.className : null,
        countdownHasError: cd
          ? cd.className.includes("text-alert-error-text")
          : null,
        countdownHasWarning: cd
          ? cd.className.includes("text-alert-warning-text")
          : null,
        submitText: btn ? btn.innerText : null,
        submitDisabled: btn ? btn.disabled : null,
      };
    });
    console.log(`\n[${label}]`);
    console.log(`  countdown text:    "${fmt(data.countdownText ?? "")}"`);
    console.log(`  countdown error?   ${data.countdownHasError}`);
    console.log(`  countdown warning? ${data.countdownHasWarning}`);
    console.log(`  submit disabled?   ${data.submitDisabled}`);
    console.log(`  submit text:       "${fmt(data.submitText ?? "")}"`);
    return data;
  }

  // State 1: Normal — countdown should show 0:10, button disabled (no input).
  const s1 = await snapshot("state 1: t=0 (normal)");
  if (!s1.countdownText || !s1.countdownText.includes("0:10")) {
    throw new Error(`FAIL: expected countdown '0:10', got '${s1.countdownText}'`);
  }
  if (s1.countdownHasError || s1.countdownHasWarning) {
    throw new Error("FAIL: countdown should not be in warning/error state at start");
  }
  if (!s1.submitDisabled) {
    throw new Error("FAIL: submit should be disabled with empty inputs");
  }
  console.log("  ✓ PASS — normal state");

  // Now type a username + OTP so the button's "disabled" state is
  // governed by the countdown alone (not by missing inputs).
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="otp"]', "");
  await page.keyboard.type("ABCDEF");

  // State 2: Wait until the countdown drops into the warning band.
  // With OTP_TTL_SECONDS=10 the warning band kicks in when remaining
  // drops to 3 seconds (≤ TTL/3). We poll the countdown until it
  // reports ≤ 4s, then snapshot.
  await page.waitForFunction(
    () => {
      const cd = document.querySelector('[data-testid="otp-countdown"]');
      if (!cd) return false;
      const m = cd.innerText.match(/(\d+):(\d+)/);
      if (!m) return false;
      const total = Number(m[1]) * 60 + Number(m[2]);
      return total <= 4;
    },
    { timeout: 12000, polling: 250 },
  );
  const s2 = await snapshot("state 2: warning band");
  if (!s2.countdownHasWarning) {
    throw new Error("FAIL: countdown should be in warning state in warning band");
  }
  if (s2.countdownHasError) {
    throw new Error("FAIL: countdown should not be in error state yet");
  }
  if (s2.submitDisabled) {
    throw new Error("FAIL: submit should still be enabled with valid inputs and time remaining");
  }
  console.log("  ✓ PASS — warning state, submit still enabled");

  // State 3: Wait for the countdown to fully expire.
  await page.waitForFunction(
    () => {
      const cd = document.querySelector('[data-testid="otp-countdown"]');
      return cd && cd.innerText.includes("Expirado");
    },
    { timeout: 12000, polling: 250 },
  );
  const s3 = await snapshot("state 3: expired");
  if (!s3.countdownHasError) {
    throw new Error("FAIL: countdown should be in error state at expiry");
  }
  if (!s3.submitDisabled) {
    throw new Error("FAIL: submit must be disabled after countdown expires");
  }
  if (!s3.submitText || !s3.submitText.includes("Código expirado")) {
    throw new Error(
      `FAIL: submit button text should say 'Código expirado', got '${s3.submitText}'`,
    );
  }
  console.log("  ✓ PASS — expired state, submit locked");

  // State 4: Edit the OTP field (simulating operator delivering a fresh
  // code). The countdown should reset to 0:10 and the button should
  // become enabled again.
  await page.fill('input[name="otp"]', "");
  await page.keyboard.type("XYZ123");
  await page.waitForFunction(
    () => {
      const cd = document.querySelector('[data-testid="otp-countdown"]');
      return cd && cd.innerText.includes("0:10");
    },
    { timeout: 5000, polling: 100 },
  );

  const s4 = await snapshot("state 4: OTP edited, timer resets");
  if (s4.countdownHasError) {
    throw new Error("FAIL: countdown should clear error state on OTP edit");
  }
  if (s4.submitDisabled) {
    throw new Error("FAIL: submit should be enabled again after fresh code entered");
  }
  console.log("  ✓ PASS — timer reset, submit re-enabled");

  console.log("\n" + "=".repeat(60));
  console.log("ALL COUNTDOWN STATES VALIDATED — warning + expired + reset work end-to-end");
  console.log("(TTL temporarily set to 10s for probe — revert to 300 before push)");
  console.log("=".repeat(60));

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});