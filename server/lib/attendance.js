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
      // Clamp na >= 0: manuálna úprava môže posunúť odchod pred príchod
      // (preklep / nudge), čo by inak dalo zápornú mzdu tečúcu do
      // outstanding/balance. Mirror frontendového buildShifts guardu aj
      // clampov v /active a computeWageWithOverlap.
      const minutes = Math.max(0, Math.round((ev.at.getTime() - openIn.at.getTime()) / 60000));
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

/**
 * Overlap pravidlá — keď dvaja zamestnanci robia SPOLU (prekryv smien),
 * jeden z nich má na tie spoločné hodiny inú sadzbu než svoju normálnu.
 *
 * Pr.: Oleg (id 3) keď robí s Jarikom (id 5), dostáva na prekryvajúce
 * hodiny 5 €/h namiesto svojej normálnej 9 €/h. Sólo hodiny ostávajú 9 €/h.
 *
 * Hardcoded — jedno konkrétne pravidlo pre túto prevádzku. Keby pribudli
 * ďalšie, spravíme z toho DB tabuľku; teraz YAGNI.
 */
export const OVERLAP_RULES = [
  { staffId: 3, withStaffId: 5, overlapRate: 5.00 },
];

/**
 * Spočíta prekryvové minúty medzi dvoma sadami smien (len uzavreté — open
 * smena nemá koniec, nedá sa rátať prekryv). O(n*m) ale n,m sú malé (smeny
 * za obdobie). Sčíta všetky prekryvy (aj viac smien za deň).
 *
 * @param {Array} shiftsA - pairEventsToShifts() výstup pre osobu A
 * @param {Array} shiftsB - pairEventsToShifts() výstup pre osobu B
 * @returns {number} prekryvové minúty
 */
export function overlapMinutes(shiftsA, shiftsB) {
  let total = 0;
  for (const a of shiftsA) {
    if (!a.closed || !a.inEvent || !a.outEvent) continue;
    const aStart = a.inEvent.at.getTime();
    const aEnd = a.outEvent.at.getTime();
    for (const b of shiftsB) {
      if (!b.closed || !b.inEvent || !b.outEvent) continue;
      const bStart = b.inEvent.at.getTime();
      const bEnd = b.outEvent.at.getTime();
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (end > start) total += Math.round((end - start) / 60000);
    }
  }
  return total;
}

/**
 * Mzda s overlap pravidlom: sólo minúty × normálna sadzba + prekryvové
 * minúty × overlap sadzba.
 *
 * @param {number} minutes - celkové odpracované minúty
 * @param {number|string} hourlyRate - normálna sadzba
 * @param {number} ovMinutes - z toho prekryvové minúty
 * @param {number} overlapRate - sadzba pre prekryv
 */
export function computeWageWithOverlap(minutes, hourlyRate, ovMinutes, overlapRate) {
  const rate = parseFloat(hourlyRate);
  if (!Number.isFinite(rate)) return 0;
  const ov = Math.max(0, Math.min(ovMinutes || 0, minutes)); // clamp do <0, minutes>
  const solo = minutes - ov;
  const wage = (solo / 60) * rate + (ov / 60) * (Number(overlapRate) || 0);
  return Math.round(wage * 100) / 100;
}


// ── Mesačné bucketovanie (samoobslužný prehľad zárobku) ────────────────────
// Server beží v UTC, ale mesiac patrí človeku v Bratislave: smena, ktorá
// začala 31. 8. o 23:30 UTC, je 1. 9. 00:30 lokálne — patrí do septembra.
const YM_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit',
});

/** 'YYYY-MM' dátumu v Europe/Bratislava. */
export function monthKeyBratislava(date) {
  const parts = YM_PARTS.formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return `${y}-${m}`;
}

/** Map ym → [index do `rows`]; poradie indexov zachované. */
export function groupIndexByMonth(rows) {
  const map = new Map();
  rows.forEach((r, i) => {
    if (!map.has(r.ym)) map.set(r.ym, []);
    map.get(r.ym).push(i);
  });
  return map;
}

/**
 * Súčty nad riadkami smien ({ closed, minutes, paid: {amount}|null }).
 * Bez sadzby — mzdu (aj overlap) dopočíta volajúci, lebo potrebuje DB.
 */
export function summarizeShiftRows(rows) {
  let minutes = 0, paid = 0, shiftCount = 0, openShifts = 0;
  for (const r of rows) {
    if (r.closed) {
      shiftCount += 1;
      minutes += r.minutes || 0;
      paid += r.paid ? (Number(r.paid.amount) || 0) : 0;
    } else {
      openShifts += 1;
    }
  }
  return { minutes, paid: Math.round(paid * 100) / 100, shiftCount, openShifts };
}
