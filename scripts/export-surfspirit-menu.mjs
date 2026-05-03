#!/usr/bin/env node
/**
 * Export the live POS menu to the JSON format consumed by
 * surfspirit.sk's `api.php?action=all`. Run me locally:
 *
 *   node scripts/export-surfspirit-menu.mjs > surfspirit-menu.json
 *
 * Reads the menu via the kasa SSH tunnel (DEPLOY_HOST defaults to
 * `surfs@100.95.64.38`) so it always reflects what's actually being
 * sold today — no admin-side copy-paste.
 *
 * Filters / cleanups:
 *   - active=false items dropped
 *   - 'Záloha fľaša' and 'Omáčka (combo)' suppressed (POS-internal)
 *   - 'Capovane' legacy slug `cat_…` rewritten to a readable form
 *   - Diacritics-free slug fallback if a category lacks one
 */

import { execFileSync } from 'node:child_process';

const SSH_HOST = process.env.DEPLOY_HOST || 'surfs@100.95.64.38';

// Fold Slovak diacritics to ASCII for slug fallback (matches what the
// surfspirit.sk side uses as DOM ids / scroll anchors).
function slugify(label) {
  return String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const sql = `
  SELECT json_agg(c ORDER BY sort_key, id)::text FROM (
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
`;

function fetchRows() {
  // Single SSH hop → docker exec → psql -At returns the raw aggregate
  // as one text line. We strip stderr (containing the post-quantum SSH
  // warning) by routing only stdout back.
  const stdout = execFileSync('ssh', [
    '-o', 'ConnectTimeout=5',
    SSH_HOST,
    `docker exec pos-db-1 psql -U pos -d pos -At -c "${sql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(stdout.trim());
}

const SLUG_OVERRIDES = {
  cat_1776806631615: 'capovane',
};

const rows = fetchRows();
const out = {
  menu: rows.map((c, idx) => ({
    slug:  SLUG_OVERRIDES[c.slug] || c.slug || slugify(c.label),
    label: c.label,
    icon:  c.icon,
    sort:  String(c.sort_key ?? (idx + 1)),
    items: c.items || [],
  })).filter((c) => c.items.length > 0),
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
