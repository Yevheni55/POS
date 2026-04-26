// Auth + role-gating sanity. Doesn't try to hammer the rate-limiter (the
// limiter keys on req.ip and lifts only after a window) — just verifies the
// happy path + a denied path.

import { test, expect, request } from '@playwright/test';
import { PINS, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

async function login(name, pin) {
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const r = await ctx.post('/api/auth/login', { data: { name, pin } });
  await ctx.dispose();
  return { status: r.status(), body: r.ok() ? await r.json() : null };
}

test('Valid PIN login returns a JWT', async () => {
  const { status, body } = await login('Admin', PINS.admin);
  expect(status).toBe(200);
  expect(body.token).toBeTruthy();
  expect(body.user.name).toBe('Admin');
  expect(body.user.role).toBe('admin');
});

test('Wrong PIN is rejected', async () => {
  const { status } = await login('Admin', '0000');
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
});

test('Cisnik cannot resolve a storno (manazer/admin only)', async () => {
  // Seed an admin storno entry first via direct DB to keep this test isolated.
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  let id;
  try {
    const r = await pool.query(`
      INSERT INTO storno_basket (menu_item_id, qty, item_name, unit_price, reason, was_prepared, staff_id)
      VALUES (1, 1, 'Pivo 0.5 l', 2.50, 'order_error', false, 1) RETURNING id
    `);
    id = r.rows[0].id;
  } finally { await pool.end().catch(() => {}); }

  // Login as cisnik, try to resolve.
  const { body: cisnikAuth } = await login('Cisnik 1', PINS.cisnik);
  const ctx = await request.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${cisnikAuth.token}` },
  });
  const r2 = await ctx.post(`/api/storno-basket/${id}/resolve`, { data: {} });
  expect(r2.status()).toBe(403);
  await ctx.dispose();

  // Admin can resolve it.
  const { body: adminAuth } = await login('Admin', PINS.admin);
  const ctxA = await request.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${adminAuth.token}` },
  });
  const r3 = await ctxA.post(`/api/storno-basket/${id}/resolve`, { data: {} });
  expect(r3.ok()).toBeTruthy();
  await ctxA.dispose();
});

test('Protected route without token returns 401', async () => {
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const r = await ctx.get('/api/menu');
  expect(r.status()).toBe(401);
  await ctx.dispose();
});
