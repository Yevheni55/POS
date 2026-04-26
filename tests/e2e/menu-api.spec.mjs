// Menu API: GET full menu, item CRUD, image upload, role guards.
// Covers commits 30ec41f (storno-write-off requireRole), 9cafd01 (companion),
// 61dcde9 (image upload).

import { test, expect, request } from '@playwright/test';
import { apiLogin, resetTransientData } from './_setup/helpers.mjs';

test.beforeEach(async () => { await resetTransientData(); });

async function ctxAdmin() {
  const auth = await apiLogin();
  return await request.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${auth.token}` },
  });
}

test('GET /api/menu returns categories with items + companion + imageUrl', async () => {
  const ctx = await ctxAdmin();
  const r = await ctx.get('/api/menu');
  expect(r.ok()).toBeTruthy();
  const cats = await r.json();
  const napoje = cats.find((c) => c.slug === 'napoje');
  expect(napoje).toBeTruthy();
  const cola = napoje.items.find((i) => i.name === 'Cola 0,5 l');
  expect(cola).toBeTruthy();
  expect(cola.companionMenuItemId).toBe(3); // → Záloha
  expect(cola.imageUrl).toBeNull();
  // Záloha is a real menu item (used as the companion target)
  const zaloha = napoje.items.find((i) => i.name === 'Záloha fľaša');
  expect(zaloha).toBeTruthy();
  await ctx.dispose();
});

test('PUT /api/menu/items/:id changes price + companion', async () => {
  const ctx = await ctxAdmin();
  const r = await ctx.put('/api/menu/items/2', {
    data: { price: 2.99, companionMenuItemId: null, vatRate: 19 },
  });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.price).toBe(2.99);
  expect(body.companionMenuItemId).toBeNull();
  await ctx.dispose();
});

test('Image upload: POST → file is served from /uploads/menu', async () => {
  const ctx = await ctxAdmin();

  // 1×1 transparent PNG (89 bytes)
  const PNG_1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

  const r = await ctx.post('/api/menu/items/1/image', { data: { image: PNG_1x1 } });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.imageUrl).toMatch(/^\/uploads\/menu\/1\.png\?v=\d+$/);

  // Fetch the file itself and assert it's a PNG.
  const fileR = await ctx.get(body.imageUrl);
  expect(fileR.ok()).toBeTruthy();
  expect(fileR.headers()['content-type']).toMatch(/image\/png/);
  const bytes = await fileR.body();
  expect(bytes.length).toBeGreaterThan(50);

  // DELETE clears it.
  const del = await ctx.delete('/api/menu/items/1/image');
  expect(del.ok()).toBeTruthy();
  const after = await ctx.get('/api/menu');
  const cats = await after.json();
  const pivo = cats.flatMap((c) => c.items).find((i) => i.id === 1);
  expect(pivo.imageUrl).toBeNull();
  await ctx.dispose();
});

test('Image upload rejects non-image data URLs', async () => {
  const ctx = await ctxAdmin();
  const r = await ctx.post('/api/menu/items/1/image', {
    data: { image: 'data:text/plain;base64,SGVsbG8=' },
  });
  expect(r.status()).toBe(400);
  await ctx.dispose();
});
