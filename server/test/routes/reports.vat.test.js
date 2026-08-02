// Regresné testy pre audit prechodu na PLATITEĽA DPH — reportová vrstva:
//   [07] účtovný export musí vynechať fiškálne stornovanú platbu
//   [06]/[15] Základ/DPH sa berú zo ZMRAZENÉHO dokladu, nie zo živého menu
//   [08] žiadny report nesmie miešať tržby dvoch daňových subjektov
//   [09] zisk platiteľa stojí na tržbe BEZ DPH; u neplatiteľa sa nič nemení
//   [Z2] kategórie a topItems v uzávierke musia odpočítať fiškálne storno
//   [27] uzávierka vracia rozpad hotovosti podľa kódu pokladne
//
// Pripúšťa aj paralelné worker DB (pos_test_w1..w6) — rovnaký guard ako
// v ostatných test súboroch, nech sa testy nikdy netrafia do živej `pos`.
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
import { sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

const OWN_CODE = '88821217418420001';   // SL management, s.r.o.
const FOREIGN_CODE = '88812345678900001'; // predchádzajúci daňový subjekt

describe('reports — režim platiteľa DPH', () => {
  let fixtures = {};
  let prevEnvCashRegisterCode;
  const auth = (r) => r.set('Authorization', `Bearer ${tokens.manazer()}`);

  before(async () => {
    // `getActiveCashRegisterCode()` padá na `PORTOS_CASH_REGISTER_CODE` zo .env,
    // keď v DB nie je profil. Pinujeme ho, nech testy NEZÁVISIA od toho, čo je
    // práve v `server/.env` — pozor, prázdna env hodnota NIE JE prázdny kód:
    // `getPortosConfig()` fallbackuje na DEFAULT_CASH_REGISTER_CODE.
    prevEnvCashRegisterCode = process.env.PORTOS_CASH_REGISTER_CODE;
    process.env.PORTOS_CASH_REGISTER_CODE = OWN_CODE;
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    await testDb.execute(
      sql.raw('TRUNCATE company_profiles, fiscal_documents, order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
    await testDb.update(schema.tables).set({ status: 'free' });
  });

  after(async () => {
    if (prevEnvCashRegisterCode === undefined) delete process.env.PORTOS_CASH_REGISTER_CODE;
    else process.env.PORTOS_CASH_REGISTER_CODE = prevEnvCashRegisterCode;
    await closeDb();
  });

  // `created_at` je `timestamp` BEZ zóny (UTC nástenný čas) — vkladáme SQL
  // literál, nech test nezávisí od TZ vývojárskeho stroja.
  const at = (utcWallClock) => sql`${utcWallClock}::timestamp`;
  const DAY = '2026-07-20';
  const NOON = at(`${DAY} 10:00:00`); // 12:00 Bratislava

  async function makeSale({ amount, items, method = 'hotovost', createdAt = NOON }) {
    const [order] = await testDb.insert(schema.orders).values({
      tableId: fixtures.table1.id, staffId: fixtures.cisnik.id,
      status: 'closed', createdAt, closedAt: createdAt,
    }).returning();
    await testDb.insert(schema.orderItems).values(
      items.map((it) => ({ orderId: order.id, menuItemId: it.menuItemId, qty: it.qty, sent: true })),
    );
    const [payment] = await testDb.insert(schema.payments).values({
      orderId: order.id, method, amount, createdAt,
    }).returning();
    return { order, payment };
  }

  /** Zapíše fiškálny doklad k platbe. `vatRate` = sadzba zmrazená v payloade. */
  async function makeFiscalDoc({ payment, order, sourceType = 'payment', cashRegisterCode = OWN_CODE, lines = null, resultMode = 'online_success' }) {
    // `request_json` je NOT NULL — bez `lines` zapíšeme prázdny payload,
    // takže export naň spadne do fallbacku ("odhad"), presne ako pri starých
    // riadkoch bez uloženého požiadavku.
    const requestJson = lines
      ? JSON.stringify({ request: { data: { items: lines } } })
      : '{}';
    await testDb.insert(schema.fiscalDocuments).values({
      sourceType,
      orderId: order.id,
      paymentId: payment.id,
      externalId: `ext-${sourceType}-${payment.id}`,
      cashRegisterCode,
      requestType: 'receipt',
      resultMode,
      isSuccessful: true,
      requestJson,
    });
  }

  async function setCompanyProfile({ icDph, cashRegisterCode = OWN_CODE }) {
    await testDb.insert(schema.companyProfiles).values({
      businessName: 'SL management, s.r.o.', icDph, cashRegisterCode,
    });
  }

  // ── [07] storno ────────────────────────────────────────────────────────
  it('[07] export vynechá fiškálne stornovanú platbu — DPH sa neprizná zo zrušeného predaja', async () => {
    const ok = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
    const stornoed = await makeSale({ amount: '100.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 40 }] });
    await makeFiscalDoc({ ...stornoed, sourceType: 'payment' });
    await makeFiscalDoc({ ...stornoed, sourceType: 'storno' });

    const res = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    assert.equal(res.status, 200);
    const ids = res.body.map((r) => r.cislo);
    assert.deepEqual(ids, [ok.order.id], 'stornovaná platba nesmie byť v exporte');

    // Súčet exportu musí sedieť s uzávierkou toho istého dňa.
    const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
    assert.equal(z.status, 200);
    assert.equal(res.body.reduce((s, r) => s + r.celkom, 0), z.body.fiscalRevenue);
  });

  // ── [06]/[15] zdroj Základ/DPH ─────────────────────────────────────────
  it('[06] Základ/DPH sa berú zo zmrazeného dokladu — doklad s 0 % ostane 0 % aj keď menu má 23 %', async () => {
    // Predaj z obdobia NEplatiteľa: doklad vznikol s vatRate 0, hoci Pivo má
    // v menu 23 % (`forceZeroVat`). Export nesmie dorobiť DPH, ktorá nikdy nebola.
    const sale = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
    await makeFiscalDoc({ ...sale, lines: [{ name: 'Pivo', price: 10, vatRate: 0 }] });

    const res = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].celkom, 10);
    assert.equal(res.body[0].zaklad, 10);
    assert.equal(res.body[0].dph, 0);
    assert.equal(res.body[0].zdroj, 'doklad');
  });

  it('[06] doklad s reálnymi sadzbami: Základ + DPH === Celkom a zdroj je "doklad"', async () => {
    const sale = await makeSale({
      amount: '11.00',
      items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }, { menuItemId: fixtures.itemPivo.id, qty: 1 }],
    });
    await makeFiscalDoc({
      ...sale,
      lines: [
        { name: 'Burger', price: 8.5, vatRate: 5 },
        { name: 'Pivo', price: 2.5, vatRate: 23 },
      ],
    });

    const res = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    const row = res.body[0];
    assert.equal(row.zdroj, 'doklad');
    assert.equal(row.celkom, 11);
    // 8,50/1,05 = 8,10 ; 2,50/1,23 = 2,03
    assert.equal(row.zaklad, 10.13);
    assert.equal(Math.round((row.zaklad + row.dph) * 100) / 100, row.celkom);
  });

  it('[06] platba bez použiteľného dokladu je v CSV označená ako "odhad"', async () => {
    await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });

    const res = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    assert.equal(res.body[0].zdroj, 'odhad');

    const csv = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=csv`));
    assert.match(csv.text, /Zdroj DPH/);
    assert.match(csv.text, /;odhad\r?\n/);
  });

  // ── [08] oddelenie firiem ──────────────────────────────────────────────
  it('[08] platba pod CUDZÍM kódom pokladne nesmie byť v exporte, summary ani uzávierke', async () => {
    await setCompanyProfile({ icDph: '', cashRegisterCode: OWN_CODE });
    const mine = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
    await makeFiscalDoc({ ...mine, cashRegisterCode: OWN_CODE, lines: [{ name: 'Pivo', price: 10, vatRate: 0 }] });
    const theirs = await makeSale({ amount: '55.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 22 }] });
    await makeFiscalDoc({ ...theirs, cashRegisterCode: FOREIGN_CODE, lines: [{ name: 'Pivo', price: 55, vatRate: 0 }] });
    // Platba BEZ dokladu ostáva započítaná (paragón / lokálny režim) — rovnaká
    // sémantika ako server/lib/payments/history.js.
    await makeSale({ amount: '3.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }] });

    const exp = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    assert.deepEqual(exp.body.map((r) => r.celkom).sort((a, b) => a - b), [3, 10]);

    const sum = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(sum.body.revenue.fiscal, 13);

    const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
    assert.equal(z.body.fiscalRevenue, 13);
    // Kategórie/topItems idú cez `orders` — cudzí účet z nich musí vypadnúť tiež.
    assert.equal(z.body.categoryBreakdown.reduce((s, c) => s + c.total, 0), 12.5);
  });

  it('[08] kód pokladne z company_profiles má prednosť pred .env fallbackom', async () => {
    // Na kase sa mení daňový subjekt: `.env` ešte drží starý kód, ale Portos
    // profile sync už do DB zapísal nový. Reporty MUSIA ísť podľa DB —
    // inak by po prepnutí zmizli všetky vlastné tržby a namiesto nich by sa
    // vykázali tržby predchádzajúceho subjektu.
    const prevEnv = process.env.PORTOS_CASH_REGISTER_CODE;
    process.env.PORTOS_CASH_REGISTER_CODE = FOREIGN_CODE;
    try {
      await setCompanyProfile({ icDph: '', cashRegisterCode: OWN_CODE });
      const mine = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
      await makeFiscalDoc({ ...mine, cashRegisterCode: OWN_CODE });
      const theirs = await makeSale({ amount: '77.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 30 }] });
      await makeFiscalDoc({ ...theirs, cashRegisterCode: FOREIGN_CODE });

      const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
      assert.equal(z.body.activeCashRegisterCode, OWN_CODE, 'DB profil musí prebiť .env');
      assert.equal(z.body.fiscalRevenue, 10);

      const exp = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
      assert.deepEqual(exp.body.map((r) => r.cislo), [mine.order.id]);
    } finally {
      if (prevEnv === undefined) delete process.env.PORTOS_CASH_REGISTER_CODE;
      else process.env.PORTOS_CASH_REGISTER_CODE = prevEnv;
    }
  });

  it('[08] export, summary aj uzávierka dajú ROVNAKÚ tržbu, keď sú v dni storno aj cudzia kasa', async () => {
    // Toto je ostrý prípad z produkcie: v DB sú riadky pod starým DKP
    // (88821227931780001) aj nové pod SL management, a k tomu jedno storno.
    // Ak sa tri reporty rozídu, účtovníčka nemá ako zistiť, ktorý je pravda.
    await setCompanyProfile({ icDph: 'SK2121741842', cashRegisterCode: OWN_CODE });
    const a = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
    await makeFiscalDoc({ ...a, cashRegisterCode: OWN_CODE, lines: [{ name: 'Pivo', price: 10, vatRate: 23 }] });
    const b = await makeSale({ amount: '17.00', method: 'karta', items: [{ menuItemId: fixtures.itemBurger.id, qty: 2 }] });
    await makeFiscalDoc({ ...b, cashRegisterCode: OWN_CODE, lines: [{ name: 'Burger', price: 17, vatRate: 5 }] });
    // (c) cudzia kasa
    const foreign = await makeSale({ amount: '55.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 22 }] });
    await makeFiscalDoc({ ...foreign, cashRegisterCode: FOREIGN_CODE, lines: [{ name: 'Pivo', price: 55, vatRate: 23 }] });
    // (d) vlastné, ale stornované
    const stornoed = await makeSale({ amount: '33.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 13 }] });
    await makeFiscalDoc({ ...stornoed, cashRegisterCode: OWN_CODE, lines: [{ name: 'Pivo', price: 33, vatRate: 23 }] });
    await makeFiscalDoc({ ...stornoed, sourceType: 'storno', cashRegisterCode: OWN_CODE });
    // (e) platba BEZ dokladu — MUSÍ sa započítať (paragón / lokálny režim).
    // Suma zámerne SEDÍ s cenníkom (1× Pivo = 2,50), lebo fallback vetva
    // exportu rozpad počíta z menu, nie zo zaplatenej sumy — pri rozdiele jej
    // Zaklad+DPH nesedí s Celkom (viď `todo` v reports.export.vat.test.js).
    await makeSale({ amount: '2.50', items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }] });

    const exp = await auth(request.get(`/api/reports/export?from=${DAY}&to=${DAY}&format=json`));
    const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
    const sum = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));

    const expTotal = Math.round(exp.body.reduce((s, r) => s + r.celkom, 0) * 100) / 100;
    assert.equal(expTotal, 29.5, '10 + 17 + 2,50 (bez cudzej kasy a bez storna)');
    assert.equal(z.body.fiscalRevenue, 29.5);
    assert.equal(sum.body.revenue.fiscal, 29.5);
    assert.equal(sum.body.totalRevenue, 29.5);
    // DPH z exportu: 10,00 @ 23 % = 1,87 ; 17,00 @ 5 % = 0,81 ; 2,50 @ 23 % = 0,47
    const expDph = Math.round(exp.body.reduce((s, r) => s + r.dph, 0) * 100) / 100;
    assert.equal(expDph, 3.15);
    // Summary počíta DPH z pomeru sadzieb ŽIVÉHO menu, export zo zmrazeného
    // dokladu — pri zhodných sadzbách sa musia stretnúť (tolerancia na
    // rozpočítanie po dňoch je cent).
    assert.ok(
      Math.abs(expDph - sum.body.totalVatOutput) <= 0.02,
      `export DPH ${expDph} vs summary totalVatOutput ${sum.body.totalVatOutput}`,
    );
  });

  // ── [Z2] storno v item-agregátoch ──────────────────────────────────────
  it('[Z2] stornovaný účet zmizne aj z kategórií a topItems uzávierky', async () => {
    const stornoed = await makeSale({ amount: '10.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 4 }] });
    await makeFiscalDoc({ ...stornoed, sourceType: 'payment' });
    await makeFiscalDoc({ ...stornoed, sourceType: 'storno' });

    const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
    assert.equal(z.body.fiscalRevenue, 0);
    assert.deepEqual(z.body.categoryBreakdown, [], 'kategórie nesmú ukázať stornovaný predaj');
    assert.deepEqual(z.body.topItems, []);

    const sum = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.deepEqual(sum.body.products, []);
  });

  // ── [27] rozpad hotovosti podľa pokladne ───────────────────────────────
  it('[27] uzávierka vráti rozpad hotovosti podľa kódu pokladne + mixedRegisters', async () => {
    await setCompanyProfile({ icDph: '', cashRegisterCode: OWN_CODE });
    const mine = await makeSale({ amount: '250.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 100 }] });
    await makeFiscalDoc({ ...mine, cashRegisterCode: OWN_CODE });
    const theirs = await makeSale({ amount: '400.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 160 }] });
    await makeFiscalDoc({ ...theirs, cashRegisterCode: FOREIGN_CODE });

    const z = await auth(request.get(`/api/reports/z-report?date=${DAY}`));
    assert.equal(z.body.activeCashRegisterCode, OWN_CODE);
    const byCode = Object.fromEntries(z.body.cashFiscalByRegister.map((r) => [r.cashRegisterCode, r.total]));
    assert.equal(byCode[OWN_CODE], 250);
    assert.equal(byCode[FOREIGN_CODE], 400);
    assert.deepEqual(z.body.mixedRegisters.sort(), [FOREIGN_CODE, OWN_CODE].sort());
    // Cudzia tržba sa NESMIE dostať do fiškálnej tržby dňa.
    assert.equal(z.body.fiscalRevenue, 250);
  });

  // ── [09] zisk na netto základe ─────────────────────────────────────────
  it('[09] NEPLATITEĽ: totalRevenueNet === totalRevenue, DPH 0 a zisk je nezmenený', async () => {
    await setCompanyProfile({ icDph: '' });
    await makeSale({ amount: '100.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 40 }] });

    const res = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.vatRegistered, false);
    assert.equal(res.body.totalVatOutput, 0);
    assert.equal(res.body.totalRevenueNet, res.body.totalRevenue);
    assert.deepEqual(res.body.vat.byRate, []);
    assert.equal(res.body.totalProfit, res.body.totalRevenue - res.body.totalCogs - res.body.totalLabor - res.body.totalStaffMeal);
    assert.equal(res.body.daily[0].revenueNet, res.body.daily[0].revenue);
    // Produkty: marža ostáva na brutto tržbe.
    assert.equal(res.body.products[0].revenueNet, res.body.products[0].revenue);
  });

  it('[09] PLATITEĽ: zisk a marža stoja na tržbe BEZ DPH (100 € pri 23 % → základ 81,30 €)', async () => {
    await setCompanyProfile({ icDph: 'SK2121741842' });
    await makeSale({ amount: '100.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 40 }] });

    const res = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.vatRegistered, true);
    // KPI „Celkové tržby" ostáva BRUTTO — musí sedieť so zásuvkou.
    assert.equal(res.body.totalRevenue, 100);
    assert.equal(res.body.totalRevenueNet, 81.3);
    assert.equal(res.body.totalVatOutput, 18.7);
    assert.equal(res.body.vat.amount, 18.7);
    assert.deepEqual(res.body.vat.byRate.map((r) => r.vatRate), [23]);
    assert.equal(res.body.totalProfit, res.body.totalRevenueNet - res.body.totalCogs - res.body.totalLabor - res.body.totalStaffMeal);
    assert.equal(res.body.daily[0].revenueNet, 81.3);
    assert.equal(res.body.products[0].revenueNet, 81.3);
  });

  it('[09] PLATITEĽ so zmiešanými sadzbami: Σ vat.byRate.amount === totalVatOutput', async () => {
    await setCompanyProfile({ icDph: 'SK2121741842' });
    // 2× Burger (5 %, 8,50) + 2× Pivo (23 %, 2,50) = 22,00 €
    await makeSale({
      amount: '22.00',
      items: [{ menuItemId: fixtures.itemBurger.id, qty: 2 }, { menuItemId: fixtures.itemPivo.id, qty: 2 }],
    });

    const res = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(res.body.totalRevenue, 22);
    assert.deepEqual(res.body.vat.byRate.map((r) => r.vatRate), [5, 23]);
    const sumVat = res.body.vat.byRate.reduce((s, r) => s + r.amount, 0);
    assert.ok(Math.abs(sumVat - res.body.totalVatOutput) <= 0.02, `Σ byRate ${sumVat} vs ${res.body.totalVatOutput}`);
    assert.ok(res.body.totalRevenueNet < res.body.totalRevenue);
  });

  it('[09] BEZ company_profiles riadku sa firma správa ako NEPLATITEĽ (fail-safe)', async () => {
    // Kým Portos profile sync ani raz nezbehol, v DB nie je profil. Reporty
    // vtedy NESMÚ začať odpočítavať DPH — inak by produkčná kasa neplatiteľa
    // po nasadení ticho stratila ~19 % zisku v Sezóne.
    await makeSale({ amount: '100.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 40 }] });

    const res = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.vatRegistered, false);
    assert.equal(res.body.totalVatOutput, 0);
    assert.equal(res.body.totalRevenueNet, 100);
    assert.equal(res.body.totalRevenue, 100);
    assert.deepEqual(res.body.vat.byRate, []);
    assert.equal(res.body.vat.base, res.body.revenue.fiscal);
  });

  it('[09] prepnutie na platiteľa NEZMENÍ ani jedno brutto číslo — mení sa len netto vetva', async () => {
    // 2× Burger (5 %, 8,50) + 4× Pivo (23 %, 2,50) = 27,00 €
    await setCompanyProfile({ icDph: '' });
    await makeSale({
      amount: '27.00',
      items: [{ menuItemId: fixtures.itemBurger.id, qty: 2 }, { menuItemId: fixtures.itemPivo.id, qty: 4 }],
    });
    const nonPayer = (await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`))).body;

    await testDb.execute(sql.raw('TRUNCATE company_profiles RESTART IDENTITY CASCADE'));
    await setCompanyProfile({ icDph: 'SK2121741842' });
    const payer = (await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`))).body;

    assert.equal(nonPayer.vatRegistered, false);
    assert.equal(payer.vatRegistered, true);

    // BRUTTO strana musí byť bajt-identická — KPI „Celkové tržby" aj zásuvka
    // sa prechodom na platiteľa nemenia.
    for (const key of ['totalRevenue', 'totalOrders', 'avgCheck', 'totalCogs', 'totalLabor', 'totalStaffMeal', 'totalOdpis', 'topRevenue']) {
      assert.equal(payer[key], nonPayer[key], `${key} sa nesmie zmeniť prepnutím režimu DPH`);
    }
    assert.equal(payer.revenue.fiscal, nonPayer.revenue.fiscal);
    assert.deepEqual(payer.methods, nonPayer.methods);
    assert.deepEqual(payer.topItems, nonPayer.topItems);
    assert.deepEqual(
      payer.daily.map((d) => [d.date, d.revenue, d.orders, d.cogs]),
      nonPayer.daily.map((d) => [d.date, d.revenue, d.orders, d.cogs]),
    );
    assert.deepEqual(
      payer.products.map((p) => [p.name, p.revenue]),
      nonPayer.products.map((p) => [p.name, p.revenue]),
    );

    // NETTO vetva sa naopak zmeniť MUSÍ — inak je fix [09] mŕtvy.
    assert.equal(nonPayer.totalRevenueNet, nonPayer.totalRevenue);
    assert.equal(nonPayer.totalProfit, nonPayer.totalRevenue - nonPayer.totalCogs - nonPayer.totalLabor - nonPayer.totalStaffMeal);
    assert.ok(payer.totalRevenueNet < payer.totalRevenue, 'netto tržba platiteľa musí byť nižšia než brutto');
    assert.ok(payer.totalProfit < nonPayer.totalProfit, 'zisk platiteľa je o DPH na výstupe nižší');
    assert.equal(
      Math.round((nonPayer.totalProfit - payer.totalProfit) * 100) / 100,
      payer.totalVatOutput,
      'celý rozdiel v zisku je presne DPH na výstupe',
    );
  });

  it('[09] invariant: totalRevenueNet + totalVatOutput === totalRevenue', async () => {
    await setCompanyProfile({ icDph: 'SK2121741842' });
    await makeSale({
      amount: '27.00',
      items: [{ menuItemId: fixtures.itemBurger.id, qty: 2 }, { menuItemId: fixtures.itemPivo.id, qty: 4 }],
    });
    await makeSale({
      amount: '13.50', method: 'karta',
      items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }, { menuItemId: fixtures.itemPivo.id, qty: 2 }],
    });

    const res = await auth(request.get(`/api/reports/summary?from=${DAY}&to=${DAY}`));
    assert.equal(res.body.totalRevenue, 40.5);
    assert.equal(
      Math.round((res.body.totalRevenueNet + res.body.totalVatOutput) * 100) / 100,
      res.body.totalRevenue,
    );
    // Rozpad po sadzbách musí sedieť s celkom aj v základe, nielen v dani.
    const baseSum = Math.round(res.body.vat.byRate.reduce((s, r) => s + r.base, 0) * 100) / 100;
    assert.ok(Math.abs(baseSum - res.body.vat.base) <= 0.02, `Σ byRate.base ${baseSum} vs vat.base ${res.body.vat.base}`);
    const grossSum = Math.round(res.body.vat.byRate.reduce((s, r) => s + r.gross, 0) * 100) / 100;
    assert.ok(Math.abs(grossSum - res.body.revenue.fiscal) <= 0.02, `Σ byRate.gross ${grossSum} vs fiscal ${res.body.revenue.fiscal}`);
  });

  // ── [24] weekly na rovnakom základe ako COGS ───────────────────────────
  it('[24] weekly: u neplatiteľa brutto, u platiteľa netto (vatExclusive flag)', async () => {
    await setCompanyProfile({ icDph: '' });
    await makeSale({ amount: '100.00', items: [{ menuItemId: fixtures.itemPivo.id, qty: 40 }] });

    const gross = await auth(request.get(`/api/reports/weekly?from=${DAY}&to=${DAY}`));
    assert.equal(gross.status, 200);
    assert.equal(gross.body.vatExclusive, false);
    assert.equal(gross.body.totals.barRevenue, 100);

    await testDb.execute(sql.raw('TRUNCATE company_profiles RESTART IDENTITY CASCADE'));
    await setCompanyProfile({ icDph: 'SK2121741842' });
    const net = await auth(request.get(`/api/reports/weekly?from=${DAY}&to=${DAY}`));
    assert.equal(net.body.vatExclusive, true);
    assert.equal(net.body.totals.barRevenue, 81.3);
  });
});
