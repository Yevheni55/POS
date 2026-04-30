// Shisha — internal counter (commit a0ee23a / aad4d9a). Stays out of fiscal
// flow but rolls into /reports/summary + /reports/z-report.

import { test, expect, request } from '@playwright/test';
import { apiLogin, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

async function authedCtx() {
  const auth = await apiLogin();
  return await request.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${auth.token}` },
  });
}

test('POST /api/shisha records a sale at default price 17 €', async () => {
  const ctx = await authedCtx();
  const r = await ctx.post('/api/shisha', { data: {} });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.id).toBeGreaterThan(0);
  expect(Number(body.price)).toBe(17);
  await ctx.dispose();
});

test('GET /api/shisha/summary aggregates count + revenue', async () => {
  const ctx = await authedCtx();
  // 3 sales today
  for (let i = 0; i < 3; i++) await ctx.post('/api/shisha', { data: {} });

  const r = await ctx.get('/api/shisha/summary');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.summary.today.count).toBe(3);
  expect(body.summary.today.revenue).toBeCloseTo(51, 2); // 3 × 17
  expect(body.summary.month.count).toBe(3);
  expect(body.summary.total.count).toBe(3);
  expect(body.recent.length).toBe(3);
  expect(body.byDay.length).toBeGreaterThanOrEqual(1);
  await ctx.dispose();
});

test('Shisha revenue rolls into /reports/summary total', async () => {
  const ctx = await authedCtx();
  await ctx.post('/api/shisha', { data: {} });
  await ctx.post('/api/shisha', { data: {} });

  const today = new Date().toISOString().split('T')[0];
  const r = await ctx.get(`/api/reports/summary?from=${today}&to=${today}`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.shisha.count).toBe(2);
  expect(body.shisha.revenue).toBeCloseTo(34, 2);
  // No fiscal payments → revenue.total equals shisha revenue.
  expect(body.revenue.total).toBeCloseTo(34, 2);
  expect(body.revenue.fiscal).toBeCloseTo(0, 2);
  await ctx.dispose();
});

test('Z-report includes shisha breakdown', async () => {
  const ctx = await authedCtx();
  await ctx.post('/api/shisha', { data: {} });

  const today = new Date().toISOString().split('T')[0];
  const r = await ctx.get(`/api/reports/z-report?date=${today}`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.shisha.count).toBe(1);
  expect(body.shisha.revenue).toBeCloseTo(17, 2);
  expect(body.totalRevenue).toBeCloseTo(17, 2);
  expect(body.fiscalRevenue).toBeCloseTo(0, 2);
  await ctx.dispose();
});
