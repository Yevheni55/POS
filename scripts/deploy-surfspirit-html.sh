#!/usr/bin/env sh
# Deploy webu → surfspirit.sk webhosting (Websupport) cez FTPS.
#
#   web/index.html           → /surfspirit.sk/web/index.html            (hlavná stránka)
#   web/objednat.html        → /surfspirit.sk/web/objednat.html         (objednávky s doručením)
#   web/objednavky-api.php   → /surfspirit.sk/web/objednavky-api.php    (PHP most cez Neon)
#
# Vyžaduje env vars (drž v server/.env, nie v repe):
#   SURFSPIRIT_FTP_HOST=ftp.websupport.sk
#   SURFSPIRIT_FTP_USER=<login z Webadminu>
#   SURFSPIRIT_FTP_PASS=<heslo>
#
# Cesta na hostingu je natvrdo: /surfspirit.sk/web/ (Websupport štruktúra pre tento účet).
# Tajomstvá (.secrets.ini) sa NEnahrávajú — žijú len na hostingu, viď web/.secrets.ini.example.
#
# Usage:
#   bash scripts/deploy-surfspirit-html.sh               # všetky tri súbory
#   bash scripts/deploy-surfspirit-html.sh objednat      # len objednat.html + objednavky-api.php
#   bash scripts/deploy-surfspirit-html.sh --backup      # stiahne aj zálohu index.html pred uploadom

set -e

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/server/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$REPO_ROOT/server/.env"; set +a
fi

if [ -z "$SURFSPIRIT_FTP_HOST" ] || [ -z "$SURFSPIRIT_FTP_USER" ] || [ -z "$SURFSPIRIT_FTP_PASS" ]; then
  echo "ERROR: chýbajú FTP credentials. Doplň do server/.env (SURFSPIRIT_FTP_HOST/USER/PASS)."
  exit 2
fi

BASE="ftp://$SURFSPIRIT_FTP_HOST/surfspirit.sk/web"
# FTPS (explicitné TLS). Pri pripojení cez IP certifikát nesedí na meno → -k;
# s hostom ftp.websupport.sk sa overuje naplno.
case "$SURFSPIRIT_FTP_HOST" in
  *[!0-9.]*) TLS="--ssl-reqd" ;;
  *)         TLS="--ssl-reqd -k" ;;
esac
# shellcheck disable=SC2086
ftp_put() { curl -sS --max-time 60 $TLS --user "$SURFSPIRIT_FTP_USER:$SURFSPIRIT_FTP_PASS" -T "$1" "$BASE/$2" -w "  $2: %{size_upload} B in %{time_total}s\n"; }
# shellcheck disable=SC2086
ftp_get() { curl -sS --max-time 60 $TLS --user "$SURFSPIRIT_FTP_USER:$SURFSPIRIT_FTP_PASS" "$BASE/$1" -o "$2"; }

MODE="${1:-all}"
FILES=""
case "$MODE" in
  objednat) FILES="objednat.html objednavky-api.php" ;;
  --backup|all) FILES="index.html objednat.html objednavky-api.php" ;;
  *) echo "Neznámy argument: $MODE"; exit 2 ;;
esac

if [ "$MODE" = "--backup" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BAK="$REPO_ROOT/web/_backup-$TS.html"
  echo "=== Backup live index.html → $BAK ==="
  ftp_get index.html "$BAK"
  echo "  ($(wc -c < "$BAK") B)"
fi

if command -v php >/dev/null 2>&1; then
  php -l "$REPO_ROOT/web/objednavky-api.php" >/dev/null || { echo "ERROR: objednavky-api.php má syntaktickú chybu"; exit 3; }
fi

echo "=== Upload → $BASE/ ==="
for f in $FILES; do
  [ -f "$REPO_ROOT/web/$f" ] || { echo "ERROR: web/$f neexistuje"; exit 3; }
  ftp_put "$REPO_ROOT/web/$f" "$f"
done

echo "=== Verify ==="
sleep 1
for f in $FILES; do
  case "$f" in
    index.html)          URL="https://surfspirit.sk/?v=$(date +%s)" ;;
    objednat.html)       URL="https://surfspirit.sk/objednat.html?v=$(date +%s)" ;;
    objednavky-api.php)  URL="https://surfspirit.sk/objednavky-api.php/online-orders/config" ;;
  esac
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$URL")
  echo "  $f → HTTP $CODE ($URL)"
done
echo "Hotovo. (Ctrl+Shift+R pre browser cache.)"
