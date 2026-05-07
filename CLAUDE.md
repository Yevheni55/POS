# Working in this repo

## Design Code je povinný

Predtým ako napíšeš UI / komponent / page — prečítaj **[DESIGN-CODE.md](./DESIGN-CODE.md)**.
Všetky nové features, modály, stránky a komponenty musia dodržať
pravidlá tam definované. Najmä:

- Importuj `tokens.css` ako prvý
- Žiadne hex hodnoty mimo `tokens.css` — používaj `var(--color-*)`
- Žiadne nové fonty mimo Sora + Manrope (POS) / Instrument Serif + Plus Jakarta + Caveat (web)
- Type scale, spacing, radius — všetko z premenných
- Tap targets ≥ 44 px
- `[hidden]` override pre modal overlays
- `prefers-reduced-motion` motion-safe blok
- `Intl.DateTimeFormat` s `Europe/Bratislava` pre časy
- Sub-cent ceny cez `fmtCost()` adaptívny formátter
- Slovak locale (`sk-SK`) — čiarka ako oddeľovač

## Deploy flow

```sh
# Lokálne zmeny → kasa
DEPLOY_HOST=surfs@100.95.64.38 bash scripts/deploy-tailscale-pos.sh

# Sklad / DB SQL
ssh surfs@100.95.64.38 "docker cp tmp/X.sql pos-db-1:/tmp/ && docker exec pos-db-1 psql -U pos -d pos -f /tmp/X.sql"

# Webka (surfspirit.sk)
bash scripts/deploy-surfspirit-html.sh           # FTP upload
bash scripts/sync-pos-to-neon.sh                  # menu DB sync

# Commit + push
git push origin HEAD:main                         # branch tracks main
```

## Štruktúra

| Adresár | Obsah |
|---|---|
| `pos-enterprise.html` + `js/pos-*.js` + `css/pos.css` | POS appka (kasa) |
| `admin/` | Manager admin (sklad, recepty, reporty, sezóna) |
| `dochadzka.html` + `js/dochadzka.js` | Self-service attendance terminal |
| `server/routes/` | Express API |
| `server/db/schema.js` | Drizzle ORM schema |
| `web/index.html` | Public webka surfspirit.sk |
| `scripts/` | Deploy + sync utilities |
| `tokens.css` | **Design tokens — single source of truth** |

## Pred commit-om

Spusti checklist z `DESIGN-CODE.md` § 16. Najmä:
- žiadne hex hodnoty
- žiadne `!important` (okrem `[hidden]`)
- focus ring na novom interaktívnom prvku
- Slovak locale formátovanie

## API base URL

POS: `http://localhost:3080/api/*` (Docker), `http://100.95.64.38:3080` Tailscale.
Webka Neon: `ep-patient-night-anjk0fv0-pooler.c-6.us-east-1.aws.neon.tech`.

## eKasa / Portos

- Konfigurácia v `server/.env` cez `PORTOS_*` premenné
- Aktuálny režim: **non-payer DPH** (`forceZeroVat: true`) — všetky doklady idú s 0 % DPH
- Hranica registrácie: 50 000 € / kalendárny rok (od 2025)
- Pri prekročení v `server/lib/vat-registration.js` flipni `isVatRegisteredBusiness()` flag

## TZ

Server beží v Docker UTC. **Vždy** používaj `Intl.DateTimeFormat` s
`timeZone: 'Europe/Bratislava'` pre formátovanie časov, inak budú
bony posunuté o 1-2 hodiny.
