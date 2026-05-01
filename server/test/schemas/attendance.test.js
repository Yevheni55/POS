import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinSchema, clockSchema, manualEventSchema, summaryQuerySchema, attendanceReasonSchema } from '../../schemas/attendance.js';

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

test('manualEventSchema requires staffId + type + at + reason; note optional', () => {
  const ok = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'forgot', note: 'forgot to clock',
  });
  assert.equal(ok.success, true);
  // No reason → reject
  const noReason = manualEventSchema.safeParse({ staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z' });
  assert.equal(noReason.success, false);
  // Bad enum value → reject
  const bad = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'whatever',
  });
  assert.equal(bad.success, false);
});

test('attendanceReasonSchema accepts the documented values', () => {
  for (const v of ['forgot','wrong_time','shift_change','pin_failed','other']) {
    assert.equal(attendanceReasonSchema.safeParse(v).success, true, `should accept "${v}"`);
  }
  assert.equal(attendanceReasonSchema.safeParse('').success, false);
});

test('summaryQuerySchema requires from <= to as ISO date strings', () => {
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-31' }).success, true);
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-31', to: '2026-05-01' }).success, false);
  assert.equal(summaryQuerySchema.safeParse({ from: 'bad', to: '2026-05-01' }).success, false);
});
