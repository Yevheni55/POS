// Regresia pre paragón (náhradný doklad § 10) po prechode na platiteľa DPH.
//
// Kryje presne to, na čom audit horel: server veril klientskemu `vatRate: 0`,
// takže u platiteľa DPH išiel do eKasy doklad s nulovou daňou; a `discountAmount`
// z kasy vôbec neprišiel, takže súčet položiek ≠ suma platby a paragón sa
// nezaregistroval nikdy. Plus: 202 `offline_accepted` sa nesmie brať ako zlyhanie
// a zmrazený payload so starým kódom pokladne sa musí pred registráciou prestavať.
//
// Pripúšťa aj paralelné worker DB (pos_test_w1..w6) — rovnako ako payments.qr.test.js.
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
import { registerOneParagon } from '../../routes/paragons.js';

app.set('io', { emit: () => {} });
const request = supertest(app);
const originalFetch = global.fetch;
const originalPortosEnabled = process.env.PORTOS_ENABLED;

let fx;

async function clearParagons() {
  await testDb.execute(sql.raw('TRUNCATE offline_paragons RESTART IDENTITY CASCADE'));
}

async function createOpenOrder(items, discountAmount = null) {
  const [order] = await testDb.insert(schema.orders)
    .values({ tableId: fx.table1.id, staffId: fx.cisnik.id, status: 'open', discountAmount })
    .returning();
  for (const item of items) {
    await testDb.insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: item.menuItemId, qty: item.qty, sent: true });
  }
  return order;
}

async function countParagons() {
  const rows = await testDb.select().from(schema.offlineParagons);
  return rows.length;
}

/**
 * Docasne prepne sadzbu polozky v menu. `beforeEach` menu_items NEtruncuje
 * (seed bezi raz v `before`), takze bez obnovy by sa zmena presypala do
 * dalsich testov.
 */
async function withMenuVatRate(menuItemId, vatRate, fn) {
  const [before] = await testDb.select({ vatRate: schema.menuItems.vatRate })
    .from(schema.menuItems)
    .where(sql`${schema.menuItems.id} = ${menuItemId}`);
  await testDb.update(schema.menuItems)
    .set({ vatRate })
    .where(sql`${schema.menuItems.id} = ${menuItemId}`);
  try {
    return await fn();
  } finally {
    await testDb.update(schema.menuItems)
      .set({ vatRate: before.vatRate })
      .where(sql`${schema.menuItems.id} = ${menuItemId}`);
  }
}

/**
 * Docasne prida polozku do menu (napr. duplicitny nazov s inou sadzbou).
 * `menu_items` sa medzi testami NEtruncuje, takze upratanie je povinne.
 */
async function withExtraMenuItem(values, fn) {
  const [row] = await testDb.insert(schema.menuItems)
    .values({ categoryId: fx.catDrink.id, emoji: 'beer', desc: '', ...values })
    .returning();
  try {
    return await fn(row);
  } finally {
    await testDb.delete(schema.menuItems).where(sql`${schema.menuItems.id} = ${row.id}`);
  }
}

async function setVatPayer(icDph, cashRegisterCode = '88821217418420001') {
  await testDb.delete(schema.companyProfiles);
  await testDb.insert(schema.companyProfiles).values({
    companyName: 'Test s.r.o.',
    ico: '54588481',
    icDph,
    cashRegisterCode,
  });
}

before(async () => {
  await truncateAll();
  await clearParagons();
  fx = await seed();
});

beforeEach(async () => {
  await testDb.execute(sql.raw('TRUNCATE order_items, orders, company_profiles RESTART IDENTITY CASCADE'));
  await clearParagons();
  process.env.PORTOS_ENABLED = 'false';
  global.fetch = originalFetch;
});

after(async () => {
  global.fetch = originalFetch;
  process.env.PORTOS_ENABLED = originalPortosEnabled;
  await clearParagons();
  await closeDb();
});

function payloadOf(row) {
  return JSON.parse(row.requestPayloadJson);
}

describe('POST /api/paragons — fiskalne data zo servera', () => {
  it('NEPLATITEL: sadzby ostavaju 0 %, suma sa nemeni', async () => {
    const order = await createOpenOrder([
      { menuItemId: fx.itemBurger.id, qty: 1 },
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ]);

    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [
          { id: 1, name: 'Burger', qty: 1, price: 8.5, vatRate: 0 },
          { id: 2, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 13.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const payload = payloadOf(res.body);
    const items = payload.request.data.items;
    assert.ok(items.every((i) => i.vatRate === 0), 'neplatitel musi mat vsade 0 %');
    assert.equal(payload.request.data.payments[0].amount, 13.5);
  });

  it('PLATITEL: sadzby sa beru z menu_items, nie z tela requestu', async () => {
    await setVatPayer('SK2121741842');
    const order = await createOpenOrder([
      { menuItemId: fx.itemBurger.id, qty: 1 },
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ]);

    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [
          { id: 1, name: 'Burger', qty: 1, price: 8.5, vatRate: 0 },
          { id: 2, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 13.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = payloadOf(res.body).request.data.items;
    const burger = items.find((i) => i.name === 'Burger');
    const pivo = items.find((i) => i.name === 'Pivo');
    assert.equal(burger.vatRate, 5);
    assert.equal(pivo.vatRate, 23);
    assert.ok(items.every((i) => i.vatRate !== 0), 'ziadny riadok nesmie mat 0 %');
  });

  it('PLATITEL: klientske sadzby sa ignoruju aj ked chybaju alebo su NESPRAVNE', async () => {
    // Web POS pole `vatRate` na polozkach vobec nema (js/pos-orders.js ho
    // nikdy neplni) — telo teda pride bud bez neho, alebo s nulou z `|| 0`.
    // Ani jeden variant, ani vyslovene zla hodnota, sa nesmie dostat do
    // zmrazeneho payloadu.
    await setVatPayer('SK2121741842');
    const order = await createOpenOrder([
      { menuItemId: fx.itemBurger.id, qty: 1 },
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ]);

    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [
          { id: 1, name: 'Burger', qty: 1, price: 8.5 },              // ziadny vatRate
          { id: 2, name: 'Pivo', qty: 2, price: 2.5, vatRate: 19 },   // NESPRAVNY vatRate
        ],
        paymentMethod: 'hotovost',
        totalAmount: 13.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = payloadOf(res.body).request.data.items;
    assert.equal(items.find((i) => i.name === 'Burger').vatRate, 5);
    assert.equal(items.find((i) => i.name === 'Pivo').vatRate, 23, 'klientskych 19 % sa musi ignorovat');
    assert.equal(res.body.vatRegistered, true);
  });

  it('PLATITEL + zlava: polozky + zlavove riadky sa scitaju na sumu platby', async () => {
    await setVatPayer('SK2121741842');
    const order = await createOpenOrder([
      { menuItemId: fx.itemBurger.id, qty: 1 },
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ], '2.00');

    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        // klient zlavu NEposiela — server si ju musi zobrat z objednavky
        items: [
          { id: 1, name: 'Burger', qty: 1, price: 8.5, vatRate: 0 },
          { id: 2, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 11.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payloadOf(res.body).request.data;
    const sum = data.items.reduce((s, i) => s + i.price, 0);
    assert.ok(Math.abs(sum - data.payments[0].amount) < 0.011,
      `sucet poloziek ${sum} != platba ${data.payments[0].amount}`);
    assert.equal(data.payments[0].amount, 11.5);
    assert.ok(data.items.some((i) => i.type === 'Discount'), 'chyba zlavovy riadok');
  });

  it('PLATITEL: polozka s 0 % v menu skonci 400 a nic sa nezapise', async () => {
    await setVatPayer('SK2121741842');
    const order = await withMenuVatRate(fx.itemPivo.id, '0.00', () => createOpenOrder([
      { menuItemId: fx.itemPivo.id, qty: 1 },
    ]));

    const res = await withMenuVatRate(fx.itemPivo.id, '0.00', () => request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [{ id: 1, name: 'Pivo', qty: 1, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 2.5,
      }));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /platite/i);
    assert.equal(await countParagons(), 0, 'odmietnuty paragon sa NESMIE zapisat');
  });

  it('PLATITEL: nepodporovana sadzba 20,00 z menu skonci 400 a NIC sa nezapise', async () => {
    // Manazer omylom ulozi 20 % (stara slovenska zakladna sadzba). Portos take
    // sadzby neprijma — chyba musi prist HNED pri vystaveni, nie az po 100
    // retry-och nad zmrazenym payloadom, ktory sa uz neda prepocitat.
    await setVatPayer('SK2121741842');
    const order = await withMenuVatRate(fx.itemPivo.id, '20.00', () => createOpenOrder([
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ]));

    const res = await withMenuVatRate(fx.itemPivo.id, '20.00', () => request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [{ id: 1, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 5,
      }));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /20\.00%/, 'hlaska musi pomenovat konkretnu zlu sadzbu');
    assert.equal(res.body.fiscal?.status, 'validation_error');
    assert.equal(await countParagons(), 0, 'odmietnuty paragon sa NESMIE zapisat');
  });

  it('PLATITEL bez orderId: nepodporovana sadzba 20,00 z menu tiez skonci 400', async () => {
    // Fallback vetva (nesynchnuty kosik) sadzbu tiez berie z menu_items — guard
    // musi platit rovnako, inak by sa dala obist vynechanim orderId.
    await setVatPayer('SK2121741842');

    const res = await withMenuVatRate(fx.itemPivo.id, '20.00', () => request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [{ id: 1, menuItemId: fx.itemPivo.id, name: 'Pivo', qty: 2, price: 2.5, vatRate: null }],
        paymentMethod: 'hotovost',
        totalAmount: 5,
      }));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /20\.00%/);
    assert.equal(await countParagons(), 0, 'odmietnuty paragon sa NESMIE zapisat');
  });

  it('PLATITEL bez orderId a bez zhody v menu: 400 namiesto tichej nuly', async () => {
    // Ani menuItemId, ani nazov sa v menu nenajde -> sadzba je neznama.
    // Radsej hlasna chyba nez zmrazeny payload s tichou nulou.
    await setVatPayer('SK2121741842');
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [{ id: 1, name: 'Polozka co v menu nie je', qty: 1, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 2.5,
      });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /sadzbu DPH/i);
    assert.equal(await countParagons(), 0, 'odmietnuty paragon sa NESMIE zapisat');
  });

  it('PLATITEL: Android bez menuItemId — sadzby sa dohladaju podla NAZVU', async () => {
    // Android v3.3.0 bezi na produkcnej kase a `menuItemId` NEposiela vobec
    // (ParagonItem ma len id order-itemu, nazov, mnozstvo, cenu). Bez
    // name-fallbacku by pri vypadku eKasy nahradny doklad podla § 10 nevznikol
    // vobec — presne vtedy, ked je najviac potrebny.
    await setVatPayer('SK2121741842');
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [
          { id: 11, name: 'Burger', qty: 1, price: 8.5, vatRate: 0 },
          { id: 12, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 13.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payloadOf(res.body).request.data;
    assert.equal(data.items.find((i) => i.name === 'Burger').vatRate, 5);
    assert.equal(data.items.find((i) => i.name === 'Pivo').vatRate, 23);
    assert.equal(data.payments[0].amount, 13.5);
    // V prevadzke musi byt vidno, ze sa islo cez name-fallback.
    assert.equal(res.body.itemSource, 'menu');
    assert.equal(res.body.itemsResolvedBy.menuName, 2);
    assert.equal(res.body.itemsResolvedBy.menuItemId, 0);
  });

  it('PLATITEL: name-fallback zvlada TRIM aj velke pismena, cenu berie z kasy', async () => {
    await setVatPayer('SK2121741842');
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [{ id: 21, name: '  pIvO  ', qty: 1, price: 3.2 }],
        paymentMethod: 'hotovost',
        totalAmount: 3.2,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const item = payloadOf(res.body).request.data.items[0];
    assert.equal(item.vatRate, 23, 'sadzba MUSI byt z menu_items');
    // Zhoda podla nazvu je slabsi dokaz totoznosti nez ID — cena ostava z kasy,
    // doklad musi niest to, co host realne zaplatil (menu ma 2,50).
    assert.equal(item.unitPrice, 3.2);
    assert.equal(res.body.itemsResolvedBy.menuName, 1);
  });

  it('PLATITEL: rovnaky nazov s ROZNOU sadzbou je nejednoznacny → 400', async () => {
    await setVatPayer('SK2121741842');
    const res = await withExtraMenuItem({ name: 'Pivo', price: '2.50', vatRate: '5.00' }, () =>
      request.post('/api/paragons')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .send({
          items: [{ id: 31, name: 'Pivo', qty: 1, price: 2.5 }],
          paymentMethod: 'hotovost',
          totalAmount: 2.5,
        }));

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /r[oô]znou sadzbou dph/i);
    assert.match(res.body.error, /5 %/);
    assert.match(res.body.error, /23 %/);
    assert.equal(await countParagons(), 0, 'nejednoznacny paragon sa NESMIE zapisat');
  });

  it('PLATITEL: presna zhoda nazvu ma prednost pred case-insensitive', async () => {
    // 'PIVO' (5 %) sa lisi iba velkostou pismen — presna zhoda 'Pivo' (23 %)
    // vyhrava a nejde o nejednoznacnost.
    await setVatPayer('SK2121741842');
    const res = await withExtraMenuItem({ name: 'PIVO', price: '2.50', vatRate: '5.00' }, () =>
      request.post('/api/paragons')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .send({
          items: [{ id: 41, name: 'Pivo', qty: 1, price: 2.5 }],
          paymentMethod: 'hotovost',
          totalAmount: 2.5,
        }));

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(payloadOf(res.body).request.data.items[0].vatRate, 23);
    assert.equal(res.body.itemsResolvedBy.menuName, 1);
  });

  it('PLATITEL: menuItemId ma prednost pred nazvom', async () => {
    // Klient posle menuItemId Burgera, ale nazov 'Pivo' — rozhodnut musi ID.
    await setVatPayer('SK2121741842');
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [{ id: 51, menuItemId: fx.itemBurger.id, name: 'Pivo', qty: 1, price: 2.5 }],
        paymentMethod: 'hotovost',
        totalAmount: 8.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const item = payloadOf(res.body).request.data.items[0];
    assert.equal(item.name, 'Burger');
    assert.equal(item.vatRate, 5);
    assert.equal(res.body.itemsResolvedBy.menuItemId, 1);
    assert.equal(res.body.itemsResolvedBy.menuName, 0);
  });

  it('PLATITEL bez orderId + per-item zlava: riadky sa scitaju na sumu paragonu', async () => {
    await setVatPayer('SK2121741842');
    // Nesynchnuty kosik -> fallback na telo requestu. Kasa posiela per-item
    // zlavu; bez nej by server vyratal 13,50 a paragon by odmietol ako mismatch.
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [
          { id: 1, menuItemId: fx.itemBurger.id, name: 'Burger', qty: 1, price: 8.5, vatRate: null, discountAmount: 8.5 },
          { id: 2, menuItemId: fx.itemPivo.id, name: 'Pivo', qty: 2, price: 2.5, vatRate: null, discountAmount: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payloadOf(res.body).request.data;
    const sum = data.items.reduce((s, i) => s + i.price, 0);
    assert.ok(Math.abs(sum - data.payments[0].amount) < 0.011,
      `sucet poloziek ${sum} != platba ${data.payments[0].amount}`);
    assert.equal(data.payments[0].amount, 5);
    // Zlavovy riadok musi niest sadzbu SVOJEJ polozky (Burger = 5 %), nie 0.
    const discountLine = data.items.find((i) => i.type === 'Discount');
    assert.ok(discountLine, 'chyba zlavovy riadok');
    assert.equal(discountLine.vatRate, 5);
  });

  it('NEPLATITEL bez orderId: snapshot z kasy prejde ako doteraz', async () => {
    const res = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [{ id: 1, name: 'Pivo', qty: 1, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 2.5,
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = payloadOf(res.body).request.data;
    assert.equal(data.payments[0].amount, 2.5);
    assert.equal(data.items[0].vatRate, 0);
  });
});

describe('registerOneParagon — offline_accepted (HTTP 202)', () => {
  it('202 sa uzna ako uspech, paragon je registered + fiscal_document existuje', async () => {
    const order = await createOpenOrder([{ menuItemId: fx.itemPivo.id, qty: 1 }]);
    const issue = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [{ id: 1, name: 'Pivo', qty: 1, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 2.5,
      });
    assert.equal(issue.status, 200, JSON.stringify(issue.body));

    process.env.PORTOS_ENABLED = 'true';
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/receipts/paragon')) {
        return {
          status: 202,
          ok: false,
          text: async () => JSON.stringify({
            isSuccessful: null,
            request: { id: 'req-1', data: { okp: 'OKP-TEST', receiptNumber: 7 } },
            response: { data: { id: 'rcpt-1' } },
          }),
        };
      }
      return { status: 404, ok: false, text: async () => '{}' };
    };

    const result = await registerOneParagon(issue.body.paragonId);
    assert.equal(result.ok, true, JSON.stringify(result));

    const [row] = await testDb.select().from(schema.offlineParagons)
      .where(sql`${schema.offlineParagons.id} = ${issue.body.paragonId}`);
    assert.equal(row.status, 'registered');
    assert.ok(row.fiscalDocumentId, 'chyba fiscal_document');
    // Jadro nalezu [19]: 202 sa NESMIE brat ako zlyhanie. Jeden pokus, ziadna
    // chyba — bez toho by paragon zostal 'pending' a retryoval sa 100×.
    assert.equal(row.attempts, 1, 'jeden pokus staci — 202 nie je zlyhanie');
    assert.equal(row.lastError, null, 'uspesny 202 nesmie nechat lastError');

    const [fd] = await testDb.select().from(schema.fiscalDocuments)
      .where(sql`${schema.fiscalDocuments.id} = ${row.fiscalDocumentId}`);
    assert.equal(fd.resultMode, 'offline_accepted');
    assert.equal(fd.requestType, 'paragon');
    // Pri 202 este nie je vysledok z FS — stlpce to musia povolit.
    assert.equal(fd.isSuccessful, null);

    // Opakovany beh (background worker) uz nesmie POSTnut druhy doklad.
    let reposted = false;
    global.fetch = async () => { reposted = true; return { status: 500, ok: false, text: async () => '{}' }; };
    const again = await registerOneParagon(issue.body.paragonId);
    assert.equal(again.alreadyRegistered, true);
    assert.equal(reposted, false, 'registrovany paragon sa nesmie poslat znova');
  });
});

describe('registerOneParagon — zachrana zmrazeneho payloadu', () => {
  it('prepise stary kod pokladne a zachova externalId', async () => {
    // Paragon sa vystavi este so STARYM kodom pokladne (sync nedobehol)
    await setVatPayer('', '88812345678900001');
    const order = await createOpenOrder([{ menuItemId: fx.itemPivo.id, qty: 1 }]);
    const issue = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [{ id: 1, name: 'Pivo', qty: 1, price: 2.5, vatRate: 0 }],
        paymentMethod: 'hotovost',
        totalAmount: 2.5,
      });
    assert.equal(issue.status, 200, JSON.stringify(issue.body));
    const frozenExternalId = JSON.parse(issue.body.requestPayloadJson).request.externalId;
    const frozenCode = JSON.parse(issue.body.requestPayloadJson).request.data.cashRegisterCode;

    // Portos profile sync medzitym dobehol a priniesol INY kod pokladne
    await setVatPayer('');
    process.env.PORTOS_ENABLED = 'true';
    process.env.POS_VAT_REGISTERED = 'false';
    let posted = null;
    global.fetch = async (url, opts) => {
      const href = String(url);
      if (href.includes('/receipts/paragon')) {
        posted = JSON.parse(opts.body);
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({
            isSuccessful: true,
            request: { id: 'req-2', data: { okp: 'OKP-2', receiptNumber: 9 } },
            response: { data: { id: 'rcpt-2' } },
          }),
        };
      }
      return { status: 404, ok: false, text: async () => '{}' };
    };

    const result = await registerOneParagon(issue.body.paragonId);
    delete process.env.POS_VAT_REGISTERED;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(frozenCode, '88821217418420001');
    assert.equal(posted.request.data.cashRegisterCode, '88821217418420001');
    assert.equal(posted.request.externalId, frozenExternalId);
    assert.ok(posted.request.data.items.every((i) => i.vatRate === 0));
  });

  it('platitel DPH + zmrazene nuly + objednavka → prebuduje realne sadzby', async () => {
    const order = await createOpenOrder([
      { menuItemId: fx.itemBurger.id, qty: 1 },
      { menuItemId: fx.itemPivo.id, qty: 2 },
    ]);
    const issue = await request.post('/api/paragons')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        orderId: order.id,
        items: [
          { id: 1, name: 'Burger', qty: 1, price: 8.5, vatRate: 0 },
          { id: 2, name: 'Pivo', qty: 2, price: 2.5, vatRate: 0 },
        ],
        paymentMethod: 'hotovost',
        totalAmount: 13.5,
      });
    assert.equal(issue.status, 200, JSON.stringify(issue.body));
    assert.ok(JSON.parse(issue.body.requestPayloadJson).request.data.items.every((i) => i.vatRate === 0));

    // Firma sa medzitym stala platitelom DPH
    await setVatPayer('SK2121741842');
    process.env.PORTOS_ENABLED = 'true';
    process.env.POS_VAT_REGISTERED = 'true';
    let posted = null;
    global.fetch = async (url, opts) => {
      const href = String(url);
      if (href.includes('/receipts/paragon')) {
        posted = JSON.parse(opts.body);
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({
            isSuccessful: true,
            request: { id: 'req-3', data: { okp: 'OKP-3', receiptNumber: 11 } },
            response: { data: { id: 'rcpt-3' } },
          }),
        };
      }
      return { status: 404, ok: false, text: async () => '{}' };
    };

    const result = await registerOneParagon(issue.body.paragonId);
    delete process.env.POS_VAT_REGISTERED;
    assert.equal(result.ok, true, JSON.stringify(result));
    const rates = posted.request.data.items.map((i) => i.vatRate).sort((a, b) => a - b);
    assert.deepEqual(rates, [5, 23]);
    assert.equal(posted.request.data.payments[0].amount, 13.5);
  });
});
