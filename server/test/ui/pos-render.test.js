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
    disabled: false,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    closest() { return null; },
    focus() {},
    remove() {},
    insertAdjacentHTML() {},
    appendChild() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    style: {},
    dataset: {},
  };
}

function createStorageStub(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    clear() { for (const key of Object.keys(store)) delete store[key]; },
  };
}

function loadPosRender(overrides = {}) {
  const elements = new Map();

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElementStub());
      return elements.get(id);
    },
    querySelector() {
      return createElementStub();
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return createElementStub(); },
    body: createElementStub(),
    documentElement: createElementStub(),
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Promise,
    document: documentStub,
    window: null,
    globalThis: null,
    localStorage: createStorageStub(),
    sessionStorage: createStorageStub(),
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(fn) { fn(); return 1; },
    cancelAnimationFrame() {},
    TABLES: [
      { id: 1, name: 'Stol 1', zone: 'interior', seats: 4, status: 'occupied', x: 0, y: 0 },
      { id: 2, name: 'Stol 2', zone: 'interior', seats: 4, status: 'free', x: 0, y: 0 },
    ],
    tableOrders: {},
    tableOrdersList: [],
    activeZone: 'interior',
    ZONES: [{ id: 'interior', label: 'Interier' }],
    currentView: 'products',
    selectedTableId: 1,
    editMode: false,
    searchQuery: '',
    activeCategory: null,
    MENU: {},
    CAT_COLORS: {},
    escHtml(value) { return String(value); },
    escAttr(value) { return String(value); },
    fmt(value) { return String(value); },
    renderOrder() {},
    updateQtyBadges() {},
    loadTableOrder: async () => {},
    showAccountPicker() {},
    showToast() {},
    getOrder() { return []; },
    sendToKitchen: async () => {},
    // Globals that live in the sibling pos-*.js modules (in the browser every
    // file shares one global scope; here only pos-render.js is evaluated).
    _renderTimer: null,
    _orderDirty: false,
    _pendingStorno: [],
    moveMode: false,
    moveSelectedItems: [],
    exitMoveMode() {},
    loadTables: async () => {},
    renderProducts() {},
    persistUIState() {},
    ...overrides,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scriptPath = path.join(REPO_ROOT, 'js/pos-render.js');
  const script = readFileSync(scriptPath, 'utf8');
  vm.runInNewContext(script, sandbox, { filename: scriptPath });

  return {
    sandbox,
  };
}

test('openTable flushes pending storno before switching tables even when order is empty', async () => {
  let sendCalls = 0;

  const { sandbox } = loadPosRender({
    _orderDirty: false,
    _pendingStorno: [{ qty: 1, name: 'Pivo', note: '' }],
    sendToKitchen: async () => {
      sendCalls += 1;
    },
  });

  await sandbox.openTable(2);

  assert.equal(sendCalls, 1);
  assert.equal(sandbox.selectedTableId, 2);
});

test('switchView waits for leave-table flush before opening table grid', async () => {
  let resolveSend;

  const { sandbox } = loadPosRender({
    currentView: 'products',
    _orderDirty: false,
    _pendingStorno: [{ qty: 1, name: 'Pivo', note: '' }],
    sendToKitchen: async () => await new Promise((resolve) => {
      resolveSend = resolve;
    }),
  });

  const switchPromise = sandbox.switchView('tables');

  // flushOrderBeforeTableLeave chains sendToKitchen through
  // Promise.resolve().then(...), so give the microtask queue a few turns to
  // actually reach it. The view must still be on 'products' afterwards —
  // that is what proves switchView is blocked on the flush and not merely on
  // a microtask hop.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(typeof resolveSend, 'function', 'sendToKitchen should have been started');
  assert.equal(sandbox.currentView, 'products');

  resolveSend();
  await switchPromise;

  assert.equal(sandbox.currentView, 'tables');
});
