import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrphanedClockIns, buildAutoCloseRows } from '../../lib/attendance-auto-close.js';

const ev = (id, staffId, type, at) => ({ id, staffId, type, at: new Date(at) });

test('findOrphanedClockIns returns staff whose last event before cutoff is clock_in', () => {
  const events = [
    ev(1, 5, 'clock_in',  '2026-05-01T18:00:00Z'),
    ev(2, 5, 'clock_out', '2026-05-01T22:00:00Z'),
    ev(3, 6, 'clock_in',  '2026-05-01T19:00:00Z'),
    // staff 6 forgot to clock out
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z'); // 04:00 Bratislava
  const orphans = findOrphanedClockIns(events, cutoff);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].staffId, 6);
  assert.equal(orphans[0].lastInEvent.id, 3);
});

test('findOrphanedClockIns ignores staff whose last event is after cutoff', () => {
  const events = [
    ev(1, 5, 'clock_in', '2026-05-02T03:00:00Z'), // already after cutoff — current shift, leave alone
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  assert.equal(findOrphanedClockIns(events, cutoff).length, 0);
});

test('findOrphanedClockIns ignores staff whose last event is clock_out', () => {
  const events = [
    ev(1, 5, 'clock_in',  '2026-05-01T18:00:00Z'),
    ev(2, 5, 'clock_out', '2026-05-01T22:00:00Z'),
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  assert.equal(findOrphanedClockIns(events, cutoff).length, 0);
});

test('buildAutoCloseRows returns one clock_out row per orphan with the cutoff timestamp', () => {
  const orphans = [
    { staffId: 6, lastInEvent: ev(3, 6, 'clock_in', '2026-05-01T19:00:00Z') },
    { staffId: 7, lastInEvent: ev(4, 7, 'clock_in', '2026-05-01T20:00:00Z') },
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  const rows = buildAutoCloseRows(orphans, cutoff);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    staffId: 6, type: 'clock_out', at: cutoff, source: 'auto_close', note: 'auto', reason: null,
  });
  assert.deepEqual(rows[1], {
    staffId: 7, type: 'clock_out', at: cutoff, source: 'auto_close', note: 'auto', reason: null,
  });
});
