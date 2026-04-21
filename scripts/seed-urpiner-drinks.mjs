import 'dotenv/config';
import pg from 'pg';

/**
 * Pridá položky z obrázka "ČAPUJEME":
 *  - Urpiner 10°, 12°, Nealko, Radler (0,3 l + 0,5 l)
 *  - Kofola (0,3 l + 0,5 l)
 *  - Sóda, Prosecco
 * Zabezpečí kategórie Pivo / Nealko / Sekt.
 */

const CATS = [
  { slug: 'pivo', label: 'Pivo', icon: '\uD83C\uDF7A', sortKey: '10', dest: 'bar' },
  { slug: 'nealko', label: 'Nealko', icon: '\uD83E\uDD64', sortKey: '20', dest: 'bar' },
  { slug: 'sekt', label: 'Sekt / Šumivé', icon: '\uD83C\uDF7E', sortKey: '30', dest: 'bar' },
];

/** cat slug, name, emoji, price €, vat %, desc */
const ITEMS = [
  ['pivo',   'Urpiner 10° 0,3 l',    '\uD83C\uDF7A', 1.80, 23, '0,3 l točené'],
  ['pivo',   'Urpiner 10° 0,5 l',    '\uD83C\uDF7A', 2.70, 23, '0,5 l točené'],
  ['pivo',   'Urpiner 12° 0,3 l',    '\uD83C\uDF7A', 1.90, 23, '0,3 l točené'],
  ['pivo',   'Urpiner 12° 0,5 l',    '\uD83C\uDF7A', 2.90, 23, '0,5 l točené'],
  ['pivo',   'Urpiner Nealko 0,3 l', '\uD83C\uDF7A', 1.90, 19, '0,3 l nealko'],
  ['pivo',   'Urpiner Nealko 0,5 l', '\uD83C\uDF7A', 2.90, 19, '0,5 l nealko'],
  ['pivo',   'Urpiner Radler 0,3 l', '\uD83C\uDF4B', 1.90, 23, '0,3 l ovocný radler'],
  ['pivo',   'Urpiner Radler 0,5 l', '\uD83C\uDF4B', 2.90, 23, '0,5 l ovocný radler'],
  ['nealko', 'Kofola 0,3 l',         '\uD83E\uDD64', 1.90, 19, '0,3 l točená'],
  ['nealko', 'Kofola 0,5 l',         '\uD83E\uDD64', 2.50, 19, '0,5 l točená'],
  ['nealko', 'Sóda 0,1 l',           '\uD83E\uDDCB', 0.40, 19, '0,1 l sifón'],
  ['sekt',   'Prosecco 0,1 l',       '\uD83C\uDF7E', 2.50, 23, '0,1 l Prosecco'],
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catIdBySlug = {};
    for (const c of CATS) {
      const found = await client.query('SELECT id FROM menu_categories WHERE slug = $1', [c.slug]);
      if (found.rows.length) {
        catIdBySlug[c.slug] = found.rows[0].id;
        await client.query(
          'UPDATE menu_categories SET label=$2, icon=$3, dest=$4 WHERE id=$1',
          [found.rows[0].id, c.label, c.icon, c.dest],
        );
      } else {
        const ins = await client.query(
          'INSERT INTO menu_categories (slug, label, icon, sort_key, dest) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [c.slug, c.label, c.icon, c.sortKey, c.dest],
        );
        catIdBySlug[c.slug] = ins.rows[0].id;
      }
    }

    let created = 0;
    let updated = 0;
    for (const [slug, name, emoji, price, vat, desc] of ITEMS) {
      const catId = catIdBySlug[slug];
      if (!catId) throw new Error(`Kategória ${slug} nebola vytvorená`);

      const existing = await client.query(
        'SELECT id FROM menu_items WHERE category_id=$1 AND name=$2 LIMIT 1',
        [catId, name],
      );
      if (existing.rows.length) {
        await client.query(
          'UPDATE menu_items SET emoji=$2, price=$3, vat_rate=$4, "desc"=$5, active=true WHERE id=$1',
          [existing.rows[0].id, emoji, String(price), String(vat), desc],
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO menu_items (category_id, name, emoji, price, vat_rate, "desc", active, track_mode, stock_qty, min_stock_qty)
           VALUES ($1,$2,$3,$4,$5,$6,true,'none','0','0')`,
          [catId, name, emoji, String(price), String(vat), desc],
        );
        created++;
      }
    }

    await client.query('COMMIT');

    const [menuCats, menuItemsRes] = await Promise.all([
      client.query('SELECT id, slug, label FROM menu_categories ORDER BY sort_key'),
      client.query('SELECT id, name, price FROM menu_items WHERE category_id IN (SELECT id FROM menu_categories WHERE slug IN ($1,$2,$3)) ORDER BY category_id, id', ['pivo', 'nealko', 'sekt']),
    ]);
    console.log('Kategorie:', menuCats.rows);
    console.log('\nVytvorene:', created, 'Aktualizovane:', updated);
    console.log('\nVsetky polozky v Pivo/Nealko/Sekt:', menuItemsRes.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
