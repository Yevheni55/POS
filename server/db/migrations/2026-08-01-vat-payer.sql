-- ============================================================================
-- Migracia: prechod na PLATITELA DPH (SL management, s.r.o.)
-- Datum: 2026-08-01 | Nalezy [12] a [25] z .claude/vat-payer-audit-2026-07.txt
--
-- !!! TENTO SUBOR MUSI BEZAT NA DB SKOR, NEZ SA NASADI KOD. !!!
-- `menu_categories.default_vat_rate` je uz DEKLAROVANY v server/db/schema.js,
-- takze drizzle ho dava do KAZDEHO `SELECT ... FROM menu_categories`. Kym tento
-- skript (alebo `npm run db:push`) na danej DB nebezal, GET /api/menu spadne na
-- `column "default_vat_rate" does not exist` — teda KASA NENABEHNE.
-- Presne preto uz nie je v gitignorovanom tmp/, ale v trackovanom
-- `server/db/migrations/`, a preto `scripts/deploy-tailscale-pos.sh` ma branu,
-- ktora nasadenie zastavi, kym stlpec na kase neexistuje.
--
-- KDE PUSTIT — na OBIDVOCH databazach:
--   1) PRODUKCNA kasa 100.95.64.38 (od 2026-08-01 PLATITEL DPH, SL management):
--        scp server/db/migrations/2026-08-01-vat-payer.sql surfs@100.95.64.38:C:/POS/
--        ssh surfs@100.95.64.38 "docker cp C:\POS\2026-08-01-vat-payer.sql pos-db-1:/tmp/ && \
--          docker exec pos-db-1 psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/2026-08-01-vat-payer.sql"
--   2) DEV PC (lokalny docker stack):
--        docker cp server/db/migrations/2026-08-01-vat-payer.sql pos-db-1:/tmp/
--        docker exec pos-db-1 psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/2026-08-01-vat-payer.sql
--
-- Migracia je pre NEPLATITELA spravanim NEUTRALNA — ziaden existujuci riadok sa
-- nemeni: menia sa iba DEFAULT pre BUDUCE inserty a pridava sa novy NULLABLE
-- stlpec. Hromadny prepis 20 % -> 23 % je zamerne ZAKOMENTOVANY (viz nizsie),
-- lebo by posunul cisla v uctovnom CSV exporte.
--
-- Idempotentna: da sa pustit opakovane (ALTER ... SET DEFAULT aj
-- ADD COLUMN IF NOT EXISTS aj UPDATE ... WHERE ... IS NULL su bezpecne).
--
-- Zodpoveda `server/db/schema.js` (projekt inak pouziva drizzle-kit push, nie
-- migracne subory) — po spusteni je `npm run db:push` no-op. Lokalne testovacie
-- DB (pos_test, pos_test_w1..w6) sa udrziavaju cez `npm run db:push`.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- [25] menu_items.vat_rate — DEFAULT '20.00' je sadzba, ktora v SR od 2025
-- neexistuje a Portos ju odmietne (validation_error az pri platbe, ucet sa neda
-- zaplatit). Prepiname na 23.00 = aktualna zakladna sadzba.
-- ---------------------------------------------------------------------------
ALTER TABLE menu_items ALTER COLUMN vat_rate SET DEFAULT '23.00';

-- Kontrola existujucich riadkov s neplatnou sadzbou (vznikli rucnym SQL / obnovou
-- z dumpu). 20 % nie je v SUPPORTED_VAT_RATES -> u PLATITELA taka polozka blokuje
-- platbu celeho uctu. Tento SELECT nic nemeni, iba vypise zoznam do logu psql:
SELECT id, name, vat_rate AS neplatna_sadzba
  FROM menu_items WHERE vat_rate NOT IN (0, 5, 19, 23);

-- ZAMERNE NEROBIME hromadny UPDATE existujucich riadkov.
-- Dovod: u NEPLATITELA sa sadzba na doklade aj tak nuluje (forceZeroVat), ALE
-- uctovny CSV export (server/lib/reports/export.js) pocita DPH skupiny zo ZIVEJ
-- menu_items.vat_rate — prepis 20 -> 23 by teda zmenil uz vykazane cisla. Preto
-- to musi byt vedome rozhodnutie majitela, a az PO tom, co si zoznam vyssie
-- pozrel:
--
-- UPDATE menu_items SET vat_rate = '23.00' WHERE vat_rate = '20.00';

-- ---------------------------------------------------------------------------
-- [12] menu_categories.default_vat_rate — explicitna sadzba kategorie namiesto
-- hadania podla slugu. Nove kategorie z admin UI maju slug `cat_<timestamp>`,
-- ktory inferencia nikdy nepokryje a UI ticho padalo na 23 %.
-- NULLABLE zamerne: NULL = "manazer sadzbu este nezvolil".
-- ---------------------------------------------------------------------------
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS default_vat_rate numeric(5, 2);

-- Jednorazove doplnenie pre kategorie, ktorych slug uz inferencia pozna
-- (server/lib/menu-vat.js). Ostatne — vratane `cat_*` — ostavaju NULL a musi ich
-- vyplnit manazer v admine, aby sadzba nebola uhadnuta.
UPDATE menu_categories SET default_vat_rate = 5.00
  WHERE default_vat_rate IS NULL AND slug IN ('jedlo');
UPDATE menu_categories SET default_vat_rate = 19.00
  WHERE default_vat_rate IS NULL AND slug IN ('kava', 'caj', 'nealko');
UPDATE menu_categories SET default_vat_rate = 23.00
  WHERE default_vat_rate IS NULL AND slug IN ('pivo', 'vino', 'sekt', 'koktaily', 'destilaty');

COMMIT;

-- Overenie po behu (to iste sa pyta aj brana v scripts/deploy-tailscale-pos.sh):
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = $$menu_categories$$ AND column_name = $$default_vat_rate$$
       ) THEN $$MIGRATION_OK$$ ELSE $$MIGRATION_MISSING$$ END AS stav;

-- ---------------------------------------------------------------------------
-- VOLITELNE (obrana do hlbky) — CHECK constraint, ktory neplatnu sadzbu zablokuje
-- uz na urovni DB, teda aj pri rucnom SQL a pri obnove zo stareho dumpu.
--
-- ZAMERNE ZAKOMENTOVANE: pusti az potom, co `SELECT ... WHERE vat_rate NOT IN
-- (0, 5, 19, 23)` vrati 0 riadkov — inak ALTER zlyha a transakcia sa vrati spat.
-- Hodnota 0 musi v zozname ostat kvoli NEPLATITELOVI DPH.
--
-- SELECT id, name, vat_rate FROM menu_items WHERE vat_rate NOT IN (0, 5, 19, 23);
--
-- ALTER TABLE menu_items
--   ADD CONSTRAINT menu_items_vat_rate_supported
--   CHECK (vat_rate IN (0, 5, 19, 23));
--
-- Rovnaky guard pre kategorie (NULL = nezvolena, preto je povolena):
-- ALTER TABLE menu_categories
--   ADD CONSTRAINT menu_categories_default_vat_rate_supported
--   CHECK (default_vat_rate IS NULL OR default_vat_rate IN (5, 19, 23));
--
-- ROLLBACK (ak by bolo treba) — POZOR: kym je nasadeny kod, ktory stlpec
-- deklaruje v schema.js, DROP COLUMN zhodi /api/menu. Rollback DB robit IBA
-- spolu s rollbackom kodu:
--   ALTER TABLE menu_items ALTER COLUMN vat_rate SET DEFAULT '20.00';
--   ALTER TABLE menu_categories DROP COLUMN IF EXISTS default_vat_rate;
-- ---------------------------------------------------------------------------
