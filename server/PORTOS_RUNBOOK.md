# Portos eKasa Runbook

Last verified: `2026-04-02`

## Current Readiness Snapshot

The backend and Portos integration were verified on `2026-04-02` against the local Windows workstation runtime.


| Check               | Result                                               |
| ------------------- | ---------------------------------------------------- |
| Database schema     | `fiscal_documents` table present                     |
| Database schema     | `menu_items.vat_rate` column present                 |
| Backend route       | `GET /api/integrations/portos/status` returned `200` |
| Portos connectivity | `Up`                                                 |
| CHDU / storage      | `CHDU Lite v1.5`, serial `3587077614`                |
| Fiscal printer      | `Ready`                                              |
| Paper state         | `Ready`                                              |
| Cash register code  | `88812345678900001`                                  |
| Certificate         | valid, expiry `2026-11-15T11:03:57+01:00`            |
| CHDU serial port    | `COM3`                                               |


## Runtime Configuration

The host runtime now expects these Portos variables in `server/.env`:

```env
PORTOS_ENABLED=false
PORTOS_BASE_URL=http://localhost:3010
PORTOS_CASH_REGISTER_CODE=88812345678900001
PORTOS_PRINTER_NAME=pos
PORTOS_TIMEOUT_MS=10000
```

Keep `PORTOS_ENABLED=false` until pilot fiscal UAT is intentionally started.

## Host Startup

Run the backend on the same Windows PC where Portos, CHDU, and the fiscal printer are installed.

```powershell
cd C:\Users\yevhe\Desktop\POS\server
npm install
npm run db:push
npm start
```

To verify readiness without touching the UI:

```powershell
cd C:\Users\yevhe\Desktop\POS\server
node scripts/portos-readiness.mjs
```

To prepare the temporary pilot items and fixed discount without exposing them in the live menu yet:

```powershell
cd C:\Users\yevhe\Desktop\POS\server
node scripts/portos-pilot-item.mjs ensure
node scripts/portos-pilot-discount.mjs ensure
```

## Pilot UAT Procedure

Do not let an automated agent create a live fiscal sale without human approval. Real Portos receipt registration is a legally significant operation.

1. Verify `GET /api/integrations/portos/status` is green in the admin settings screen.
2. Confirm the legacy kitchen/bar printer path is acceptable for pilot day.
3. Switch `PORTOS_ENABLED=true` in `server/.env`.
4. Restart the backend.
5. Use cashier `Peter Novak`, manager observer `Admin`, and table `Stol 1`.
6. Run `node scripts/portos-pilot-item.mjs activate`.
7. Run one cash payment through the normal POS flow using `Portos VAT 19 Test`.
8. Run one card payment through the normal POS flow using `Portos VAT 19 Test`.
9. Run `node scripts/portos-pilot-discount.mjs activate` before the mixed-VAT scenario.
10. Run one mixed-VAT payment with `Portos VAT 19 Test`, `Portos VAT 5 Test`, and the fixed discount `Portos Pilot Fixed 0.30`.
11. Run `POST /api/payments/:id/receipt-copy` for one completed pilot payment.
12. Run `node scripts/portos-pilot-discount.mjs deactivate` immediately after the mixed-VAT scenario.
13. Run `node scripts/portos-pilot-item.mjs deactivate` immediately after the mixed-VAT scenario.
14. Fill in `server/PORTOS_PILOT_LOG.md`.
15. Only after cash, card, mixed VAT, and receipt copy pass should Portos stay enabled for wider use.

For each successful payment, verify:

- POS shows a fiscal success state
- the customer receipt comes from Portos
- the order closes
- the payment row exists
- `GET /api/payments/:id/fiscal` returns the saved fiscal metadata

## Cashier Rules During Pilot

- `success`: payment is complete.
- `offline_accepted`: payment is complete, but accounting must know the receipt was accepted offline.
- `blocked`: do not retry blindly; call a manager.
- `ambiguous`: do not send a second payment; manager must inspect the fiscal record and use receipt lookup or copy flow.

## Known Blockers And Caveats

- The legacy printer health check on `2026-04-02` still reported printer `main` at `192.168.0.106:9100` as unreachable. This does not block Portos fiscal readiness, but it does block a clean sign-off for non-fiscal kitchen/bar printing until verified separately.
- A first live UAT payment with `Espresso` at `20.00%` was rejected by Portos on `2026-04-02` with validation code `-900`: `Sadzba DPH 20,00% nie je platná pre doklad s dátumom vyhotovenia 2. 4. 2026`. The pilot now uses dedicated temporary items at `19.00%` and `5.00%` instead of changing production menu items blindly.
- The Portos integration itself is now pilot-verified, but the production menu still needs a VAT audit and remap before broader rollout. Leaving live catalog items at stale rates such as `20.00%` will cause fiscal validation failures.
- Live fiscal receipt UAT was intentionally not auto-executed by the agent because it would create a real fiscal document.

## Rollback

If Portos blocks pilot payments or the cashier flow becomes unstable:

1. Set `PORTOS_ENABLED=false` in `server/.env`.
2. Restart the backend.
3. Verify:
  - `GET /api/health` responds
  - `GET /api/integrations/portos/status` still responds
  - `enabled` is now `false`
4. Continue payments on the legacy non-Portos path while the issue is investigated.

## Sign-Off Checklist

- Portos diagnostics route is green.
- CHDU and fiscal printer are ready.
- Cash register code and certificate match the workstation.
- Cash pilot payment passes.
- Card pilot payment passes.
- Receipt copy passes.
- `payments` and `fiscal_documents` data match the real receipt.
- Legacy kitchen/bar printing is either verified or explicitly accepted as a separate blocker.
- Mixed-VAT UAT is completed before final accounting sign-off.

