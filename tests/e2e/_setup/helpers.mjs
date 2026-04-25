// Shared helpers for E2E specs.

import { request } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3081';
const ADMIN_PIN = process.env.E2E_ADMIN_PIN || '1234';

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

/** Click a product card by name and wait for it to appear in the order panel. */
export async function clickProduct(page, productName) {
  await page.locator(`.product-card[data-name="${productName}"]`).click();
  await page.locator(`.order-item-name`, { hasText: productName }).first().waitFor({ state: 'visible' });
}

/** Open a table chip by its visible name (e.g. "Stol 1") and wait for the
 *  order panel to settle on the products view. */
export async function openTable(page, tableName) {
  await page.locator('.table-chip', { hasText: tableName }).first().click();
  await page.locator('#productsPanel.active').waitFor({ state: 'visible', timeout: 5_000 });
}
