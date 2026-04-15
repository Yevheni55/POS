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
});
