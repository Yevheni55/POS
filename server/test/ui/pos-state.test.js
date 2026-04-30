import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function createElementStub() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    outerHTML: '<div class="header-avatar"></div>',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

async function loadPosState() {
  const elements = new Map();
  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Promise,
    localStorage: {
      _store: {},
      getItem(key) { return this._store[key] || null; },
      setItem(key, value) { this._store[key] = String(value); },
      removeItem(key) { delete this._store[key]; },
    },
    sessionStorage: {
      _store: { pos_user: JSON.stringify({ name: 'Test User', role: 'admin' }) },
      getItem(key) { return this._store[key] || null; },
      setItem(key, value) { this._store[key] = String(value); },
      removeItem(key) { delete this._store[key]; },
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElementStub());
        return elements.get(id);
      },
      querySelector(selector) {
        if (selector === '.header-avatar') return createElementStub();
        if (selector === '.header-user') {
          const userEl = createElementStub();
          userEl.querySelector = function(innerSelector) {
            if (innerSelector === '.header-avatar') return createElementStub();
            return null;
          };
          return userEl;
        }
        return createElementStub();
      },
    },
    window: null,
    globalThis: null,
    escHtml(value) { return String(value); },
    renderFloor() {},
    api: {
      requireAuth() { return true; },
      getUser() { return { name: 'Test User', role: 'admin' }; },
      get: async () => [],
      put: async () => ({}),
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
  });

  context.window = context;
  context.globalThis = context;

  const scriptPath = path.join(REPO_ROOT, 'js/pos-state.js');
  const script = readFileSync(scriptPath, 'utf8');
  vm.runInContext(script, context, { filename: scriptPath });

  await context.loadTables([
    { id: 1, name: 'Stol 1', seats: 4, zone: 'interior', status: 'occupied' },
    { id: 2, name: 'Stol 2', seats: 4, zone: 'interior', status: 'occupied' },
  ]);

  return context;
}

test('updateTableStatuses marks table free when open accounts have no items', async () => {
  const context = await loadPosState();

  vm.runInContext(`
    allOrdersCache = {
      1: [{ id: 101, items: [] }],
      2: [{ id: 202, items: [{ qty: 1, price: 2.5 }] }]
    };
  `, context);

  context.updateTableStatuses();

  const statuses = vm.runInContext('TABLES.map(function(t){ return t.status; })', context);
  assert.deepEqual(statuses, ['free', 'occupied']);
});

test('setOrder marks selected table free after the last local item is removed', async () => {
  const context = await loadPosState();

  vm.runInContext(`
    selectedTableId = 1;
    currentOrderId = 101;
    tableOrdersList = [{ id: 101, items: [] }];
    allOrdersCache = { 1: [{ id: 101, items: [] }] };
  `, context);

  context.setOrder([]);

  const status = vm.runInContext('TABLES.find(function(t){ return t.id === 1; }).status', context);
  assert.equal(status, 'free');
});
