if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';

import { app } from '../../app.js';
import { closeDb, seed, truncateAll } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

app.set('io', { emit: () => {} });

const request = supertest(app);
const originalFetch = global.fetch;

function mockJsonResponse(status, body) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  });
}

describe('company profile routes', () => {
  before(async () => {
    await truncateAll();
    await seed();
  });

  beforeEach(async () => {
    await truncateAll();
    await seed();
    global.fetch = originalFetch;
    process.env.PORTOS_ENABLED = 'true';
    process.env.PORTOS_CASH_REGISTER_CODE = '88812345678900001';
    process.env.PORTOS_PRINTER_NAME = 'pos';
    process.env.PORTOS_BASE_URL = 'http://localhost:3010';
  });

  after(async () => {
    global.fetch = originalFetch;
    await closeDb();
  });

  it('allows manager to save and load company profile from the server', async () => {
    const payload = {
      businessName: 'Surf Coffee s.r.o.',
      ico: '12345678',
      dic: '2023456789',
      icDph: 'SK2023456789',
      registeredAddress: 'Hlavna 15, 811 01 Bratislava',
      branchName: 'Surf Coffee Eurovea',
      branchAddress: 'Pribinova 8, 811 09 Bratislava',
      cashRegisterCode: '88812345678900001',
      contactPhone: '+421900123456',
      contactEmail: 'manager@surf.sk',
    };

    const saveRes = await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send(payload);

    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.businessName, payload.businessName);

    const getRes = await request
      .get('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.businessName, payload.businessName);
    assert.equal(getRes.body.branchName, payload.branchName);
    assert.equal(getRes.body.cashRegisterCode, payload.cashRegisterCode);
  });

  it('rejects company profile updates for cisnik', async () => {
    const res = await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        businessName: 'Blocked',
        dic: '2023456789',
        registeredAddress: 'Somewhere 1',
        branchName: 'Branch',
        branchAddress: 'Somewhere 2',
        cashRegisterCode: '88812345678900001',
      });

    assert.equal(res.status, 403);
  });

  it('returns read-only comparison between local company profile and Portos identity', async () => {
    await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({
        businessName: 'Surf Coffee s.r.o.',
        ico: '12345678',
        dic: '2023456789',
        icDph: 'SK2023456789',
        registeredAddress: 'Hlavna 15, 811 01 Bratislava',
        branchName: 'Surf Coffee Eurovea',
        branchAddress: 'Pribinova 8, 811 09 Bratislava',
        cashRegisterCode: '88812345678900001',
      });

    global.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/api/v1/identities')) {
        return mockJsonResponse(200, [{
          dic: '2023456789',
          ico: '12345678',
          icdph: 'SK2023456789',
          corporateBodyFullName: 'Surf Coffee s.r.o.',
          organizationUnit: {
            organizationUnitName: 'Surf Coffee Eurovea',
            cashRegisterCode: '88812345678900001',
            physicalAddress: {
              country: 'Slovenska republika',
              municipality: 'Bratislava',
              streetName: 'Pribinova',
              buildingNumber: '8',
              deliveryAddress: { postalCode: '81109' },
            },
          },
          physicalAddress: {
            country: 'Slovenska republika',
            municipality: 'Bratislava',
            streetName: 'Hlavna',
            buildingNumber: '15',
            deliveryAddress: { postalCode: '81101' },
          },
        }]);
      }
      if (target.includes('/api/v1/product/info')) return mockJsonResponse(200, { name: 'Portos' });
      if (target.includes('/api/v1/connectivity/status')) return mockJsonResponse(200, { state: 'Up' });
      if (target.includes('/api/v1/storage/info')) return mockJsonResponse(200, { state: 'Ready', port: 'COM3' });
      if (target.includes('/api/v1/printers/status')) return mockJsonResponse(200, { state: 'Ready' });
      if (target.includes('/api/v1/certificates/valid/latest')) return mockJsonResponse(200, { validTo: '2026-11-15T00:00:00Z' });
      if (target.includes('/api/v1/settings')) return mockJsonResponse(200, { cultureName: 'sk-SK' });
      throw new Error(`Unexpected URL: ${target}`);
    };

    const res = await request
      .get('/api/company-profile/portos-compare')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.local.businessName, 'Surf Coffee s.r.o.');
    assert.equal(res.body.portos.businessName, 'Surf Coffee s.r.o.');
    assert.equal(res.body.summary.mismatchCount, 0);
    assert.equal(res.body.summary.matches.cashRegisterCode, true);
  });

  it('rejects sync-from-portos for cisnik', async () => {
    const res = await request
      .post('/api/company-profile/sync-from-portos')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(res.status, 403);
  });

  it('manager sync-from-portos overwrites company profile from Portos identity', async () => {
    await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({
        businessName: 'Stara Test s.r.o.',
        ico: '11111111',
        dic: '2021111111',
        icDph: 'SK2021111111',
        registeredAddress: 'Stara 1',
        branchName: 'Pobocka Stara',
        branchAddress: 'Stara 2',
        cashRegisterCode: '11111111111111111',
        contactPhone: '+421911111111',
        contactEmail: 'stary@test.sk',
      });

    global.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/api/v1/identities')) {
        return mockJsonResponse(200, [{
          dic: '2029999999',
          ico: '99999999',
          icdph: 'SK2029999999',
          corporateBodyFullName: 'Nova Prevadzka s.r.o.',
          organizationUnit: {
            organizationUnitName: 'Nova pobocka',
            cashRegisterCode: '88812345678900001',
            physicalAddress: {
              country: 'Slovenska republika',
              municipality: 'Kosice',
              streetName: 'Hlavna',
              buildingNumber: '99',
              deliveryAddress: { postalCode: '04001' },
            },
          },
          physicalAddress: {
            country: 'Slovenska republika',
            municipality: 'Zilina',
            streetName: 'Nova',
            buildingNumber: '1',
            deliveryAddress: { postalCode: '01001' },
          },
        }]);
      }
      if (target.includes('/api/v1/product/info')) return mockJsonResponse(200, { name: 'Portos' });
      if (target.includes('/api/v1/connectivity/status')) return mockJsonResponse(200, { state: 'Up' });
      if (target.includes('/api/v1/storage/info')) return mockJsonResponse(200, { state: 'Ready', port: 'COM3' });
      if (target.includes('/api/v1/printers/status')) return mockJsonResponse(200, { state: 'Ready' });
      if (target.includes('/api/v1/certificates/valid/latest')) return mockJsonResponse(200, { validTo: '2026-11-15T00:00:00Z' });
      if (target.includes('/api/v1/settings')) return mockJsonResponse(200, { cultureName: 'sk-SK' });
      throw new Error(`Unexpected URL: ${target}`);
    };

    const syncRes = await request
      .post('/api/company-profile/sync-from-portos')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.profile.businessName, 'Nova Prevadzka s.r.o.');
    assert.equal(syncRes.body.profile.ico, '99999999');
    assert.equal(syncRes.body.profile.contactPhone, '+421911111111');
    assert.equal(syncRes.body.profile.contactEmail, 'stary@test.sk');

    const getRes = await request
      .get('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.businessName, 'Nova Prevadzka s.r.o.');
    assert.equal(getRes.body.ico, '99999999');
  });

  it('GET /api/company-profile?refresh=1 syncs Portos identity for cisnik', async () => {
    await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({
        businessName: 'Stara Test s.r.o.',
        ico: '11111111',
        dic: '2021111111',
        icDph: 'SK2021111111',
        registeredAddress: 'Stara 1',
        branchName: 'Pobocka Stara',
        branchAddress: 'Stara 2',
        cashRegisterCode: '11111111111111111',
        contactPhone: '+421911111111',
        contactEmail: 'stary@test.sk',
      });

    global.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/api/v1/identities')) {
        return mockJsonResponse(200, [{
          dic: '2027777777',
          ico: '77777777',
          icdph: 'SK2027777777',
          corporateBodyFullName: 'Refresh Firma s.r.o.',
          organizationUnit: {
            organizationUnitName: 'Refresh Branch',
            cashRegisterCode: '77788812345678900',
            physicalAddress: {
              country: 'Slovenska republika',
              municipality: 'Presov',
              streetName: 'Prezsky',
              buildingNumber: '7',
              deliveryAddress: { postalCode: '08001' },
            },
          },
          physicalAddress: {
            country: 'Slovenska republika',
            municipality: 'Presov',
            streetName: 'Hlavna',
            buildingNumber: '1',
            deliveryAddress: { postalCode: '08001' },
          },
        }]);
      }
      if (target.includes('/api/v1/product/info')) return mockJsonResponse(200, { name: 'Portos' });
      if (target.includes('/api/v1/connectivity/status')) return mockJsonResponse(200, { state: 'Up' });
      if (target.includes('/api/v1/storage/info')) return mockJsonResponse(200, { state: 'Ready', port: 'COM3' });
      if (target.includes('/api/v1/printers/status')) return mockJsonResponse(200, { state: 'Ready' });
      if (target.includes('/api/v1/certificates/valid/latest')) return mockJsonResponse(200, { validTo: '2026-11-15T00:00:00Z' });
      if (target.includes('/api/v1/settings')) return mockJsonResponse(200, { cultureName: 'sk-SK' });
      throw new Error(`Unexpected URL: ${target}`);
    };

    const res = await request
      .get('/api/company-profile?refresh=1')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.businessName, 'Refresh Firma s.r.o.');
    assert.equal(res.body.ico, '77777777');
    assert.equal(res.body.cashRegisterCode, '77788812345678900');
    assert.equal(res.body.contactPhone, '+421911111111', 'kontakty z DB sa zachovali');
  });
});
