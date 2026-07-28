// Čisté unit testy pre TZ pomôcky reportov (bez DB).
// Testy NESMÚ závisieť od timezone vývojárskeho stroja — server beží
// v Dockeri v UTC, vývojár typicky v Europe/Bratislava. Všetky vstupy sú
// preto absolútne instanty (ISO s 'Z') a očakávania sú v Europe/Bratislava.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { localHourSlices } from '../../lib/reports/weekly.js';
import { localDateSK, localTimeHHMM, localYmd } from '../../lib/print/format.js';

describe('localHourSlices — hodinové buckety v Europe/Bratislava', () => {
  it('zaradí minúty po polnoci do lokálnej hodiny 0, nie do UTC hodiny 22/23', () => {
    // 2026-07-14 22:15Z = 2026-07-15 00:15 Bratislava (CEST, UTC+2)
    const slices = localHourSlices('2026-07-14T22:15:00.000Z', '2026-07-14T22:45:00.000Z');
    assert.equal(slices.length, 1);
    assert.deepEqual(slices[0], { date: '2026-07-15', hour: 0, minutes: 30 });
  });

  it('reže zmenu presne na lokálnych hodinových hraniciach', () => {
    // 2026-01-15 17:30Z → 19:30Z = 18:30 → 20:30 Bratislava (CET, UTC+1)
    const slices = localHourSlices('2026-01-15T17:30:00.000Z', '2026-01-15T19:30:00.000Z');
    assert.deepEqual(slices, [
      { date: '2026-01-15', hour: 18, minutes: 30 },
      { date: '2026-01-15', hour: 19, minutes: 60 },
      { date: '2026-01-15', hour: 20, minutes: 30 },
    ]);
    assert.equal(slices.reduce((s, x) => s + x.minutes, 0), 120);
  });

  it('rozdelí nočnú zmenu cez polnoc na dva lokálne dni', () => {
    // 2026-07-15 21:00Z (23:00 lokálne) → 2026-07-15 23:00Z (01:00 lokálne)
    const slices = localHourSlices('2026-07-15T21:00:00.000Z', '2026-07-15T23:00:00.000Z');
    assert.deepEqual(slices, [
      { date: '2026-07-15', hour: 23, minutes: 60 },
      { date: '2026-07-16', hour: 0, minutes: 60 },
    ]);
  });

  it('zachová celkový počet minút aj cez jarný DST prechod', () => {
    // 2026-03-29 01:00Z: Bratislava skáče z 02:00 CET na 03:00 CEST.
    const slices = localHourSlices('2026-03-29T00:30:00.000Z', '2026-03-29T02:30:00.000Z');
    assert.equal(slices.reduce((s, x) => s + x.minutes, 0), 120);
    assert.deepEqual(slices.map(x => x.hour), [1, 3, 4]);
    assert.ok(slices.every(x => x.date === '2026-03-29'));
  });

  it('nestratí minúty ani pri jesennom DST prechode (hodina 2 je dvakrát)', () => {
    // 2026-10-25 01:00Z: Bratislava skáče z 03:00 CEST späť na 02:00 CET,
    // takže lokálna hodina 2 nastane dvakrát. Konzumenti (byHour / hourCell)
    // minúty pripočítavajú, takže duplicitný bucket je OK — nesmie sa však
    // stratiť ani jedna minúta.
    const slices = localHourSlices('2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00.000Z');
    assert.equal(slices.reduce((s, x) => s + x.minutes, 0), 120);
    assert.deepEqual(slices.map(x => x.hour), [2, 2, 3]);
    assert.ok(slices.every(x => x.date === '2026-10-25'));
  });

  it('vráti prázdne pole pre nulovú alebo zápornú zmenu', () => {
    assert.deepEqual(localHourSlices('2026-07-15T10:00:00Z', '2026-07-15T10:00:00Z'), []);
    assert.deepEqual(localHourSlices('2026-07-15T10:00:00Z', '2026-07-15T09:00:00Z'), []);
  });
});

describe('format.js — lokálny dátum/čas', () => {
  it('localDateSK a localTimeHHMM vracajú Bratislavský deň, nie UTC deň', () => {
    const justAfterMidnight = new Date('2026-07-14T22:30:00.000Z'); // 00:30 dňa 15.
    assert.equal(localTimeHHMM(justAfterMidnight), '00:30');
    assert.match(localDateSK(justAfterMidnight), /15\D+07\D+2026/);
  });

  it('funguje aj v zimnom čase (CET, UTC+1)', () => {
    const winter = new Date('2026-01-14T23:30:00.000Z'); // 00:30 dňa 15.
    assert.equal(localTimeHHMM(winter), '00:30');
    assert.match(localDateSK(winter), /15\D+01\D+2026/);
  });
});

describe('localYmd — defaultný deň reportov', () => {
  it('vráti lokálny kalendárny deň, nie UTC deň', () => {
    assert.equal(localYmd(new Date('2026-07-14T22:30:00.000Z')), '2026-07-15'); // CEST
    assert.equal(localYmd(new Date('2026-01-14T23:30:00.000Z')), '2026-01-15'); // CET
    assert.equal(localYmd(new Date('2026-07-15T10:00:00.000Z')), '2026-07-15');
  });
});
