import { test, expect, type Page } from '@playwright/test';

/**
 * Functional check for the reveal flow on the assignment screen.
 *
 * Reported symptom: revealing an "Asignados" marbete completed the flow (OTP +
 * audit) but the row kept showing the masked code (`V***69`). The API masks
 * every list read by design, so the page has to keep the revealed value in its
 * own state; this test fails if that state is ever dropped again.
 */

const USERNAME = 'admin';
const OTP = 'ABC123';

async function login(page: Page) {
  await page.goto('/backoffice/login');
  const username = page.getByLabel('Usuario');
  await username.click();
  await username.fill(USERNAME);
  await page.getByTestId('login-otp').locator('input').first().click();
  await page.keyboard.type(OTP, { delay: 20 });
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/backoffice\/dashboard$/);
}

test.describe('Reveal marbete — assignment screen', () => {
  test('the revealed code replaces the mask in the assigned row', async ({ page }) => {
    await login(page);
    await page.goto('/backoffice/asociar');
    await page.getByTestId('tab-assigned').click();

    const row = page.locator('[data-panel="assigned"] tbody tr').first();
    const cell = row.getByTestId('masked-number');
    await expect(cell).toHaveAttribute('data-revealed', 'false');
    await expect(cell.locator('.credential-mask')).toHaveText(/\*\*\*/);

    await row.getByTestId(/^assigned-reveal-/).click();
    await expect(page.getByTestId('reveal-marbete-dialog')).toBeVisible();

    // The reason field is a native <select> (not the interior dropdown), so
    // selectOption is the deterministic interaction.
    await page.getByTestId('reveal-reason-select').selectOption('auditoria');

    await page.getByTestId('reveal-marbete-otp').locator('input').first().click();
    await page.keyboard.type(OTP, { delay: 20 });
    await page.getByTestId('reveal-marbete-submit').click();

    await expect(page.getByTestId('reveal-marbete-dialog')).toBeHidden();
    await expect(cell).toHaveAttribute('data-revealed', 'true');
    await expect(cell.locator('.credential-mask')).toHaveText(/^VALIDO-26\d{6}$/);
    await expect(cell.locator('.privacy-chip')).toHaveAttribute('aria-label', 'Revelado');
  });

  test('the revealed code survives a filter change and is per row', async ({ page }) => {
    await login(page);
    await page.goto('/backoffice/asociar');
    await page.getByTestId('tab-assigned').click();

    const rows = page.locator('[data-panel="assigned"] tbody tr');
    const firstCell = rows.first().getByTestId('masked-number');
    const secondCell = rows.nth(1).getByTestId('masked-number');

    await rows
      .first()
      .getByTestId(/^assigned-reveal-/)
      .click();
    await page.getByTestId('reveal-reason-select').selectOption('verificacion');
    await page.getByTestId('reveal-marbete-otp').locator('input').first().click();
    await page.keyboard.type(OTP, { delay: 20 });
    await page.getByTestId('reveal-marbete-submit').click();
    await expect(firstCell).toHaveAttribute('data-revealed', 'true');

    // Only the revealed row flips; the neighbour keeps its mask.
    await expect(secondCell).toHaveAttribute('data-revealed', 'false');

    // Search filters the list without dropping the revealed value.
    await page.getByTestId('assigned-search').fill('Estudiante');
    await expect(firstCell).toHaveAttribute('data-revealed', 'true');
  });
});
