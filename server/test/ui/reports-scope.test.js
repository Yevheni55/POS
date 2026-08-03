// Prepínač rozsahu reportov (`?scope=active|all`) v admin/pages/reports.js
// a admin/pages/season.js.
//
// Na kase sa vystriedali TRI daňové subjekty. Default `active` filtruje na
// aktívny cash_register_code (jediný správny podklad pre DPH), `all` filter
// uvoľní. Testy držia kontrakt: default, fail-safe normalizáciu, odolnosť
// voči nedostupnému localStorage a to, že uzávierka rozsah ZÁMERNE neposiela.
//
// Bez jsdom v repe sa netestuje render — testuje sa reálny zdroj helperov
// (vytiahnutý zo súboru a spustený vo `vm`) plus statické invarianty volaní.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// Repo je na Windows (CRLF) — normalizuj, nech kotvy na koniec riadku sedia.
function readSrc(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
const REPORTS_SRC = readSrc('admin/pages/reports.js');
const SEASON_SRC = readSrc('admin/pages/season.js');

// Texty pre používateľa sú v zdroji zreťazené cez `'a ' + 'b'`. Na kontrolu
// obsahu spoj literály dokopy, nech sa fráza dá hľadať ako súvislý text.
function joinedLiterals(src) {
  return src.replace(/'\s*\n?\s*\+\s*\n?\s*'/g, '');
}
const REPORTS_TEXT = joinedLiterals(REPORTS_SRC);
const SEASON_TEXT = joinedLiterals(SEASON_SRC);

/**
 * Vytiahne blok scope helperov zo zdroja stránky a spustí ho vo `vm`, takže
 * sa testuje naozaj odoslaný kód, nie jeho kópia v teste.
 *
 * @param {string} src zdroj admin stránky
 * @param {object|null} storage stub localStorage; `null` = globál chýba
 */
function loadScopeHelpers(src, storage) {
  const start = src.indexOf("const SCOPE_KEY = 'pos_reports_scope';");
  assert.notEqual(start, -1, 'blok scope helperov sa nenašiel — presunul sa?');
  const endMarker = 'function effectiveScope';
  const endIdx = src.indexOf(endMarker, start);
  assert.notEqual(endIdx, -1, 'effectiveScope() sa nenašiel');
  // Po effectiveScope() vezmi telo až po jeho uzatváraciu zátvorku na stĺpci 0.
  const tail = src.slice(endIdx);
  const bodyEnd = tail.indexOf('\n}\n');
  assert.notEqual(bodyEnd, -1, 'telo effectiveScope() sa nedá ohraničiť');
  const block = src.slice(start, endIdx) + tail.slice(0, bodyEnd + 3);

  const sandbox = { console };
  if (storage) sandbox.localStorage = storage;
  vm.createContext(sandbox);
  vm.runInContext(
    block + '\nglobalThis.__api = { normalizeScope, readScope, writeScope, effectiveScope, getScope: () => _scope };',
    sandbox,
  );
  return sandbox.__api;
}

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

for (const [label, src] of [['reports.js', REPORTS_SRC], ['season.js', SEASON_SRC]]) {
  test(`${label}: default rozsah je 'active'`, () => {
    const api = loadScopeHelpers(src, memoryStorage());
    assert.equal(api.readScope(), 'active');
    assert.equal(api.getScope(), 'active');
  });

  test(`${label}: zapamätaná voľba 'all' sa obnoví`, () => {
    const api = loadScopeHelpers(src, memoryStorage({ pos_reports_scope: 'all' }));
    assert.equal(api.getScope(), 'all', 'modul má čítať localStorage pri načítaní');
  });

  test(`${label}: neznáma hodnota padá na 'active' (fail-safe, nie chyba)`, () => {
    for (const junk of ['ALL', 'everything', '', '1', 'active ', 'null']) {
      const api = loadScopeHelpers(src, memoryStorage({ pos_reports_scope: junk }));
      assert.equal(api.normalizeScope(junk), 'active', `'${junk}' malo padnúť na active`);
      assert.equal(api.getScope(), 'active');
    }
    // Jediná hodnota, ktorá filter uvoľní.
    const api = loadScopeHelpers(src, memoryStorage());
    assert.equal(api.normalizeScope('all'), 'all');
  });

  test(`${label}: nedostupný localStorage nezhodí stránku`, () => {
    // Private mode / zakázané cookies — getItem aj setItem hádžu.
    const hostile = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    };
    const api = loadScopeHelpers(src, hostile);
    assert.equal(api.readScope(), 'active');
    assert.doesNotThrow(() => api.writeScope('all'));
    assert.equal(api.writeScope('all'), 'all', 'voľba platí v pamäti aj keď sa neuloží');

    // Globál úplne chýba (ReferenceError, nie výnimka metódy).
    const noStorage = loadScopeHelpers(src, null);
    assert.equal(noStorage.readScope(), 'active');
    assert.doesNotThrow(() => noStorage.writeScope('all'));
  });

  test(`${label}: effectiveScope uprednostní odpoveď servera, inak lokálnu voľbu`, () => {
    const api = loadScopeHelpers(src, memoryStorage({ pos_reports_scope: 'all' }));
    // Server je autorita — keď povie 'active', UI musí ukázať active text.
    assert.equal(api.effectiveScope({ scope: 'active' }), 'active');
    assert.equal(api.effectiveScope({ scope: 'all' }), 'all');
    // Chýbajúce / pokazené pole nesmie rozbiť render (staršie API).
    assert.equal(api.effectiveScope({}), 'all', 'fallback na lokálnu voľbu');
    assert.equal(api.effectiveScope(null), 'all');
    assert.equal(api.effectiveScope(undefined), 'all');
    assert.equal(api.effectiveScope({ scope: 'bogus' }), 'all');
    assert.equal(api.effectiveScope({ scope: null }), 'all');
  });

  test(`${label}: obe hodnoty prepínača sú v UI dosiahnuteľné`, () => {
    assert.match(src, /data-scope="active"/, 'chýba tlačidlo „Táto kasa"');
    assert.match(src, /data-scope="all"/, 'chýba tlačidlo „Celá história"');
    assert.match(src, /Celá história/, 'chýba popiska celej histórie');
  });
}

test('reports.js: každé obdobové volanie reportu nesie scope', () => {
  // summary, staff a účtovný export musia rešpektovať prepínač — inak by
  // majiteľ prepol rozsah a časť stránky by ostala na starých číslach.
  const mustCarryScope = [
    /\/reports\/summary\?from=[^\n]*scopeQuery\(\)/,
    /\/reports\/staff\?from=[^\n]*scopeQuery\(\)/,
    /\/api\/reports\/export\?from=[^\n]*scopeQuery\(\)/,
  ];
  for (const re of mustCarryScope) {
    assert.match(REPORTS_SRC, re, `volanie bez scope: ${re}`);
  }
});

test('reports.js: uzávierka scope ZÁMERNE neposiela (fiškálny doklad)', () => {
  // Z-report je doklad JEDNÉHO daňového subjektu a tlačová cesta
  // (POST /print/z-report) rozsah neprijíma. Keby preview bežal v 'all',
  // papier a obrazovka by si protirečili. Server default = active.
  const zCall = REPORTS_SRC.match(/api\.get\('\/reports\/z-report[^\n]*/);
  assert.ok(zCall, 'volanie z-reportu sa nenašlo');
  assert.doesNotMatch(zCall[0], /scope/, 'z-report nesmie posielať scope');
  // A používateľ musí vidieť, prečo sa čísla líšia.
  assert.match(REPORTS_SRC, /id="zScopeNote"/, 'chýba vysvetlenie pri uzávierke');
});

test('scope param je URL-enkódovaný a posiela sa ako &scope=', () => {
  assert.match(REPORTS_SRC, /'&scope=' \+ encodeURIComponent\(_scope\)/);
  assert.match(SEASON_SRC, /'&scope=' \+ encodeURIComponent\(_scope\)/);
});

test('obe stránky zdieľajú rovnaký localStorage kľúč', () => {
  const key = /const SCOPE_KEY = 'pos_reports_scope';/;
  assert.match(REPORTS_SRC, key);
  assert.match(SEASON_SRC, key);
});

test('pri rozsahu „all" je vidno, že to nie je podklad pre DPH', () => {
  for (const [label, text] of [['reports.js', REPORTS_TEXT], ['season.js', SEASON_TEXT]]) {
    assert.match(text, /nie sú podkladom pre priznanie\s+DPH/, `${label}: chýba varovanie k DPH`);
    assert.match(text, /predchádzajúcich\s+daňových subjektov/,
      `${label}: chýba vysvetlenie iných subjektov`);
    // Vecný tón bez výkričníkov — pás je vysvetlenie, nie poplach.
    const banner = text.match(/Zobrazenie zahŕňa[\s\S]{0,400}?Táto kasa/);
    assert.ok(banner, `${label}: text pásu sa nenašiel`);
    assert.doesNotMatch(banner[0], /!/, `${label}: pás nemá obsahovať výkričník`);
  }
});

test('v default rozsahu je poznámka o začiatku obdobia', () => {
  // Bez nej majiteľ vidí „prepad tržieb" a nevie prečo.
  for (const [label, text] of [['reports.js', REPORTS_TEXT], ['season.js', SEASON_TEXT]]) {
    assert.match(text, /obdobie začína prvým dokladom aktuálnej kasy/, `${label}: chýba poznámka`);
  }
});

test('prepínač spĺňa DESIGN-CODE: 44px tap target, focus ring, žiadne hex', () => {
  for (const [label, src] of [['reports.js', REPORTS_SRC], ['season.js', SEASON_SRC]]) {
    const css = src.match(/\.scope-btn\{[^}]*\}/);
    assert.ok(css, `${label}: .scope-btn štýl sa nenašiel`);
    assert.match(css[0], /min-height:\s*var\(--btn-h-md\)/, `${label}: tap target < 44px`);
    assert.match(src, /\.scope-btn:focus-visible\{[^}]*box-shadow:\s*0 0 0 3px/,
      `${label}: chýba 3px focus ring`);
    // Farby len cez tokeny — žiadny hex v scope CSS.
    const scopeCss = src.match(/\.scope-(btn|switch|note)[^\n]*/g) || [];
    for (const line of scopeCss) {
      assert.doesNotMatch(line, /#[0-9a-fA-F]{3,8}\b/, `${label}: hex hodnota v "${line.trim()}"`);
    }
  }
});
