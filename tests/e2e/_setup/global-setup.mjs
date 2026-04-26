// Spins up an isolated test server on E2E_PORT against the pos_test DB.
// Truncates DB, seeds minimal menu + an admin staff (PIN 1234), then waits
// for /api/health before letting the tests run. Port + DB URL are written to
// process.env so global-teardown / tests share them.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3081;
const TEST_DB_URL = process.env.E2E_DATABASE_URL
  || process.env.TEST_DATABASE_URL
  || 'postgresql://pos:pos@localhost:5432/pos_test';

// Tables in dependency order (children first) for safe TRUNCATE CASCADE.
const TABLES = [
  'asset_depreciations', 'assets',
  'storno_basket',
  'shisha_sales',
  'write_off_items', 'write_offs',
  'inventory_audit_items', 'inventory_audits',
  'purchase_order_items', 'purchase_orders',
  'stock_movements', 'recipes',
  'ingredients', 'suppliers',
  'company_profiles',
  'fiscal_documents',
  'idempotency_keys', 'events',
  'order_events', 'payments',
  'order_items', 'orders',
  'printers', 'shifts', 'discounts',
  'menu_items', 'menu_categories',
  'tables', 'staff',
];

let serverProc = null;

async function waitForHealth(url, attempts = 60, intervalMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Server did not become healthy at ${url} within ${attempts * intervalMs} ms`);
}

async function dbExists(url) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function ensureDbAndSchema(url) {
  if (!(await dbExists(url))) {
    throw new Error(
      `Test database not reachable at ${url}.\n` +
      `Bring it up first:\n` +
      `  docker compose up -d db\n` +
      `  docker compose exec -T db psql -U pos -d postgres -c 'CREATE DATABASE pos_test;'\n` +
      `  cd server && DATABASE_URL=${url} npm run db:push`
    );
  }
  // Verify the schema is there — fail fast with the exact remediation step
  // instead of a confusing "relation menu_items does not exist" mid-test.
  const pool = new pg.Pool({ connectionString: url });
  try {
    const r = await pool.query(`SELECT to_regclass('menu_items') AS oid`);
    if (!r.rows[0].oid) {
      throw new Error(
        `pos_test schema not initialised. Run once:\n  cd server && DATABASE_URL=${url} npm run db:push`
      );
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

async function truncateAll(url) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    // Some tables may not exist (e.g. older deploys without storno_basket).
    // Use to_regclass to filter out missing ones.
    const present = [];
    for (const t of TABLES) {
      const r = await pool.query(`SELECT to_regclass($1) AS oid`, [t]);
      if (r.rows[0].oid) present.push(t);
    }
    if (present.length) {
      await pool.query(`TRUNCATE ${present.join(', ')} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

async function seedMinimal(url) {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  try {
    // Admin staff with PIN 1234
    const adminHash = await bcrypt.hash('1234', 10);
    const cisnikHash = await bcrypt.hash('5678', 10);
    await db.execute(sql`
      INSERT INTO staff (name, pin, role, active) VALUES
        ('Admin',    ${adminHash},  'admin', true),
        ('Cisnik 1', ${cisnikHash}, 'cisnik', true)
    `);
    // Tables
    await db.execute(sql`
      INSERT INTO tables (name, seats, zone, shape, x, y, status) VALUES
        ('Stol 1', 4, 'interior', 'rect',  60,  80, 'free'),
        ('Stol 2', 4, 'interior', 'rect', 240,  80, 'free'),
        ('Bar',    2, 'interior', 'round', 60, 240, 'free')
    `);
    // Menu category — bar
    await db.execute(sql`
      INSERT INTO menu_categories (slug, label, icon, sort_key, dest) VALUES
        ('napoje', 'Napoje', '🥤', 'B01', 'bar'),
        ('burgre', 'Burgre', '🍔', 'K01', 'kuchyna')
    `);
    // Ingredient for Pivo (recipe trackMode)
    await db.execute(sql`
      INSERT INTO ingredients (name, unit, current_qty, cost_per_unit)
      VALUES ('Pivo svetle 10 sud', 'l', 50, 1.5)
    `);
    // Items, IDs assigned in insertion order:
    //   1 = Pivo 0.5 l (recipe-tracked, no companion)
    //   2 = Cola 0,5 l (simple, companion → 3)
    //   3 = Záloha fľaša (no track, no companion)
    //   4 = Combo BBQ Smash (no track, name starts "Combo " → opens sauce modal)
    //   5 = Omáčka (combo) (0 €, used as combo annotation row)
    await db.execute(sql`
      INSERT INTO menu_items (category_id, name, emoji, price, vat_rate, track_mode, stock_qty) VALUES
        (1, 'Pivo 0.5 l',         '🍺', 2.50, 19, 'recipe', 0),
        (1, 'Cola 0,5 l',         '🥤', 2.50, 19, 'simple', 100),
        (1, 'Záloha fľaša',       '📦', 0.15, 19, 'none',   0),
        (2, 'Combo BBQ Smash',    '🍔', 13.00, 19, 'none',  0),
        (2, 'Omáčka (combo)',     '🥫', 0.00, 19, 'none',   0)
    `);
    // Recipe: Pivo (id=1) needs 0.5 L of ingredient 1
    await db.execute(sql`
      INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
      VALUES (1, 1, 0.5)
    `);
    // Companion: Cola (id=2) auto-adds Záloha (id=3)
    await db.execute(sql`UPDATE menu_items SET companion_menu_item_id = 3 WHERE id = 2`);
    // One bar printer pointing at localhost — sendOrQueue catches the failure
    // gracefully and queues; doesn't block tests.
    await db.execute(sql`
      INSERT INTO printers (name, dest, ip, port, active)
      VALUES ('TestBar', 'all', '127.0.0.1', 9999, true)
    `);
  } finally {
    await pool.end().catch(() => {});
  }
}

function startServer(url) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: url,
      JWT_SECRET: 'e2e-test-secret-do-not-use-in-prod',
      PORTOS_ENABLED: 'false',          // crucial — no fiscalization in tests
      CORS_ALLOW_LAN: 'true',
    };
    serverProc = spawn('node', ['server.js'], {
      cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    serverProc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (process.env.E2E_VERBOSE) process.stdout.write(`[server] ${s}`);
      if (!ready && /POS server running/i.test(s)) { ready = true; resolve(); }
    });
    serverProc.stderr.on('data', (chunk) => {
      if (process.env.E2E_VERBOSE) process.stderr.write(`[server] ${chunk}`);
    });
    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited early with code ${code}`));
    });
    setTimeout(() => { if (!ready) reject(new Error('Server start timeout')); }, 15_000);
  });
}

export default async function globalSetup() {
  console.log(`[e2e] DB:   ${TEST_DB_URL}`);
  console.log(`[e2e] PORT: ${PORT}`);
  await ensureDbAndSchema(TEST_DB_URL);
  await truncateAll(TEST_DB_URL);
  await seedMinimal(TEST_DB_URL);
  await startServer(TEST_DB_URL);
  await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
  console.log('[e2e] server ready, running tests');

  // Stash the proc on globalThis so teardown can kill it.
  globalThis.__E2E_SERVER_PROC__ = serverProc;
  // Expose the seeded admin's PIN/login for tests via env.
  process.env.E2E_ADMIN_PIN = '1234';
  process.env.E2E_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.E2E_DATABASE_URL = TEST_DB_URL;
}
