# Portos Pilot Log

Use this file to record the controlled pilot run on the host workstation.

## Pilot Setup

- Pilot cashier: `Peter Novak`
- Manager observer: `Admin`
- Pilot table: `Stol 1`
- Portos enable flag before pilot: `PORTOS_ENABLED=true`
- Current configured default before pilot: `PORTOS_ENABLED=false`
- Backend restarted after `.env` change: `YES`, live backend process restarted on `2026-04-02`
- Legacy kitchen/bar printer accepted for pilot day: `NO` at `2026-04-02`, both `192.168.0.106:9100` and `192.168.0.107:9100` were unreachable from this workstation

## Readiness Before Pilot

- `node scripts/portos-readiness.mjs` executed: `YES`, last local run `2026-04-02T15:15:58.459Z`
- `hasFiscalDocumentsTable=true`: `YES`
- `hasMenuItemVatRate=true`: `YES`
- `serviceReachable=true`: `YES`
- `connectivityState=Up`: `YES`
- `printerState=Ready`: `YES`
- `certificateValid=true`: `YES`
- `cashRegisterCode=88812345678900001`: `YES`
- `certificateExpiry`: `2026-11-15T11:03:57+01:00`
- `CHDU serial port`: `COM3`

## Pilot Fixtures

- Command used:

```powershell
cd C:\Users\yevhe\Desktop\POS\server
node scripts/portos-pilot-item.mjs ensure
node scripts/portos-pilot-discount.mjs ensure
node scripts/portos-pilot-item.mjs activate
```

- Current pilot items:
  - `Portos VAT 19 Test`, `1.00`, `vatRate=19.00`, temporary beverage item
  - `Portos VAT 5 Test`, `1.00`, `vatRate=5.00`, temporary food item
  - current DB item ids: `66`, `67`
- Current pilot discount:
  - `Portos Pilot Fixed 0.30`, `type=fixed`, `value=0.30`, inactive until mixed-VAT scenario
  - current DB discount id: `1`
- Legacy invalid pilot item:
  - `Portos VAT 10 Test`, `vatRate=10.00`, forced inactive and no longer used
- Deactivate immediately after mixed-VAT UAT:

```powershell
cd C:\Users\yevhe\Desktop\POS\server
node scripts/portos-pilot-discount.mjs deactivate
node scripts/portos-pilot-item.mjs deactivate
```

## Validation Failure Recorded Before Updated Pilot

- Attempted live cash payment on `2026-04-02` using `Espresso 1.80 (20%)`
- Result: `FAIL`
- Portos HTTP status: `400`
- Fiscal status: `validation_error`
- Fiscal error code: `-900`
- Detail: `Sadzba DPH 20,00% nie je platná pre doklad s dátumom vyhotovenia 2. 4. 2026`
- Saved fiscal document externalId: `order-1-payment`
- Action taken:
  - leave production menu unchanged
  - switch pilot to dedicated temporary `19.00%` and `5.00%` UAT items
  - cancel the failed open order before rerunning live scenarios

## UAT Scenarios

### 1. Cash Happy Path

- Product(s): `Portos VAT 19 Test 1.00 (19%)`
- Order discount: none
- `payment.id`: `1`
- `POST /api/payments` result: `201 Created`, `fiscal.status=online_success`, `externalId=order-2-payment`, `receiptNumber=1`
- `GET /api/payments/:id/fiscal` result: `200 OK`, `vatRate=19`, `payment name=Hotovosť`, `printerName=pos`
- Physical receipt printed from Portos: `Portos online_success returned on printer pos`
- Order closed: `YES`
- Result: `PASS`

### 2. Card Happy Path

- Product(s): `Portos VAT 19 Test 1.00 (19%)`
- Order discount: none
- `payment.id`: `2`
- `POST /api/payments` result: `201 Created`, `fiscal.status=online_success`, `externalId=order-3-payment`, `receiptNumber=2`
- `GET /api/payments/:id/fiscal` result: `200 OK`, `vatRate=19`, `payment name=Karta`, `printerName=pos`
- Physical receipt printed from Portos: `Portos online_success returned on printer pos`
- Order closed: `YES`
- Result: `PASS`

### 3. Mixed VAT + Discount

- Product(s): `Portos VAT 19 Test 1.00 (19%)` + `Portos VAT 5 Test 1.00 (5%)`
- Order discount: `Portos Pilot Fixed 0.30`
- `payment.id`: `3`
- `POST /api/payments` result: `201 Created`, `fiscal.status=online_success`, `externalId=order-4-payment`, `receiptNumber=3`
- `GET /api/payments/:id/fiscal` result: `200 OK`, payload contains positive lines for `19%` and `5%` plus two `Discount` lines `-0.15` / `-0.15`
- Export/report verified against VAT groups: `YES`, export row `zaklad=1.52`, `dph=0.18`, `celkom=1.70`
- Result: `PASS`

### 4. Receipt Copy

- Source `payment.id`: `1`
- `POST /api/payments/:id/receipt-copy` result: `200 OK`, `{ ok: true, printed: true, externalId: "order-2-payment" }`
- Copy printed: `YES`, according to Portos copy endpoint
- Result: `PASS`

### 5. Duplicate Guard Sanity Check

- Source order: `2`
- Repeat request: `POST /api/payments` with the same closed order and amount
- Result: `200 OK`, `alreadyProcessed=true`, existing `payment.id=1` returned
- Second fiscal sale created: `NO`
- Result: `PASS`

## Cashier Rules During Pilot

- `success`: payment is complete.
- `offline_accepted`: payment is complete, but note the offline acceptance.
- `blocked`: cashier does not retry; manager intervenes.
- `ambiguous`: cashier does not retry; manager checks `GET /api/payments/:id/fiscal`.

## Final Pilot Verdict

- Cash scenario: `PASS`
- Card scenario: `PASS`
- Mixed VAT scenario: `PASS`
- Receipt copy: `PASS`
- Legacy kitchen/bar printer blocker accepted or resolved: `NO`
- Production menu VAT audit completed for broad rollout: `NO`
- Temporary UAT items deactivated after pilot: `YES`
- Temporary pilot discount deactivated after pilot: `YES`
- Backend returned to `PORTOS_ENABLED=false` after pilot: `YES`
- Ready for broader rollout: `NO`
