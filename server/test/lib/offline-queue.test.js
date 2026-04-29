import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PR-C: api.js must refuse to queue fiscal/payment writes when offline.
//
// api.js is a frontend script (window/localStorage globals) that cannot be
// imported into Node directly. We extract the pure helpers — the prefix
// allowlist constant and _shouldBlockOfflineQueue(path) — and evaluate them
// in a vm sandbox so the policy is exercised in a unit test that runs as part
// of `npm test` rather than only via a manual browser smoke check.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_JS_PATH = path.resolve(__dirname, '../../../api.js');

let shouldBlockOfflineQueue;
let prefixes;

before(() => {
  const src = readFileSync(API_JS_PATH, 'utf8');

  const prefixesMatch = src.match(/const OFFLINE_NO_QUEUE_PREFIXES\s*=\s*\[[\s\S]*?\];/);
  const helperMatch = src.match(/function _shouldBlockOfflineQueue\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);

  assert.ok(prefixesMatch, 'api.js must define OFFLINE_NO_QUEUE_PREFIXES');
  assert.ok(helperMatch, 'api.js must define function _shouldBlockOfflineQueue');

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${prefixesMatch[0]}\n${helperMatch[0]}\nthis.fn = _shouldBlockOfflineQueue;\nthis.prefixes = OFFLINE_NO_QUEUE_PREFIXES;`,
    sandbox,
  );
  shouldBlockOfflineQueue = sandbox.fn;
  prefixes = sandbox.prefixes;
});

describe('api.js offline-queue allowlist', () => {
  it('exposes a non-empty OFFLINE_NO_QUEUE_PREFIXES list including /payments and /fiscal-documents', () => {
    assert.ok(Array.isArray(prefixes), 'prefixes must be an array');
    assert.ok(prefixes.length > 0, 'prefixes must not be empty');
    assert.ok(prefixes.includes('/payments'), '/payments must be in the allowlist');
    assert.ok(prefixes.includes('/fiscal-documents'), '/fiscal-documents must be in the allowlist');
  });

  it('blocks POST /payments at queue time', () => {
    assert.equal(shouldBlockOfflineQueue('/payments'), true);
  });

  it('blocks POST /payments/:id/fiscal-storno', () => {
    assert.equal(shouldBlockOfflineQueue('/payments/123/fiscal-storno'), true);
  });

  it('blocks POST /payments/:id/receipt-copy', () => {
    assert.equal(shouldBlockOfflineQueue('/payments/77/receipt-copy'), true);
  });

  it('blocks POST /fiscal-documents/:id/storno', () => {
    assert.equal(shouldBlockOfflineQueue('/fiscal-documents/45/storno'), true);
  });

  it('does NOT block /orders writes (offline queue allowed)', () => {
    assert.equal(shouldBlockOfflineQueue('/orders'), false);
    assert.equal(shouldBlockOfflineQueue('/orders/12/items'), false);
  });

  it('does NOT block /inventory writes (separate follow-up; not in PR-C scope)', () => {
    assert.equal(shouldBlockOfflineQueue('/inventory'), false);
    assert.equal(shouldBlockOfflineQueue('/inventory/stock'), false);
  });

  it('does NOT block /menu or /tables paths', () => {
    assert.equal(shouldBlockOfflineQueue('/menu'), false);
    assert.equal(shouldBlockOfflineQueue('/tables'), false);
  });

  it('does not match a path whose prefix is a near-miss (e.g. /payments-history)', () => {
    // Defensive: prefix must be matched at a path-segment boundary, not a
    // substring. /payments-history is hypothetical — we don't have such a
    // route — but the helper should not over-block.
    assert.equal(shouldBlockOfflineQueue('/payments-history'), false);
    assert.equal(shouldBlockOfflineQueue('/fiscal-documents-foo'), false);
  });

  it('returns false for non-string input rather than throwing', () => {
    assert.equal(shouldBlockOfflineQueue(undefined), false);
    assert.equal(shouldBlockOfflineQueue(null), false);
    assert.equal(shouldBlockOfflineQueue(42), false);
  });
});
