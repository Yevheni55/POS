// Combo flow: clicking a "Combo *" item opens the sauce-picker, on confirm
// it adds the combo + a 0-price "Omáčka (combo)" annotation row whose note
// carries the picked sauces. Multiple taps must produce distinct rows
// (commits 41ed209, ae42b35).

import { test, expect } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

test('Combo opens sauce modal; cancel does not add anything', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await page.locator('.product-card[data-name="Combo BBQ Smash"]').click();

  const modal = page.locator('#sauceSelectorModal');
  await expect(modal).toBeVisible();
  // Cancel via backdrop
  await page.locator('#sauceSelectorModal').click({ position: { x: 5, y: 5 } });
  await expect(modal).toHaveCount(0, { timeout: 3000 });

  // Nothing in cart
  await expect(page.locator('.order-item-wrap')).toHaveCount(0);
});

test('Combo + Bez omáčky adds combo + annotation row "bez omáčky"', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await page.locator('.product-card[data-name="Combo BBQ Smash"]').click();

  await page.locator('#sauceNone').click();

  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Combo BBQ Smash' })).toBeVisible();
  const annotation = page.locator('.order-item-wrap').filter({ hasText: 'Omáčka (combo)' });
  await expect(annotation).toBeVisible();
  // The annotation row's note should be "bez omáčky"
  await expect(annotation).toContainText(/bez omáčky/);
});

test('Combo + 2 sauces records the names in the annotation note', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await page.locator('.product-card[data-name="Combo BBQ Smash"]').click();

  const modal = page.locator('#sauceSelectorModal');
  await expect(modal).toBeVisible();
  await modal.locator('input[data-sauce="BBQ"]').check();
  await modal.locator('input[data-sauce="Big Mac domáca"]').check();
  await modal.locator('#sauceConfirm').click();

  const annotation = page.locator('.order-item-wrap').filter({ hasText: 'Omáčka (combo)' });
  await expect(annotation).toContainText(/BBQ/);
  await expect(annotation).toContainText(/Big Mac/);
});

test('Two combo taps create 2 distinct combo rows + 2 annotation rows', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');

  // First combo: Bez omáčky
  await page.locator('.product-card[data-name="Combo BBQ Smash"]').click();
  await page.locator('#sauceNone').click();

  // Second combo: BBQ
  await page.locator('.product-card[data-name="Combo BBQ Smash"]').click();
  const modal = page.locator('#sauceSelectorModal');
  await expect(modal).toBeVisible();
  await modal.locator('input[data-sauce="BBQ"]').check();
  await modal.locator('#sauceConfirm').click();

  // 2 distinct combo rows (forceNewRow + _noMerge)
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Combo BBQ Smash' })).toHaveCount(2);
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Omáčka (combo)' })).toHaveCount(2);
});
