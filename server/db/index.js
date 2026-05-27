import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

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
