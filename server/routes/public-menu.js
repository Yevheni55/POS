// Verejný read-only menu endpoint pre webku surfspirit.sk.
// Žiadne auth — vracia iba to, čo je aj tak verejné na samotnom webe.
// Ak budeš chcieť, aby surfspirit.sk ťahal priamo z POS-u namiesto
// statického surfspirit-menu.json, na webhostingu zmen api.php aby
// fetchoval `https://<verejná-url-POS>/api/public/menu`. Bez prístupu
// surfspirit.sk-u k tomuto endpointu (Cloudflare Tunnel, public IP,
// ngrok) sa stále musí ručne nahrať vyexportovaný JSON.
//
// CORS: povolené ľubovoľný origin (GET-only, žiadne credentials), aby
// browser na webke vedel niekedy fetchnúť priamo, ak by sa script
// menil na client-side kód.
import { Router } from 'express';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

const router = Router();

// 30s in-memory cache — zmeny v admin Menu sa prejavia max do 30 s.
// Webka má aj svoju vlastnú edge cache (Cache-Control header dolu),
// takže celkové oneskorenie je ~30 + 60 s.
let _cache = { etag: null, body: null, expiresAt: 0 };
const CACHE_TTL_MS = 30_000;

function _slugify(label) {
  return String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const _SLUG_OVERRIDES = {
  cat_1776806631615: 'capovane',
};

async function _buildMenu() {
  // Rovnaký JSON shape ako export-surfspirit-menu.mjs aby sa pri
  // prechode zo statického na live nemusel meniť client kód webky.
  const rows = await db.execute(sql`
    SELECT json_agg(c ORDER BY sort_key, id)::text AS body FROM (
      SELECT
        c.id,
        c.sort_key,
        c.slug,
        c.label,
        c.icon,
        json_agg(json_build_object(
          'name',  mi.name,
          'emoji', mi.emoji,
          'price', mi.price::text,
          'desc',  COALESCE(mi.desc, '')
        ) ORDER BY mi.name) FILTER (
          WHERE mi.id IS NOT NULL AND mi.active = true
            AND mi.name <> 'Záloha fľaša'
            AND mi.name <> 'Omáčka (combo)'
        ) AS items
      FROM menu_categories c
      LEFT JOIN menu_items mi ON mi.category_id = c.id
      GROUP BY c.id, c.sort_key, c.slug, c.label, c.icon
    ) c
  `);
  const cats = JSON.parse(rows.rows[0]?.body || '[]');
  return {
    menu: cats
      .map((c, idx) => ({
        slug:  _SLUG_OVERRIDES[c.slug] || c.slug || _slugify(c.label),
        label: c.label,
        icon:  c.icon,
        sort:  String(c.sort_key ?? (idx + 1)),
        items: c.items || [],
      }))
      .filter((c) => c.items.length > 0),
  };
}

router.get('/menu', async (req, res) => {
  try {
    const now = Date.now();
    if (_cache.body && _cache.expiresAt > now) {
      res.setHeader('ETag', _cache.etag);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-POS-Cache', 'HIT');
      if (req.headers['if-none-match'] === _cache.etag) {
        return res.status(304).end();
      }
      return res.type('application/json').send(_cache.body);
    }

    const data = await _buildMenu();
    const body = JSON.stringify(data);
    // Jednoduchý ETag = base64(length+hash-ish prefix). Stačí pre konditional
    // requesty; ak sa zmení čo i len jeden item, ETag sa zmení.
    let h = 0;
    for (let i = 0; i < body.length; i++) h = ((h << 5) - h + body.charCodeAt(i)) | 0;
    const etag = '"' + body.length.toString(36) + '-' + Math.abs(h).toString(36) + '"';

    _cache = { etag, body, expiresAt: now + CACHE_TTL_MS };

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-POS-Cache', 'MISS');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('application/json').send(body);
  } catch (e) {
    console.error('public-menu error:', e.message);
    res.status(500).json({ error: 'Menu sa nepodarilo nacitat' });
  }
});

export default router;
