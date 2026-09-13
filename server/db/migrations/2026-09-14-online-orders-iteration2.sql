-- Iterácia 2 „ošetrenie chýb, nič sa nestratí":
--  • claimed_* — kto objednávku práve rieši (vidia to všetky obrazovky, TTL 30 s);
--  • escalation_level — 0 nič, 1 po minúte (KDS + kasa červená), 2 po dvoch (Telegram);
--  • accept_deadline_at — termín Woltu na prijatie (strážca 30 s pred ním odmietne);
--  • fire_at / fired_at — predobjednávka: účet + bon + kuriér až v čase fire_at;
--  • bon_status — ok | queued | failed | none (bon nevytlačený → obsluha vidí, môže znova).
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS claimed_by integer;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS claimed_name varchar(100);
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS claimed_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS accept_deadline_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS fire_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS fired_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS bon_status varchar(16);
CREATE INDEX IF NOT EXISTS online_orders_fire_idx ON online_orders (fire_at) WHERE fire_at IS NOT NULL AND fired_at IS NULL;
