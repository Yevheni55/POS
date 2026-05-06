#!/usr/bin/env sh
# Vyexportuj POS menu a nahraj na surfspirit.sk webhosting.
#
# Vyžaduje env vars (ulož ich do server/.env alebo exportuj v shell):
#   SURFSPIRIT_FTP_HOST    napr. ftp.websupport.sk alebo sftp://surfspirit.sk
#   SURFSPIRIT_FTP_USER    FTP používateľ
#   SURFSPIRIT_FTP_PASS    FTP heslo
#   SURFSPIRIT_FTP_PATH    cesta na hostingu kam patrí súbor (napr. /web/surfspirit-menu.json)
#
# Voliteľne:
#   DEPLOY_HOST            kasa SSH host pre čítanie POS DB (default surfs@100.95.64.38)
#   SURFSPIRIT_FTP_PROTO   ftp / sftp / ftps (default ftp)
#
# Usage:
#   ./scripts/deploy-surfspirit-menu.sh
#
# Vyžaduje `lftp` na lokálnom stroji (apt install lftp / brew install lftp).
# Pri Windows použiť cez WSL alebo si script prepísať na curl-ftp variant.

set -e

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/surfspirit-menu.json"

# Načítaj env z server/.env ak nie sú v shelli
if [ -f "$REPO_ROOT/server/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$REPO_ROOT/server/.env"; set +a
fi

if [ -z "$SURFSPIRIT_FTP_HOST" ] || [ -z "$SURFSPIRIT_FTP_USER" ] || [ -z "$SURFSPIRIT_FTP_PASS" ] || [ -z "$SURFSPIRIT_FTP_PATH" ]; then
  echo "ERROR: chýbajú FTP credentials. Doplň do server/.env:"
  echo "  SURFSPIRIT_FTP_HOST=ftp.websupport.sk"
  echo "  SURFSPIRIT_FTP_USER=tvoj-user"
  echo "  SURFSPIRIT_FTP_PASS=tvoje-heslo"
  echo "  SURFSPIRIT_FTP_PATH=/web/surfspirit-menu.json"
  exit 2
fi

PROTO="${SURFSPIRIT_FTP_PROTO:-ftp}"

echo "=== Export menu z POS-u ==="
DEPLOY_HOST="${DEPLOY_HOST:-surfs@100.95.64.38}" \
  node "$REPO_ROOT/scripts/export-surfspirit-menu.mjs" > "$OUT"
SIZE=$(wc -c < "$OUT")
echo "OK — $OUT ($SIZE B)"

if ! command -v lftp >/dev/null 2>&1; then
  echo "ERROR: lftp not installed. apt install lftp / brew install lftp"
  exit 3
fi

echo "=== Upload na $PROTO://$SURFSPIRIT_FTP_HOST ==="
LOCAL_DIR="$(dirname "$OUT")"
REMOTE_DIR="$(dirname "$SURFSPIRIT_FTP_PATH")"
REMOTE_FILE="$(basename "$SURFSPIRIT_FTP_PATH")"

lftp -u "$SURFSPIRIT_FTP_USER","$SURFSPIRIT_FTP_PASS" "$PROTO://$SURFSPIRIT_FTP_HOST" <<EOF
set ssl:verify-certificate no
cd "$REMOTE_DIR"
put "$OUT" -o "$REMOTE_FILE"
bye
EOF

echo "=== Verify cez HTTP ==="
sleep 1
curl -sI "https://surfspirit.sk/${REMOTE_FILE}" | head -5 || true
echo ""
echo "Skontroluj live: https://surfspirit.sk/api.php?action=all"
echo "Hotovo."
