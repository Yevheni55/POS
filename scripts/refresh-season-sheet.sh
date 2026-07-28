#!/usr/bin/env sh
# Manuálny refresh sezónneho P&L v Google Sheete (mimo denného 05:10 cronu).
# Spustí runSheetsExportOnce() priamo v kontajneri pos-app-1 na kase — rovnaká
# cesta ako POST /api/reports/sheets-export, len bez potreby JWT tokenu.
#
# Výstup:
#   RESULT {"ok":true,"rows":N,...}       → sheet prepísaný aktuálnymi číslami
#   RESULT {"skipped":true,"reason":...}  → SHEETS_EXPORT_URL nie je nastavené
#                                            (webhook ešte nie je zapojený)
#   ERR ...                                → webhook nedostupný / zlý token
#
# Usage: bash scripts/refresh-season-sheet.sh
#    alebo: DEPLOY_HOST=surfs@INA-IP bash scripts/refresh-season-sheet.sh

HOST="${DEPLOY_HOST:-surfs@100.95.64.38}"

ssh "$HOST" "docker exec -w /app/server pos-app-1 node -e \"import('./lib/sheets-export.js').then(m=>m.runSheetsExportOnce()).then(r=>console.log('RESULT '+JSON.stringify(r))).catch(e=>console.log('ERR '+(e&&e.message||e)))\""
