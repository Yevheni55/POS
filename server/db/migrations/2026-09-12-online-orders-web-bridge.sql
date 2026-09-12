-- Most web ↔ kasa cez Neon: lokálna online objednávka si pamätá, z ktorého
-- riadku web_orders (Neon) vznikla, a kedy sa jej stav naposledy zapísal späť.
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS web_order_id bigint;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS web_synced_at timestamp;
CREATE INDEX IF NOT EXISTS online_orders_web_order_idx ON online_orders (web_order_id) WHERE web_order_id IS NOT NULL;
