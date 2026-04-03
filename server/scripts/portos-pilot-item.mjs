import 'dotenv/config';
import pg from 'pg';

const PILOT_ITEMS = [
  {
    name: 'Portos VAT 19 Test',
    categorySlug: 'kava',
    price: '1.00',
    vatRate: '19.00',
    desc: 'Temporary Portos beverage pilot item',
    emoji: 'P19',
  },
  {
    name: 'Portos VAT 5 Test',
    categorySlug: 'jedlo',
    price: '1.00',
    vatRate: '5.00',
    desc: 'Temporary Portos food pilot item',
    emoji: 'P05',
  },
];

const LEGACY_ITEM_NAMES = [
  'Portos VAT 10 Test',
];

const command = process.argv[2] || 'status';

async function loadCategoryMap(pool) {
  const result = await pool.query(
    'select id, slug, label from menu_categories where slug = any($1::text[])',
    [PILOT_ITEMS.map((item) => item.categorySlug)],
  );

  return new Map(result.rows.map((row) => [row.slug, row]));
}

async function findManagedItems(pool) {
  const itemNames = [...PILOT_ITEMS.map((item) => item.name), ...LEGACY_ITEM_NAMES];
  const result = await pool.query(
    `select id, category_id, name, price, vat_rate, active
     from menu_items
     where name = any($1::text[])
     order by id`,
    [itemNames],
  );

  const rowsByName = new Map(result.rows.map((row) => [row.name, row]));
  return {
    managedItems: PILOT_ITEMS.map((item) => rowsByName.get(item.name) || null),
    legacyItems: LEGACY_ITEM_NAMES.map((name) => rowsByName.get(name) || null).filter(Boolean),
  };
}

async function upsertPilotItem(pool, item, categoryId) {
  const existingResult = await pool.query(
    'select id from menu_items where name = $1 limit 1',
    [item.name],
  );
  const existing = existingResult.rows[0] || null;

  if (existing) {
    await pool.query(
      `update menu_items
       set category_id = $2,
           price = $3,
           vat_rate = $4,
           active = $5,
           desc = $6,
           emoji = $7,
           track_mode = 'none',
           stock_qty = '0',
           min_stock_qty = '0'
       where id = $1`,
      [existing.id, categoryId, item.price, item.vatRate, false, item.desc, item.emoji],
    );
    return existing.id;
  }

  const inserted = await pool.query(
    `insert into menu_items
      (category_id, name, emoji, price, vat_rate, "desc", active, track_mode, stock_qty, min_stock_qty)
     values
      ($1, $2, $3, $4, $5, $6, $7, 'none', '0', '0')
     returning id`,
    [categoryId, item.name, item.emoji, item.price, item.vatRate, item.desc, false],
  );

  return inserted.rows[0].id;
}

async function setItemsActive(pool, itemNames, active) {
  if (!itemNames.length) return;

  await pool.query(
    'update menu_items set active = $2 where name = any($1::text[])',
    [itemNames, active],
  );
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const categoryMap = await loadCategoryMap(pool);
    for (const item of PILOT_ITEMS) {
      if (!categoryMap.has(item.categorySlug)) {
        throw new Error(`Category "${item.categorySlug}" not found`);
      }
    }

    if (command === 'ensure') {
      for (const item of PILOT_ITEMS) {
        const category = categoryMap.get(item.categorySlug);
        await upsertPilotItem(pool, item, category.id);
      }
      await setItemsActive(pool, LEGACY_ITEM_NAMES, false);
    } else if (command === 'activate') {
      await setItemsActive(pool, PILOT_ITEMS.map((item) => item.name), true);
      await setItemsActive(pool, LEGACY_ITEM_NAMES, false);
    } else if (command === 'deactivate') {
      await setItemsActive(pool, PILOT_ITEMS.map((item) => item.name), false);
      await setItemsActive(pool, LEGACY_ITEM_NAMES, false);
    } else if (command !== 'status') {
      throw new Error(`Unknown command: ${command}`);
    }

    const { managedItems, legacyItems } = await findManagedItems(pool);
    console.log(JSON.stringify({
      command,
      managedItems,
      legacyItems,
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
