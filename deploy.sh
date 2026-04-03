#!/bin/sh
# Push to production: bundle → scp → import → trigger deploy
# Usage: ./push-deploy.sh

set -e

REMOTE_HOST="surfspirit@192.168.0.104"
BUNDLE="/tmp/pos-deploy.bundle"
BARE_REPO="C:/POS-bare"

echo "=== Bundling main branch ==="
git bundle create "$BUNDLE" main

echo "=== Uploading to $REMOTE_HOST ==="
scp "$BUNDLE" "$REMOTE_HOST:$BARE_REPO/pos.bundle"

echo "=== Importing on server ==="
ssh "$REMOTE_HOST" "cd C:\POS-bare && git fetch pos.bundle main:main --force && del pos.bundle && git --work-tree=C:\POS --git-dir=C:\POS-bare checkout -f main"

echo "=== Rebuilding containers ==="
ssh "$REMOTE_HOST" "cd C:\POS && docker compose up -d --build app"

echo "=== Deploy complete ==="
rm -f "$BUNDLE"
