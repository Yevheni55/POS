-- Iterácia 1 „Rozvoz na jeden dotyk":
--  • prep_minutes / promised_ready_at — koľko minút si kuchyňa vypýtala pri prijatí;
--    ide kuriérovi (Wolt adjusted_pickup_time, Drive min_preparation_time) a od toho
--    sa počítajú farby/odpočty na KDS a kase;
--  • wolt_accepted_at — objednávka už prijatá vo Wolte (retry po páde DB ju neprijme znova);
--  • processing_at / processing_by — zámok proti dvojitému spracovaniu (KDS + kasa
--    naraz): UPDATE … WHERE status='new' AND zámok voľný prejde len jednému.
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS prep_minutes integer;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS promised_ready_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS wolt_accepted_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS processing_at timestamp;
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS processing_by integer;
