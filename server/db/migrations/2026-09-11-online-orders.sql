-- Online objednávky s doručením cez Wolt Drive.
--
-- Spustenie na kase (PRED nasadením kódu, inak /api/online-orders padne na
-- "relation online_orders does not exist"):
--   scp server/db/migrations/2026-09-11-online-orders.sql surfs@100.95.64.38:C:/POS/
--   ssh surfs@100.95.64.38 "docker cp C:\POS\2026-09-11-online-orders.sql pos-db-1:/tmp/ && \
--     docker exec pos-db-1 psql -U pos -d pos -v ON_ERROR_STOP=1 -f /tmp/2026-09-11-online-orders.sql"
--
-- Idempotentné: dá sa pustiť opakovane.

-- Objednávka z webu. Položky sú SNAPSHOT (názov, cena, DPH v čase objednávky) —
-- menu sa medzitým môže zmeniť a zákazník musí dostať to, čo si objednal.
CREATE TABLE IF NOT EXISTS online_orders (
  id                       serial PRIMARY KEY,
  public_code              varchar(12) NOT NULL UNIQUE,          -- kód pre zákazníka, napr. SS-4F7K2
  status                   varchar(20) NOT NULL DEFAULT 'new',   -- new | confirmed | dispatched | delivered | rejected | cancelled
  customer_name            varchar(100) NOT NULL,
  customer_phone           varchar(30) NOT NULL,
  customer_email           varchar(120) NOT NULL DEFAULT '',
  dropoff_street           varchar(150) NOT NULL,
  dropoff_city             varchar(80) NOT NULL,
  dropoff_post_code        varchar(12) NOT NULL,
  dropoff_comment          varchar(300) NOT NULL DEFAULT '',
  dropoff_lat              numeric(9,6),
  dropoff_lon              numeric(9,6),
  items                    jsonb NOT NULL,                       -- [{menuItemId,name,qty,unitPrice,vatRate}]
  subtotal                 numeric(10,2) NOT NULL,
  delivery_fee             numeric(10,2) NOT NULL DEFAULT 0,
  total                    numeric(10,2) NOT NULL,
  payment_method           varchar(20) NOT NULL DEFAULT 'cash',  -- cash (kuriérovi) | transfer (QR/prevod vopred)
  note                     varchar(500) NOT NULL DEFAULT '',
  scheduled_for            timestamp,                            -- NULL = čo najskôr
  wolt_promise_id          varchar(80),
  wolt_promise_valid_until timestamp,
  wolt_order_reference_id  varchar(80),
  wolt_tracking_url        text,
  wolt_status              varchar(40),
  wolt_fee                 numeric(10,2),
  pos_order_id             integer REFERENCES orders(id),
  confirmed_by             integer REFERENCES staff(id),
  confirmed_at             timestamp,
  rejected_reason          varchar(300) NOT NULL DEFAULT '',
  client_ip                varchar(64) NOT NULL DEFAULT '',
  created_at               timestamp NOT NULL DEFAULT now(),
  updated_at               timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS online_orders_status_created_idx ON online_orders (status, created_at);

-- Časová os objednávky: čo prišlo z Woltu (webhook), kto potvrdil, prečo odmietol.
CREATE TABLE IF NOT EXISTS online_order_events (
  id              serial PRIMARY KEY,
  online_order_id integer NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  type            varchar(40) NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS online_order_events_order_idx ON online_order_events (online_order_id, created_at);

-- Zóna „Rozvoz" so štyrmi virtuálnymi stolmi: potvrdená online objednávka sa
-- stane bežným POS účtom na jednom z nich, takže kuchyňa dostane bon, sklad sa
-- odpíše a predaj prejde cez eKasu ako každý iný.
INSERT INTO zones (slug, label, sort_order) VALUES ('rozvoz', 'Rozvoz', 90)
  ON CONFLICT (slug) DO NOTHING;
INSERT INTO tables (name, seats, zone, shape, x, y)
  SELECT 'Rozvoz ' || n, 0, 'rozvoz', 'rect', 20 + (n - 1) * 120, 20
  FROM generate_series(1, 4) AS n
  WHERE NOT EXISTS (SELECT 1 FROM tables WHERE zone = 'rozvoz');

-- Overenie (musí vypísať 2):
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_name IN ('online_orders', 'online_order_events');
