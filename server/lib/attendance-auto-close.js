/**
 * Pure helpers for the daily auto-close cron. No DB access — caller
 * loads recent events and inserts the returned rows in a single TX.
 *
 * Contract: events is an array of { id, staffId, type, at: Date } sorted
 * ASCENDING by `at`. cutoff is the Date at which we declare unfinished
 * shifts dead (typically 04:00 Bratislava local).
 *
 * findOrphanedClockIns groups events by staff, takes the last event
 * before the cutoff, and returns those whose last event is clock_in.
 * Staff whose last event is at-or-after the cutoff are left alone —
 * those are current/future shifts the cron must not touch.
 */

export function findOrphanedClockIns(events, cutoff) {
  const lastByStaff = new Map();
  for (const ev of events) {
    if (ev.at >= cutoff) continue;
    lastByStaff.set(ev.staffId, ev);
  }
  const orphans = [];
  for (const [staffId, lastInEvent] of lastByStaff.entries()) {
    if (lastInEvent.type === 'clock_in') {
      orphans.push({ staffId, lastInEvent });
    }
  }
  return orphans;
}

export function buildAutoCloseRows(orphans, cutoff) {
  return orphans.map(({ staffId }) => ({
    staffId,
    type: 'clock_out',
    at: cutoff,
    source: 'auto_close',
    note: 'auto',
    reason: null,
  }));
}
