/**
 * Automatické doplnenie receptov pre barové položky podľa názvov na sklade.
 *
 * Logika:
 *  - Z názvu položky menu vyčíta objem (napr. 0,3 l → 0.3 l).
 *  - Nájde najvhodnejší ingredient podľa zhody kľúčových slov (Urpiner 10/12, Radler, Nealko, Kofola, Prosecco, Sóda…).
 *  - qty_per_unit = odčítané množstvo na 1 predanú porciu v jednotke suroviny na sklade:
 *      * ak jednotka vyzerá ako litre (l, lit, liter) → priamo litre z porcie;
 *      * ak sud/keg/50l alebo jednotka ks/kus a v názve je 50l → litre / veľkosť suda (default 50).
 *
 * Použitie (z priečinka server, kde je .env s DATABASE_URL):
 *   node ../scripts/sync-bar-recipes.mjs --dry-run
 *   node ../scripts/sync-bar-recipes.mjs --apply
 *
 * Vo Dockeri na kase:
 *   docker compose exec -T -w /app/server app node ../scripts/sync-bar-recipes.mjs --apply
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../server');
const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
try {
  requireFromServer('dotenv').config({ path: path.join(serverRoot, '.env') });
} catch {
  /* Docker: DATABASE_URL už v prostredí */
}
const pg = requireFromServer('pg');

const DRY = !process.argv.includes('--apply');
const REPLACE = process.argv.includes('--replace');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/°/g, '')
    .replace(/,/g, '.');
}

/** @returns {number|null} litrov v jednej porcii */
function extractVolumeLiters(menuName) {
  const n = norm(menuName);
  const m = n.match(/(\d+\.?\d*)\s*l\b/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function inferKegLitersFromIngredientName(ingName) {
  const n = norm(ingName);
  const m = n.match(/(\d+)\s*l\b/);
  if (m) {
    const k = parseFloat(m[1]);
    if (k >= 20 && k <= 60) return k;
  }
  return 50;
}

function isLiterUnit(unit) {
  const u = norm(unit).replace(/\./g, '');
  return ['l', 'lit', 'liter', 'litre'].includes(u);
}

function looksLikeKegStock(ing) {
  const u = norm(ing.unit);
  const n = norm(ing.name);
  if (['ks', 'kus', 'kusov', 'sud', 'sudy', 'keg', 'sudov'].includes(u)) return true;
  if (/\b(sud|keg|sudy|50\s*l|50l)\b/.test(n)) return true;
  return false;
}

function qtyPerUnitForPour(volumeLiters, ing) {
  if (!volumeLiters) return null;
  if (isLiterUnit(ing.unit)) return volumeLiters;
  if (looksLikeKegStock(ing)) {
    const kegL = inferKegLitersFromIngredientName(ing.name);
    return volumeLiters / kegL;
  }
  return volumeLiters;
}

/** Kľúčové slová z názvu menu položky (priorita zhora nadol) */
function menuKeywords(menuName) {
  const n = norm(menuName);
  const keys = [];
  if (n.includes('prosecco')) keys.push('prosecco');
  else if (n.includes('kofola')) keys.push('kofola');
  else if (n.includes('soda') || n.includes('syfon') || n.includes('sifon')) {
    keys.push('soda', 'syfon', 'sifon', 'co2');
  } else if (n.includes('urpiner') && n.includes('radler')) {
    keys.push('urpiner', 'radler');
  } else if (n.includes('urpiner') && (n.includes('nealko') || n.includes('nepr'))) {
    keys.push('urpiner', 'nealko', 'nepr');
  } else if (n.includes('urpiner') && /\b10\b/.test(n)) {
    keys.push('urpiner', '10');
  } else if (n.includes('urpiner') && /\b12\b/.test(n)) {
    keys.push('urpiner', '12');
  } else if (n.includes('urpiner')) {
    keys.push('urpiner');
  }
  return [...new Set(keys)];
}

function scoreIngredient(menuName, ing) {
  const keys = menuKeywords(menuName);
  if (!keys.length) return 0;
  const inm = norm(ing.name);
  let score = 0;
  for (const k of keys) {
    if (inm.includes(k)) score += 2;
  }
  const n = norm(menuName);
  if (n.includes('10') && /\b12\b/.test(inm) && !inm.includes('10')) score -= 4;
  if (n.includes('12') && /\b10\b/.test(inm) && !inm.includes('12')) score -= 4;
  if ((n.includes('nealko') || n.includes('nepr')) && inm.includes('radler')) score -= 5;
  if (n.includes('radler') && inm.includes('nealko') && !inm.includes('radler')) score -= 5;
  return score;
}

const STOP_TOKENS = new Set([
  'l', 'lit', 'liter', 'tocene', 'tocene', 'flaskove', 'flaskova', 'porcia', 'porcie',
  'suche', 'biele', 'cervene', 'ruzove', 'ovocny', 'domace', 'klasicke',
]);

function tokens(s) {
  return norm(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_TOKENS.has(t));
}

/** Záloha: zhoda významných slov v názve menu a suroviny (napr. Zlaty Bazant). */
function pickByTokenOverlap(menuName, ingredients) {
  const mt = tokens(menuName);
  if (mt.length < 2) return null;
  const setM = new Set(mt);
  let best = null;
  let bestScore = 0;
  for (const ing of ingredients) {
    const it = tokens(ing.name);
    let s = 0;
    for (const t of it) {
      if (setM.has(t)) s += 2;
    }
    if (s > bestScore) {
      bestScore = s;
      best = ing;
    }
  }
  if (bestScore < 4) return null;
  return best;
}

function pickIngredient(menuName, ingredients, { allowWeak } = {}) {
  let best = null;
  let bestScore = 0;
  for (const ing of ingredients) {
    const s = scoreIngredient(menuName, ing);
    if (s > bestScore) {
      bestScore = s;
      best = ing;
    }
  }
  if (bestScore >= 2) return best;
  if (allowWeak) return pickByTokenOverlap(menuName, ingredients);
  return null;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Chýba DATABASE_URL (spusti z /app/server s .env).');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const { rows: ingredients } = await client.query(
      `SELECT id, name, unit FROM ingredients WHERE active = true ORDER BY id`,
    );
    const { rows: menuItems } = await client.query(
      `SELECT mi.id, mi.name, mi.active, mi.track_mode, mc.slug AS cat_slug
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.active = true
       ORDER BY mi.id`,
    );

    const { rows: existingRecipes } = await client.query(
      `SELECT menu_item_id, COUNT(*)::int AS c FROM recipes GROUP BY menu_item_id`,
    );
    const recipeCount = new Map(existingRecipes.map((r) => [r.menu_item_id, r.c]));

    const barish = new Set(['pivo', 'nealko', 'sekt', 'vino', 'koktaily']);

    console.log(DRY ? 'DRY-RUN (žiadne zápisy do DB). Pre zápis pridaj --apply' : 'ZÁPIS do DB (--apply)');
    if (REPLACE) console.log('Režim --replace: existujúce recepty pre cieľové položky sa prepíšu.');
    console.log(`Ingredientov: ${ingredients.length}, položiek menu: ${menuItems.length}\n`);

    let considered = 0;
    let skipped = 0;
    let planned = [];

    for (const mi of menuItems) {
      const vol = extractVolumeLiters(mi.name);
      const keys = menuKeywords(mi.name);
      if (!vol) {
        skipped++;
        continue;
      }
      const inBar = barish.has(mi.cat_slug);
      if (!keys.length && !inBar) continue;
      considered++;

      const ing = pickIngredient(mi.name, ingredients, {
        allowWeak: inBar || keys.length > 0,
      });
      if (!ing) {
        console.log(`[skip] #${mi.id} "${mi.name}" — nenašiel sa ingredient (kľúče: ${menuKeywords(mi.name).join(', ')})`);
        skipped++;
        continue;
      }

      const qpu = qtyPerUnitForPour(vol, ing);
      if (qpu == null || qpu <= 0) {
        skipped++;
        continue;
      }

      const has = recipeCount.get(mi.id) || 0;
      if (has > 0 && !REPLACE) {
        console.log(`[keep] #${mi.id} "${mi.name}" — už má recept (${has} riadkov), použite --replace na prepísanie`);
        skipped++;
        continue;
      }

      planned.push({ mi, ing, qpu, vol });
    }

    for (const p of planned) {
      const line = `[${p.mi.id}] "${p.mi.name}" → ingredient #${p.ing.id} "${p.ing.name}" (${p.ing.unit})  qty_per_unit=${p.qpu.toFixed(6)} (porcia ${p.vol} l)`;
      console.log(DRY ? `WOULD: ${line}` : `WRITE: ${line}`);
    }

    if (!DRY && planned.length) {
      await client.query('BEGIN');
      for (const p of planned) {
        if (REPLACE) {
          await client.query('DELETE FROM recipes WHERE menu_item_id = $1', [p.mi.id]);
        }
        await client.query(
          `INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
           VALUES ($1, $2, $3)`,
          [p.mi.id, p.ing.id, String(p.qpu)],
        );
        await client.query(
          `UPDATE menu_items SET track_mode = 'recipe' WHERE id = $1`,
          [p.mi.id],
        );
      }
      await client.query('COMMIT');
      console.log(`\nHotovo: zapísaných ${planned.length} receptov.`);
    } else if (DRY && planned.length) {
      console.log(`\nDry-run: pripravených ${planned.length} receptov. Spusti s --apply na zápis.`);
    } else {
      console.log('\nNič na zápis (skontroluj názvy surovín alebo použite --replace).');
    }

    console.log(`\nZhrnutie: zvážených s objemom v názve: ${considered}, preskočených: ${skipped}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
