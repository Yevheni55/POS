-- Pridanie dest_override stlpca pre menu_items aby admin mohol per-polozku
-- pretociť cieľ tlače (kuchyňa / bar) bez ohľadu na default kategórie.
--
-- Pravidlo:
--   - NULL = use category.dest (default behavior)
--   - 'bar' alebo 'kuchyna' = override
--
-- Použité v:
--   - server/routes/orders.js (kitchen ticket routing)
--   - server/lib/print/network.js (getPrinterForDest)
--   - frontend js/pos-state.js (getItemDest)
--   - reports per-product breakdown

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS dest_override varchar(20);

-- Verifikácia
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_name = 'menu_items' AND column_name = 'dest_override';
