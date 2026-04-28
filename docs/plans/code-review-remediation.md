# Code Review Remediation Plan

**Status:** DRAFT — awaiting approval. No code changes until reviewed.
**Author:** Claude (planning pass)
**Date:** 2026-04-28
**Scope:** 4 findings from the latest read-only review of the POS Express/PG application.
**Branch strategy:** one PR per finding, sequenced PR-A → PR-B → PR-C → PR-D, each gated on review.

---

## Global ground rules

These apply to every PR below.

- **Tests-first.** Every PR lands a failing test on the first commit, the fix on the second, and a green run on the third (or squashed equivalent).
- **Backend test gate.** `cd server && npm test` must be green before merge. No skipping, no `.only`.
- **Do not touch fiscal Portos scripts.** Specifically, do not run `npm run portos:fiscal-test` and do not modify code paths that emit live fiscal receipts.
- **Reuse existing patterns.**
  - Role checks use `server/middleware/requireRole.js` (`requireRole('manazer','admin')`). The bespoke inline `if (role === 'cisnik')` check at `server/routes/orders.js:587-590` should be replaced by the middleware in PR-A so authorization is consistent.
  - PIN/login throttling uses the DB-backed pattern in `server/routes/auth.js:13-100`: `countRecentFailures` + `recordAttempt` against the `auth_attempts` table, 5 attempts / 15 min window. PR-B reuses this.
- **Frontend offline queue.** Preserve the existing idempotency-key flow (`api.js:267-308`). Online behavior must be unchanged; only the offline-queueing decision is in scope.
- **Rollback.** Each PR is independent and revertable in isolation. No DB schema changes are required by any PR (PR-B reuses `auth_attempts`).

---

## PR-A — Discount removal authorization (Medium)

### Problem
`POST /api/orders/:id/discount` blocks `cisnik` (`server/routes/orders.js:587-590`) but `DELETE /api/orders/:id/discount` (`server/routes/orders.js:650`) has no role check. The existing test at `server/test/routes/orders.test.js:880-895` documents this gap as the current contract (`assert.equal(res.status, 200)` for cisnik DELETE).

### Decision
Discounts are manager-controlled on apply; removal MUST be the same — anything else lets a cashier silently undo a manager action. Required role on DELETE: `manazer | admin`.

### Touchpoints (file:line)
- `server/routes/orders.js:13` — add `requireRole` to existing import line for `../middleware/requireRole.js` (or new import).
- `server/routes/orders.js:582` — POST route: replace inline `if (role === 'cisnik')` block (587-590) with `requireRole('manazer','admin')` middleware passed to `router.post(...)`. Keeps behavior identical, removes duplication.
- `server/routes/orders.js:650` — DELETE route: add `requireRole('manazer','admin')` between path and `asyncRoute(...)`.
- `server/test/routes/orders.test.js:880-895` — flip the existing "documents actual behavior" test.

### Tests to add / modify
File: `server/test/routes/orders.test.js`

- **Modify** the test currently around line 880 (`'allows cisnik to remove discount'` or similarly worded). Rename to `'rejects cisnik DELETE /discount with 403'`. Assert `res.status === 403`. Body assertion: `res.body.error === 'Pristup odmietnuty'` (matches `requireRole` message).
- **Add** `'allows manazer to DELETE /discount with 200 and clears discountAmount'`. Setup: manazer applies a discount via POST, then manazer issues DELETE. Assert 200, response body has `discountAmount === null`.
- **Add** `'allows admin to DELETE /discount with 200'`. Same shape, admin token.
- **Add** (regression) `'still rejects cisnik POST /discount with 403'` — explicit test so future refactors of the middleware migration don't break the existing rule.

### Verification commands
```
cd server
npm test -- test/routes/orders.test.js
npm test
```

### Risk + rollback
- **Risk:** low. Pure authorization tightening; no data shape change. Theoretical concern — a deployed POS UI that calls DELETE /discount as a cashier would start failing with 403. Mitigation: the UI surfaces "remove discount" only after a manager PIN override; cashiers cannot reach the action through normal flow. To verify, grep `js/` for `del('/orders/.*/discount` or equivalent and confirm callers are inside manager-gated handlers (do this verification before opening the PR).
- **Rollback:** `git revert` the PR. No data migration, no DB state change.

---

## PR-B — Manager PIN lockout (Medium)

### Problem
`POST /api/auth/verify-manager` (`server/routes/auth.js:105-112`) — used to gate sent-item removal and STORNO from the POS — has no rate limiting. Login (`server/routes/auth.js:72-100`) does. A terminal can brute-force the manager PIN at full speed.

### Decision — lockout key
**Use the same identity-aware key as login: prefer matched `staffId`; fall back to IP for attempts that match no staff row.**

Why this key (vs. per-IP only or per-terminal):
- **Per-IP only is wrong** for the same reason it was wrong on /login (PR-2.3 commit history): inside Docker, all LAN clients can collapse to the same apparent IP, both punishing legitimate managers and letting an attacker rotate IPs.
- **Per-terminal would require new client-state plumbing.** No terminal identifier is currently sent on `/verify-manager`. Adding one is out of scope for a Medium fix.
- **Per-matched-staffId is correct:** the lockout pins to the specific manager whose PIN is being guessed. Failed attempts that match no manager row fall into the IP bucket (same fallback as login), which is the right behavior because there is no staff identity to pin them to.

Reuse the constants `PIN_WINDOW_MS` and `PIN_MAX_ATTEMPTS` already defined at `server/routes/auth.js:19-20`. No DB migration — `auth_attempts` already supports this.

### Touchpoints (file:line)
- `server/routes/auth.js:105-112` — wrap `/verify-manager` body in the same lockout pattern used by `/login`:
  1. Look up manager candidates (existing line 107-108).
  2. Find match (existing line 109).
  3. Compute `lockKey = found ? { staffId: found.id, ip } : { staffId: null, ip }`.
  4. `countRecentFailures(lockKey)`; if `>= PIN_MAX_ATTEMPTS`, return 429 with `Retry-After` header (seconds until oldest failed attempt in window expires; or use a constant `PIN_WINDOW_MS / 1000` as a safe upper bound — pick the constant for simplicity).
  5. On `!found`: `recordAttempt({ staffId: null, ip, success: false })`, return 401.
  6. On `found`: `recordAttempt({ staffId: found.id, ip, success: true })`, return 200 (existing response).
- Update the comment block at `server/routes/auth.js:103-104` (currently says "DB-backed limiter is only wired on /login in this PR") to reflect that verify-manager now also uses it.

### Tests to add / modify
New file: `server/test/routes/auth-verify-manager.test.js` (or add a `describe` block to the existing auth test file if one exists — check `server/test/routes/auth.test.js` first).

- **Add** `'returns 401 on wrong manager PIN'` (sanity).
- **Add** `'returns 200 on correct manager PIN'` (sanity).
- **Add** `'locks out after 5 failed attempts within window — returns 429'`. Loop 5 wrong PINs against the same matched manager (use a known-existing manager row from fixtures and a wrong PIN), then assert the 6th returns 429. Assert `res.headers['retry-after']` is present.
- **Add** `'lockout is per-staff, not global'`. Lock out manager A; verify manager B can still authenticate.
- **Add** `'unmatched-PIN attempts share an IP bucket and lock out'`. Submit 5 PINs that match no manager row (random strings); assert the 6th returns 429 even with another never-matched PIN.
- **Add** `'successful verify resets the failure window for that staff'`. Hardcode behavior: after a successful auth, a fresh failure count starts (matches login behavior — successful inserts a `success:true` row but the count still uses `success:false` filter, so this test asserts the existing semantics, not a new behavior).
- **Test data hygiene:** truncate `auth_attempts` in `beforeEach`/`before` to keep tests independent.

### Verification commands
```
cd server
npm test -- test/routes/auth-verify-manager.test.js
npm test
```

### Risk + rollback
- **Risk:** medium-low. Wrong key choice could lock out a legitimate manager in a busy shift. The 5/15-min window is the same as login and has been in production via PR-2.3 without incident. The per-staff key prevents one cashier's typos from locking another manager.
- **Rollback:** `git revert`. No DB migration. Clearing accumulated lockout state in production: `DELETE FROM auth_attempts WHERE created_at < NOW() - INTERVAL '15 minutes' AND success = false` is a no-op; or wait 15 minutes for the window to expire naturally.

---

## PR-C — Offline replay allowlist for fiscal/payment (Medium)

### Problem
`api.js:24-50` (`syncQueue`) and `api.js:127-141` (offline path inside `request`) treat every non-GET fetch failure as a queueable operation. This includes `/payments`, `/payments/:id/fiscal-storno`, `/payments/:id/receipt-copy`, `/fiscal-documents/:id/storno`, and inventory writes. Idempotency keys (`api.js:267-308`) reduce duplicate-write risk on the server but do not address the operator-trust problem: a fiscal receipt or STORNO that auto-replays minutes after the cashier walked away is a real-world hazard.

`js/pos-payments.js:310` interprets a `null` return from `api.post('/payments', …)` as "offline_queued" and shows a warning toast. That contract must continue to exist for non-fiscal flows; for fiscal flows we want a hard refusal at queue time, not a queued-then-replayed pseudo-success.

### Decision — block at queue time, do not "queue with confirm"
**Refuse to queue fiscal/payment operations when offline. Throw a distinct offline error so the caller can show "you must be online to complete this operation."**

Why "block" over "queue + manual confirm on reconnect":
- A queued fiscal write that's "waiting for confirm" is a footgun — the operator may not be present, may not understand, or may bulk-confirm without reading.
- The fiscal flow already has a paired UX: `confirmPayment` shows a clear feedback message; switching to a "must be online" error is a strict subset of existing UX work.
- Inventory writes, STORNO, receipt copies are infrequent enough that "do it again when online" is the right user instruction.

### Touchpoints (file:line)
- `api.js` — define a constant near top:
  ```js
  const OFFLINE_NO_QUEUE_PREFIXES = [
    '/payments',                    // POST /payments and POST /payments/:id/...
    '/fiscal-documents',             // POST /fiscal-documents/:id/storno
  ];
  ```
  Note: this also covers `/payments/:id/fiscal-storno` and `/payments/:id/receipt-copy` because they share the `/payments` prefix.
- `api.js:127-141` (`request` catch block, offline branch) — before pushing onto `_queue`, check if `path` starts with any prefix in `OFFLINE_NO_QUEUE_PREFIXES`. If yes:
  - Do not push.
  - Throw a distinct error: `const err = new Error('Pripojenie nie je dostupne — operacia vyzaduje online stav.'); err.code = 'OFFLINE_NO_QUEUE'; err.path = path; err.method = options.method; throw err;`
  - Document the contract: callers must handle this error explicitly. `confirmPayment` will fall into its existing `catch (e)` block (`js/pos-payments.js:326`); update `normalizeFiscalOutcome(null, e)` if necessary so the outcome message is "must be online" rather than the generic queued banner.
- `js/pos-payments.js:310` — keep the `paymentResult === null` branch as-is for backward safety, but add an early check: if the request threw `OFFLINE_NO_QUEUE`, the catch already runs — no change needed beyond verifying the message rendered to the operator is unambiguous (`'Pripojenie nie je dostupne — platbu nie je mozne dokoncit offline.'`). Inspect `normalizeFiscalOutcome` to confirm it surfaces `err.code === 'OFFLINE_NO_QUEUE'` as a distinct outcome, not merged with generic network errors.
- `api.js:24-50` (`syncQueue`) — no change needed since queued items will no longer include fiscal paths. Add a defensive filter at the start of `syncQueue` that drops any historical queued items matching `OFFLINE_NO_QUEUE_PREFIXES` (in case a user upgrades with a non-empty queue from before the fix). Log a console warning per dropped item.

### Tests to add / modify
There is no JS unit test harness for `api.js` yet (this is a static frontend file loaded in the browser). Two options:

**Option 1 (recommended):** add a tiny Node-based unit test at `server/test/lib/offline-queue.test.js` that imports the allowlist constant and the prefix-check helper. Refactor `api.js` to extract `_shouldBlockOfflineQueue(path)` so it is unit-testable in isolation. The frontend file remains a script tag include; the helper is duplicated as a tiny ESM module on the server side and re-imported by `api.js` via a small build-free `<script type="module">` change — OR more pragmatically, just keep the helper inline in `api.js` and add a Node test that loads the file as text and evaluates the helper in a sandboxed `vm` context. Pick whichever the team finds less invasive; the inline-with-vm approach is recommended for minimum surface area.

**Option 2:** rely on the existing `e2e-runner` agent (Recommendation #5 from review) to cover this. Inferior because it doesn't run on `npm test`.

Tests to add (Option 1):
- `'_shouldBlockOfflineQueue returns true for /payments'`
- `'_shouldBlockOfflineQueue returns true for /payments/123/fiscal-storno'`
- `'_shouldBlockOfflineQueue returns true for /payments/123/receipt-copy'`
- `'_shouldBlockOfflineQueue returns true for /fiscal-documents/45/storno'`
- `'_shouldBlockOfflineQueue returns false for /orders'`
- `'_shouldBlockOfflineQueue returns false for /inventory'` (NOTE: review recommendation also calls out inventory; per decision below, inventory writes remain queueable — they are not fiscal. Document this in the PR description.)
- `'_shouldBlockOfflineQueue returns false for /menu'`

**Inventory note:** the review groups inventory writes with fiscal in finding #2. PR-C scope is fiscal only. Inventory writes (stock, write-offs, audits) are operationally fine to replay because they're idempotent at the server and not legally binding the way a fiscal receipt is. If we want to also block inventory replay, that's a separate follow-up — call it out in the PR description but do not include it here.

### Manual smoke checklist (paste into PR description)
```
[ ] Online: pay an order — succeeds, fiscal receipt issued.
[ ] Pull network cable. Try to pay an order — UI shows "must be online", no queued operation in localStorage `pos_offline_queue`.
[ ] Restore network. Open a fresh order — pay normally, no replayed phantom payment from prior attempt.
[ ] Online: STORNO a payment from history — succeeds.
[ ] Pull network cable. Try to STORNO — UI shows "must be online", no queued operation.
[ ] Online: print receipt copy — succeeds.
[ ] Pull network cable. Print receipt copy — UI shows "must be online", no queued operation.
[ ] Pull network cable. Add an item to an open order — queued (existing behavior preserved).
[ ] Restore network. Verify item write replays once and only once.
```

### Verification commands
```
cd server
npm test -- test/lib/offline-queue.test.js
npm test
```

### Risk + rollback
- **Risk:** medium. The change alters POS UX for offline cashiers — they will now see a hard error on payment instead of a "queued" banner. This is the correct behavior, but operators must be informed. The PR description must include a "user-visible change" section.
- **Rollback:** `git revert` restores prior queueing behavior. Clients that already have queued fiscal operations from the pre-revert state would still be in the queue and would replay; that's the existing risk we are now fixing, so rollback returns to status quo without new harm.
- **Edge case to verify in PR review:** the defensive filter in `syncQueue` correctly drops legacy queued fiscal items without crashing on malformed entries.

---

## PR-D — Empty-order semantics (Low)

### Problem
- `server/schemas/orders.js:9` — `createOrderSchema` declares `items: z.array(...).default([])`, allowing both missing and empty.
- `js/pos-orders.js:518-531` — `newAccount` intentionally creates orders with `items: []` so a cashier can open a new account on a table before deciding what to add.
- `server/test/routes/orders.test.js:127-141` — two tests assert that empty/missing items return 400.

The schema and UI agree (empty allowed). Tests disagree.

### Decision
**Keep the UI behavior. Empty accounts are an intentional product flow.** Update tests to match. Justification:
- The "open a blank account on a table" workflow is real (split-bill prep, walk-up customers undecided).
- The schema already encodes the intent (`.default([])`).
- The tests look like they were written before the UI feature landed, and were never reconciled.
- "Reject empty" would force the UI to invent a fake placeholder item, which is worse.

### Touchpoints (file:line)
- `server/schemas/orders.js:3-11` — no code change. Confirm `.default([])` is intentional; add a one-line comment: `// items may be empty — POS opens blank accounts on a table before any selection. See js/pos-orders.js:518.`
- `server/test/routes/orders.test.js:127-141` — replace the two "returns 400" tests:
  - Replace `'returns 400 when items array is empty'` with `'allows empty items array — POS creates blank accounts'`. Assert 201, body has `items: []` (or no items / empty list per the response shape). Look up the existing `createOrder` helper to confirm response shape.
  - Replace `'returns 400 when items is missing entirely'` with `'allows missing items — defaults to empty list'`. Assert 201.
- Confirm no other test file relies on the 400 contract: grep tests for `'items array is empty'` and `'items is missing'`.

### Tests to add / modify
Already covered above — modify the two existing tests in place.

### Verification commands
```
cd server
npm test -- test/routes/orders.test.js
npm test
```

### Risk + rollback
- **Risk:** very low. Tests-only change plus a comment. No runtime behavior shift; the schema already allowed empty.
- **Rollback:** `git revert`.

---

## Sequencing and merge gates

| PR   | Depends on | Merge gate                                             |
|------|------------|--------------------------------------------------------|
| PR-A | none       | green `cd server && npm test`; manual review approved  |
| PR-B | none       | green `cd server && npm test`; manual review approved  |
| PR-C | none       | green `cd server && npm test`; manual smoke checklist run by reviewer or operator on staging  |
| PR-D | none       | green `cd server && npm test`                           |

PR-A is implemented first per the original instruction. Pause for review before PR-B.

---

## Out of scope (explicit non-goals)

- Recommendation #5 (browser smoke tests for POS payment/send/storno and admin payment-history/STORNO) — separate ticket; the `ecc:e2e-runner` agent should pick this up after these four land.
- Recommendation #6 (no-real-Portos-receipt test policy near fiscal scripts) — documentation-only; separate small PR.
- Inventory offline-queue policy — see note in PR-C.
- Per-terminal manager-PIN identity — see PR-B decision.
