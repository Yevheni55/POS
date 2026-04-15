import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function createElementStub() {
  return {
    textContent: '',
    value: '',
    disabled: false,
    innerHTML: '',
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    setAttribute() {},
    focus() {},
  };
}

function loadPosMobile(options = {}) {
  const elements = new Map();
  let orderState = options.order || [];

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElementStub());
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
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
    navigator: {},
    TABLES: options.tables || [{ id: 1, name: 'Stol 1', zone: 'interior', seats: 4, status: 'occupied' }],
    MENU: {},
    tableOrders: {},
    tableOrdersList: options.tableOrdersList || [],
    currentOrderId: options.currentOrderId || null,
    selectedTableId: options.selectedTableId || 1,
    moveMode: !!options.moveMode,
    moveSelectedItems: options.moveSelectedItems || [],
    mobActiveCategory: null,
    mobSearchQuery: '',
    renderOrder() {},
    updateQtyBadges() {},
    updateTotals() {},
    loadTableOrder: async () => {},
    handleMoveToTable: async () => {},
    showAccountPicker() {},
    addToOrder() {},
    changeQty() {},
    removeItem() {},
    enterMoveMode() {},
    exitMoveMode() {},
    toggleMoveSelection() {},
    moveToTab() {},
    moveToNewAccountInline() {},
    showTablePicker() {},
    newAccount() {},
    mergeAccounts() {},
    switchAccount() {},
    fmt(value) { return value.toFixed ? value.toFixed(2) + ' €' : String(value); },
    escHtml(value) { return String(value); },
    api: {
      getUser() { return { name: 'Tester' }; },
      _queue: [],
    },
    getOrder() { return orderState; },
    setOrder(next) { orderState = next; },
    getOrderTotal() {
      return orderState.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },
    isMobile() { return true; },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { return fn(), 1; },
    clearTimeout() {},
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scriptPath = path.resolve('C:/Users/yevhe/Desktop/POS/js/pos-mobile.js');
  const script = readFileSync(scriptPath, 'utf8');
  vm.runInNewContext(script, sandbox, { filename: scriptPath });

  return {
    sandbox,
    elements,
  };
}

test('mobile checkout drawer exposes split bill action', () => {
  const html = readFileSync(path.resolve('C:/Users/yevhe/Desktop/POS/pos-enterprise.html'), 'utf8');

  assert.match(
    html,
    /onclick="splitBill\(\);closeMobPayDrawer\(\)"/,
    'mobile order footer should expose split bill from the payment drawer'
  );
});

test('renderMobOrder shows mobile move targets and selected items when move mode is active', () => {
  const item = {
    id: 501,
    name: 'Latte',
    emoji: '☕',
    price: 3.2,
    qty: 1,
    note: '',
    menuItemId: 77,
    sent: true,
  };
  const { sandbox, elements } = loadPosMobile({
    order: [item],
    currentOrderId: 10,
    moveMode: true,
    moveSelectedItems: [501],
    tableOrdersList: [
      { id: 10, label: 'Ucet 1', items: [item] },
      { id: 11, label: 'Ucet 2', items: [] },
    ],
  });

  sandbox.renderMobOrder();

  const tabsHtml = elements.get('mobOrderTabs').innerHTML;
  const itemsHtml = elements.get('mobOrderItems').innerHTML;

  assert.match(tabsHtml, /moveToTab\(11\)/);
  assert.match(tabsHtml, /moveToNewAccountInline\(\)/);
  assert.match(tabsHtml, /showTablePicker\(\)/);
  assert.match(tabsHtml, /exitMoveMode\(\)/);
  assert.match(itemsHtml, /toggleMoveSelection\(501\)/);
  assert.match(itemsHtml, /move-selected/);
  assert.match(itemsHtml, /Presunout vybrane polozky/);
});

test('mobSelectTable flushes pending changes before switching to another table', async () => {
  let flushCalls = 0;
  let loadedTableId = null;

  const { sandbox } = loadPosMobile({
    selectedTableId: 1,
    tables: [
      { id: 1, name: 'Stol 1', zone: 'interior', seats: 4, status: 'occupied' },
      { id: 2, name: 'Stol 2', zone: 'interior', seats: 4, status: 'free' },
    ],
  });

  sandbox.flushOrderBeforeTableLeave = async () => {
    flushCalls += 1;
    return true;
  };
  sandbox.loadTableOrder = async (id) => {
    loadedTableId = id;
  };

  await sandbox.mobSelectTable(2);

  assert.equal(flushCalls, 1);
  assert.equal(loadedTableId, 2);
  assert.equal(sandbox.selectedTableId, 2);
});

test('switchMobTab waits for leave-table flush before opening tables tab', async () => {
  let flushCalls = 0;
  let resolveFlush;

  const { sandbox } = loadPosMobile({
    selectedTableId: 1,
  });

  sandbox.mobActiveTab = 'mobTabOrder';
  sandbox.flushOrderBeforeTableLeave = async () => {
    flushCalls += 1;
    return await new Promise((resolve) => {
      resolveFlush = resolve;
    });
  };
  sandbox.hasPendingOrderFlushState = () => true;

  const switchPromise = sandbox.switchMobTab('mobTabTables');

  assert.equal(flushCalls, 1);
  assert.equal(sandbox.mobActiveTab, 'mobTabOrder');

  resolveFlush(true);
  await switchPromise;

  assert.equal(sandbox.mobActiveTab, 'mobTabTables');
});
