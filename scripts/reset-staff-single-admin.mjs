/**
 * Odstráni všetkých zamestnancov a vytvorí jedného admin účtu.
 * Použitie (v kontajneri app na kase):
 *   docker exec -e NEW_STAFF_NAME=Yevhen -e NEW_STAFF_PIN=1855 -w /app/server pos-app-1 node /tmp/reset-staff.mjs
 */

import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const NAME = process.env.NEW_STAFF_NAME || 'Yevhen';
const PIN = process.env.NEW_STAFF_PIN || '1855';
const ROLE = process.env.NEW_STAFF_ROLE || 'admin';

if (!/^\d{4,8}$/.test(PIN)) {
  console.error(`PIN "${PIN}" musí byť 4–8 číslic.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // odstrániť závislosti, ktoré referencujú staff (shifts, order_events, stock_movements, audity, write-offs, assets, atď.)
    await client.query('DELETE FROM shifts');
    await client.query('DELETE FROM order_events');
    await client.query('DELETE FROM stock_movements');
    await client.query('DELETE FROM inventory_audits');
    await client.query('DELETE FROM write_offs');
    await client.query('DELETE FROM purchase_orders');
    await client.query('DELETE FROM staff');
    await client.query('ALTER SEQUENCE staff_id_seq RESTART WITH 1');
    const hash = await bcrypt.hash(PIN, 10);
    const { rows } = await client.query(
      'INSERT INTO staff (name, pin, role, active) VALUES ($1, $2, $3, true) RETURNING id, name, role, active',
      [NAME, hash, ROLE],
    );
    await client.query('COMMIT');
    console.log('Zamestnanec vytvoreny:', rows[0]);
    console.log(`Prihlasovacie PIN: ${PIN}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
