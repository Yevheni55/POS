# Portos Read-Only Sync And Fiscal Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-backed company identity profile, read-only Portos comparison, and a dedicated admin fiscal-documents workflow that no longer requires managers to know internal `paymentId` values.

**Architecture:** Store local identity data in the POS database, compare it against live Portos read-only snapshots on the backend, and expose a separate fiscal-documents route/page for search/detail/storno. Keep Portos write operations out of scope; reuse existing payment/storno runtime code where possible.

**Tech Stack:** Node.js, Express, Drizzle ORM, PostgreSQL, vanilla JS admin SPA, Node test runner, Supertest.

---

### Task 1: Add failing backend tests for company profile and fiscal document search

**Files:**
- Create: `C:/Users/yevhe/Desktop/POS/server/test/routes/company-profile.test.js`
- Create: `C:/Users/yevhe/Desktop/POS/server/test/routes/fiscal-documents.test.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/test/helpers/setup.js`

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run tests to verify they fail for missing routes/storage**
- [ ] **Step 3: Add only the minimum shared test seeding needed for company profile + fiscal docs**
- [ ] **Step 4: Re-run tests and keep them failing for the intended missing behavior**

### Task 2: Add backend storage and routes for server-backed company profile

**Files:**
- Modify: `C:/Users/yevhe/Desktop/POS/server/db/schema.js`
- Create: `C:/Users/yevhe/Desktop/POS/server/routes/company-profile.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/app.js`

- [ ] **Step 1: Extend schema with a focused `company_profiles` table**
- [ ] **Step 2: Implement `GET /api/company-profile` and `PUT /api/company-profile`**
- [ ] **Step 3: Mount the new route in `app.js`**
- [ ] **Step 4: Run company-profile tests and make them pass**

### Task 3: Add read-only Portos comparison endpoint

**Files:**
- Modify: `C:/Users/yevhe/Desktop/POS/server/lib/portos.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/routes/company-profile.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/test/routes/company-profile.test.js`

- [ ] **Step 1: Write a failing test for `GET /api/company-profile/portos-compare`**
- [ ] **Step 2: Add read-only identity fetch + normalization helpers in `portos.js`**
- [ ] **Step 3: Implement compare endpoint that returns local profile, Portos snapshot, and mismatch summary**
- [ ] **Step 4: Run the comparison tests and make them pass**

### Task 4: Add backend fiscal document search/detail/storno-by-document routes

**Files:**
- Create: `C:/Users/yevhe/Desktop/POS/server/routes/fiscal-documents.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/routes/payments.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/app.js`
- Modify: `C:/Users/yevhe/Desktop/POS/server/test/routes/fiscal-documents.test.js`

- [ ] **Step 1: Write failing tests for search by `receiptId`, `externalId`, and `cashRegisterCode+year+month+receiptNumber`**
- [ ] **Step 2: Add a detail endpoint that computes storno eligibility**
- [ ] **Step 3: Add storno-by-document endpoint that resolves linked payment internally and reuses existing storno logic**
- [ ] **Step 4: Run fiscal-document tests and make them pass**

### Task 5: Add admin navigation and new fiscal-documents page

**Files:**
- Modify: `C:/Users/yevhe/Desktop/POS/admin/index.html`
- Modify: `C:/Users/yevhe/Desktop/POS/admin/router.js`
- Create: `C:/Users/yevhe/Desktop/POS/admin/pages/fiscal-documents.js`
- Modify: `C:/Users/yevhe/Desktop/POS/api.js`

- [ ] **Step 1: Add a failing smoke expectation or manual verification target for the new route wiring**
- [ ] **Step 2: Add API client helpers for company profile and fiscal document search**
- [ ] **Step 3: Add `Fiškálne doklady` nav item + route**
- [ ] **Step 4: Implement the page with search, detail, copy, and storno actions**

### Task 6: Move legal identity settings off `localStorage` and add Portos comparison UI

**Files:**
- Modify: `C:/Users/yevhe/Desktop/POS/admin/pages/settings.js`
- Modify: `C:/Users/yevhe/Desktop/POS/api.js`

- [ ] **Step 1: Keep local-only visual/operational settings intact**
- [ ] **Step 2: Replace legal identity fields with server-backed load/save**
- [ ] **Step 3: Add `Portos porovnanie` section with mismatch badges and compliance warning**
- [ ] **Step 4: Verify existing settings behavior is not broken for unrelated controls**

### Task 7: Verify the implementation

**Files:**
- Verify only

- [ ] **Step 1: Run targeted route tests**
- [ ] **Step 2: Run the existing Portos payment test suite to catch regressions**
- [ ] **Step 3: Sanity-check admin routing and settings/fiscal-documents pages**
- [ ] **Step 4: Summarize remaining legal gaps intentionally left out of this iteration**
