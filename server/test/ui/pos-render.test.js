import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
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
    ...overrides,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scriptPath = path.resolve('C:/Users/yevhe/Desktop/POS/js/pos-render.js');
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

  assert.equal(sandbox.currentView, 'products');

  resolveSend();
  await switchPromise;

  assert.equal(sandbox.currentView, 'tables');
});
