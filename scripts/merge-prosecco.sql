-- Merge všetkých Prosecco záznamov do jedného (id=13). Pôvodné id=13
-- 'Prossecco' (typo) je linkované v recipes pre menu Prosecco 0,1 l, takže
-- ho zachováme ako kanonický a zlúčime doň 117 + 167 (oba 0,75l fľaše,
-- 4 ks za faktúru = 3 l prirátame).
--
-- Po merge:
--   id=13 'Prosecco', unit='l', current_qty = -0.7 + 3.0 + 3.0 = 5.3 l
--   po_items pôvodne pre 117/167 ukazujú teraz na 13 s conversion_factor=0.75
--   stock_movements re-pointed na 13, qty prepočítané na litre
--   id=117 a id=167 vymazané

BEGIN;

-- 1) Repoint PO items: ks fľaše → 0,75 l každá. unit_cost zostáva za 1 ks
--    (cena za fľašu), historicky to PO ukáže korektne.
UPDATE purchase_order_items
SET ingredient_id = 13, conversion_factor = 0.75
WHERE ingredient_id IN (117, 167);

-- 2) Repoint stock_movements + prepočítaj qty na litre (×0,75).
--    previous_qty a new_qty sa nastavia tak, aby chain pre id=13 dával zmysel:
--    movement 117 (24.4): prev = -0.7, new = -0.7 + 3 = 2.3
--    movement 167 (2.5):  prev = 2.3, new = 2.3 + 3 = 5.3
--    (medzi tým reálne mohol byť POS spotrebiteľ, ale id=13 mal už -0.7 pred merge,
--     takže kedy presne sa to spotrebovalo nevieme z dostupných dát)
UPDATE stock_movements
SET ingredient_id = 13,
    quantity = ROUND(quantity * 0.75, 3),
    previous_qty = -0.7,
    new_qty = 2.3
WHERE ingredient_id = 117 AND type = 'purchase';

UPDATE stock_movements
SET ingredient_id = 13,
    quantity = ROUND(quantity * 0.75, 3),
    previous_qty = 2.3,
    new_qty = 5.3
WHERE ingredient_id = 167 AND type = 'purchase';

-- 3) Premenuj id=13 (oprava typo 'Prossecco' → 'Prosecco') a nastav
--    finálne current_qty + cost_per_unit (vážený priemer:
--    (4×5.70 + 4×4.90) / 6 l = 42.40 / 6 = 7.07 €/l)
UPDATE ingredients
SET name = 'Prosecco',
    unit = 'l',
    current_qty = 5.3,
    cost_per_unit = 7.07
WHERE id = 13;

-- 4) Zmaž duplicitné záznamy.
DELETE FROM ingredients WHERE id IN (117, 167);

-- 5) Verify
SELECT id, name, unit, current_qty, cost_per_unit
FROM ingredients
WHERE id = 13 OR name ILIKE '%prosecco%' OR name ILIKE '%prossecco%';

SELECT 'po_items_repointed' AS metric, COUNT(*)::text AS value FROM purchase_order_items WHERE ingredient_id = 13
UNION ALL SELECT 'stock_movements_for_13', COUNT(*)::text FROM stock_movements WHERE ingredient_id = 13
UNION ALL SELECT 'orphaned_117', COUNT(*)::text FROM ingredients WHERE id = 117
UNION ALL SELECT 'orphaned_167', COUNT(*)::text FROM ingredients WHERE id = 167;

COMMIT;
