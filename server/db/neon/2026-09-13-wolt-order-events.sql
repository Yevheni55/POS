-- Notifikácie Wolt Order API (objednávky z aplikácie Wolt). Wolt ich posiela
-- na surfspirit.sk (web/objednavky-api.php → /wolt/order-webhook), PHP ich
-- odloží sem a kasa si ich vyzdvihne (server/lib/web-orders-bridge.js),
-- stiahne detail objednávky priamo z Woltu a ukáže ju na KDS/kase.
--
-- Spustenie (idempotentné):  node scripts/neon-apply.mjs server/db/neon/2026-09-13-wolt-order-events.sql

CREATE TABLE IF NOT EXISTS wolt_order_events (
  id               bigserial PRIMARY KEY,
  notification_id  varchar(64) UNIQUE,          -- Wolt opakuje doručenie 3×; duplicitu zahodíme
  type             varchar(40) NOT NULL,        -- order.notification
  wolt_order_id    varchar(64) NOT NULL,
  venue_id         varchar(64),
  status           varchar(40) NOT NULL,        -- CREATED | PRODUCTION | READY | DELIVERED | CANCELED | …
  resource_url     text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS wolt_order_events_pending_idx ON wolt_order_events (id) WHERE processed_at IS NULL;
