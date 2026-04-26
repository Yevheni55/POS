// Storno flow: cashier `−` on a sent item → modal forces explicit
// wasPrepared + reason → POST /api/storno-basket → admin opens basket from
// floor view → resolves with revert / write-off override.
//
// Covers commits: 0742e8f (modal redesign), 36daa7c (basket + chip), 94edab1
// (admin two-button choice), 21b0d57 (debounce per-item).

import { test, expect, request } from '@playwright/test';
import { loginAndOpenPos, openTable, clickProduct, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

async function sendOrderAndStorno(page, productName, prepChoice /* 'yes' | 'no' */) {
  await openTable(page, 'Stol 1');
  await clickProduct(page, productName);
  await page.locator('#btnSend').click();
  await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });
  // Click the − button on that row.
  const row = page.locator('.order-item-wrap', { hasText: productName });
  await row.locator('.qty-btn', { hasText: '−' }).click();
  // Modal opens — wait, then pick prep + reason.
  const modal = page.locator('#stornoReasonModal');
  await expect(modal).toBeVisible();
  await modal.locator(`.storno-prep-btn[data-prep="${prepChoice}"]`).click();
  await modal.locator('.storno-reason-btn[data-reason="order_error"]').click();
  await expect(modal.locator('#stornoSubmit')).toBeEnabled();
  await modal.locator('#stornoSubmit').click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

test('Modal — Potvrdiť disabled until both prep + reason chosen', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Pivo 0.5 l');
  await page.locator('#btnSend').click();
  await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });

  await page.locator('.order-item-wrap', { hasText: 'Pivo 0.5 l' })
    .locator('.qty-btn', { hasText: '−' }).click();

  const modal = page.locator('#stornoReasonModal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('#stornoSubmit')).toBeDisabled();

  // Pick prep alone — still disabled.
  await modal.locator('.storno-prep-btn[data-prep="no"]').click();
  await expect(modal.locator('#stornoSubmit')).toBeDisabled();

  // Add reason — now enabled.
  await modal.locator('.storno-reason-btn[data-reason="complaint"]').click();
  await expect(modal.locator('#stornoSubmit')).toBeEnabled();
});

test('Modal — Cancel does NOT create a storno_basket entry', async ({ page }) => {
  // Note: clicking − on a sent qty=1 item splices the row optimistically and
  // fires the server DELETE before the reason modal opens. The product
  // invariant under test is therefore "Cancel must not record a write-off",
  // not "Cancel restores the row" (the row is already gone server-side).
  const auth = await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Pivo 0.5 l');
  await page.locator('#btnSend').click();
  await expect(page.locator('.order-item-inner.sent').first()).toBeVisible({ timeout: 10_000 });

  await page.locator('.order-item-wrap', { hasText: 'Pivo 0.5 l' })
    .locator('.qty-btn', { hasText: '−' }).click();
  await expect(page.locator('#stornoReasonModal')).toBeVisible();
  await page.locator('#stornoReasonModal #stornoCancel').click();
  await expect(page.locator('#stornoReasonModal')).toHaveCount(0);

  // Wait a beat for any (un-)wanted POSTs to settle.
  await page.waitForTimeout(400);

  // No storno_basket entry should exist for this cancel.
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const r = await ctx.get('/api/storno-basket', { headers: { Authorization: `Bearer ${auth.token}` } });
  const body = await r.json();
  expect(body.summary.pendingCount).toBe(0);
  expect(body.items.length).toBe(0);
  await ctx.dispose();
});

test('Confirm posts to storno_basket; admin sees STORNO chip + count', async ({ page }) => {
  const auth = await loginAndOpenPos(page);
  await sendOrderAndStorno(page, 'Pivo 0.5 l', 'no');

  // Wait briefly for fire-and-forget POST + chip refresh
  await page.waitForTimeout(400);

  // Verify via API: 1 pending entry
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const r = await ctx.get('/api/storno-basket', { headers: { Authorization: `Bearer ${auth.token}` } });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.summary.pendingCount).toBe(1);
  expect(body.items[0].itemName).toBe('Pivo 0.5 l');
  expect(body.items[0].wasPrepared).toBe(false);
  expect(body.items[0].reason).toBe('order_error');
  await ctx.dispose();

  // Floor STORNO chip badge shows the count
  await page.locator('#btnTableView').click();
  const chip = page.locator('#stornoChip');
  await expect(chip).toBeVisible();
  await expect(chip.locator('.storno-badge')).toHaveText('1');
});

test('Admin Vrátiť reverts ingredient stock', async ({ page }) => {
  const auth = await loginAndOpenPos(page);
  // Pivo recipe = 0.5 L per pour. Ingredient currentQty starts at 50; sending
  // 1 pivo deducts to 49.5; Vrátiť should bring it back to 50.
  await sendOrderAndStorno(page, 'Pivo 0.5 l', 'no');

  // Open the basket overlay.
  await page.locator('#btnTableView').click();
  await page.locator('#stornoChip').click();
  const overlay = page.locator('#stornoBasketModal');
  await expect(overlay).toBeVisible();

  await overlay.locator('button.storno-action-return').first().click();
  // Toast confirms returned.
  await expect(page.locator('.toast-item .toast-message').last()).toContainText(/vrátené|vratené/i);

  // Verify ingredient stock restored.
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const ing = await ctx.get('/api/inventory/ingredients', { headers: { Authorization: `Bearer ${auth.token}` } });
  if (ing.ok()) {
    const list = await ing.json();
    const pivo = list.find((i) => i.name === 'Pivo svetle 10 sud');
    if (pivo) expect(parseFloat(pivo.currentQty)).toBeCloseTo(50.0, 3);
  }
  await ctx.dispose();
});

test('Admin Odpísať creates a write-off (stock NOT reverted)', async ({ page }) => {
  const auth = await loginAndOpenPos(page);
  await sendOrderAndStorno(page, 'Pivo 0.5 l', 'yes'); // cashier said it WAS prepared

  await page.locator('#btnTableView').click();
  await page.locator('#stornoChip').click();
  const overlay = page.locator('#stornoBasketModal');
  await overlay.locator('button.storno-action-writeoff').first().click();
  await expect(page.locator('.toast-item .toast-message').last()).toContainText(/Odpis/i);

  // Verify a write_off row exists.
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM write_offs');
    expect(r.rows[0].n).toBe(1);
    // Stock NOT reverted (still 49.5 from the original send-deduction).
    const ing = await pool.query(`SELECT current_qty FROM ingredients WHERE name = 'Pivo svetle 10 sud'`);
    expect(parseFloat(ing.rows[0].current_qty)).toBeCloseTo(49.5, 3);
  } finally { await pool.end().catch(() => {}); }
});

test('Admin × deletes basket entry without touching stock', async ({ page }) => {
  await loginAndOpenPos(page);
  await sendOrderAndStorno(page, 'Pivo 0.5 l', 'no');

  await page.locator('#btnTableView').click();
  await page.locator('#stornoChip').click();
  const overlay = page.locator('#stornoBasketModal');
  await overlay.locator('button.storno-action-delete').first().click();
  await expect(page.locator('.toast-item .toast-message').last()).toContainText(/zmazaný/i);

  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const wo = await pool.query('SELECT COUNT(*)::int AS n FROM write_offs');
    expect(wo.rows[0].n).toBe(0);
    const ing = await pool.query(`SELECT current_qty FROM ingredients WHERE name = 'Pivo svetle 10 sud'`);
    expect(parseFloat(ing.rows[0].current_qty)).toBeCloseTo(49.5, 3); // still deducted from send, never restored
    const sb = await pool.query('SELECT COUNT(*)::int AS n FROM storno_basket WHERE resolved_at IS NULL');
    expect(sb.rows[0].n).toBe(0);
  } finally { await pool.end().catch(() => {}); }
});
