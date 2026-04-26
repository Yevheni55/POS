// Companion item: adding Cola (companionMenuItemId → Záloha) auto-pushes a
// Záloha row with mirrored qty; removing Cola removes its companion.
// Covers commit 9cafd01.

import { test, expect } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

test('Adding Cola auto-adds Záloha companion at qty 1', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Cola 0,5 l');
  // Cola + Záloha rows
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' })).toBeVisible();
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Záloha fľaša' })).toBeVisible();
});

test('Adding 2 Colas mirrors Záloha qty to 2 (one row, not two)', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Cola 0,5 l');
  await clickProduct(page, 'Cola 0,5 l');
  const cola = page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' });
  const zaloha = page.locator('.order-item-wrap').filter({ hasText: 'Záloha fľaša' });
  await expect(cola).toHaveCount(1);
  await expect(zaloha).toHaveCount(1);
  await expect(cola.locator('.qty-val')).toHaveText('2');
  await expect(zaloha.locator('.qty-val')).toHaveText('2');
});

test('Removing Cola removes its companion Záloha', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Cola 0,5 l');
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Záloha fľaša' })).toBeVisible();

  // − to qty 0 (local item, no modal — modal only appears for sent items).
  await page.locator('.order-item-wrap', { hasText: 'Cola 0,5 l' })
    .locator('.qty-btn', { hasText: '−' }).click();
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' })).toHaveCount(0);
  await expect(page.locator('.order-item-wrap').filter({ hasText: 'Záloha fľaša' })).toHaveCount(0);
});
