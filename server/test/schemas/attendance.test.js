import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinSchema, clockSchema, manualEventSchema, summaryQuerySchema } from '../../schemas/attendance.js';

test('pinSchema accepts 4-6 digits', () => {
  assert.equal(pinSchema.safeParse({ pin: '1234' }).success, true);
  assert.equal(pinSchema.safeParse({ pin: '123456' }).success, true);
  assert.equal(pinSchema.safeParse({ pin: '12' }).success, false);
  assert.equal(pinSchema.safeParse({ pin: '1234567' }).success, false);
  assert.equal(pinSchema.safeParse({ pin: '12ab' }).success, false);
});

test('clockSchema requires pin + valid type', () => {
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'clock_in' }).success, true);
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'clock_out' }).success, true);
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'punch' }).success, false);
  assert.equal(clockSchema.safeParse({ pin: '1234' }).success, false);
});

test('manualEventSchema requires staffId + type + at + optional note', () => {
  const ok = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', note: 'forgot',
  });
  assert.equal(ok.success, true);
  const bad = manualEventSchema.safeParse({ staffId: 'x', type: 'clock_in', at: 'not a date' });
  assert.equal(bad.success, false);
});

test('summaryQuerySchema requires from <= to as ISO date strings', () => {
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-31' }).success, true);
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-31', to: '2026-05-01' }).success, false);
  assert.equal(summaryQuerySchema.safeParse({ from: 'bad', to: '2026-05-01' }).success, false);
});
