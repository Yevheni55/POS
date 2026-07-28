// Žiadosti o opravu dochádzky — samoobslužné nahlásenie + schválenie manažérom.
//
// Prečo testy: schválenie ZAPISUJE do attendance_events, z ktorých sa počíta
// mzda. Chyba tu = niekto dostane zaplatené za smenu, ktorú neodrobil, alebo
// naopak príde o hodinu a pol, keď PIN zadal neskoro.
//
// Kryjeme: vytvorenie oboch typov, validáciu (budúcnosť, príliš staré, duplicita,
// odchod pred príchodom), role gate, schválenie late_pin (upraví existujúci
// príchod) aj missing_day (vytvorí celú smenu), dvojité schválenie a zamietnutie.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import { eq, and } from 'drizzle-orm';

import { app } from '../../app.js';
import { truncateAll, seed, testDb, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

const request = supertest(app);
app.set('io', { emit: () => {} });
after(closeDb);

const PIN = '4321';

/** Bratislavský deň posunutý o `delta` dní, ako 'YYYY-MM-DD'. */
async function dayIso(delta = 0) {
  const r = await testDb.execute(
    `SELECT to_char((NOW() AT TIME ZONE 'Europe/Bratislava')::date + ${Number(delta)}, 'YYYY-MM-DD') AS d`
  );
  return (r.rows || r)[0].d;
}

async function seedWithPin() {
  const fx = await seed();
  const hash = await bcrypt.hash(PIN, 10);
  await testDb.update(schema.staff)
    .set({ attendancePin: hash, hourlyRate: '8.00' })
    .where(eq(schema.staff.id, fx.cisnik.id));
  return fx;
}

function createReq(body) {
  return request.post('/api/attendance/requests').send({ pin: PIN, ...body });
}

async function requestsFor(staffId) {
  return testDb.select().from(schema.attendanceRequests)
    .where(eq(schema.attendanceRequests.staffId, staffId));
}

async function eventsFor(staffId) {
  return testDb.select().from(schema.attendanceEvents)
    .where(eq(schema.attendanceEvents.staffId, staffId));
}

describe('Žiadosti o opravu dochádzky — podanie na termináli', () => {
  let fx;
  before(async () => { await truncateAll(); fx = await seedWithPin(); });
  beforeEach(async () => { await truncateAll(); fx = await seedWithPin(); });

  it('zamestnanec podá žiadosť o zabudnutý deň', async () => {
    const d = await dayIso(-1);
    const res = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00',
      note: 'Zabudol som sa označiť',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending');

    const rows = await requestsFor(fx.cisnik.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'missing_day');
    // Žiadosť sama NESMIE zapísať dochádzku.
    assert.equal((await eventsFor(fx.cisnik.id)).length, 0, 'žiadosť nesmie meniť dochádzku');
  });

  it('žiadosť o neskoro zadaný PIN nemusí obsahovať odchod', async () => {
    const d = await dayIso(0);
    const res = await createReq({ type: 'late_pin', targetDate: d, claimedIn: '08:00' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.claimedOut, null);
  });

  it('zabudnutý deň BEZ odchodu je odmietnutý (inak by vznikla večne otvorená smena)', async () => {
    const d = await dayIso(-1);
    const res = await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00' });
    assert.equal(res.status, 400);
  });

  it('odchod pred príchodom je odmietnutý', async () => {
    const d = await dayIso(-1);
    const res = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '16:00', claimedOut: '08:00',
    });
    assert.equal(res.status, 400);
  });

  it('deň v budúcnosti sa nahlásiť nedá', async () => {
    const d = await dayIso(3);
    const res = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /budúcnosti/i);
  });

  it('príliš starý deň sa nahlásiť nedá', async () => {
    const d = await dayIso(-90);
    const res = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00',
    });
    assert.equal(res.status, 400);
  });

  it('druhá čakajúca žiadosť na ten istý deň je odmietnutá', async () => {
    const d = await dayIso(-1);
    const first = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00',
    });
    assert.equal(first.status, 201);
    const second = await createReq({
      type: 'missing_day', targetDate: d, claimedIn: '09:00', claimedOut: '17:00',
    });
    assert.equal(second.status, 409);
    assert.equal((await requestsFor(fx.cisnik.id)).length, 1);
  });

  it('nesprávny PIN neprejde', async () => {
    const d = await dayIso(-1);
    const res = await request.post('/api/attendance/requests').send({
      pin: '9999', type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00',
    });
    assert.equal(res.status, 401);
  });

  it('zamestnanec vidí svoje žiadosti cez PIN', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const res = await request.post('/api/attendance/my-requests').send({ pin: PIN });
    assert.equal(res.status, 200);
    assert.equal(res.body.requests.length, 1);
    assert.equal(res.body.requests[0].targetDate.slice(0, 10), d);
  });
});

describe('Žiadosti o opravu dochádzky — schvaľovanie', () => {
  let fx;
  before(async () => { await truncateAll(); fx = await seedWithPin(); });
  beforeEach(async () => { await truncateAll(); fx = await seedWithPin(); });

  async function pendingId() {
    const rows = await requestsFor(fx.cisnik.id);
    return rows[0].id;
  }

  it('schválenie zabudnutého dňa vytvorí celú smenu s auditom', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const id = await pendingId();

    const res = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({ note: 'ok' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const evs = await eventsFor(fx.cisnik.id);
    assert.equal(evs.length, 2, 'má vzniknúť príchod aj odchod');
    const cin = evs.find((e) => e.type === 'clock_in');
    const cout = evs.find((e) => e.type === 'clock_out');
    assert.ok(cin && cout);
    // Audit: nesmie to vyzerať ako PIN na termináli.
    assert.equal(cin.source, 'manual');
    assert.equal(cin.reason, 'forgot');
    assert.equal(cin.editedBy, 2);
    assert.match(cin.note, /Žiadosť #/);
    // 8 hodín rozdiel
    const diffH = (new Date(cout.at) - new Date(cin.at)) / 3600000;
    assert.equal(Math.round(diffH), 8);
  });

  it('schválenie neskorého PINu POSUNIE existujúci príchod, nevytvorí druhý', async () => {
    const d = await dayIso(0);
    // Simuluj, že sa človek označil neskoro: príchod o 09:30.
    const lateIn = await testDb.execute(
      `SELECT (('${d}' || ' 09:30')::timestamp AT TIME ZONE 'Europe/Bratislava') AS ts`
    );
    await testDb.insert(schema.attendanceEvents).values({
      staffId: fx.cisnik.id, type: 'clock_in',
      at: new Date(((lateIn.rows || lateIn)[0]).ts), source: 'pin',
    });

    await createReq({ type: 'late_pin', targetDate: d, claimedIn: '08:00' });
    const id = await pendingId();

    const res = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const evs = await eventsFor(fx.cisnik.id);
    assert.equal(evs.length, 1, 'príchod sa má upraviť, nie zdvojiť');
    assert.equal(evs[0].source, 'manual');
    assert.equal(evs[0].reason, 'wrong_time');
    // Čas musí sedieť na 08:00 bratislavského času.
    const hh = await testDb.execute(
      `SELECT to_char(TIMESTAMP WITH TIME ZONE '${evs[0].at.toISOString()}' AT TIME ZONE 'Europe/Bratislava', 'HH24:MI') AS t`
    );
    assert.equal(((hh.rows || hh)[0]).t, '08:00');
  });

  it('zabudnutý deň sa NEschváli, keď v ten deň už dochádzka je', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const id = await pendingId();

    // Manažér medzitým smenu doplnil ručne.
    const ts = await testDb.execute(
      `SELECT (('${d}' || ' 10:00')::timestamp AT TIME ZONE 'Europe/Bratislava') AS ts`
    );
    await testDb.insert(schema.attendanceEvents).values({
      staffId: fx.cisnik.id, type: 'clock_in',
      at: new Date(((ts.rows || ts)[0]).ts), source: 'manual', reason: 'forgot',
    });

    const res = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({});
    assert.equal(res.status, 409, 'nesmie vzniknúť dvojitá smena');
    assert.equal((await eventsFor(fx.cisnik.id)).length, 1);
  });

  it('druhé schválenie tej istej žiadosti je 409 a smenu nezdvojí', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const id = await pendingId();

    const first = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({});
    assert.equal(first.status, 200);

    const second = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({});
    assert.equal(second.status, 409);
    assert.equal((await eventsFor(fx.cisnik.id)).length, 2, 'smena sa nesmie zdvojiť');
  });

  it('zamietnutie dochádzku nemení', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const id = await pendingId();

    const res = await request.post(`/api/attendance/requests/${id}/reject`)
      .set('Authorization', `Bearer ${tokens.manazer()}`).send({ note: 'V ten deň si nebol' });
    assert.equal(res.status, 200);
    assert.equal((await eventsFor(fx.cisnik.id)).length, 0);

    const rows = await requestsFor(fx.cisnik.id);
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].reviewNote, 'V ten deň si nebol');
  });

  it('čašník nesmie schvaľovať ani čítať žiadosti', async () => {
    const d = await dayIso(-1);
    await createReq({ type: 'missing_day', targetDate: d, claimedIn: '08:00', claimedOut: '16:00' });
    const id = await pendingId();

    const list = await request.get('/api/attendance/requests')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(list.status, 403);

    const approve = await request.post(`/api/attendance/requests/${id}/approve`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`).send({});
    assert.equal(approve.status, 403);
    assert.equal((await eventsFor(fx.cisnik.id)).length, 0);
  });

  it('manažér vidí v zozname aj to, čo je v ten deň reálne v systéme', async () => {
    const d = await dayIso(0);
    const ts = await testDb.execute(
      `SELECT (('${d}' || ' 09:30')::timestamp AT TIME ZONE 'Europe/Bratislava') AS ts`
    );
    await testDb.insert(schema.attendanceEvents).values({
      staffId: fx.cisnik.id, type: 'clock_in',
      at: new Date(((ts.rows || ts)[0]).ts), source: 'pin',
    });
    await createReq({ type: 'late_pin', targetDate: d, claimedIn: '08:00' });

    const res = await request.get('/api/attendance/requests?status=pending')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.pendingCount, 1);
    assert.equal(res.body.requests[0].staffName, fx.cisnik.name);
    assert.equal(res.body.requests[0].existingEvents.length, 1,
      'manažér musí vidieť, že systém má na ten deň záznam');
  });
});
