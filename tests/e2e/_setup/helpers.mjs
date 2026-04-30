// Shared helpers for E2E specs.

import { request } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3081';
const ADMIN_PIN = process.env.E2E_ADMIN_PIN || '1234';
const CISNIK_PIN = process.env.E2E_CISNIK_PIN || '5678';

export const PINS = { admin: ADMIN_PIN, cisnik: CISNIK_PIN };

/** Wipe rows that tests typically dirty (orders, payments, storno_basket,
 *  shisha_sales, write_offs, fiscal_documents, events) without touching the
 *  seeded menu/staff/tables/ingredients/recipes. Use in test.beforeEach so
 *  spec files don't bleed into each other. */
export async function resetTransientData() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  // No public API for truncate — go straight to PG via the helper container.
  // Tests run sequentially (workers:1), so this is safe.
  const pg = await import('pg');
  const url = process.env.E2E_DATABASE_URL || 'postgresql://pos:pos@localhost:5432/pos_test';
  const pool = new pg.default.Pool({ connectionString: url });
  try {
    // Reset in dependency order (children first).
    await pool.query(`
      TRUNCATE
        write_off_items, write_offs,
        storno_basket,
        shisha_sales,
        fiscal_documents,
        idempotency_keys, events,
        order_events, payments,
        order_items, orders,
        stock_movements
      RESTART IDENTITY CASCADE
    `);
    // Reset table statuses so each test starts with all tables free.
    await pool.query(`UPDATE tables SET status = 'free'`);
    // Reset ingredient stock to seeded value (avoid drift across tests).
    await pool.query(`UPDATE ingredients SET current_qty = 50 WHERE name = 'Pivo svetle 10 sud'`);
    // Reset Cola (id=2) simple-tracked stock to 100.
    await pool.query(`UPDATE menu_items SET stock_qty = 100 WHERE id = 2`);
    // menu-api.spec.mjs PUTs to /menu/items/2 changing Cola's price + companion.
    // Restore both so later specs see Cola at 2.50 € with the Záloha companion.
    await pool.query(`UPDATE menu_items SET price = 2.50, companion_menu_item_id = 3 WHERE id = 2`);
    // Same spec uploads/deletes images to/from menu_items/1 — clear it.
    await pool.query(`UPDATE menu_items SET image_url = NULL WHERE id = 1`);
  } finally {
    await pool.end().catch(() => {});
  }
  await ctx.dispose();
}

/** Hit /api/auth/login as the seeded admin and return { token, user }. */
export async function apiLogin(name = 'Admin', pin = ADMIN_PIN) {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/auth/login', { data: { name, pin } });
  if (!res.ok()) {
    throw new Error(`apiLogin ${res.status()}: ${await res.text()}`);
  }
  const body = await res.json();
  await ctx.dispose();
  return body; // { token, user }
}

/** Navigate to pos-enterprise.html with the seeded admin already authenticated. */
export async function loginAndOpenPos(page) {
  const auth = await apiLogin();
  await page.addInitScript(({ token, user }) => {
    sessionStorage.setItem('pos_token', token);
    sessionStorage.setItem('pos_user', JSON.stringify(user));
  }, { token: auth.token, user: auth.user });
  await page.goto('/pos-enterprise.html');
  // Wait for the floor view to render at least one table chip.
  await page.locator('.table-chip').first().waitFor({ state: 'visible', timeout: 10_000 });
  return auth;
}

/** Same as above but reusing an existing token (avoid double login). */
export async function openPosWithToken(page, auth) {
  await page.addInitScript(({ token, user }) => {
    sessionStorage.setItem('pos_token', token);
    sessionStorage.setItem('pos_user', JSON.stringify(user));
  }, { token: auth.token, user: auth.user });
  await page.goto('/pos-enterprise.html');
  await page.locator('.table-chip').first().waitFor({ state: 'visible', timeout: 10_000 });
}

/** Click a product card by name. If the card isn't visible (different category
 *  active), click the search field and type the name first to filter to it. */
export async function clickProduct(page, productName) {
  const card = page.locator(`.product-card[data-name="${productName}"]`);
  if (!(await card.isVisible().catch(() => false))) {
    await typeInProductSearch(page, productName);
  }
  await card.click();
  await page.locator(`.order-item-name`, { hasText: productName }).first().waitFor({ state: 'visible' });
}

/** Switch the products panel to a category by visible label (e.g. "Burgre"). */
export async function selectCategory(page, label) {
  await page.locator('.cat-btn', { hasText: label }).first().click();
}

/** Type into the products search box to filter the grid. */
export async function typeInProductSearch(page, q) {
  const input = page.locator('#productSearch, input[placeholder*="Hladat"]').first();
  await input.fill(q);
}

/** Open a table chip by its visible name (e.g. "Stol 1") and wait for the
 *  order panel to settle on the products view. */
export async function openTable(page, tableName) {
  await page.locator('.table-chip', { hasText: tableName }).first().click();
  await page.locator('#productsPanel.active').waitFor({ state: 'visible', timeout: 5_000 });
}
