/**
 * Attendance helpers — pure functions, no DB or framework deps.
 *
 * Events come in as `{ id, type, at }` rows ordered by `at` ASC. We pair
 * each `clock_in` with the next `clock_out` for the same staff. A trailing
 * `clock_in` with no `clock_out` is an "open" shift (cashier forgot to
 * clock out) and contributes 0 minutes — admin must close it manually.
 */

export function pairEventsToShifts(events) {
  const shifts = [];
  let openIn = null;
  for (const ev of events) {
    if (ev.type === 'clock_in') {
      if (openIn) {
        // Two clock_ins in a row = previous shift never closed. Keep it open.
        shifts.push({ inEvent: openIn, outEvent: null, minutes: 0, closed: false });
      }
      openIn = ev;
    } else if (ev.type === 'clock_out') {
      if (!openIn) continue; // stray clock_out
      const minutes = Math.round((ev.at.getTime() - openIn.at.getTime()) / 60000);
      shifts.push({ inEvent: openIn, outEvent: ev, minutes, closed: true });
      openIn = null;
    }
  }
  if (openIn) {
    shifts.push({ inEvent: openIn, outEvent: null, minutes: 0, closed: false });
  }
  return shifts;
}

export function summarizeHours(shifts) {
  let minutes = 0;
  let openShifts = 0;
  for (const s of shifts) {
    if (s.closed) minutes += s.minutes;
    else openShifts += 1;
  }
  return { minutes, openShifts };
}

export function computeWage(minutes, hourlyRate) {
  const rate = parseFloat(hourlyRate);
  if (!Number.isFinite(rate)) return 0;
  return Math.round((minutes / 60) * rate * 100) / 100;
}
