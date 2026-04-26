// Happy-path order → send → pay flow.
// Verifies the bare-minimum cashier flow works against a real server +
// real Postgres with PORTOS_ENABLED=false (no fiscalisation).

import { test, expect } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

test.describe('Order → Send → Pay', () => {
  test('opens an empty table, adds 2 items, sends to kitchen, pays', async ({ page }) => {
    await loginAndOpenPos(page);

    // 1. Open Stol 1 (seeded by global-setup) — switches to products view.
    await openTable(page, 'Stol 1');

    // 2. Add 1× Pivo + 2× Cola.
    await clickProduct(page, 'Pivo 0.5 l');
    await clickProduct(page, 'Cola 0,5 l');
    await clickProduct(page, 'Cola 0,5 l');

    // 3. Order list: Pivo + Cola + Záloha (companion auto-adds with Cola, qty mirrored).
    const orderItems = page.locator('.order-item-wrap');
    await expect(orderItems).toHaveCount(3);
    const colaRow = page.locator('.order-item-wrap').filter({ hasText: 'Cola 0,5 l' });
    await expect(colaRow.locator('.qty-val')).toHaveText('2');
    const zalohaRow = page.locator('.order-item-wrap').filter({ hasText: 'Záloha fľaša' });
    await expect(zalohaRow.locator('.qty-val')).toHaveText('2');

    // 4. Subtotal = 1*2.50 + 2*2.50 + 2*0.15 = 7.80 €
    await expect(page.locator('#total')).toContainText('7,80');

    // 5. Send to kitchen.
    await page.locator('#btnSend').click();
    // After send the items become "sent" (visual marker on .order-item-inner)
    await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });

    // 6. Pay (cash). With PORTOS_ENABLED=false the fiscal step is a no-op.
    await page.locator('.btn-cash').first().click();
    // Confirmation modal opens — confirm.
    await page.locator('#paymentModal .u-btn-mint').click();

    // 7. After successful payment the cashier is bounced to the floor (commit
    //    2c6620e) and the table flips back to free.
    await expect(page.locator('#tableView.active')).toBeVisible({ timeout: 10_000 });
    const stol = page.locator('.table-chip').filter({ hasText: 'Stol 1' });
    await expect(stol).toHaveClass(/s-free/, { timeout: 10_000 });

    // 8. Order panel is hidden on tables view.
    await expect(page.locator('.order-panel.pos-hidden')).toBeAttached();
  });
});
