import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createElementStub() {
  const classNames = new Set();
  return {
    textContent: '',
    value: '',
    disabled: false,
    innerHTML: '',
    classList: {
      add(...names) {
        names.forEach((name) => classNames.add(name));
      },
      remove(...names) {
        names.forEach((name) => classNames.delete(name));
      },
      toggle(name, force) {
        if (force === true) {
          classNames.add(name);
          return true;
        }
        if (force === false) {
          classNames.delete(name);
          return false;
        }
        if (classNames.has(name)) {
          classNames.delete(name);
          return false;
        }
        classNames.add(name);
        return true;
      },
      contains(name) { return classNames.has(name); },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    remove() {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    focus() {},
  };
}

function loadPosOrders(initialOrder, overrides = {}) {
  let orderState = clone(initialOrder);
  const elements = new Map();
  const queryElements = new Map();
  const tableOrders = { 1: orderState };

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElementStub());
      return elements.get(id);
    },
    querySelector(selector) {
      if (!queryElements.has(selector)) queryElements.set(selector, createElementStub());
      return queryElements.get(selector);
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
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    document: documentStub,
    window: null,
    globalThis: null,
    showToast() {},
    renderOrder() {},
    updateQtyBadges() {},
    updateTotals() {},
    startQtyHold() {},
    swipeStart() {},
    swipeMove() {},
    swipeEnd() {},
    requireManagerPin() {},
    showStornoReason() {},
    loadTableOrder: async () => {},
    updateTableStatuses() {},
    renderFloor() {},
    renderMobOrder() {},
    renderMobTables() {},
    isMobile() { return false; },
    fmt(n) { return String(n); },
    getItemDest() { return 'bar'; },
    MENU_ID_MAP: new Map([['Pivo', 10]]),
    TABLES: [{ id: 1, status: 'occupied', name: 'Stol 1' }],
    selectedTableId: 1,
    currentOrderId: 100,
    currentOrderVersion: 1,
    currentView: 'products',
    tableOrdersList: [],
    api: {
      getUser() { return { id: 1, role: 'admin', name: 'Test User' }; },
      post: async () => ({}),
      del: async () => ({}),
      put: async () => ({}),
    },
    getOrder() {
      return tableOrders[this.selectedTableId] || [];
    },
    setOrder(nextOrder) {
      orderState = nextOrder;
      tableOrders[this.selectedTableId] = nextOrder;
    },
    tableOrders,
    ...overrides,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scriptPath = path.join(REPO_ROOT, 'js/pos-orders.js');
  const script = readFileSync(scriptPath, 'utf8');
  vm.runInNewContext(script, sandbox, { filename: scriptPath });

  return {
    sandbox,
    elements,
    getOrderState() {
      return orderState;
    },
  };
}

test('changeQty on a sent item creates a new unsent delta row for additional quantity', () => {
  const sentItem = {
    id: 11,
    name: 'Pivo',
    emoji: 'beer',
    price: 2.5,
    qty: 1,
    note: '',
    menuItemId: 10,
    sent: true,
    _sentQty: 1,
  };
  const { sandbox, getOrderState } = loadPosOrders([sentItem]);

  sandbox.changeQty('Pivo', 1, 11);

  const nextOrder = getOrderState();
  const sentRows = nextOrder.filter((item) => item.sent);
  const unsentRows = nextOrder.filter((item) => !item.sent);

  assert.equal(sentRows.length, 1);
  assert.equal(sentRows[0].qty, 1);
  assert.equal(unsentRows.length, 1);
  assert.equal(unsentRows[0].qty, 1);
  assert.equal(unsentRows[0].menuItemId, 10);
});

test('changeQty on a sent item reuses an existing unsent delta row instead of mutating the sent row', () => {
  const sentItem = {
    id: 11,
    name: 'Pivo',
    emoji: 'beer',
    price: 2.5,
    qty: 1,
    note: '',
    menuItemId: 10,
    sent: true,
    _sentQty: 1,
  };
  const unsentDelta = {
    id: 1000000005,
    name: 'Pivo',
    emoji: 'beer',
    price: 2.5,
    qty: 2,
    note: '',
    menuItemId: 10,
    sent: false,
  };
  const { sandbox, getOrderState } = loadPosOrders([sentItem, unsentDelta]);

  sandbox.changeQty('Pivo', 1, 11);

  const nextOrder = getOrderState();
  const unchangedSent = nextOrder.find((item) => item.id === 11);
  const reusedDelta = nextOrder.find((item) => item.id === 1000000005);

  assert.equal(unchangedSent.qty, 1);
  assert.equal(reusedDelta.qty, 3);
  assert.equal(nextOrder.length, 2);
});

test('splitBill syncs a local draft order before opening the split modal', async () => {
  const draftItem = {
    id: 1000000010,
    name: 'Pivo',
    emoji: 'beer',
    price: 2.5,
    qty: 2,
    note: '',
    menuItemId: 10,
    sent: false,
  };

  let createCalls = 0;
  const { sandbox, elements } = loadPosOrders([draftItem], {
    currentOrderId: null,
    api: {
      getUser() { return { id: 1, role: 'admin', name: 'Test User' }; },
      post: async (url, body) => {
        if (url === '/orders') {
          createCalls += 1;
          assert.deepEqual(body, {
            tableId: 1,
            items: [{ menuItemId: 10, qty: 2, note: '' }],
          });
          return { id: 222, version: 3 };
        }
        throw new Error('Unexpected POST ' + url);
      },
      del: async () => ({}),
      put: async () => ({}),
    },
    loadTableOrder: async () => {},
  });

  sandbox._orderDirty = true;

  await sandbox.splitBill();

  assert.equal(createCalls, 1);
  assert.equal(sandbox.currentOrderId, 222);
  assert.equal(elements.get('splitCount').value, 2);
  assert.equal(elements.get('splitPreview').textContent, 'Kazdy plati: 2.5');
  assert.equal(elements.get('splitModal').classList.contains('show'), true);
});

test('moveToTab activates the target account items immediately after reload', async () => {
  const sourceItems = [
    {
      id: 11,
      name: 'Pivo',
      emoji: 'beer',
      price: 2.5,
      qty: 1,
      note: '',
      menuItemId: 10,
      orderId: 100,
      sent: true,
      _sentQty: 1,
    },
  ];
  const targetItems = [
    {
      id: 22,
      name: 'Burger',
      emoji: 'burger',
      price: 8.5,
      qty: 1,
      note: '',
      menuItemId: 20,
      orderId: 200,
      sent: false,
      _sentQty: 0,
    },
  ];

  let movePayload = null;
  const { sandbox, getOrderState } = loadPosOrders(sourceItems, {
    currentOrderId: 100,
    tableOrdersList: [{ id: 100, label: 'Ucet 1', items: sourceItems }],
    api: {
      getUser() { return { id: 1, role: 'admin', name: 'Test User' }; },
      post: async (url, body) => {
        movePayload = { url, body };
        return {};
      },
      del: async () => ({}),
      put: async () => ({}),
    },
  });

  sandbox.moveSelectedItems = [11];
  sandbox.moveSourceOrderId = 100;
  sandbox.moveSourceTableId = 1;
  sandbox.moveMode = true;
  sandbox.loadTableOrder = async () => {
    sandbox.tableOrdersList = [
      { id: 100, label: 'Ucet 1', items: sourceItems, version: 1 },
      { id: 200, label: 'Ucet 2', items: targetItems, version: 2 },
    ];
    sandbox.setOrder(sourceItems);
  };

  await sandbox.moveToTab(200);

  assert.deepEqual(movePayload, {
    url: '/orders/100/move-items',
    body: { itemIds: [11], targetTableId: 1, targetOrderId: 200 },
  });
  assert.equal(sandbox.currentOrderId, 200);
  assert.equal(sandbox.currentOrderVersion, 2);
  assert.equal(getOrderState().length, 1);
  assert.equal(getOrderState()[0].name, 'Burger');
  assert.equal(getOrderState()[0].orderId, 200);
});
