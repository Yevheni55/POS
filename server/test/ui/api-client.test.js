// Testy klientskeho api.js — častí, kde chyba nie je vidieť, ale bolí.
//
// 1. _needsManagerElevation — rozhoduje, na ktoré cesty sa pripojí manažérsky
//    elevačný token. Príliš úzky regex = čašník po správnom PINe dostane 403
//    (a keďže klient je optimistic-local-first, POS a server sa rozídu).
//    Príliš široký = kredenciál manažéra chodí na nesúvisiace endpointy.
// 2. isoAddDays / bratislavaMonthStartIso / bratislavaMondayIso — dátumová
//    aritmetika reportov. Pôvodné `toISOString()` nad lokálnym Date vracalo
//    celý letný čas posledný deň PREDOŠLÉHO mesiaca.
//
// api.js je klasický skript (nie ESM) — načítame ho do vm s minimálnym
// prehliadačovým prostredím.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function loadApi() {
  const src = readFileSync(path.join(REPO_ROOT, 'api.js'), 'utf8');
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    window: { location: { origin: 'http://localhost:3080', pathname: '/pos-enterprise.html', search: '' } },
    location: { origin: 'http://localhost:3080', pathname: '/pos-enterprise.html', search: '' },
    document: {
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null,
      body: { classList: { add() {}, remove() {} } },
      documentElement: {},
    },
    navigator: { onLine: true, sendBeacon: () => true },
    localStorage: storage,
    sessionStorage: storage,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    console,
    crypto: { randomUUID: () => 'test-uuid' },
    Intl,
    Date,
    JSON,
    Math,
    String,
    Number,
    Array,
    Object,
    Promise,
    Error,
    TypeError,
    Blob: function Blob() {},
  };
  sandbox.window.addEventListener = () => {};
  sandbox.addEventListener = () => {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'api.js' });
  // `const api = {...}` je lexikálna deklarácia — do globálneho objektu
  // kontextu sa nedostane, ale v globálnom lexikálnom scope kontextu žije,
  // takže ju vytiahneme ďalším vyhodnotením v tom istom kontexte.
  sandbox.api = vm.runInContext('api', sandbox);
  return sandbox;
}

const sb = loadApi();

test('_needsManagerElevation pokrýva presne tie cesty, kde server eláciu vyžaduje', () => {
  const api = sb.api;
  // Vyžadujú ju: PUT/DELETE /orders/:id/items/:itemId a POST /orders/:id/batch
  assert.equal(api._needsManagerElevation('/orders/12/items/34', 'DELETE'), true);
  assert.equal(api._needsManagerElevation('/orders/12/items/34', 'PUT'), true);
  assert.equal(api._needsManagerElevation('/orders/7/batch', 'POST'), true);
  assert.equal(api._needsManagerElevation('/orders/12/items/34?x=1', 'DELETE'), true);

  // Nevyžadujú — token tam nemá čo chodiť.
  assert.equal(api._needsManagerElevation('/orders/12', 'DELETE'), false);
  assert.equal(api._needsManagerElevation('/orders/12/close', 'POST'), false);
  assert.equal(api._needsManagerElevation('/payments', 'POST'), false);
  assert.equal(api._needsManagerElevation('/storno-basket', 'POST'), false);

  // GET nikdy — čítanie eláciu nepotrebuje.
  assert.equal(api._needsManagerElevation('/orders/12/items/34', 'GET'), false);
  assert.equal(api._needsManagerElevation('/orders/12/items/34', undefined), false);
});

test('isoAddDays počíta kalendárne, nezávisle od letného času', () => {
  assert.equal(sb.isoAddDays('2026-07-31', 1), '2026-08-01');
  assert.equal(sb.isoAddDays('2026-01-01', -1), '2025-12-31');
  assert.equal(sb.isoAddDays('2026-07-01', -6), '2026-06-25');
  // cez prechod letný → zimný čas (posledná októbrová nedeľa)
  assert.equal(sb.isoAddDays('2026-10-24', 7), '2026-10-31');
  // priestupný rok
  assert.equal(sb.isoAddDays('2028-02-28', 1), '2028-02-29');
});

test('bratislavaMonthStartIso vracia PRVÝ deň mesiaca aj tesne po polnoci', () => {
  // 2026-06-30T22:30Z = 1.7.2026 00:30 bratislavského času.
  // Starý kód (`new Date(y,m,1).toISOString()`) tu vracal 2026-06-30.
  assert.equal(sb.bratislavaMonthStartIso(new Date('2026-06-30T22:30:00Z')), '2026-07-01');
  assert.equal(sb.bratislavaMonthStartIso(new Date('2026-07-15T10:00:00Z')), '2026-07-01');
  // zimný čas (UTC+1)
  assert.equal(sb.bratislavaMonthStartIso(new Date('2026-01-14T23:30:00Z')), '2026-01-01');
});

test('bratislavaDayIso nespadne na včerajšok medzi polnocou a 02:00', () => {
  assert.equal(sb.bratislavaDayIso(new Date('2026-06-30T22:30:00Z')), '2026-07-01');
  assert.equal(sb.bratislavaDayIso(new Date('2026-01-14T23:30:00Z')), '2026-01-15');
});

test('bratislavaMondayIso vracia pondelok aktuálneho týždňa', () => {
  // 2026-07-28 je utorok → pondelok 2026-07-27
  assert.equal(sb.bratislavaMondayIso(new Date('2026-07-28T10:00:00Z')), '2026-07-27');
  // nedeľa patrí do TOHO ISTÉHO týždňa (ISO), nie do nasledujúceho
  assert.equal(sb.bratislavaMondayIso(new Date('2026-08-02T10:00:00Z')), '2026-07-27');
  // pondelok sám na seba
  assert.equal(sb.bratislavaMondayIso(new Date('2026-07-27T10:00:00Z')), '2026-07-27');
});
