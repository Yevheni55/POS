// Empty-after-storno: removing the last sent item from an order auto-deletes
// the server order so the table flips to free immediately. Covers commits
// 68ff19c, 529d44e, 531c483.

import { test, expect, request } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

test('Stornoing the last sent item frees the table', async ({ page }) => {
  const auth = await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Pivo 0.5 l');
  await page.locator('#btnSend').click();
  await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });

  // Storno via −, fill modal, submit
  await page.locator('.order-item-wrap', { hasText: 'Pivo 0.5 l' })
    .locator('.qty-btn', { hasText: '−' }).click();
  const modal = page.locator('#stornoReasonModal');
  await modal.locator('.storno-prep-btn[data-prep="no"]').click();
  await modal.locator('.storno-reason-btn[data-reason="order_error"]').click();
  await modal.locator('#stornoSubmit').click();

  // Order should auto-delete server-side; verify via API.
  await page.waitForTimeout(800);
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const r = await ctx.get('/api/orders', { headers: { Authorization: `Bearer ${auth.token}` } });
  const orders = await r.json();
  expect(orders.length).toBe(0);
  await ctx.dispose();
});
