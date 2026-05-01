import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairEventsToShifts, summarizeHours, computeWage } from '../../lib/attendance.js';

const at = (iso) => new Date(iso);

test('pairEventsToShifts pairs in→out within the same day', () => {
  const events = [
    { id: 1, type: 'clock_in',  at: at('2026-05-01T09:00:00Z') },
    { id: 2, type: 'clock_out', at: at('2026-05-01T13:00:00Z') },
    { id: 3, type: 'clock_in',  at: at('2026-05-01T14:00:00Z') },
    { id: 4, type: 'clock_out', at: at('2026-05-01T18:30:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 2);
  assert.equal(shifts[0].minutes, 240);
  assert.equal(shifts[1].minutes, 270);
  assert.equal(shifts[0].closed, true);
  assert.equal(shifts[1].closed, true);
});

test('pairEventsToShifts marks an open shift when clock_in has no clock_out', () => {
  const events = [
    { id: 1, type: 'clock_in', at: at('2026-05-01T09:00:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].closed, false);
  assert.equal(shifts[0].minutes, 0);
});

test('pairEventsToShifts ignores a stray clock_out with no preceding clock_in', () => {
  const events = [
    { id: 1, type: 'clock_out', at: at('2026-05-01T13:00:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 0);
});

test('summarizeHours sums closed shifts only', () => {
  const shifts = [
    { minutes: 240, closed: true },
    { minutes: 270, closed: true },
    { minutes: 0,   closed: false }, // open shift, not counted
  ];
  assert.equal(summarizeHours(shifts).minutes, 510);
  assert.equal(summarizeHours(shifts).openShifts, 1);
});

test('computeWage rounds to 2 decimals', () => {
  // 510 minutes = 8.5 h * 12.34 EUR/h = 104.89 EUR
  assert.equal(computeWage(510, '12.34'), 104.89);
  // numeric NULL rate → 0
  assert.equal(computeWage(510, null), 0);
});
