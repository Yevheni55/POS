# Backend Hardening Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the critical backend security, fiscal, inventory, reporting, and realtime risks found by the backend analysis agents.

**Architecture:** Keep the current Express/Drizzle structure and make narrow hardening changes in the existing modules. Prefer regression tests first, then minimal implementation. Avoid broad route rewrites except where preserving fiscal/audit records requires changing destructive behavior into state transitions.

**Tech Stack:** Node.js ESM, Express 4, Drizzle ORM, PostgreSQL, Node test runner, supertest, Socket.IO.

---

## File Structure

- Modify: `server/app.js`
  - Mount idempotency after `auth` on protected route groups so it can scope keys by `req.user`.
- Modify: `server/middleware/idempotency.js`
  - Scope keys by user, method, path, and request body hash.
  - Reserve keys before route execution to block concurrent duplicate writes.
  - Return replay responses only after auth has already run.
- Modify: `server/middleware/auth.js`
  - Verify that token user still exists, is active, and has current DB role.
- Modify: `server/routes/auth.js`
  - Apply DB-backed attempt tracking to `/verify-manager`.
- Modify: `server/routes/orders.js`
  - Block unpaid direct close.
  - Replace destructive paid/fiscal order delete with immutable rejection.
  - Soft-cancel unpaid orders instead of deleting order/audit history.
  - Require manager/admin for discount removal.
  - Validate storno write-off quantities against sent order rows.
- Modify: `server/routes/payments.js`
  - Acquire a DB-backed payment in-flight state before Portos calls.
  - Finalize from `payment_pending` to `closed`.
  - Reset to `open` on non-final fiscal failure.
- Modify: `server/routes/printers.js`, `server/routes/print.js`, `server/routes/ttlock.js`
  - Add role gates to admin-style operations.
- Modify: `server/server.js`
  - Configure HTTP and HTTPS Socket.IO servers with the same auth/connection behavior and emit to both.
- Modify: `server/schemas/menu.js`, `server/schemas/inventory.js`, `server/routes/inventory.js`, `server/lib/stock.js`
  - Standardize stock tracking on `none`, `simple`, `recipe`.
  - Normalize legacy `direct` inputs to `simple`.
  - Reset item track mode when a recipe is deleted.
- Modify: `server/routes/reports.js`
  - Fix duplicate item export aggregation.
  - Fix staff revenue aggregation and payment method labels.
  - Align top-item/export filters to paid/closed payment timeline.
- Test: `server/test/middleware/idempotency.test.js`
- Test: `server/test/routes/auth.test.js`
- Test: `server/test/routes/auth-me.test.js`
- Test: `server/test/routes/role-gates.test.js`
- Test: `server/test/routes/orders.test.js`
- Test: `server/test/routes/payments.portos.test.js`
- Test: `server/test/routes/reports.export.vat.test.js`
- Test: `server/test/routes/reports.staff.test.js`
- Test: `server/test/routes/menu.vat.test.js`
- Test: `server/test/lib/stock.test.js`
- Test: `server/test/realtime/socket-server.test.js`

---

## Task 1: Harden Idempotency Scoping And Ordering

**Files:**
- Modify: `server/app.js`
- Modify: `server/middleware/idempotency.js`
- Test: `server/test/middleware/idempotency.test.js`

- [ ] **Step 1: Add failing auth-bypass and scope regression tests**

Append these tests inside `describe('idempotency middleware - POST /api/orders', ...)` in `server/test/middleware/idempotency.test.js`:

```js
it('does not replay a protected cached response without auth', async () => {
  const key = randomUUID();
  const payload = validOrderPayload(fixtures);

  const first = await request
    .post('/api/orders')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .set('X-Idempotency-Key', key)
    .send(payload);

  assert.equal(first.status, 201);
  await new Promise((r) => setImmediate(r));

  const replayWithoutAuth = await request
    .post('/api/orders')
    .set('X-Idempotency-Key', key)
    .send(payload);

  assert.equal(replayWithoutAuth.status, 401);
});

it('does not replay a key reused for a different path', async () => {
  const key = randomUUID();

  const first = await request
    .post('/api/orders')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .set('X-Idempotency-Key', key)
    .send(validOrderPayload(fixtures));

  assert.equal(first.status, 201);
  await new Promise((r) => setImmediate(r));

  const reused = await request
    .post(`/api/orders/${first.body.id}/items`)
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .set('X-Idempotency-Key', key)
    .send({ items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }] });

  assert.equal(reused.status, 201);
  assert.equal(reused.headers['x-idempotent-replayed'], undefined);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
cd server
node scripts/run-tests.mjs full -- test/middleware/idempotency.test.js
```

Expected before implementation: the unauthenticated replay returns cached `201`, or the path-reuse request is replayed.

- [ ] **Step 3: Move idempotency after auth in `server/app.js`**

Replace the protected route mounts with this pattern:

```js
app.use('/api/menu', auth, idempotency, menuRoutes);
app.use('/api/tables', auth, idempotency, tablesRoutes);
app.use('/api/orders', auth, idempotency, ordersRoutes);
app.use('/api/staff', auth, idempotency, staffRoutes);
app.use('/api/payments', auth, idempotency, paymentsRoutes);
app.use('/api/reports', auth, idempotency, reportsRoutes);
app.use('/api/print', auth, idempotency, printRoutes);
app.use('/api/shifts', auth, idempotency, shiftRoutes);
app.use('/api/discounts', auth, idempotency, discountRoutes);
app.use('/api/printers', auth, idempotency, printerRoutes);
app.use('/api/events', auth, idempotency, eventsRoutes);
app.use('/api/inventory', auth, idempotency, inventoryRoutes);
app.use('/api/invoice-scan', auth, idempotency, invoiceScanRoutes);
app.use('/api/ttlock', auth, idempotency, ttlockRoutes);
app.use('/api/integrations/portos', auth, idempotency, portosRoutes);
app.use('/api/company-profile', auth, idempotency, companyProfileRoutes);
app.use('/api/fiscal-documents', auth, idempotency, fiscalDocumentsRoutes);
```

Remove the old global mount:

```js
app.use('/api', idempotency);
```

- [ ] **Step 4: Implement scoped reservation in `server/middleware/idempotency.js`**

Use this shape:

```js
import { createHash } from 'node:crypto';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';

const EXPIRY_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS_STATUS = 409;
const IN_PROGRESS_RESPONSE = JSON.stringify({ error: 'Request with this idempotency key is already in progress' });

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scopedKey(req, rawKey) {
  const bodyHash = createHash('sha256').update(stableStringify(req.body || {})).digest('hex');
  return createHash('sha256')
    .update(`${req.user?.id || 'anonymous'}:${req.method}:${req.baseUrl}${req.path}:${bodyHash}:${rawKey}`)
    .digest('hex');
}

export async function idempotency(req, res, next) {
  const rawKey = req.headers['x-idempotency-key'];
  if (!rawKey || req.method === 'GET') return next();

  const key = scopedKey(req, String(rawKey));

  try {
    const inserted = await db.insert(idempotencyKeys)
      .values({ key, statusCode: IN_PROGRESS_STATUS, response: IN_PROGRESS_RESPONSE })
      .onConflictDoNothing()
      .returning();

    if (!inserted.length) {
      const [cached] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      if (!cached) return res.status(IN_PROGRESS_STATUS).json(JSON.parse(IN_PROGRESS_RESPONSE));
      res.status(cached.statusCode);
      res.setHeader('X-Idempotent-Replayed', 'true');
      return res.end(cached.response);
    }

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      const statusCode = res.statusCode || 200;
      const responseStr = JSON.stringify(body);
      const write = statusCode >= 200 && statusCode < 300
        ? db.update(idempotencyKeys).set({ statusCode, response: responseStr }).where(eq(idempotencyKeys.key, key))
        : db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      write.catch((e) => console.error('Idempotency store error:', e));
      return originalJson(body);
    };

    next();
  } catch (e) {
    console.error('Idempotency lookup error:', e);
    next();
  }
}
```

- [ ] **Step 5: Run idempotency tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/middleware/idempotency.test.js
```

Expected: all idempotency tests pass.

- [ ] **Step 6: Commit**

```powershell
git add server/app.js server/middleware/idempotency.js server/test/middleware/idempotency.test.js
git commit -m "fix: scope idempotency after auth"
```

---

## Task 2: Refresh JWT Authorization Against Current Staff State

**Files:**
- Modify: `server/middleware/auth.js`
- Test: `server/test/routes/auth-me.test.js`

- [ ] **Step 1: Add stale-token tests**

Append to `server/test/routes/auth-me.test.js`:

```js
it('rejects a token for a deactivated staff member', async () => {
  await testDb.update(schema.staff)
    .set({ active: false })
    .where(eq(schema.staff.id, fixtures.cisnik.id));

  const res = await request
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${tokens.cisnik()}`);

  assert.equal(res.status, 401);
});

it('uses the current DB role instead of the stale JWT role', async () => {
  await testDb.update(schema.staff)
    .set({ role: 'cisnik' })
    .where(eq(schema.staff.id, fixtures.manazer.id));

  const res = await request
    .get('/api/reports/summary')
    .set('Authorization', `Bearer ${tokens.manazer()}`);

  assert.equal(res.status, 403);
});
```

If the file does not currently import `testDb`, `schema`, `eq`, or `fixtures`, add the same imports/setup style used in `server/test/routes/auth.test.js`.

- [ ] **Step 2: Run the focused auth tests and confirm failure**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/auth-me.test.js test/routes/role-gates.test.js
```

Expected before implementation: stale token still succeeds.

- [ ] **Step 3: Make `auth` async and DB-backed**

Replace `server/middleware/auth.js` with:

```js
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { staff } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token chyba' });

  const token = header.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const [currentStaff] = await db
      .select({ id: staff.id, name: staff.name, role: staff.role, active: staff.active })
      .from(staff)
      .where(eq(staff.id, decoded.id))
      .limit(1);

    if (!currentStaff?.active) return res.status(401).json({ error: 'Neplatny token' });

    req.user = { id: currentStaff.id, name: currentStaff.name, role: currentStaff.role };
    next();
  } catch {
    res.status(401).json({ error: 'Neplatny token' });
  }
}
```

- [ ] **Step 4: Run auth and role-gate tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/auth-me.test.js test/routes/role-gates.test.js
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```powershell
git add server/middleware/auth.js server/test/routes/auth-me.test.js
git commit -m "fix: validate jwt users against staff table"
```

---

## Task 3: Rate-Limit Manager PIN Verification

**Files:**
- Modify: `server/routes/auth.js`
- Test: `server/test/routes/auth-lockout.test.js`

- [ ] **Step 1: Add failing `/verify-manager` brute-force test**

Append to `server/test/routes/auth-lockout.test.js`:

```js
it('rate limits repeated invalid manager PIN verification attempts', async () => {
  for (let i = 0; i < 5; i += 1) {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '0000' });
    assert.equal(res.status, 401);
  }

  const blocked = await request
    .post('/api/auth/verify-manager')
    .send({ pin: '0000' });

  assert.equal(blocked.status, 429);
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/auth-lockout.test.js
```

Expected before implementation: sixth attempt returns `401`.

- [ ] **Step 3: Reuse attempt tracking in `/verify-manager`**

Change the handler in `server/routes/auth.js` to:

```js
router.post('/verify-manager', validate(loginSchema), async (req, res) => {
  const { pin } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || '';

  const allManagers = await db.select().from(staff)
    .where(and(eq(staff.active, true), sql`${staff.role} IN ('manazer', 'admin')`));
  const found = allManagers.find(s => bcrypt.compareSync(pin, s.pin));
  const lockKey = found ? { staffId: found.id, ip } : { staffId: null, ip };
  const fails = await countRecentFailures(lockKey);

  if (fails >= PIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neopravneny pristup' });
  }

  await recordAttempt({ staffId: found.id, ip, success: true });
  res.json({ ok: true, name: found.name });
});
```

- [ ] **Step 4: Run auth route tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/auth.test.js test/routes/auth-lockout.test.js
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```powershell
git add server/routes/auth.js server/test/routes/auth-lockout.test.js
git commit -m "fix: rate limit manager pin verification"
```

---

## Task 4: Block Fiscal Bypasses In Order Close And Delete

**Files:**
- Modify: `server/routes/orders.js`
- Test: `server/test/routes/orders.test.js`
- Test: `server/test/e2e/order-lifecycle.test.js`

- [ ] **Step 1: Add failing direct-close test**

Append to `server/test/routes/orders.test.js`:

```js
it('rejects closing an unpaid order directly', async () => {
  const order = await createOrderForTest({ tableId: fixtures.table1.id, staffId: fixtures.cisnik.id });

  const res = await request
    .post(`/api/orders/${order.id}/close`)
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send({});

  assert.equal(res.status, 409);

  const [dbOrder] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
  assert.equal(dbOrder.status, 'open');
});
```

Use the existing helper in `orders.test.js`; if no helper fits, insert directly with `testDb.insert(schema.orders).values(...)`.

- [ ] **Step 2: Add failing paid-delete retention test**

Append to `server/test/routes/orders.test.js`:

```js
it('does not delete orders that have payments or fiscal documents', async () => {
  const order = await createOrderForTest({ tableId: fixtures.table1.id, staffId: fixtures.cisnik.id });
  const [payment] = await testDb.insert(schema.payments)
    .values({ orderId: order.id, method: 'hotovost', amount: '8.50' })
    .returning();
  await testDb.insert(schema.fiscalDocuments).values({
    orderId: order.id,
    paymentId: payment.id,
    externalId: `order-${order.id}-payment`,
    cashRegisterCode: '88812345678900001',
    requestType: 'CashRegister',
    resultMode: 'online_success',
    requestJson: '{}',
    responseJson: '{}',
  });

  const res = await request
    .delete(`/api/orders/${order.id}`)
    .set('Authorization', `Bearer ${tokens.admin()}`)
    .send({});

  assert.equal(res.status, 409);
  assert.equal((await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).length, 1);
  assert.equal((await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id))).length, 1);
});
```

- [ ] **Step 3: Run and confirm failure**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/orders.test.js
```

Expected before implementation: direct close returns `200`, or paid delete removes rows.

- [ ] **Step 4: Block unpaid direct close**

In `router.post('/:id/close', ...)`, before bumping version, check for a payment:

```js
const [existingPay] = await tx.select({ id: payments.id })
  .from(payments)
  .where(eq(payments.orderId, orderId))
  .limit(1);
if (!existingPay) {
  const err = new Error('PAYMENT_REQUIRED');
  err.status = 409;
  throw err;
}
```

In the catch block, add:

```js
if (e && e.status === 409 && e.message === 'PAYMENT_REQUIRED') {
  return res.status(409).json({ error: 'Objednavku je potrebne uzavriet cez platbu.' });
}
```

- [ ] **Step 5: Soft-cancel unpaid orders and reject paid/fiscal deletes**

In `router.delete('/:id', ...)`, replace deletion of payment/fiscal/order rows with:

```js
const payRows = await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId));
const fiscalRows = await tx.select({ id: fiscalDocuments.id }).from(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderId));
if (payRows.length || fiscalRows.length) {
  const err = new Error('FISCAL_RECORDS_IMMUTABLE');
  err.status = 409;
  throw err;
}

await logEvent(tx, { orderId, type: 'order_cancelled', payload: { tableId: order.tableId }, staffId: req.user.id });

await tx.update(orders)
  .set({ status: 'cancelled', closedAt: new Date() })
  .where(eq(orders.id, orderId));
```

Remove these destructive statements from that route:

```js
await tx.delete(fiscalDocuments)...
await tx.delete(payments)...
await tx.delete(orderItems)...
await tx.delete(orders)...
```

In the catch block, add:

```js
if (e && e.status === 409 && e.message === 'FISCAL_RECORDS_IMMUTABLE') {
  return res.status(409).json({
    error: 'Objednavka s platbou alebo fiskalnym dokladom sa nemoze vymazat. Pouzite storno.',
  });
}
```

- [ ] **Step 6: Update e2e expectations**

Search for direct `/close` use in `server/test/e2e/order-lifecycle.test.js`. Replace sale-closing usage with `POST /api/payments` when the scenario is a real sale, or `DELETE /api/orders/:id` when the scenario is an unpaid cancellation.

- [ ] **Step 7: Run order tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/orders.test.js test/e2e/order-lifecycle.test.js
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```powershell
git add server/routes/orders.js server/test/routes/orders.test.js server/test/e2e/order-lifecycle.test.js
git commit -m "fix: preserve fiscal order history"
```

---

## Task 5: Add Payment In-Flight Lock Before Portos Calls

**Files:**
- Modify: `server/routes/payments.js`
- Test: `server/test/routes/payments.portos.test.js`

- [ ] **Step 1: Add failing concurrent Portos test**

Append to `server/test/routes/payments.portos.test.js`:

```js
it('does not submit the same order to Portos twice under concurrent payment requests', async () => {
  const { cisnik, table1, itemBurger } = fixtures;
  const order = await createOpenOrder(table1.id, cisnik.id, [
    { menuItemId: itemBurger.id, qty: 1 },
  ]);

  let portosCalls = 0;
  global.fetch = async () => {
    portosCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return mockJsonResponse(200, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 50,
      receiptId: 'O-CONCURRENT',
    }));
  };

  const payload = { orderId: order.id, method: 'hotovost', amount: 8.50 };
  const [first, second] = await Promise.all([
    request.post('/api/payments').set('Authorization', `Bearer ${tokens.cisnik()}`).send(payload),
    request.post('/api/payments').set('Authorization', `Bearer ${tokens.cisnik()}`).send(payload),
  ]);

  assert.equal(portosCalls, 1);
  assert.ok([201, 200, 409].includes(first.status));
  assert.ok([201, 200, 409].includes(second.status));

  const dbPayments = await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
  assert.equal(dbPayments.length, 1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/payments.portos.test.js
```

Expected before implementation: `portosCalls` can be `2`.

- [ ] **Step 3: Add payment lock helpers**

In `server/routes/payments.js`, add:

```js
async function acquirePaymentAttempt(orderId) {
  const [locked] = await db.update(orders)
    .set({ status: 'payment_pending' })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'open')))
    .returning();
  return locked || null;
}

async function releasePaymentAttempt(orderId) {
  await db.update(orders)
    .set({ status: 'open' })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'payment_pending')));
}
```

- [ ] **Step 4: Use the lock before Portos registration**

After amount/VAT validation and before building/calling Portos:

```js
const lockedOrder = await acquirePaymentAttempt(orderId);
if (!lockedOrder) {
  const existing = await loadExistingPaymentSnapshot(orderId);
  if (existing.order && existing.payment) {
    return res.status(200).json({
      payment: existing.payment,
      order: existing.order,
      fiscal: toFiscalResponse(existing.fiscalDocument),
      alreadyProcessed: true,
    });
  }
  return res.status(409).json({ error: 'Platba pre tuto objednavku uz prebieha' });
}
orderContext.order = lockedOrder;
```

In every Portos failure branch that returns before local payment creation, call:

```js
await releasePaymentAttempt(orderId);
```

- [ ] **Step 5: Finalize from `payment_pending`**

In `finalizeLocalPayment`, change the close update to:

```js
.where(and(
  eq(orders.id, orderContext.order.id),
  inArray(orders.status, ['open', 'payment_pending']),
))
```

`inArray` is already imported in `payments.js`.

- [ ] **Step 6: Run Portos payment tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/payments.portos.test.js test/routes/payments.test.js
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```powershell
git add server/routes/payments.js server/test/routes/payments.portos.test.js
git commit -m "fix: lock fiscal payment attempts"
```

---

## Task 6: Gate Sensitive Operational Routes

**Files:**
- Modify: `server/routes/printers.js`
- Modify: `server/routes/print.js`
- Modify: `server/routes/ttlock.js`
- Modify: `server/routes/orders.js`
- Test: `server/test/routes/role-gates.test.js`
- Test: `server/test/routes/orders.test.js`

- [ ] **Step 1: Add role-gate tests**

Append to `server/test/routes/role-gates.test.js`:

```js
describe('sensitive operational routes - manazer/admin only', () => {
  const protectedPosts = [
    ['/api/printers', { name: 'P1', ip: '127.0.0.1', port: 9100, dest: 'bar' }],
    ['/api/print/queue/retry', { id: 1 }],
    ['/api/ttlock/passcode', { room: '101', checkIn: '2026-04-23T10:00:00Z', checkOut: '2026-04-23T12:00:00Z' }],
  ];

  for (const [path, body] of protectedPosts) {
    it(`returns 403 when cisnik calls POST ${path}`, async () => {
      const res = await request
        .post(path)
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .send(body);
      assert.equal(res.status, 403);
    });
  }

  it('returns 403 when cisnik lists print queue', async () => {
    const res = await request
      .get('/api/print/queue')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 403);
  });

  it('returns 403 when cisnik lists locks', async () => {
    const res = await request
      .get('/api/ttlock/locks')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 403);
  });
});
```

Append to `server/test/routes/orders.test.js`:

```js
it('rejects discount removal by cisnik', async () => {
  const order = await createOrderForTest({ tableId: fixtures.table1.id, staffId: fixtures.cisnik.id });

  const res = await request
    .delete(`/api/orders/${order.id}/discount`)
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send({});

  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run and confirm failures**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/role-gates.test.js test/routes/orders.test.js
```

Expected before implementation: some routes return non-403 for `cisnik`.

- [ ] **Step 3: Add `requireRole` gates**

In `server/routes/printers.js`, import and use:

```js
import { requireRole } from '../middleware/requireRole.js';
const mgr = requireRole('manazer', 'admin');
```

Apply `mgr` to create/update/delete/test:

```js
router.post('/', mgr, async (req, res) => { ... });
router.put('/:id', mgr, async (req, res) => { ... });
router.delete('/:id', mgr, async (req, res) => { ... });
router.post('/:id/test', mgr, async (req, res) => { ... });
```

In `server/routes/print.js`, use existing `mgr` on queue admin endpoints:

```js
router.get('/queue', mgr, async (req, res) => { ... });
router.post('/queue/retry', mgr, async (req, res) => { ... });
router.delete('/queue/:id', mgr, async (req, res) => { ... });
```

In `server/routes/ttlock.js`, import `requireRole`, define `mgr`, and gate:

```js
router.post('/passcode', mgr, async (req, res) => { ... });
router.get('/locks', mgr, async (req, res) => { ... });
```

In `server/routes/orders.js`, add the same role check used by discount apply to discount delete:

```js
if (req.user.role === 'cisnik') {
  return res.status(403).json({ error: 'Pristup odmietnuty' });
}
```

- [ ] **Step 4: Run role-gate tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/role-gates.test.js test/routes/orders.test.js
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```powershell
git add server/routes/printers.js server/routes/print.js server/routes/ttlock.js server/routes/orders.js server/test/routes/role-gates.test.js server/test/routes/orders.test.js
git commit -m "fix: gate sensitive operations by role"
```

---

## Task 7: Standardize Stock Tracking Modes And Recipe Deletion

**Files:**
- Modify: `server/schemas/menu.js`
- Modify: `server/schemas/inventory.js`
- Modify: `server/routes/inventory.js`
- Modify: `server/lib/stock.js`
- Test: `server/test/routes/menu.vat.test.js`
- Test: `server/test/lib/stock.test.js`

- [ ] **Step 1: Add stock-mode regression tests**

Append to `server/test/routes/menu.vat.test.js`:

```js
it('normalizes legacy direct trackMode to simple when creating a menu item', async () => {
  const res = await request
    .post('/api/menu/items')
    .set('Authorization', `Bearer ${tokens.manazer()}`)
    .send({
      categoryId: fixtures.catDrink.id,
      name: 'Legacy Direct Stock',
      emoji: 'box',
      price: 4,
      trackMode: 'direct',
      stockQty: 5,
      minStockQty: 1,
      vatRate: 23,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.trackMode, 'simple');
});
```

Append to `server/test/lib/stock.test.js`:

```js
it('deducts stock for legacy direct mode as simple mode', async () => {
  const [directItem] = await testDb.insert(schema.menuItems)
    .values({
      categoryId: fixtures.catDrink.id,
      name: 'Legacy Direct',
      emoji: 'box',
      price: '3.00',
      trackMode: 'direct',
      stockQty: '10',
      minStockQty: '1',
    })
    .returning();

  await testDb.transaction((tx) =>
    deductStockForSentItems(tx, [{ menuItemId: directItem.id, qty: 2 }], fixtures.cisnik.id, 100),
  );

  const updated = await fetchMenuItem(directItem.id);
  assert.equal(parseFloat(updated.stockQty), 8);
});
```

- [ ] **Step 2: Add recipe-delete regression test**

Append to the inventory route test file that covers recipe routes. If no such file exists, create `server/test/routes/inventory-recipes.test.js` using the same setup pattern as `server/test/routes/menu.vat.test.js`:

```js
it('resets menu item trackMode to none when recipe is deleted', async () => {
  const { itemBurger, manazer } = fixtures;
  const [ingredient] = await testDb.insert(schema.ingredients)
    .values({ name: 'Recipe Reset Ing', unit: 'kg', currentQty: '10', minQty: '1', costPerUnit: '1' })
    .returning();

  await request
    .put(`/api/inventory/recipes/${itemBurger.id}`)
    .set('Authorization', `Bearer ${tokens.manazer()}`)
    .send({ lines: [{ ingredientId: ingredient.id, qtyPerUnit: 0.2 }] });

  const deleted = await request
    .delete(`/api/inventory/recipes/${itemBurger.id}`)
    .set('Authorization', `Bearer ${tokens.manazer()}`);

  assert.equal(deleted.status, 200);

  const [row] = await testDb.select().from(schema.menuItems).where(eq(schema.menuItems.id, itemBurger.id));
  assert.equal(row.trackMode, 'none');
});
```

- [ ] **Step 3: Run and confirm failures**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/menu.vat.test.js test/lib/stock.test.js test/routes/inventory-recipes.test.js
```

Expected before implementation: direct mode is stored or ignored, and recipe delete leaves `trackMode='recipe'`.

- [ ] **Step 4: Normalize menu schemas**

In `server/schemas/menu.js`, add:

```js
const trackModeSchema = z.enum(['none', 'simple', 'direct', 'recipe'])
  .transform((mode) => mode === 'direct' ? 'simple' : mode);
```

Use it in both item schemas:

```js
trackMode: trackModeSchema.default('none'),
```

and:

```js
trackMode: trackModeSchema.optional(),
```

- [ ] **Step 5: Make stock logic tolerate legacy rows**

In `server/lib/stock.js`, change:

```js
if (mi.trackMode === 'simple') {
```

to:

```js
if (mi.trackMode === 'simple' || mi.trackMode === 'direct') {
```

- [ ] **Step 6: Reset mode on recipe delete**

In `server/routes/inventory.js`, replace the recipe delete handler with:

```js
router.delete('/recipes/:menuItemId', mgr, asyncRoute(async (req, res) => {
  const menuItemId = +req.params.menuItemId;
  await db.transaction(async (tx) => {
    await tx.delete(recipes).where(eq(recipes.menuItemId, menuItemId));
    await tx.update(menuItems).set({ trackMode: 'none' }).where(eq(menuItems.id, menuItemId));
  });
  res.json({ ok: true });
}));
```

- [ ] **Step 7: Run stock/menu/inventory tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/menu.vat.test.js test/lib/stock.test.js test/routes/inventory-recipes.test.js
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```powershell
git add server/schemas/menu.js server/lib/stock.js server/routes/inventory.js server/test/routes/menu.vat.test.js server/test/lib/stock.test.js server/test/routes/inventory-recipes.test.js
git commit -m "fix: standardize stock tracking modes"
```

---

## Task 8: Fix Reports Aggregation And Export Duplicates

**Files:**
- Modify: `server/routes/reports.js`
- Test: `server/test/routes/reports.export.vat.test.js`
- Create: `server/test/routes/reports.staff.test.js`

- [ ] **Step 1: Add duplicate export item test**

Append to `server/test/routes/reports.export.vat.test.js`:

```js
it('aggregates duplicate item rows in export instead of dropping later quantities', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const createdAt = new Date(`${today}T12:30:00.000Z`);
  const { cisnik, table1, itemBurger } = fixtures;

  const [order] = await testDb.insert(schema.orders).values({
    tableId: table1.id,
    staffId: cisnik.id,
    status: 'closed',
    label: 'Duplicate item export',
    createdAt,
    closedAt: createdAt,
  }).returning();

  await testDb.insert(schema.orderItems).values([
    { orderId: order.id, menuItemId: itemBurger.id, qty: 1, sent: true },
    { orderId: order.id, menuItemId: itemBurger.id, qty: 2, sent: true },
  ]);

  await testDb.insert(schema.payments).values({
    orderId: order.id,
    method: 'hotovost',
    amount: '25.50',
    createdAt,
  });

  const res = await request
    .get(`/api/reports/export?from=${today}&to=${today}&format=json`)
    .set('Authorization', `Bearer ${tokens.manazer()}`);

  assert.equal(res.status, 200);
  assert.match(res.body[0].polozky, /3x Burger/);
});
```

- [ ] **Step 2: Create staff report regression tests**

Create `server/test/routes/reports.staff.test.js`:

```js
if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

describe('staff reports', () => {
  let fixtures = {};

  before(async () => {
    app.set('io', { emit: () => {} });
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    await testDb.execute(sql.raw('TRUNCATE payments, order_items, orders RESTART IDENTITY CASCADE'));
  });

  after(async () => {
    await closeDb();
  });

  it('does not collapse separate equal payment amounts', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const createdAt = new Date(`${today}T13:00:00.000Z`);
    const orders = await testDb.insert(schema.orders).values([
      { tableId: fixtures.table1.id, staffId: fixtures.cisnik.id, status: 'closed', label: 'A', createdAt, closedAt: createdAt },
      { tableId: fixtures.table2.id, staffId: fixtures.cisnik.id, status: 'closed', label: 'B', createdAt, closedAt: createdAt },
    ]).returning();

    await testDb.insert(schema.orderItems).values([
      { orderId: orders[0].id, menuItemId: fixtures.itemBurger.id, qty: 1 },
      { orderId: orders[1].id, menuItemId: fixtures.itemBurger.id, qty: 1 },
    ]);
    await testDb.insert(schema.payments).values([
      { orderId: orders[0].id, method: 'hotovost', amount: '8.50', createdAt },
      { orderId: orders[1].id, method: 'hotovost', amount: '8.50', createdAt },
    ]);

    const res = await request
      .get(`/api/reports/staff?from=${today}&to=${today}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    const row = res.body.find((item) => item.staffId === fixtures.cisnik.id);
    assert.equal(row.revenue, 17);
    assert.equal(row.cashPayments, 17);
  });
});
```

- [ ] **Step 3: Run and confirm failures**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/reports.export.vat.test.js test/routes/reports.staff.test.js
```

Expected before implementation: duplicate export shows `1x Burger`, staff revenue is `8.5`, or `cashPayments` is `0`.

- [ ] **Step 4: Aggregate duplicate export items**

In `server/routes/reports.js`, replace the duplicate skip block:

```js
const existing = grouped[key].items.find(i => i.name === row.itemName);
if (existing) {
  // skip duplicate from join
} else {
  grouped[key].items.push({
    name: row.itemName,
    qty: row.itemQty,
    price: parseFloat(row.itemPrice),
    vatRate: parseFloat(row.itemVatRate),
  });
}
```

with:

```js
const itemKey = `${row.itemName}::${parseFloat(row.itemPrice)}::${parseFloat(row.itemVatRate)}`;
const existing = grouped[key].items.find(i => i.key === itemKey);
if (existing) {
  existing.qty += row.itemQty;
} else {
  grouped[key].items.push({
    key: itemKey,
    name: row.itemName,
    qty: row.itemQty,
    price: parseFloat(row.itemPrice),
    vatRate: parseFloat(row.itemVatRate),
  });
}
```

- [ ] **Step 5: Fix staff report revenue**

Replace the staff revenue query with payment pre-aggregation by staff. One simple route-local approach:

```js
const staffStats = await db.select({
  staffId: staff.id,
  name: staff.name,
  role: staff.role,
  ordersCount: sql`COUNT(DISTINCT ${orders.id})`,
  itemsCount: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
  cancelledOrders: sql`COUNT(DISTINCT ${orders.id}) FILTER (WHERE ${orders.status} = 'cancelled')`,
})
.from(staff)
.leftJoin(orders, and(
  eq(orders.staffId, staff.id),
  gte(orders.createdAt, fromDate),
  sql`${orders.createdAt} <= ${toDate}`
))
.leftJoin(orderItems, eq(orderItems.orderId, orders.id))
.where(eq(staff.active, true))
.groupBy(staff.id, staff.name, staff.role);

const paymentBreakdown = await db.select({
  staffId: staff.id,
  method: payments.method,
  total: sql`SUM(${payments.amount}::numeric)`,
})
.from(payments)
.innerJoin(orders, eq(payments.orderId, orders.id))
.innerJoin(staff, eq(orders.staffId, staff.id))
.where(and(
  gte(payments.createdAt, fromDate),
  sql`${payments.createdAt} <= ${toDate}`
))
.groupBy(staff.id, payments.method);
```

Then compute revenue from `breakdownMap`:

```js
const revenue = Object.values(bd).reduce((sum, value) => sum + value, 0);
cashPayments: bd['hotovost'] || 0,
cardPayments: bd['karta'] || 0,
```

- [ ] **Step 6: Run report tests**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/routes/reports.export.vat.test.js test/routes/reports.staff.test.js
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```powershell
git add server/routes/reports.js server/test/routes/reports.export.vat.test.js server/test/routes/reports.staff.test.js
git commit -m "fix: correct report aggregation"
```

---

## Task 9: Configure Socket.IO Consistently For HTTP And HTTPS

**Files:**
- Modify: `server/server.js`
- Create: `server/lib/socket-server.js`
- Test: `server/test/realtime/socket-server.test.js`

- [ ] **Step 1: Extract socket setup helpers**

Create `server/lib/socket-server.js`:

```js
import jwt from 'jsonwebtoken';
import { Server as SocketServer } from 'socket.io';
import { corsOriginCallback } from './cors-origin.js';

export function configureSocketServer(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log('WS connected:', socket.user.name);
    socket.on('disconnect', () => console.log('WS disconnected:', socket.user.name));
  });

  return io;
}

export function createSocketServer(httpServer) {
  return configureSocketServer(new SocketServer(httpServer, { cors: { origin: corsOriginCallback } }));
}

export function createSocketBroadcaster(ioServers) {
  return {
    emit(eventName, payload) {
      for (const io of ioServers) io.emit(eventName, payload);
    },
  };
}
```

- [ ] **Step 2: Add unit test for broadcaster**

Create `server/test/realtime/socket-server.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSocketBroadcaster } from '../../lib/socket-server.js';

describe('socket broadcaster', () => {
  it('emits route events to every configured Socket.IO server', () => {
    const calls = [];
    const broadcaster = createSocketBroadcaster([
      { emit: (eventName, payload) => calls.push(['http', eventName, payload]) },
      { emit: (eventName, payload) => calls.push(['https', eventName, payload]) },
    ]);

    broadcaster.emit('order:updated', { orderId: 1 });

    assert.deepEqual(calls, [
      ['http', 'order:updated', { orderId: 1 }],
      ['https', 'order:updated', { orderId: 1 }],
    ]);
  });
});
```

- [ ] **Step 3: Update `server/server.js`**

Replace the direct `SocketServer` setup with:

```js
import { createSocketBroadcaster, createSocketServer } from './lib/socket-server.js';
```

Use both servers:

```js
const ioServers = [createSocketServer(httpServer)];
if (httpsServer) ioServers.push(createSocketServer(httpsServer));

app.set('io', createSocketBroadcaster(ioServers));
```

Remove the old duplicated block:

```js
const ioServer = httpsServer || httpServer;
const io = new SocketServer(ioServer, { cors: { origin: corsOriginCallback } });
if (httpsServer) new SocketServer(httpServer, { cors: { origin: corsOriginCallback } });
io.use(...);
io.on(...);
app.set('io', io);
```

- [ ] **Step 4: Run socket test**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/realtime/socket-server.test.js
```

Expected: test passes.

- [ ] **Step 5: Commit**

```powershell
git add server/server.js server/lib/socket-server.js server/test/realtime/socket-server.test.js
git commit -m "fix: configure socket servers consistently"
```

---

## Task 10: Final Verification

**Files:**
- Read: all modified files

- [ ] **Step 1: Run focused suites from this plan**

Run:

```powershell
cd server
node --test --test-concurrency=1 test/middleware/idempotency.test.js test/routes/auth.test.js test/routes/auth-lockout.test.js test/routes/auth-me.test.js test/routes/role-gates.test.js test/routes/orders.test.js test/routes/payments.test.js test/routes/payments.portos.test.js test/routes/menu.vat.test.js test/routes/inventory-recipes.test.js test/lib/stock.test.js test/routes/reports.export.vat.test.js test/routes/reports.staff.test.js test/realtime/socket-server.test.js
```

Expected: all listed tests pass.

- [ ] **Step 2: Run full backend test suite**

Run:

```powershell
cd server
npm test
```

Expected: all tests pass. If local sandbox returns `spawn EPERM`, rerun outside sandbox or on the normal developer shell and record that environment issue separately.

- [ ] **Step 3: Run a manual smoke check with the app**

Run:

```powershell
cd server
npm start
```

Then verify:

- `GET http://localhost:3080/api/health` returns health JSON.
- Login succeeds from `login.html`.
- Creating an order, sending it, and paying it emits no server errors.
- A waiter cannot access print queue, TTLock, or printer admin endpoints.

- [ ] **Step 4: Commit verification notes**

If any docs or runbook notes are updated, commit them:

```powershell
git add docs server
git commit -m "test: verify backend hardening fixes"
```

---

## Execution Notes

- Implement tasks in order. Tasks 1, 2, and 4 affect request flow and should land before payment/report fixes.
- Keep commits small. Each task has its own commit command.
- Do not delete fiscal documents, payments, or order audit rows as part of cleanup.
- If a test helper referenced above already exists under a different name in the target file, reuse the existing helper and keep the assertion intent unchanged.

## Self-Review

- Spec coverage: every high-risk finding from the backend analysis is covered by Tasks 1, 4, 5, 7, 8, and 9. Medium security role gaps are covered by Tasks 2, 3, and 6.
- Placeholder scan: the plan contains concrete tests, implementation steps, and verification commands.
- Type consistency: all snippets use existing ESM imports, Express route style, Drizzle schema names, and Node test runner patterns already present in the repo.
