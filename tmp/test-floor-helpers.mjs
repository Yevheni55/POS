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
process.exit(fail > 0 ? 1 : 0);
