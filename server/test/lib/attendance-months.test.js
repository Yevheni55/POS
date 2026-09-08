import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthKeyBratislava, groupIndexByMonth, summarizeShiftRows } from '../../lib/attendance.js';

test('monthKeyBratislava buckets by Bratislava month, not UTC', () => {
  // CEST (UTC+2): 21:30Z je ešte 31. 8. 23:30 lokálne, 22:30Z je už 1. 9. 00:30.
  assert.equal(monthKeyBratislava(new Date('2026-08-31T21:30:00Z')), '2026-08');
  assert.equal(monthKeyBratislava(new Date('2026-08-31T22:30:00Z')), '2026-09');
  // CET (UTC+1) v zime — rovnaký princíp cez polnoc.
  assert.equal(monthKeyBratislava(new Date('2026-01-31T23:30:00Z')), '2026-02');
  assert.equal(monthKeyBratislava(new Date('2026-01-31T22:30:00Z')), '2026-01');
});

test('groupIndexByMonth keeps index order inside each month', () => {
  const rows = [
    { ym: '2026-07' }, { ym: '2026-08' }, { ym: '2026-07' }, { ym: '2026-09' },
  ];
  const map = groupIndexByMonth(rows);
  assert.deepEqual([...map.keys()], ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(map.get('2026-07'), [0, 2]);
  assert.deepEqual(map.get('2026-09'), [3]);
});

test('summarizeShiftRows counts only closed shifts into minutes and paid', () => {
  const rows = [
    { closed: true,  minutes: 480, paid: { amount: '40.00' } },
    { closed: true,  minutes: 300, paid: null },
    { closed: false, minutes: 0,   paid: null },           // otvorená — ešte nie je hotová
  ];
  const s = summarizeShiftRows(rows);
  assert.equal(s.minutes, 780);
  assert.equal(s.paid, 40);
  assert.equal(s.shiftCount, 2);
  assert.equal(s.openShifts, 1);
});

test('summarizeShiftRows on empty input is all zeros', () => {
  assert.deepEqual(summarizeShiftRows([]), { minutes: 0, paid: 0, shiftCount: 0, openShifts: 0 });
});
