-- Neon (cloudová DB, ktorú číta surfspirit.sk) — „poštová schránka" pre online
-- objednávky medzi Websupport PHP (web/objednavky-api.php) a kasou
-- (server/lib/web-orders-bridge.js). Kasa je za NAT-om a nemá verejnú adresu,
-- preto si objednávky sama vyzdvihuje odtiaľto a stav zapisuje späť.
--
-- Spustenie (idempotentné):  node scripts/neon-apply.mjs server/db/neon/2026-09-12-web-orders.sql

CREATE TABLE IF NOT EXISTS web_orders (
  id                      bigserial PRIMARY KEY,
  public_code             varchar(12)  NOT NULL UNIQUE,
  status                  varchar(16)  NOT NULL DEFAULT 'new',   -- new|confirmed|dispatched|delivered|rejected|cancelled
  customer_name           varchar(120) NOT NULL,
  customer_phone          varchar(40)  NOT NULL,
  customer_email          varchar(160) NOT NULL DEFAULT '',
  dropoff_street          varchar(200) NOT NULL,
  dropoff_city            varchar(120) NOT NULL,
  dropoff_post_code       varchar(12)  NOT NULL,
  dropoff_comment         varchar(300) NOT NULL DEFAULT '',
  dropoff_lat             double precision,
  dropoff_lon             double precision,
  items                   jsonb        NOT NULL,                 -- [{menuItemId,name,qty,unitPrice,vatRate,note}]
  subtotal                numeric(10,2) NOT NULL,
  delivery_fee            numeric(10,2) NOT NULL DEFAULT 0,
  total                   numeric(10,2) NOT NULL,
  payment_method          varchar(16)  NOT NULL,                 -- cash|transfer
  note                    varchar(300) NOT NULL DEFAULT '',
  scheduled_for           timestamptz,
  wolt_promise_id         varchar(120),
  wolt_promise_valid_until timestamptz,
  wolt_order_reference_id varchar(120),
  wolt_status             varchar(40),
  wolt_tracking_url       text,
  confirmed_at            timestamptz,
  ready_at                timestamptz,
  rejected_reason         varchar(300),
  client_ip               varchar(64)  NOT NULL DEFAULT '',
  imported_at             timestamptz,                          -- kasa si objednávku prevzala
  pos_online_order_id     integer,                              -- id v online_orders na kase
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_orders_pending_idx  ON web_orders (id) WHERE imported_at IS NULL;
CREATE INDEX IF NOT EXISTS web_orders_wolt_ref_idx ON web_orders (wolt_order_reference_id);

-- Udalosti: PHP sem zapisuje webhooky Woltu (type 'wolt:order.…'), kasa ich
-- spracuje a označí processed_at. 'created' zapisuje PHP pri vzniku.
CREATE TABLE IF NOT EXISTS web_order_events (
  id            bigserial PRIMARY KEY,
  web_order_id  bigint      NOT NULL REFERENCES web_orders(id) ON DELETE CASCADE,
  type          varchar(60) NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS web_order_events_pending_idx ON web_order_events (id) WHERE processed_at IS NULL;

-- Prísľuby ceny doručenia (Wolt shipment promise) — cena do objednávky sa berie
-- odtiaľto, nikdy z klienta.
CREATE TABLE IF NOT EXISTS web_promises (
  id           varchar(120) PRIMARY KEY,
  fee_eur      numeric(10,2) NOT NULL,
  eta_minutes  integer,
  valid_until  timestamptz,
  dropoff      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Konfigurácia od kasy (kľúč 'config': deliveryEnabled, mode, paymentMethods,
-- minOrderEur, pickup). updated_at = heartbeat: keď kasa dlhšie nepíše, web
-- hlási „doručenie nie je dostupné".
CREATE TABLE IF NOT EXISTS web_delivery_config (
  key         varchar(40) PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Menu na webe dostane id položky z kasy (objednávka sa robí podľa neho) a DPH.
ALTER TABLE guest_menu ADD COLUMN IF NOT EXISTS pos_item_id integer;
ALTER TABLE guest_menu ADD COLUMN IF NOT EXISTS vat_rate numeric(5,2);
CREATE INDEX IF NOT EXISTS guest_menu_pos_item_idx ON guest_menu (pos_item_id);
