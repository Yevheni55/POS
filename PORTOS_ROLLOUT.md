# Portos eKasa Rollout Playbook

## Current state on this workstation

Checked on April 2, 2026:

- Backend env exists in `server/.env`.
- `PORTOS_ENABLED=false` in the live env.
- `PORTOS_BASE_URL=http://localhost:3010`.
- `PORTOS_CASH_REGISTER_CODE=88812345678900001`.
- `PORTOS_PRINTER_NAME=pos`.
- Working DB already contains:
  - table `fiscal_documents`
  - column `menu_items.vat_rate`
- `npm run db:push` in `server/` returned `No changes detected`.
- Portos readiness is green:
  - connectivity: `Up`
  - CHDU/storage: `CHDU Lite v1.5`
  - CHDU serial port: `COM3`
  - printer state: `Ready`
  - paper state: `Ready`
  - certificate valid: `true`
  - certificate expiry: `2026-11-15T11:03:57+01:00`
  - cash register code matches env: `88812345678900001`

## Commands

Run from `C:\Users\yevhe\Desktop\POS\server`:

```powershell
npm run portos:readiness
```

```powershell
npm run db:push
```

```powershell
node server.js
```

## Pilot launch procedure

1. Keep `PORTOS_ENABLED=false`.
2. Run `npm run portos:readiness`.
3. Confirm all of these are true before pilot:
   - `hasFiscalDocumentsTable=true`
   - `hasMenuItemVatRate=true`
   - `serviceReachable=true`
   - `connectivityState=Up`
   - `printerState=Ready`
   - `certificateValid=true`
   - `cashRegisterCode` equals `configuredCashRegisterCode`
   - all values in `errors` are `null`
4. Only after that, switch `PORTOS_ENABLED=true`.
5. Restart the backend on the same Windows host where Portos is running.
6. Execute the pilot on one cashier account and one table only.

## UAT protocol

### Scenario 1: Cash happy path

- Create a new order with one active item.
- Pay by `hotovost`.
- Expected:
  - POS shows fiscal success
  - order is closed
  - table is freed if no other open orders remain
  - one `payments` row exists
  - one `fiscal_documents` row exists
  - customer receipt is printed by Portos

### Scenario 2: Card happy path

- Create a new order with one active item.
- Pay by `karta`.
- Expected:
  - same backend invariants as cash
  - no duplicate fiscal document

### Scenario 3: Receipt copy

- Use an existing successful payment.
- Call `POST /api/payments/:id/receipt-copy`.
- Expected:
  - copy prints successfully
  - no new payment is created
  - no new fiscal sale is created

### Scenario 4: Duplicate click protection

- Submit payment twice as fast as possible on the same order.
- Expected:
  - only one payment row
  - only one fiscal document for the order
  - second request returns already-processed behavior

### Scenario 5: Failure path

- Only if business approves the test window.
- Simulate one of:
  - Portos unavailable
  - printer not ready
  - invalid register code
- Expected:
  - order remains open
  - payment is not silently finalized
  - cashier sees blocked or ambiguous status

### Scenario 6: Mixed VAT

- Current blocker: live menu inspection on April 2, 2026 found no active items with `vatRate != 20.00`.
- Before this UAT, create one temporary non-20% item in admin or choose an existing real mixed-VAT product if the catalog changes.
- Use an order with:
  - at least one `20.00` VAT item
  - at least one non-`20.00` VAT item
  - one order-level discount
- Expected:
  - Portos request contains split discount lines by VAT group
  - export/report values use per-item VAT, not a hardcoded 20%

## Cashier operating rules

- `success`:
  - payment is complete
  - do not retry

- `offline_accepted`:
  - payment is complete
  - do not retry
  - manager can later inspect fiscal record if needed

- `blocked`:
  - do not retry from cashier UI
  - call manager

- `ambiguous`:
  - do not retry from cashier UI
  - manager must inspect `GET /api/payments/:id/fiscal`
  - if needed, use `POST /api/payments/:id/receipt-copy`

## Rollback

If Portos pilot must be stopped:

1. Set `PORTOS_ENABLED=false` in `server/.env`.
2. Restart backend.
3. Re-run:

```powershell
npm run portos:readiness
```

4. Confirm backend comes up and Portos diagnostics still read correctly.
5. Continue operations in legacy non-Portos payment mode until blocker is resolved.

## Sign-off checklist

- [x] Runtime env exists on host machine.
- [x] `PORTOS_ENABLED` is disabled by default before pilot.
- [x] Working DB schema is ready.
- [x] Portos diagnostics are green on this workstation.
- [x] Cross-platform `npm test` runner exists.
- [x] `move-items` audit warning is fixed and covered by tests.
- [ ] Live cash pilot completed.
- [ ] Live card pilot completed.
- [ ] Receipt copy validated on live receipt.
- [ ] Mixed-VAT live pilot completed.
- [ ] Business approved full rollout after pilot.

## Notes

- Kitchen/bar printing remains on the existing non-Portos flow.
- Customer fiscal receipt should not fall back to the legacy `/api/print/receipt` path.
- Live fiscal UAT was not auto-executed in this implementation pass because it creates real eKasa fiscal records and should be done intentionally during an agreed test window.
