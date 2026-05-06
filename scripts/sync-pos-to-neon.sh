#!/usr/bin/env sh
# Sync POS menu → Neon Postgres (cloud DB ktorú číta surfspirit.sk webka).
#
# Webka surfspirit.sk používa Neon Postgres `guest_menu` tabuľku, nie
# statický súbor. POS má vlastnú lokálnu DB. Tieto dve sa neudržiavali
# v sync — preto webka držala apríl menu kým sa POS aktualizoval.
#
# Tento script urobí:
#   1) SELECT z POS-u (kasa) — denormalized POS menu_items + categories
#   2) TRUNCATE guest_menu na Neon
#   3) COPY FROM csv do guest_menu
#   4) Bust webhostingovú cache cez api.php?fresh=1
#
# Vyžaduje:
#   • SSH prístup na kasu (DEPLOY_HOST=surfs@100.95.64.38 default)
#   • NEON_URL env var alebo natvrdo zapísaný v scripte
#
# Bezpečnosť: Neon credentials sú citlivé — drž ich v server/.env
#   NEON_URL="postgresql://user:pass@host/db?sslmode=require"
# (server/.env je v .gitignore, takže do GitHubu sa nedostanú)
#
# Usage:
#   bash scripts/sync-pos-to-neon.sh
#   DEPLOY_HOST=surfs@100.95.64.38 bash scripts/sync-pos-to-neon.sh

set -e

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-surfs@100.95.64.38}"

# Načítaj env z server/.env ak nie je v shelli
if [ -z "$NEON_URL" ] && [ -f "$REPO_ROOT/server/.env" ]; then
  NEON_URL=$(grep -E '^NEON_URL=' "$REPO_ROOT/server/.env" | sed 's/^NEON_URL=//; s/^"//; s/"$//')
fi

if [ -z "$NEON_URL" ]; then
  echo "ERROR: NEON_URL chýba. Nastav v server/.env:"
  echo "  NEON_URL=\"postgresql://neondb_owner:HESLO@ep-xxx.neon.tech:5432/neondb?sslmode=require\""
  exit 2
fi

echo "=== 1. POS → CSV dump (kasa) ==="
ssh "$HOST" "docker exec pos-db-1 psql -U pos -d pos -c \"COPY (SELECT CASE WHEN c.slug = 'cat_1776806631615' THEN 'capovane' ELSE c.slug END AS category_slug, c.label AS category_label, c.icon AS category_icon, c.sort_key AS category_sort, mi.name AS item_name, mi.emoji AS item_emoji, mi.price AS item_price, mi.desc AS item_desc, true AS active FROM menu_items mi JOIN menu_categories c ON c.id = mi.category_id WHERE mi.active = true AND mi.name NOT IN ('Záloha fľaša', 'Omáčka (combo)') AND c.slug != 'cisla' ORDER BY c.sort_key, mi.name) TO STDOUT WITH (FORMAT csv)\" > tmp\\pos-menu.csv"
ssh "$HOST" "docker cp tmp\\pos-menu.csv pos-app-1:/tmp/pos-menu.csv"

echo "=== 2. TRUNCATE + COPY do Neon ==="
ssh "$HOST" "docker exec pos-app-1 psql \"$NEON_URL\" -c \"TRUNCATE guest_menu RESTART IDENTITY;\""
ssh "$HOST" "docker exec -i pos-app-1 psql \"$NEON_URL\" -c \"\\copy guest_menu (category_slug, category_label, category_icon, category_sort, item_name, item_emoji, item_price, item_desc, active) FROM '/tmp/pos-menu.csv' WITH (FORMAT csv)\""

echo "=== 3. Verify Neon ==="
ssh "$HOST" "docker exec pos-app-1 psql \"$NEON_URL\" -c \"SELECT COUNT(*) AS items_synced FROM guest_menu;\""

echo "=== 4. Bust webhosting cache (api.php?fresh=1) ==="
curl -sI "https://surfspirit.sk/api.php?action=all&fresh=1" -o /dev/null -w "HTTP %{http_code} (cache flushed)\n"

echo ""
echo "✓ Hotovo. surfspirit.sk teraz drží aktuálne menu."
