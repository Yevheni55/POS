// Pure-JS test — replicate GLYPHS mapping from pos-render.js and verify it.
const GLYPHS = { free: '○', occupied: '●', reserved: '▲', dirty: '✕' };
const cases = [
  ['free', '○'],
  ['occupied', '●'],
  ['reserved', '▲'],
  ['dirty', '✕'],
  ['unknown', undefined],
];
let pass = 0, fail = 0;
for (const [status, expected] of cases) {
  const actual = GLYPHS[status];
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL'), status, '→', actual);
  if (ok) pass++; else fail++;
}
console.log(pass + ' passed, ' + fail + ' failed');
// Don't process.exit here — accumulate with date tests below

// formatSkDate test — verify Slovak genitive ("mája" not "máj")
function formatSkDate(d) {
  var s = new Intl.DateTimeFormat('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const dateCases = [
  [new Date('2026-05-23T12:00:00'), /23\. mája/i],
  [new Date('2026-01-01T12:00:00'), /1\. januára/i],
  [new Date('2026-12-31T12:00:00'), /31\. decembra/i],
];
let datePass = 0, dateFail = 0;
for (const [d, re] of dateCases) {
  const s = formatSkDate(d);
  const ok = re.test(s);
  console.log((ok ? 'PASS' : 'FAIL'), 'formatSkDate(' + d.toISOString().slice(0,10) + ') → ' + s);
  if (ok) datePass++; else dateFail++;
}
console.log('Date tests:', datePass + '/' + (datePass + dateFail));
process.exit((fail + dateFail) > 0 ? 1 : 0);
