#!/usr/bin/env sh
# Deploy main branch files to Windows kasa cez Tailscale + SSH.
# Vyžaduje v ~/.ssh/config Host (napr. pos-kasa-tscale) s IdentityFile a User surfs.
#
# Na kase musí byť C:\POS (bez povinného POS-bare). Git na hostiteľovi nie je potrebný.
# Po nahratí sa spustí: tar -xzf && docker compose up -d --build app
#
# Ak Docker cez SSH spadne na „logon session does not exist“, spusti na kase lokálne (RDP):
#   cd C:\POS && docker compose up -d --build app
#
# Usage: ./scripts/deploy-tailscale-pos.sh
#    alebo: DEPLOY_HOST=moj-host ./scripts/deploy-tailscale-pos.sh

set -e

HOST="${DEPLOY_HOST:-pos-kasa-tscale}"
REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TGZ="/tmp/pos-deploy.tgz"

cd "$REPO_ROOT"
echo "=== Creating tarball (no .git, no node_modules, keep remote server/.env) ==="
rm -f "$TGZ"
tar -czf "$TGZ" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=server/node_modules \
  --exclude=server/.env \
  --exclude=uploads \
  --exclude='*.tgz' \
  .

echo "=== Upload to $HOST:C:/POS/_pos-update.tgz ==="
scp "$TGZ" "${HOST}:C:/POS/_pos-update.tgz"

echo "=== Extract + docker compose (may fail on Docker credential session over SSH) ==="
ssh "$HOST" "cd /d C:\POS && tar -xzf _pos-update.tgz && del _pos-update.tgz && docker compose up -d --build app" \
  || {
    echo ""
    echo "!!! Súbory na kase sú rozbalené. Ak Docker zlyhal, na kase (RDP) spusti:"
    echo "    cd C:\\POS && docker compose up -d --build app"
    exit 1
  }

rm -f "$TGZ"
echo "=== Deploy complete ==="
