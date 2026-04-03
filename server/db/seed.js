import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql as rawSql } from 'drizzle-orm';
import * as schema from './schema.js';
import bcrypt from 'bcryptjs';
import { inferVatRateForMenuItem } from '../lib/menu-vat.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool, { schema });

async function seed() {
  console.log('Seeding database...');

  // Clear existing data (order matters for FK constraints)
  await db.execute(rawSql`DELETE FROM payments`);
  await db.execute(rawSql`DELETE FROM order_items`);
  await db.execute(rawSql`DELETE FROM orders`);
  await db.execute(rawSql`DELETE FROM menu_items`);
  await db.execute(rawSql`DELETE FROM menu_categories`);
  await db.execute(rawSql`DELETE FROM tables`);
  await db.execute(rawSql`DELETE FROM staff`);

  // Staff
  const staffData = [
    { name: 'Jana Kovacova', pin: await bcrypt.hash('1234', 10), role: 'manazer' },
    { name: 'Peter Novak', pin: await bcrypt.hash('5678', 10), role: 'cisnik' },
    { name: 'Maria Horvathova', pin: await bcrypt.hash('9012', 10), role: 'cisnik' },
    { name: 'Admin', pin: await bcrypt.hash('0000', 10), role: 'admin' },
  ];
  await db.insert(schema.staff).values(staffData);
  console.log('  Staff seeded');

  // Tables
  const tablesData = [
    { name: 'Stol 1', seats: 4, zone: 'interior', shape: 'rect', x: 40, y: 30 },
    { name: 'Stol 2', seats: 2, zone: 'interior', shape: 'round', x: 160, y: 30 },
    { name: 'Stol 3', seats: 6, zone: 'interior', shape: 'large', x: 280, y: 30 },
    { name: 'Stol 4', seats: 4, zone: 'interior', shape: 'rect', x: 430, y: 30 },
    { name: 'Stol 5', seats: 2, zone: 'interior', shape: 'round', x: 40, y: 140 },
    { name: 'Stol 6', seats: 4, zone: 'interior', shape: 'rect', x: 160, y: 140 },
    { name: 'Stol 7', seats: 8, zone: 'interior', shape: 'large', x: 280, y: 140 },
    { name: 'Stol 8', seats: 2, zone: 'interior', shape: 'round', x: 430, y: 140 },
    { name: 'Bar 1', seats: 1, zone: 'bar', shape: 'round', x: 560, y: 30 },
    { name: 'Bar 2', seats: 1, zone: 'bar', shape: 'round', x: 560, y: 130 },
    { name: 'Bar 3', seats: 1, zone: 'bar', shape: 'round', x: 660, y: 30 },
    { name: 'Bar 4', seats: 1, zone: 'bar', shape: 'round', x: 660, y: 130 },
    { name: 'Terasa 1', seats: 4, zone: 'terasa', shape: 'rect', x: 40, y: 280 },
    { name: 'Terasa 2', seats: 6, zone: 'terasa', shape: 'large', x: 160, y: 280 },
    { name: 'Terasa 3', seats: 4, zone: 'terasa', shape: 'rect', x: 310, y: 280 },
    { name: 'Terasa 4', seats: 2, zone: 'terasa', shape: 'round', x: 430, y: 280 },
  ];
  await db.insert(schema.tables).values(tablesData);
  console.log('  Tables seeded');

  // Menu categories
  const categories = [
    { slug: 'kava', label: 'Kava', icon: '\u2615', sortKey: '1', dest: 'bar' },
    { slug: 'caj', label: 'Caj', icon: '\uD83C\uDF75', sortKey: '2', dest: 'bar' },
    { slug: 'koktaily', label: 'Koktaily', icon: '\uD83C\uDF79', sortKey: '3', dest: 'bar' },
    { slug: 'pivo', label: 'Pivo', icon: '\uD83C\uDF7A', sortKey: '4', dest: 'bar' },
    { slug: 'vino', label: 'Vino', icon: '\uD83C\uDF77', sortKey: '5', dest: 'bar' },
    { slug: 'jedlo', label: 'Jedlo', icon: '\uD83C\uDF54', sortKey: '6', dest: 'kuchyna' },
  ];
  const insertedCats = await db.insert(schema.menuCategories).values(categories).returning();
  const catMap = {};
  const catSlugById = {};
  insertedCats.forEach(c => { catMap[c.slug] = c.id; });
  insertedCats.forEach(c => { catSlugById[c.id] = c.slug; });
  console.log('  Categories seeded');

  // Menu items
  const items = [
    // Kava
    { categoryId: catMap.kava, name: 'Espresso', emoji: '\u2615', price: '1.80', desc: 'Talianske klasicke' },
    { categoryId: catMap.kava, name: 'Dvojite espresso', emoji: '\u2615', price: '2.40', desc: 'Dvojita davka' },
    { categoryId: catMap.kava, name: 'Cappuccino', emoji: '\u2615', price: '2.90', desc: 'S penovou mliekom' },
    { categoryId: catMap.kava, name: 'Latte Macchiato', emoji: '\u2615', price: '3.20', desc: 'Vrstvene s mliekom' },
    { categoryId: catMap.kava, name: 'Flat White', emoji: '\u2615', price: '3.40', desc: 'Australsky styl' },
    { categoryId: catMap.kava, name: 'Americano', emoji: '\u2615', price: '2.20', desc: 'Espresso s vodou' },
    { categoryId: catMap.kava, name: 'Mocha', emoji: '\u2615', price: '3.50', desc: 'S cokoladou' },
    { categoryId: catMap.kava, name: 'Ristretto', emoji: '\u2615', price: '1.90', desc: 'Kratke talianske' },
    { categoryId: catMap.kava, name: 'Macchiato', emoji: '\u2615', price: '2.10', desc: 'Espresso s penou' },
    { categoryId: catMap.kava, name: 'Viedenska kava', emoji: '\u2615', price: '3.60', desc: 'So slahackou' },
    { categoryId: catMap.kava, name: 'Affogato', emoji: '\u2615', price: '3.80', desc: 'So zmrzlinou' },
    { categoryId: catMap.kava, name: 'Turecka kava', emoji: '\u2615', price: '2.50', desc: 'Tradicna priprava' },
    // Caj
    { categoryId: catMap.caj, name: 'Cierny caj', emoji: '\uD83C\uDF75', price: '2.00', desc: 'Earl Grey' },
    { categoryId: catMap.caj, name: 'Zeleny caj', emoji: '\uD83C\uDF75', price: '2.20', desc: 'Japonsky Sencha' },
    { categoryId: catMap.caj, name: 'Matcha Latte', emoji: '\uD83C\uDF75', price: '3.80', desc: 'Japonsky zeleny' },
    { categoryId: catMap.caj, name: 'Rooibos', emoji: '\uD83C\uDF75', price: '2.30', desc: 'Africky bez kofeinu' },
    { categoryId: catMap.caj, name: 'Mata', emoji: '\uD83C\uDF3F', price: '2.10', desc: 'Cerstva matova' },
    { categoryId: catMap.caj, name: 'Zazvorovy caj', emoji: '\uD83C\uDF75', price: '2.50', desc: 'S citronom a medom' },
    { categoryId: catMap.caj, name: 'Ovocny caj', emoji: '\uD83C\uDF75', price: '2.20', desc: 'Lesne ovocie' },
    { categoryId: catMap.caj, name: 'Chai Latte', emoji: '\uD83C\uDF75', price: '3.40', desc: 'Korenie s mliekom' },
    { categoryId: catMap.caj, name: 'Biely caj', emoji: '\uD83C\uDF75', price: '2.60', desc: 'Silver Needle' },
    { categoryId: catMap.caj, name: 'Harmancek', emoji: '\uD83C\uDF3C', price: '2.00', desc: 'Upokojujuci bylinny' },
    // Koktaily
    { categoryId: catMap.koktaily, name: 'Mojito', emoji: '\uD83C\uDF79', price: '6.90', desc: 'Rum, limetka, mata' },
    { categoryId: catMap.koktaily, name: 'Aperol Spritz', emoji: '\uD83C\uDF4A', price: '5.90', desc: 'Aperol, prosecco' },
    { categoryId: catMap.koktaily, name: 'Margarita', emoji: '\uD83C\uDF79', price: '7.20', desc: 'Tequila, limetka' },
    { categoryId: catMap.koktaily, name: 'Pina Colada', emoji: '\uD83C\uDF6D', price: '7.50', desc: 'Rum, kokos, ananas' },
    { categoryId: catMap.koktaily, name: 'Gin Tonic', emoji: '\uD83E\uDD43', price: '5.50', desc: 'Premium gin' },
    { categoryId: catMap.koktaily, name: 'Long Island', emoji: '\uD83C\uDF79', price: '8.50', desc: '5 liehovin, cola' },
    { categoryId: catMap.koktaily, name: 'Cosmopolitan', emoji: '\uD83C\uDF79', price: '7.00', desc: 'Vodka, brusnice' },
    { categoryId: catMap.koktaily, name: 'Hugo', emoji: '\uD83C\uDF3F', price: '5.50', desc: 'Bazovy sirup' },
    { categoryId: catMap.koktaily, name: 'Negroni', emoji: '\uD83E\uDD43', price: '6.80', desc: 'Gin, campari, vermut' },
    { categoryId: catMap.koktaily, name: 'Moscow Mule', emoji: '\uD83E\uDD43', price: '6.50', desc: 'Vodka, zazvor' },
    { categoryId: catMap.koktaily, name: 'Espresso Martini', emoji: '\uD83C\uDF79', price: '7.50', desc: 'Vodka, espresso' },
    { categoryId: catMap.koktaily, name: 'Daiquiri', emoji: '\uD83C\uDF79', price: '6.90', desc: 'Rum, limetka' },
    // Pivo
    { categoryId: catMap.pivo, name: 'Pilsner Urquell', emoji: '\uD83C\uDF7A', price: '2.80', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Zlaty Bazant', emoji: '\uD83C\uDF7A', price: '2.20', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Saris', emoji: '\uD83C\uDF7A', price: '2.00', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Kozel 11\u00B0', emoji: '\uD83C\uDF7A', price: '2.40', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Staropramen', emoji: '\uD83C\uDF7A', price: '2.50', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Bernard 12\u00B0', emoji: '\uD83C\uDF7A', price: '3.20', desc: '0.5l flaskove' },
    { categoryId: catMap.pivo, name: 'Corgon', emoji: '\uD83C\uDF7A', price: '1.90', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Radler citron', emoji: '\uD83C\uDF4B', price: '2.60', desc: '0.5l flaskove' },
    { categoryId: catMap.pivo, name: 'Nealko pivo', emoji: '\uD83C\uDF7A', price: '2.30', desc: '0.5l flaskove' },
    { categoryId: catMap.pivo, name: 'Budvar', emoji: '\uD83C\uDF7A', price: '2.90', desc: '0.5l tocene' },
    { categoryId: catMap.pivo, name: 'Guinness', emoji: '\uD83C\uDF7A', price: '4.50', desc: '0.4l stout' },
    // Vino
    { categoryId: catMap.vino, name: 'Rizling vlassky', emoji: '\uD83C\uDF77', price: '3.80', desc: 'Biele suche 0.2l' },
    { categoryId: catMap.vino, name: 'Veltlinske zelene', emoji: '\uD83E\uDD42', price: '3.50', desc: 'Biele suche 0.2l' },
    { categoryId: catMap.vino, name: 'Frankovka modra', emoji: '\uD83C\uDF77', price: '4.20', desc: 'Cervene suche 0.2l' },
    { categoryId: catMap.vino, name: 'Cabernet Sauvignon', emoji: '\uD83C\uDF77', price: '4.50', desc: 'Cervene suche 0.2l' },
    { categoryId: catMap.vino, name: 'Chardonnay', emoji: '\uD83E\uDD42', price: '4.00', desc: 'Biele suche 0.2l' },
    { categoryId: catMap.vino, name: 'Muskat Moravsky', emoji: '\uD83E\uDD42', price: '3.70', desc: 'Polosladke 0.2l' },
    { categoryId: catMap.vino, name: 'Prosecco', emoji: '\uD83E\uDD42', price: '4.50', desc: 'Sumive 0.15l' },
    { categoryId: catMap.vino, name: 'Rose', emoji: '\uD83C\uDF39', price: '3.60', desc: 'Ruzove suche 0.2l' },
    { categoryId: catMap.vino, name: 'Tokajsky vyber', emoji: '\uD83C\uDF77', price: '5.90', desc: 'Sladke 0.1l' },
    // Jedlo
    { categoryId: catMap.jedlo, name: 'Club Sandwich', emoji: '\uD83E\uDD6A', price: '7.90', desc: 'Kura, slanina' },
    { categoryId: catMap.jedlo, name: 'Caesar salat', emoji: '\uD83E\uDD57', price: '8.50', desc: 'S kuratom' },
    { categoryId: catMap.jedlo, name: 'Bruschetta', emoji: '\uD83C\uDF45', price: '5.90', desc: 'Paradajky, bazalka' },
    { categoryId: catMap.jedlo, name: 'Burger klasik', emoji: '\uD83C\uDF54', price: '9.90', desc: 'Hovadzie 200g' },
    { categoryId: catMap.jedlo, name: 'Hranolky', emoji: '\uD83C\uDF5F', price: '3.90', desc: 'Domace' },
    { categoryId: catMap.jedlo, name: 'Nachos & salsa', emoji: '\uD83E\uDED4', price: '5.50', desc: 'Kukuricne s dipom' },
    { categoryId: catMap.jedlo, name: 'Grillovany syr', emoji: '\uD83E\uDDC0', price: '6.50', desc: 'Ostiepok' },
    { categoryId: catMap.jedlo, name: 'Cheesecake', emoji: '\uD83C\uDF70', price: '4.90', desc: 'New York styl' },
    { categoryId: catMap.jedlo, name: 'Tiramisu', emoji: '\uD83C\uDF70', price: '5.50', desc: 'Talianske' },
    { categoryId: catMap.jedlo, name: 'Quesadilla', emoji: '\uD83C\uDF2F', price: '6.90', desc: 'S kuracim' },
  ];
  await db.insert(schema.menuItems).values(items.map((item) => ({
    ...item,
    vatRate: String(inferVatRateForMenuItem({
      categorySlug: catSlugById[item.categoryId],
      name: item.name,
    }) ?? 23),
  })));
  console.log('  Menu items seeded');

  console.log('Done! Database seeded successfully.');
}

seed()
  .catch(console.error)
  .finally(() => pool.end());
