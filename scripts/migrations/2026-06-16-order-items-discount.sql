-- Migrácia: per-item zľava — order_items.discount_id + discount_type + discount_value
--
-- KONTEXT: Doteraz existovala iba zľava na CELÝ účet (orders.discount_id +
-- orders.discount_amount). Táto feature pridáva zľavu na JEDNU položku v
-- objednávke. Mirror vzoru orders.discountId, ale na úrovni order_items.
--
-- DÔLEŽITÉ — prečo NEukladáme euro sumu: order_items nemá cenový snapshot
-- (ceny sa vždy čítajú live z menu_items). Preto ukladáme PRAVIDLO
-- (discount_type 'percent'|'fixed' + discount_value), a euro sumu rátame
-- on-the-fly cez lineDiscountAmount() — auto-scaluje pri zmene qty, žiadny
-- stale snapshot. discount_id = nullable link na katalóg `discounts`
-- (custom-percent nemá katalógový riadok). Všetky tri NULL = bez zľavy.
--
-- Tento súbor je tracked v gite (idempotentný, IF NOT EXISTS) — drizzle-kit
-- push už raz na prode dropol stĺpce (viď 2026-05-28-...sql), preto ide
-- explicitný backstop PRED `npm run db:push`.
--
-- Aplikované na prod: 2026-06-16
-- Spustenie:
--   cat scripts/migrations/2026-06-16-order-items-discount.sql | ssh surfs@100.95.64.38 \
--     'docker exec -i pos-db-1 psql -U pos -d pos'

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_id integer REFERENCES discounts(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_type varchar(10);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_value numeric(8,2);

-- Verifikácia
SELECT 'order_items' AS tbl, column_name FROM information_schema.columns
  WHERE table_name='order_items' AND column_name IN ('discount_id','discount_type','discount_value')
ORDER BY column_name;
