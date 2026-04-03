import 'dotenv/config';
import pg from 'pg';

import { inferVatRateForMenuItem } from '../lib/menu-vat.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { rows } = await pool.query(`
      select
        mi.id,
        mi.name,
        mc.slug as category_slug,
        mi.vat_rate as current_vat_rate,
        mi.active
      from menu_items mi
      join menu_categories mc on mc.id = mi.category_id
      order by mc.sort_key, mi.id
    `);

    const changes = rows
      .filter((row) => row.active)
      .map((row) => {
        const suggestedVatRate = inferVatRateForMenuItem({
          categorySlug: row.category_slug,
          name: row.name,
        });

        return {
          id: row.id,
          name: row.name,
          categorySlug: row.category_slug,
          currentVatRate: Number.parseFloat(row.current_vat_rate),
          suggestedVatRate,
        };
      })
      .filter((row) => row.suggestedVatRate !== null && row.currentVatRate !== row.suggestedVatRate);

    if (APPLY && changes.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const change of changes) {
          await client.query(
            'update menu_items set vat_rate = $2 where id = $1',
            [change.id, change.suggestedVatRate.toFixed(2)],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      applied: APPLY,
      changedCount: changes.length,
      changes,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    checkedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
