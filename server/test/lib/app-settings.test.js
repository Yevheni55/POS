// Serverové nastavenia: pauza príjmu (auto-návrat po čase), Auto-prijímať, lokálne časy.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { truncateAll, closeDb } from '../helpers/setup.js';
import { getPause, setPause, clearPause, getAutoAccept, setAutoAccept, endOfLocalDay, nextMorning, getSetting } from '../../lib/app-settings.js';

const TZ = 'Europe/Bratislava';
const local = (d) => new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);

before(async () => { await truncateAll(); });
after(async () => { await closeDb(); });

describe('app-settings', () => {
  it('pauza: uloží sa s dôvodom, po vypršaní sa tvári ako žiadna, zrušenie ju zmaže', async () => {
    assert.equal(await getPause(), null);
    const until = new Date(Date.now() + 30 * 60_000);
    await setPause({ until, reason: 'Preťažená kuchyňa', staffId: 7, staffName: 'Manager' });
    const p = await getPause();
    assert.ok(p && Math.abs(p.until.getTime() - until.getTime()) < 1000);
    assert.equal(p.reason, 'Preťažená kuchyňa');
    assert.equal(p.byName, 'Manager');
    assert.equal(await getPause(new Date(until.getTime() + 1000)), null, 'po čase auto-návrat bez cronu');
    await clearPause(7);
    assert.equal(await getPause(), null);
    assert.deepEqual(await getSetting('online_orders.pause'), {});
  });

  it('Auto-prijímať: vypnuté = predvolené, minúty v rozsahu 5–90', async () => {
    assert.deepEqual(await getAutoAccept(), { enabled: false, prepMinutes: 15 });
    await setAutoAccept({ enabled: true, prepMinutes: 200, staffId: 7 });
    assert.deepEqual(await getAutoAccept(), { enabled: true, prepMinutes: 90 });
    await setAutoAccept({ enabled: false, prepMinutes: 2 });
    assert.deepEqual(await getAutoAccept(), { enabled: false, prepMinutes: 5 });
  });

  it('koniec dňa je 23:59 v Bratislave, najbližšie ráno je 05:00 a je v budúcnosti', () => {
    const now = new Date();
    const eod = endOfLocalDay(now);
    assert.equal(local(eod), '23:59');
    assert.ok(eod.getTime() > now.getTime() - 60_000);
    const morning = nextMorning(now);
    assert.equal(local(morning), '05:00');
    assert.ok(morning.getTime() > now.getTime());
    assert.ok(morning.getTime() - now.getTime() <= 24 * 3600_000);
    // deterministicky: 2026-07-01 12:00 UTC (14:00 v BA) → ráno 2. 7. 05:00 BA = 03:00 UTC
    assert.equal(nextMorning(new Date('2026-07-01T12:00:00Z')).toISOString(), '2026-07-02T03:00:00.000Z');
    // v zime (UTC+1): 2026-01-10 02:00 UTC = 03:00 BA → ráno 10. 1. 05:00 BA = 04:00 UTC
    assert.equal(nextMorning(new Date('2026-01-10T02:00:00Z')).toISOString(), '2026-01-10T04:00:00.000Z');
    assert.equal(endOfLocalDay(new Date('2026-01-10T02:00:00Z')).toISOString(), '2026-01-10T22:59:00.000Z');
  });
});
