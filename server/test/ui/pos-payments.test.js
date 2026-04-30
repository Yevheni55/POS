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
    focus() {},
  };
}

function loadPosPayments(overrides = {}) {
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

  const toastCalls = [];
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Promise,
    document: documentStub,
    window: null,
    globalThis: null,
    TABLES: [{ id: 1, name: 'Stol 1' }],
    selectedTableId: 1,
    currentOrderId: 55,
    currentOrderVersion: 3,
    currentView: 'products',
    tableOrdersList: [],
    pendingPaymentMethod: null,
    _pendingStorno: [],
    _orderDirty: false,
    tableOrders: {},
    getOrder() { return []; },
    getItemDest(name) { return name === 'Burger' ? 'kuchyna' : 'bar'; },
    syncOrderToServer: async () => {},
    loadTableOrder: async () => {},
    renderOrder() {},
    renderMobOrder() {},
    renderFloor() {},
    renderMobTables() {},
    updateTableStatuses() {},
    closeMobPayDrawer() {},
    closeModal() {},
    isMobile() { return false; },
    fmt(n) { return String(n); },
    btnLoading() {},
    btnReset() {},
    showToast(message, tone) {
      toastCalls.push({ message, tone });
    },
    api: {
      getUser() { return { id: 7, name: 'Tester' }; },
      post: async () => ({}),
    },
    ...overrides,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scriptPath = path.join(REPO_ROOT, 'js/pos-payments.js');
  const script = readFileSync(scriptPath, 'utf8');
  vm.runInNewContext(script, sandbox, { filename: scriptPath });

  return { sandbox, toastCalls };
}

test('sendToKitchen flushes pending storno through the order endpoint before clearing it', async () => {
  const calls = [];
  let resolveStorno;

  const { sandbox } = loadPosPayments({
    _pendingStorno: [{ qty: 2, name: 'Pivo', note: 'bez peny', menuItemId: 10 }],
    api: {
      getUser() { return { id: 7, name: 'Tester' }; },
      post: async (url, body) => {
        calls.push({ url, body });
        if (url === '/orders/55/send-storno-and-print') {
          return await new Promise((resolve) => {
            resolveStorno = () => resolve({
              printed: 1,
              items: [{ qty: 2, name: 'Pivo', note: 'bez peny', menuItemId: 10 }],
            });
          });
        }
        if (url === '/print/kitchen') return { queued: true };
        if (url === '/orders/55/send-and-print') return { printed: 0, items: [] };
        throw new Error('Unexpected POST ' + url);
      },
    },
  });

  const pendingBefore = sandbox._pendingStorno.slice();
  const sendPromise = sandbox.sendToKitchen();

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    sandbox._pendingStorno,
    pendingBefore,
    'pending storno should stay queued until the server flow completes',
  );

  resolveStorno();
  await sendPromise;

  assert.equal(calls[0].url, '/orders/55/send-storno-and-print');
  assert.deepEqual(calls[0].body, {
    items: [{ menuItemId: 10, qty: 2, note: 'bez peny' }],
  });
  assert.deepEqual(
    sandbox._pendingStorno,
    [],
    'pending storno should clear only after storno send succeeds',
  );
  assert.equal(calls.filter((call) => call.url === '/print/kitchen').length, 1);
});
