import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

import * as schema from '../../db/schema.js';

// Use test database â€” override DATABASE_URL
const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL?.replace(/\/pos$/, '/pos_test');
if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL required');

const pool = new pg.Pool({ connectionString: TEST_DB_URL });
export const testDb = drizzle(pool, { schema });

// Table names in dependency order (children first for truncation)
const TABLES = [
  'asset_depreciations', 'assets',
  'write_off_items', 'write_offs',
  'inventory_audit_items', 'inventory_audits',
  'purchase_order_items', 'purchase_orders',
  'stock_movements', 'recipes',
  'ingredients', 'suppliers',
  'fiscal_documents',
  'idempotency_keys', 'events',
  'order_events', 'payments',
  'order_items', 'orders',
  'printers', 'shifts', 'discounts',
  'menu_items', 'menu_categories',
  'tables', 'staff',
];

/**
 * Truncate all tables with CASCADE. Use before each test suite.
 */
export async function truncateAll() {
  await testDb.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));
}

/**
 * Seed minimal test fixtures: staff, tables, menu, menu items.
 * Returns created entities for use in tests.
 */
export async function seed() {
  const pin1234 = await bcrypt.hash('1234', 10);
  const pin5678 = await bcrypt.hash('5678', 10);
  const pin9012 = await bcrypt.hash('9012', 10);

  // Staff
  const [cisnik] = await testDb.insert(schema.staff)
    .values({ name: 'Test Cisnik', pin: pin1234, role: 'cisnik' }).returning();
  const [manazer] = await testDb.insert(schema.staff)
    .values({ name: 'Test Manazer', pin: pin5678, role: 'manazer' }).returning();
  const [admin] = await testDb.insert(schema.staff)
    .values({ name: 'Test Admin', pin: pin9012, role: 'admin' }).returning();

  // Tables
  const [table1] = await testDb.insert(schema.tables)
    .values({ name: 'Stol 1', seats: 4, zone: 'interior' }).returning();
  const [table2] = await testDb.insert(schema.tables)
    .values({ name: 'Stol 2', seats: 2, zone: 'interior' }).returning();

  // Menu categories
  const [catFood] = await testDb.insert(schema.menuCategories)
    .values({ slug: 'jedlo', label: 'Jedlo', icon: 'food', sortKey: 'a', dest: 'kuchyna' }).returning();
  const [catDrink] = await testDb.insert(schema.menuCategories)
    .values({ slug: 'pivo', label: 'Pivo', icon: 'beer', sortKey: 'b', dest: 'bar' }).returning();

  // Menu items
  const [itemBurger] = await testDb.insert(schema.menuItems)
    .values({ categoryId: catFood.id, name: 'Burger', emoji: 'burger', price: '8.50', vatRate: '5.00', desc: 'Test burger' }).returning();
  const [itemPivo] = await testDb.insert(schema.menuItems)
    .values({ categoryId: catDrink.id, name: 'Pivo', emoji: 'beer', price: '2.50', vatRate: '23.00', desc: 'Test pivo' }).returning();
  const [itemTracked] = await testDb.insert(schema.menuItems)
    .values({
      categoryId: catDrink.id,
      name: 'Tracked Item',
      emoji: 'box',
      price: '5.00',
      vatRate: '23.00',
      desc: 'Stock-tracked',
      trackMode: 'simple',
      stockQty: '10',
      minStockQty: '2',
    }).returning();

  return { cisnik, manazer, admin, table1, table2, catFood, catDrink, itemBurger, itemPivo, itemTracked };
}

/**
 * Close the test database pool. Call in after() hook.
 * Idempotent â€” safe to call multiple times.
 */
let _closed = false;
export async function closeDb() {
  if (_closed) return;
  _closed = true;
  await pool.end();
}
