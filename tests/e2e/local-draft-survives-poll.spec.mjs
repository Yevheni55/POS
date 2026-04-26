// Regression: items added locally must survive a server-side refresh.
// Three commits fixed three angles of the same class of bug:
//   f0592ff loadTableOrder used to wipe local rows
//   a43a4b9 the 30 s loadAllOrders tick wiped them too
//   8e136ca after a page reload _orderDirty=false made initiatePayment
//           refuse with "Nie je co platit"
// This spec exercises all three by simulating the refresh paths and then
// pressing Pay, asserting the modal opens (no toast).

import { test, expect } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct } from './_setup/helpers.mjs';

test('local draft survives loadAllOrders + page reload + still pays', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');

  await clickProduct(page, 'Cola 0,5 l');
  await clickProduct(page, 'Cola 0,5 l');

  // (a) Force the polling refresh path. The 30 s setInterval is too slow for
  //     a test, so call loadAllOrders + the inner refresh block directly via
  //     the same globals the polling uses.
  await page.evaluate(async () => {
    if (typeof loadAllOrders === 'function') await loadAllOrders();
    if (typeof loadStornoBasket === 'function') await loadStornoBasket();
  });

  // Items must still be present after the merge.
  const colaRow = page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' });
  await expect(colaRow).toBeVisible();
  await expect(colaRow.locator('.qty-val')).toHaveText('2');

  // (b) Hard-reload the page. localStorage restores tableOrders, but
  //     _orderDirty resets to false. Without commit 8e136ca, Pay would have
  //     toasted "Nie je co platit".
  await page.reload();
  // After reload the floor is shown again — open the same table.
  await openTable(page, 'Stol 1');
  // Cola rows should still be there from sessionStorage rehydration of
  // tableOrders (persisted on every setOrder/addToOrder).
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' })).toBeVisible();

  // (c) Press Pay — payment modal must open (NOT a "Nie je co platit" toast).
  await page.locator('.btn-cash').first().click();
  await expect(page.locator('#paymentModal.show')).toBeVisible({ timeout: 5_000 });
});
