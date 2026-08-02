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
#   DEPLOY_SKIP_TESTS=1      preskočí `npm test` (syntax check beží vždy)
#   DEPLOY_ALLOW_DIRTY=1     dovolí deploy s nescommitovanými zmenami
#   DEPLOY_SKIP_DB_CHECK=1   preskočí kontrolu, či na kase bežali DB migrácie
#   DEPLOY_DB_CONTAINER=…    názov DB kontajnera na kase (default pos-db-1)
#
# ČO SA ZMENILO A PREČO:
# Skript predtým balil PRACOVNÝ ADRESÁR (`tar -czf ... .`). Na kase preto bežal
# kód, ktorý nebol v žiadnom commite — `server/routes/payments.js` importoval
# `lib/payments/qr.js`, ktorý bol untracked, takže čerstvý `git clone` repa sa
# ani nenaštartoval. Teraz sa balí `git archive HEAD`: nasadí sa presne to, čo
# je v gite, a súbor `DEPLOYED_SHA` v balíčku povie, ktorý commit to bol.

set -e

HOST="${DEPLOY_HOST:-pos-kasa-tscale}"
DB_CONTAINER="${DEPLOY_DB_CONTAINER:-pos-db-1}"
REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TGZ="/tmp/pos-deploy.tgz"
STAGE="/tmp/pos-deploy-stage"

cd "$REPO_ROOT"

# --- Brána 1: pracovný strom musí byť čistý -------------------------------
echo "=== Gate 1/4: git working tree ==="
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
echo "=== Gate 2/4: node --check ==="
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

# --- Brána 3: DB migrácie na kase ------------------------------------------
# PORADIE MIGRÁCIA → KÓD, nie naopak.
#
# `menu_categories.default_vat_rate` je deklarovaný v server/db/schema.js, takže
# drizzle ho pridá do KAŽDÉHO `SELECT ... FROM menu_categories`. Ak sa nasadí
# kód skôr, než na kase prebehne server/db/migrations/2026-08-01-vat-payer.sql,
# GET /api/menu spadne na `column "default_vat_rate" does not exist` — kasa
# nenabehne a čašník to zistí až pri prvom účte. Radšej hlasné zlyhanie deployu.
echo "=== Gate 3/4: DB migrácie na kase ==="
if [ "${DEPLOY_SKIP_DB_CHECK:-0}" = "1" ]; then
  echo "!!! DEPLOY_SKIP_DB_CHECK=1 — nekontrolujem, či na kase bežali migrácie."
  echo "!!! Ak chýba stĺpec menu_categories.default_vat_rate, /api/menu spadne a KASA NENABEHNE."
else
  # Bez apostrofov v SQL (dollar-quoting), aby sa reťazec prežil cez sh -> ssh -> cmd.exe.
  # Výsledok je ČÍSLO: chybová hláška psql síce zopakuje text dotazu, ale presné
  # porovnanie s "1"/"0" sa na ňu nedá nachytať.
  MIGRATION_PROBE_SQL='SELECT count(*) FROM information_schema.columns WHERE table_name = $$menu_categories$$ AND column_name = $$default_vat_rate$$'
  DB_PROBE_RAW="$(ssh "$HOST" "docker exec $DB_CONTAINER psql -U pos -d pos -tAc \"$MIGRATION_PROBE_SQL\"" 2>&1 || true)"
  # `2>&1` je tu zámerne (chceme vidieť SSH/docker chybu vo výpise), ale znamená to,
  # že do výstupu spadne aj čokoľvek, čo ssh píše na stderr — napr. banner
  # „WARNING: connection is not using a post-quantum key exchange algorithm“.
  # Preto neporovnávame celý výstup, ale vytiahneme z neho JEDINÝ riadok,
  # ktorý je holé číslo. Bez toho gate spadne do vetvy `*)` aj pri úspešnej migrácii.
  DB_PROBE="$(printf '%s\n' "$DB_PROBE_RAW" | tr -d '\r' | grep -E '^[0-9]+$' | tail -n 1)"
  case "$DB_PROBE" in
    1)
      echo "  OK — menu_categories.default_vat_rate na kase existuje"
      ;;
    0)
      echo "CHYBA: na kase NEBEŽALA migrácia server/db/migrations/2026-08-01-vat-payer.sql."
      echo "       Nasadenie kódu by zhodilo GET /api/menu a kasa by nenabehla."
      echo ""
      echo "Pusti NAJPRV migráciu, potom deploy:"
      echo "  scp server/db/migrations/2026-08-01-vat-payer.sql ${HOST}:C:/POS/"
      echo "  ssh ${HOST} \"docker cp C:\\POS\\2026-08-01-vat-payer.sql ${DB_CONTAINER}:/tmp/ && docker exec ${DB_CONTAINER} psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/2026-08-01-vat-payer.sql\""
      exit 1
      ;;
    *)
      echo "CHYBA: kontrolu migrácie sa nepodarilo vykonať (SSH / docker / psql)."
      echo "       Nasadzovať naslepo sa neoplatí — chýbajúca migrácia = mŕtva kasa."
      echo ""
      echo "Výstup:"
      echo "$DB_PROBE_RAW"
      echo ""
      echo "Ak je názov DB kontajnera iný: DEPLOY_DB_CONTAINER=<meno> $0"
      echo "Ak naozaj vieš, že migrácia bežala: DEPLOY_SKIP_DB_CHECK=1 $0"
      exit 1
      ;;
  esac
fi

# --- Brána 4: testy --------------------------------------------------------
echo "=== Gate 4/4: server tests ==="
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
