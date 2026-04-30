# Playwright E2E

End-to-end browser tests against a real local server + real Postgres, with
**`PORTOS_ENABLED=false`** so nothing ever touches the kasa's fiscalisation.

## Prereqs (one-time)

```bash
# 1. Postgres locally
docker compose up -d db
docker compose exec -T db psql -U pos -d postgres -c 'CREATE DATABASE pos_test;'

# 2. Schema in pos_test (runs once + after schema migrations)
cd server
DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test npm install
DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test npm run db:push

# 3. Playwright + browser
cd ..
npm install
npm run e2e:install   # downloads chromium
```

## Run

```bash
npm run e2e            # headless
npm run e2e:headed     # see the browser
npm run e2e:ui         # Playwright Inspector
E2E_VERBOSE=1 npm run e2e   # stream the test server's stdout/stderr
```

Each run:
1. Truncates pos_test (admin staff PIN 1234, 1 table, 2 menu items reseeded)
2. Boots `node server.js` on port **3081** (override with `E2E_PORT`)
3. Waits for `/api/health`, runs the specs, then SIGTERMs the server

## Adding tests

Specs live next to this README, named `*.spec.mjs`. Use the helpers:

```js
import { loginAndOpenPos, openTable, clickProduct } from './_setup/helpers.mjs';

test('my flow', async ({ page }) => {
  await loginAndOpenPos(page);
  await openTable(page, 'Stol 1');
  await clickProduct(page, 'Cola 0,5 l');
  // …
});
```

## Why not run on the kasa

The kasa runs Portos against eKasa SK. Every successful `/api/payments` call
creates a real fiscal document. Tests would fill the audit log with garbage
and waste real receipt numbers. Local server with `PORTOS_ENABLED=false`
returns `fiscal.status: disabled` and skips Portos entirely.
