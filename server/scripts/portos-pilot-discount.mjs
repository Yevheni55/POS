import 'dotenv/config';
import pg from 'pg';

const PILOT_DISCOUNT = {
  name: 'Portos Pilot Fixed 0.30',
  type: 'fixed',
  value: '0.30',
};

const command = process.argv[2] || 'status';

async function loadDiscount(pool) {
  const result = await pool.query(
    'select id, name, type, value, active from discounts where name = $1 limit 1',
    [PILOT_DISCOUNT.name],
  );
  return result.rows[0] || null;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (command === 'ensure') {
      const existing = await loadDiscount(pool);
      if (existing) {
        await pool.query(
          'update discounts set type = $2, value = $3, active = $4 where id = $1',
          [existing.id, PILOT_DISCOUNT.type, PILOT_DISCOUNT.value, false],
        );
      } else {
        await pool.query(
          'insert into discounts (name, type, value, active) values ($1, $2, $3, $4)',
          [PILOT_DISCOUNT.name, PILOT_DISCOUNT.type, PILOT_DISCOUNT.value, false],
        );
      }
    } else if (command === 'activate') {
      await pool.query(
        'update discounts set active = true where name = $1',
        [PILOT_DISCOUNT.name],
      );
    } else if (command === 'deactivate') {
      await pool.query(
        'update discounts set active = false where name = $1',
        [PILOT_DISCOUNT.name],
      );
    } else if (command !== 'status') {
      throw new Error(`Unknown command: ${command}`);
    }

    const discount = await loadDiscount(pool);
    console.log(JSON.stringify({
      command,
      discount,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    command,
  }, null, 2));
  process.exit(1);
});
