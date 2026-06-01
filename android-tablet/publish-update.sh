#!/usr/bin/env bash
# Publikuj novú verziu Android appky na kasu → tablety si ju samy stiahnu.
#
# Použitie:
#   ./publish-update.sh <APK_path> <versionCode> <versionName> "<notes>"
# Príklad:
#   ./publish-update.sh /c/at/app/build/outputs/apk/debug/app-debug.apk 3 "1.2" "Pridané zľavy"
#
# Predpoklad: versionCode v build.gradle.kts si pred buildom zdvihol na rovnaké
# číslo. Tablet pri štarte porovná tento versionCode s nainštalovaným a ak je
# vyšší, ponúkne aktualizáciu (UpdateGate → /api/app/latest + /api/app/download).
#
# Súbory idú na durable volume /backups/app (prežijú redeploy image).
set -euo pipefail

APK="${1:?APK path required}"
VC="${2:?versionCode required}"
VN="${3:?versionName required}"
NOTES="${4:-Nová verzia}"
HOST="${DEPLOY_HOST:-surfs@100.95.64.38}"

[ -f "$APK" ] || { echo "APK nenájdené: $APK"; exit 1; }

echo "{\"versionCode\":$VC,\"versionName\":\"$VN\",\"url\":\"api/app/download\",\"notes\":\"$NOTES\"}" > /tmp/ss-latest.json

echo "→ scp APK + manifest na $HOST"
scp "$APK" "$HOST:SurfSpiritPOS.apk"
scp /tmp/ss-latest.json "$HOST:latest.json"

echo "→ docker cp do /backups/app (durable volume)"
ssh "$HOST" 'docker exec pos-app-1 mkdir -p /backups/app && docker cp C:\Users\surfs\SurfSpiritPOS.apk pos-app-1:/backups/app/SurfSpiritPOS.apk && docker cp C:\Users\surfs\latest.json pos-app-1:/backups/app/latest.json'

echo "✓ Publikované v$VN (code $VC). Tablety to ponúknu pri ďalšom štarte."
