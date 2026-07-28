// Role gating + LAN validacia pre /api/printers.
//
// Tlaciarne urcuju KAM ide bon (kuchyna/bar), takze zapis musi byt manazer+.
// Test print navyse otvara TCP spojenie na adresu z DB — musi byt obmedzeny
// na RFC-1918 a nesmie prezradit rozdiel medzi "refused" a "timeout".
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb, testDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import { printers } from '../../db/schema.js';

const request = supertest(app);

before(async () => {
  app.set('io', { emit: () => {} });
  await truncateAll();
  await seed();
});

after(async () => {
  await closeDb();
});

async function makePrinter(values) {
  const [row] = await testDb.insert(printers).values({
    name: 'Kuchyna',
    ip: '192.168.0.107',
    port: 9100,
    dest: 'kuchyna',
    ...values,
  }).returning();
  return row;
}

// ---------------------------------------------------------------------------
// GET — citatelne pre kazdeho prihlaseneho (POS si tahá zoznam tlaciarni)
// ---------------------------------------------------------------------------

describe('GET /api/printers — readable by any authenticated role', () => {
  it('returns 200 for cisnik', async () => {
    const res = await request
      .get('/api/printers')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('returns 401 without a token', async () => {
    const res = await request.get('/api/printers');
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Write routes — manazer/admin only
// ---------------------------------------------------------------------------

describe('POST /api/printers — manazer/admin only', () => {
  it('returns 403 when cisnik tries to add a printer', async () => {
    const res = await request
      .post('/api/printers')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ name: 'Rogue', ip: '10.0.0.9', port: 9100, dest: 'all' });

    assert.equal(res.status, 403);
    assert.ok(res.body.error, 'error field must be present');
  });

  it('returns 200 when manazer adds a printer', async () => {
    const res = await request
      .post('/api/printers')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ name: 'Bar', ip: '192.168.0.108', port: 9100, dest: 'bar' });

    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Bar');
    assert.ok(res.body.id);
  });

  it('returns 401 without a token', async () => {
    const res = await request
      .post('/api/printers')
      .send({ name: 'Bar', ip: '192.168.0.108' });

    assert.equal(res.status, 401);
  });
});

describe('PUT /api/printers/:id — manazer/admin only', () => {
  it('returns 403 when cisnik tries to repoint a printer', async () => {
    const printer = await makePrinter({ name: 'PUT gate', ip: '192.168.0.120' });
    const res = await request
      .put(`/api/printers/${printer.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ ip: '10.6.6.6' });

    assert.equal(res.status, 403);

    // Gate musi naozaj zahryznut — riadok v DB sa nesmel zmenit.
    const after = await request
      .get('/api/printers')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const row = after.body.find((p) => p.id === printer.id);
    assert.equal(row.ip, '192.168.0.120');
  });

  it('returns 200 when manazer updates a printer', async () => {
    const printer = await makePrinter({ name: 'PUT ok', ip: '192.168.0.121' });
    const res = await request
      .put(`/api/printers/${printer.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ ip: '192.168.0.122' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ip, '192.168.0.122');
  });
});

describe('DELETE /api/printers/:id — manazer/admin only', () => {
  it('returns 403 when cisnik tries to delete a printer', async () => {
    const printer = await makePrinter({ name: 'DEL gate', ip: '192.168.0.130' });
    const res = await request
      .delete(`/api/printers/${printer.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 403);
  });

  it('returns 200 when admin deletes a printer', async () => {
    const printer = await makePrinter({ name: 'DEL ok', ip: '192.168.0.131' });
    const res = await request
      .delete(`/api/printers/${printer.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Test print — gate + LAN-only ciel + genericka chyba
// ---------------------------------------------------------------------------

describe('POST /api/printers/:id/test — gated and LAN-only', () => {
  it('returns 403 when cisnik triggers a test print', async () => {
    const printer = await makePrinter({ name: 'TEST gate', ip: '192.168.0.140' });
    const res = await request
      .post(`/api/printers/${printer.id}/test`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  });

  it('refuses a public IP target for manazer (no port scanning)', async () => {
    const printer = await makePrinter({ name: 'Public', ip: '8.8.8.8', port: 53 });
    const res = await request
      .post(`/api/printers/${printer.id}/test`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 400);
    assert.match(res.body.error, /lokalna siet/i);
  });

  it('refuses 172.15.x.x (outside the RFC-1918 172.16-31 range)', async () => {
    const printer = await makePrinter({ name: 'Near-private', ip: '172.15.0.1' });
    const res = await request
      .post(`/api/printers/${printer.id}/test`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 400);
  });

  it('refuses an out-of-range port even on a LAN address', async () => {
    const printer = await makePrinter({ name: 'Bad port', ip: '192.168.0.150', port: 0 });
    const res = await request
      .post(`/api/printers/${printer.id}/test`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 400);
  });

  it('returns 404 for an unknown printer id', async () => {
    const res = await request
      .post('/api/printers/999999/test')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({});

    assert.equal(res.status, 404);
  });
});
