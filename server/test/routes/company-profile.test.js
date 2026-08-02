// Pripusta aj paralelne worker DB (pos_test_w1..w6) — inak sa tento subor
// neda spustit vedla ostatnych bez kolizie na jednej zdielanej pos_test.
// Nazov MUSI zacinat 'pos_test', nech sa testy nikdy netrafia do zivej 'pos'
// (truncateAll() maze 32 tabuliek).
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
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
import * as schema from '../../db/schema.js';
import { closeDb, seed, testDb, truncateAll } from '../helpers/setup.js';
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

/**
 * Identitu firmy vlastní Portos — do DB sa dostane IBA cez `runPortosProfileSync`
 * alebo POST /sync-from-portos. Testy si ju preto sejú priamo, nie cez PUT:
 * PUT je zámerne contact-only (nález [18]/[14] auditu).
 */
async function seedProfile(overrides = {}) {
  await testDb.delete(schema.companyProfiles);
  const [row] = await testDb.insert(schema.companyProfiles).values({
    businessName: 'Surf Coffee s.r.o.',
    ico: '12345678',
    dic: '2023456789',
    icDph: 'SK2023456789',
    registeredAddress: 'Hlavna 15, 811 01 Bratislava',
    branchName: 'Surf Coffee Eurovea',
    branchAddress: 'Pribinova 8, 811 09 Bratislava',
    cashRegisterCode: '88812345678900001',
    contactPhone: '',
    contactEmail: '',
    ...overrides,
  }).returning();
  return row;
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

  it('allows manager to save and load contact details from the server', async () => {
    await seedProfile();

    const saveRes = await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ contactPhone: '+421900123456', contactEmail: 'manager@surf.sk' });

    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.contactPhone, '+421900123456');
    assert.equal(saveRes.body.contactEmail, 'manager@surf.sk');
    // Identita sa uložením kontaktov nesmie ani dotknúť.
    assert.equal(saveRes.body.businessName, 'Surf Coffee s.r.o.');
    assert.equal(saveRes.body.icDph, 'SK2023456789');
    assert.equal(saveRes.body.cashRegisterCode, '88812345678900001');

    const getRes = await request
      .get('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.contactPhone, '+421900123456');
    assert.equal(getRes.body.contactEmail, 'manager@surf.sk');
    assert.equal(getRes.body.businessName, 'Surf Coffee s.r.o.');
    assert.equal(getRes.body.branchName, 'Surf Coffee Eurovea');
    assert.equal(getRes.body.cashRegisterCode, '88812345678900001');
  });

  // Nález [18]/[14]: admin UI posielalo pri KAŽDOM uložení Nastavení celý
  // profil z readonly inputov. Keď GET /company-profile predtým zlyhal (503),
  // ostali naplnené z localStorage DEFAULTS — icDph:'' + dummy kód pokladne.
  // Taký payload ticho prepol POS na neplatiteľa DPH (forceZeroVat=true)
  // a razil na neexistujúci DKP. Server to teraz musí ignorovať.
  it('PUT s prazdnym icDph a cudzim cashRegisterCode NEPREPISE ulozenu identitu', async () => {
    await seedProfile({
      businessName: 'SL management, s.r.o.',
      ico: '54588481',
      dic: '2121741842',
      icDph: 'SK2121741842',
      cashRegisterCode: '88821217418420001',
      contactPhone: '+421900111222',
      contactEmail: 'stary@sl.sk',
    });

    const res = await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        // Presne to, čo posielalo stale admin UI z localStorage DEFAULTS.
        businessName: '',
        ico: '',
        dic: '',
        icDph: '',
        registeredAddress: '',
        branchName: '',
        branchAddress: '',
        cashRegisterCode: '88812345678900001',
        contactPhone: '+421905999888',
        contactEmail: 'novy@sl.sk',
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));

    // 1) Identita ostala nedotknutá — v odpovedi aj v DB.
    for (const body of [res.body, (await request
      .get('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)).body]) {
      assert.equal(body.icDph, 'SK2121741842', 'IČ DPH sa NESMIE vymazať');
      assert.equal(body.cashRegisterCode, '88821217418420001', 'kód pokladne sa NESMIE prepísať');
      assert.equal(body.businessName, 'SL management, s.r.o.');
      assert.equal(body.ico, '54588481');
      assert.equal(body.dic, '2121741842');
      assert.equal(body.branchName, 'Surf Coffee Eurovea');
      assert.equal(body.registeredAddress, 'Hlavna 15, 811 01 Bratislava');
      assert.equal(body.branchAddress, 'Pribinova 8, 811 09 Bratislava');
    }

    // 2) Kontakty sa naopak uložiť MUSIA — inak by bol PUT úplne mŕtvy.
    assert.equal(res.body.contactPhone, '+421905999888');
    assert.equal(res.body.contactEmail, 'novy@sl.sk');

    // 3) Ani jeden riadok navyše (route nesmie insertnúť druhý profil).
    const rows = await testDb.select().from(schema.companyProfiles);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].icDph, 'SK2121741842');
    assert.equal(rows[0].cashRegisterCode, '88821217418420001');
  });

  it('PUT bez existujuceho profilu zalozi riadok s kontaktmi a PRAZDNOU identitou', async () => {
    // Prázdna DB (truncate v beforeEach). Identitu doplní až Portos sync —
    // klientsky payload ju sem nesmie prepašovať ani cez insert vetvu.
    const res = await request
      .put('/api/company-profile')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({
        icDph: 'SK9999999999',
        cashRegisterCode: '99912345678900001',
        businessName: 'Podvrh s.r.o.',
        contactPhone: '+421911000000',
        contactEmail: 'kontakt@test.sk',
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.contactPhone, '+421911000000');
    assert.equal(res.body.contactEmail, 'kontakt@test.sk');
    assert.equal(res.body.icDph, '', 'identita nesmie prist z tela requestu');
    assert.equal(res.body.cashRegisterCode, '');
    assert.equal(res.body.businessName, '');

    const [row] = await testDb.select().from(schema.companyProfiles);
    assert.equal(row.icDph, '');
    assert.equal(row.cashRegisterCode, '');
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
    await seedProfile();

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
    // Starú identitu sejeme priamo — PUT ju (správne) zapísať nevie.
    await seedProfile({
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
    await seedProfile({
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
