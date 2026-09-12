-- Objednávky z aplikácie Wolt (Wolt Order API / marketplace) idú do tej istej
-- tabuľky online_orders ako objednávky z webu — KDS, kasa aj admin ich vidia
-- rovnako. Odlišuje ich `source`, kuriéra rieši Wolt sám (bez Wolt Drive).
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'web';          -- web | wolt
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS delivery_type varchar(16);                          -- homedelivery | takeaway | eatin (Wolt)
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS wolt_order_id varchar(64);                          -- id objednávky vo Wolte
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS wolt_order_number varchar(32);                      -- číslo, ktoré vidí zákazník v appke
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS wolt_pickup_eta timestamp;                          -- kedy má kuriér Woltu prísť
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS wolt_payload jsonb;                                 -- surová objednávka z Woltu (pre podporu)
CREATE UNIQUE INDEX IF NOT EXISTS online_orders_wolt_order_uidx ON online_orders (wolt_order_id) WHERE wolt_order_id IS NOT NULL;

-- OAuth tokeny integrácií (Wolt Order API: access token 1 h, refresh token
-- jednorazový, 30 dní) — musia prežiť reštart kontajnera, preto v DB.
CREATE TABLE IF NOT EXISTS integration_tokens (
  provider      varchar(40) PRIMARY KEY,
  access_token  text,
  refresh_token text,
  expires_at    timestamp,
  updated_at    timestamp NOT NULL DEFAULT now()
);
