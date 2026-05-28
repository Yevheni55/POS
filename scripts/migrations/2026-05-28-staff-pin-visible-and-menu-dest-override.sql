-- Migrácia: staff.pin_visible + staff.attendance_pin_visible + menu_items.dest_override
--
-- KONTEXT (prečo tracked): tieto 3 stĺpce boli pridané do server/db/schema.js
-- v 2 feature-och (PIN-visible pre admin, dest-override pre kuchyňa/bar tlač),
-- ale ad-hoc migrácie boli buď zmazané pri cleanup-e alebo zlyhali pri prvom
-- pokuse. To spôsobilo PROD REGRESIU: schema kód odkazoval na pin_visible
-- stĺpce čo v DB neexistovali → kazdy `db.select().from(staff)` (login +
-- dochádzka) padal s "column pin_visible does not exist".
--
-- Tento súbor je teraz tracked v gite, takže rebuild DB / nová inštalácia
-- aplikuje rovnaké stĺpce. IF NOT EXISTS = idempotentné, bezpečné spustiť
-- viackrát.
--
-- Aplikované na prod: 2026-05-28
-- Spustenie:
--   cat scripts/migrations/2026-05-28-*.sql | ssh surfs@100.95.64.38 \
--     'docker exec -i pos-db-1 psql -U pos -d pos'

-- PIN-visible: plain-text duplikát PIN-u pre admin "Zobraziť PIN-y" (bcrypt
-- hash je jednosmerný, bez plain hodnoty nedá sa zobraziť existujúci PIN).
-- Prístup chránený v routes/staff.js cez requireRole('admin','manazer').
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_visible varchar(10);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS attendance_pin_visible varchar(10);

-- dest-override: per-položku prepnutie cieľa tlače (kuchyňa/bar) bez ohľadu
-- na default kategórie. NULL = použiť category.dest.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS dest_override varchar(20);

-- Verifikácia
SELECT 'staff' AS tbl, column_name FROM information_schema.columns
  WHERE table_name='staff' AND column_name IN ('pin_visible','attendance_pin_visible')
UNION ALL
SELECT 'menu_items', column_name FROM information_schema.columns
  WHERE table_name='menu_items' AND column_name = 'dest_override'
ORDER BY tbl, column_name;
