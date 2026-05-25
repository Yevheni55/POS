// Pure-JS test — reimplements totalsFor logic to verify shape
function totalsFor(rows) {
  let totalMinutes = 0, totalWage = 0, openShifts = 0, withRate = 0;
  let totalPaid = 0, totalOutstanding = 0;
  let outstandingPositive = 0;
  for (const r of rows) {
    totalMinutes += Number(r.minutes) || 0;
    totalWage += Number(r.wage) || 0;
    openShifts += Number(r.openShifts) || 0;
    totalPaid += Number(r.paidTotal) || 0;
    totalOutstanding += Number(r.outstanding) || 0;
    if (r.hourlyRate != null) withRate += 1;
    if (Number(r.outstanding) > 0.01) outstandingPositive += 1;
  }
  return {
    totalMinutes, totalWage, openShifts, totalStaff: rows.length, withRate,
    totalPaid, totalOutstanding, outstandingPositive,
  };
}

const cases = [
  {
    name: '3 staff, 2 unpaid, 1 overpaid',
    rows: [
      { name: 'Yevhen', minutes: 480, wage: 72, paidTotal: 50, outstanding: 22, hourlyRate: 9, openShifts: 0 },
      { name: 'Tania', minutes: 240, wage: 36, paidTotal: 0, outstanding: 36, hourlyRate: 9, openShifts: 1 },
      { name: 'ALex', minutes: 360, wage: 54, paidTotal: 60, outstanding: -6, hourlyRate: 9, openShifts: 0 },
    ],
    expect: { totalMinutes: 1080, totalWage: 162, totalPaid: 110, totalOutstanding: 52, outstandingPositive: 2, openShifts: 1, totalStaff: 3 },
  },
  {
    name: 'empty rows',
    rows: [],
    expect: { totalMinutes: 0, totalWage: 0, totalPaid: 0, totalOutstanding: 0, outstandingPositive: 0, totalStaff: 0 },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const actual = totalsFor(c.rows);
  let ok = true;
  for (const k of Object.keys(c.expect)) {
    if (Math.abs((actual[k] || 0) - c.expect[k]) > 0.001) {
      console.log('FAIL', c.name, '— field', k, ':', actual[k], '!=', c.expect[k]);
      ok = false;
    }
  }
  if (ok) { console.log('PASS', c.name); pass++; } else fail++;
}
console.log(pass + ' passed, ' + fail + ' failed');
let totalFails = fail;

// === Date range helpers (LOCAL TIME — toISOString() vrati UTC co drifta)
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function firstOfMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth(), 1));
}
function lastDayOfPrevMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth(), 0));
}
function firstOfPrevMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth() - 1, 1));
}
function mondayOfWeek(d) {
  const x = d ? new Date(d) : new Date();
  const day = x.getDay() || 7; // Sun=0 → 7
  x.setDate(x.getDate() - (day - 1));
  return ymdLocal(x);
}
function sundayOfWeek(d) {
  const x = d ? new Date(d) : new Date();
  const day = x.getDay() || 7;
  x.setDate(x.getDate() + (7 - day));
  return ymdLocal(x);
}

// Tests
const refDate = new Date('2026-05-26T12:00:00'); // utorok
const dateCases = [
  ['firstOfMonth', firstOfMonth(refDate), '2026-05-01'],
  ['lastDayOfPrevMonth', lastDayOfPrevMonth(refDate), '2026-04-30'],
  ['firstOfPrevMonth', firstOfPrevMonth(refDate), '2026-04-01'],
  ['mondayOfWeek (utorok)', mondayOfWeek(refDate), '2026-05-25'],
  ['sundayOfWeek (utorok)', sundayOfWeek(refDate), '2026-05-31'],
];
let datePass = 0, dateFail = 0;
for (const [name, actual, expected] of dateCases) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL'), name, '→', actual, ok ? '' : '(expected ' + expected + ')');
  if (ok) datePass++; else dateFail++;
}
console.log('Date helpers:', datePass + '/' + (datePass + dateFail));
totalFails += dateFail;

process.exit(totalFails > 0 ? 1 : 0);
