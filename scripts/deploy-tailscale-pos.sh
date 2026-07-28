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
#
# Núdzové vypínače (vypisujú varovanie, používaj vedome):
#   DEPLOY_SKIP_TESTS=1   preskočí `npm test` (syntax check beží vždy)
#   DEPLOY_ALLOW_DIRTY=1  dovolí deploy s nescommitovanými zmenami
#
# ČO SA ZMENILO A PREČO:
# Skript predtým balil PRACOVNÝ ADRESÁR (`tar -czf ... .`). Na kase preto bežal
# kód, ktorý nebol v žiadnom commite — `server/routes/payments.js` importoval
# `lib/payments/qr.js`, ktorý bol untracked, takže čerstvý `git clone` repa sa
# ani nenaštartoval. Teraz sa balí `git archive HEAD`: nasadí sa presne to, čo
# je v gite, a súbor `DEPLOYED_SHA` v balíčku povie, ktorý commit to bol.

set -e

HOST="${DEPLOY_HOST:-pos-kasa-tscale}"
REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TGZ="/tmp/pos-deploy.tgz"
STAGE="/tmp/pos-deploy-stage"

cd "$REPO_ROOT"

# --- Brána 1: pracovný strom musí byť čistý -------------------------------
echo "=== Gate 1/3: git working tree ==="
if [ "${DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
  echo "!!! DEPLOY_ALLOW_DIRTY=1 — kontrola preskočená. Na kasu ide kód z HEAD,"
  echo "!!! NIE tvoje lokálne zmeny."
else
  DIRTY=0
  git diff --quiet || DIRTY=1
  git diff --cached --quiet || DIRTY=1
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then DIRTY=1; fi
  if [ "$DIRTY" = "1" ]; then
    echo "CHYBA: pracovný strom nie je čistý — 'git archive HEAD' by tieto zmeny nenasadil."
    echo ""
    git status --short
    echo ""
    echo "Scommituj ich (alebo DEPLOY_ALLOW_DIRTY=1, ak naozaj chceš nasadiť iba HEAD)."
    exit 1
  fi
fi

# --- Brána 2: syntax check -------------------------------------------------
# POS načítava js/*.js ako klasické skripty. Syntaktická chyba v jednom súbore
# ticho zabije všetky jeho globálne funkcie — čašník klikne a nestane sa nič,
# bez jedinej hlášky v UI. `node --check` to chytí za sekundu.
echo "=== Gate 2/3: node --check ==="
SYNTAX_FAIL=0
for f in js/*.js api.js sw.js components/*.js admin/*.js admin/pages/*.js admin/components/*.js \
         server/*.js server/routes/*.js server/lib/*.js server/lib/*/*.js server/middleware/*.js \
         server/schemas/*.js server/db/*.js; do
  [ -f "$f" ] || continue
  node --check "$f" || { echo "  ^^^ syntax error: $f"; SYNTAX_FAIL=1; }
done
if [ "$SYNTAX_FAIL" = "1" ]; then
  echo "CHYBA: syntax check zlyhal — nenasadzujem."
  exit 1
fi
echo "  OK"

# --- Brána 3: testy --------------------------------------------------------
echo "=== Gate 3/3: server tests ==="
if [ "${DEPLOY_SKIP_TESTS:-0}" = "1" ]; then
  echo "!!! DEPLOY_SKIP_TESTS=1 — testy preskočené, nasadzuješ neotestovaný kód."
else
  ( cd server && npm test ) || {
    echo "CHYBA: testy zlyhali — nenasadzujem. (DEPLOY_SKIP_TESTS=1 to obíde, ak vieš prečo.)"
    exit 1
  }
fi

# --- Balík z gitu, nie z pracovného adresára -------------------------------
SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
echo "=== Creating tarball from git HEAD ($SHORT) ==="
rm -rf "$STAGE"
rm -f "$TGZ"
mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"
# Stopa po tom, čo presne beží na kase. Bez nej sa nedá zistiť, či sa repo
# a kasa rozišli — a presne to sa stalo naposledy.
{
  echo "sha=$SHA"
  echo "ref=$(git rev-parse --abbrev-ref HEAD)"
  echo "subject=$(git log -1 --format=%s)"
} > "$STAGE/DEPLOYED_SHA"
tar -czf "$TGZ" -C "$STAGE" .
rm -rf "$STAGE"

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
echo "=== Deploy complete — $SHORT ==="
