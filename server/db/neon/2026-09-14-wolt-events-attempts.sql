-- Počet pokusov o spracovanie notifikácie Woltu na kase: po piatich sa označí
-- ako spracovaná (s logom), aby jedna chybná udalosť neblokovala front.
ALTER TABLE wolt_order_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
