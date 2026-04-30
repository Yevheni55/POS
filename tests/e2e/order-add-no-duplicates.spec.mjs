// Regression: Pošlem-then-poll must not duplicate items in the cart.
// Covers commit 80ed603 (syncedLocalIds filter before loadTableOrder
// rebuilds tableOrders).

import { test, expect } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

test('Pošlem does NOT leave duplicate rows', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');

  await clickProduct(page, 'Pivo 0.5 l');
  await clickProduct(page, 'Pivo 0.5 l');
  // 1 row, qty 2
  const piv = page.locator('.order-item-wrap').filter({ hasText: 'Pivo 0.5 l' });
  await expect(piv).toHaveCount(1);
  await expect(piv.locator('.qty-val')).toHaveText('2');

  await page.locator('#btnSend').click();
  await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });

  // After send + loadTableOrder reload still 1 row.
  await expect(piv).toHaveCount(1);
  await expect(piv.locator('.qty-val')).toHaveText('2');

  // Force the polling refresh too — still 1 row.
  await page.evaluate(async () => {
    if (typeof loadAllOrders === 'function') await loadAllOrders();
    if (typeof loadTableOrder === 'function' && typeof selectedTableId !== 'undefined') {
      await loadTableOrder(selectedTableId, true);
    }
  });
  await expect(piv).toHaveCount(1);
  await expect(piv.locator('.qty-val')).toHaveText('2');
});
