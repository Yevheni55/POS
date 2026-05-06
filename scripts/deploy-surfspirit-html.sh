#!/usr/bin/env sh
# Deploy web/index.html → surfspirit.sk webhosting (Websupport).
#
# Vyžaduje env vars (drž v server/.env, nie v repe):
#   SURFSPIRIT_FTP_HOST=37.9.175.197
#   SURFSPIRIT_FTP_USER=kkkss.surfspirit.sk
#   SURFSPIRIT_FTP_PASS=...heslo...
#
# Cesta na hostingu je natvrdo: /surfspirit.sk/web/index.html
# (Websupport štandardná štruktúra pre tento účet).
#
# Usage:
#   bash scripts/deploy-surfspirit-html.sh
#   bash scripts/deploy-surfspirit-html.sh --backup   # stiahne aj zálohu pred upload

set -e

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/web/index.html"

if [ -f "$REPO_ROOT/server/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$REPO_ROOT/server/.env"; set +a
fi

if [ -z "$SURFSPIRIT_FTP_HOST" ] || [ -z "$SURFSPIRIT_FTP_USER" ] || [ -z "$SURFSPIRIT_FTP_PASS" ]; then
  echo "ERROR: chýbajú FTP credentials. Doplň do server/.env."
  exit 2
fi

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC neexistuje"
  exit 3
fi

if [ "$1" = "--backup" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BAK="$REPO_ROOT/web/_backup-$TS.html"
  echo "=== Backup actual live → $BAK ==="
  curl -sS --user "$SURFSPIRIT_FTP_USER:$SURFSPIRIT_FTP_PASS" \
    "ftp://$SURFSPIRIT_FTP_HOST/surfspirit.sk/web/index.html" \
    -o "$BAK"
  echo "  ($(wc -c < "$BAK") B)"
fi

echo "=== Upload web/index.html → ftp://$SURFSPIRIT_FTP_HOST/surfspirit.sk/web/index.html ==="
curl -sS --user "$SURFSPIRIT_FTP_USER:$SURFSPIRIT_FTP_PASS" \
  -T "$SRC" \
  "ftp://$SURFSPIRIT_FTP_HOST/surfspirit.sk/web/index.html" \
  -w "  HTTP %{http_code}, %{size_upload} B in %{time_total}s\n"

echo "=== Verify ==="
sleep 1
TITLE=$(curl -s "https://surfspirit.sk?v=$(date +%s)" | grep -oE '<title>[^<]+</title>' | head -1)
echo "  Live: $TITLE"
echo "Hotovo. Otvor https://surfspirit.sk (Ctrl+Shift+R pre browser cache)."
