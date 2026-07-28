import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

// PROD-SAFETY: `import 'dotenv/config'` vyššie doplní DATABASE_URL zo
// server/.env — a ten na dev stroji ukazuje na ŽIVÚ databázu kasy. Test
// spustený len s TEST_DATABASE_URL by teda ticho čítal (a mohol prepísať)
// reálne objednávky a fiškálne doklady. Preto pri test behu (`node --test`
// nastavuje NODE_TEST_CONTEXT, prípadne NODE_ENV=test) odmietneme pripojiť
// sa na databázu, ktorej meno nie je zjavne testovacie. Radšej hlasný pád
// s návodom než tichý zásah do ostrých dát.
const IS_TEST_RUN = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

function databaseNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    const match = /\/([^/?#]+)(?:[?#]|$)/.exec(String(url));
    return match ? match[1] : '';
  }
}

function assertTestDatabaseUrl(url) {
  const hint = 'Spusti `npm test`, alebo nastav OBE premenné na testovaciu DB:\n'
    + '  TEST_DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test \\\n'
    + '  DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test node --test ...';

  if (!url) {
    throw new Error('[DB] Test beh bez DATABASE_URL — odmietam pripojenie.\n' + hint);
  }

  const name = databaseNameFromUrl(url);
  // Akceptujeme "test", "pos_test", "pos_test_w3" — teda meno, kde je "test"
  // samostatné slovo. "pos" (ostrá/dev DB) neprejde.
  if (!/(^|[_.-])test([_.-]|$)/i.test(name)) {
    throw new Error(
      `[DB] Test beh mieri na NETESTOVACIU databázu "${name}" — odmietam pripojenie.\n` + hint,
    );
  }
}

if (IS_TEST_RUN) assertTestDatabaseUrl(process.env.DATABASE_URL);

// Pool tuning pre POS workload — 2-3 cashier + 1 admin browse paralelne.
// Predtym sme mali defaults (max=10, ziadne timeouts) co znamenalo:
//   - runaway query mohla drzat connection forever (žiadny statement_timeout)
//   - connections sa nikdy nezatvarali (žiadny idleTimeoutMillis)
//   - zlyhane idle connections (TCP keepalive expiry) zostavali "zombie"
// Tieto values su konservativne pre Bratislava POS.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                          // 10 default je tesne pre /reports + paralelny send
  idleTimeoutMillis: 30_000,        // 30s idle → close (free up DB-side resources)
  connectionTimeoutMillis: 5_000,   // 5s na získanie connectionu z poolu (vs default 0=∞)
  // Statement timeout 8s — žiadna single query by nemala trvať dlhšie. Ak ano,
  // niečo je zle (long lock, full table scan na velkej tabuľke). Kill it tak,
  // aby ostatne requesty dostali connection naspat.
  statement_timeout: 8_000,
  // Application name pre pg_stat_activity debug — vidno v admin nástrojoch
  // ktore connection patri tejto appne.
  application_name: 'surfspirit-pos',
});

// Suppress noisy ENOTFOUND/ECONNRESET error spam ak DB restart. Default pg
// pool emituje 'error' eventy a process crashne ak nemame handler.
pool.on('error', (err) => {
  console.error('[DB pool] idle client error:', err.message);
});

export const db = drizzle(pool, { schema });
