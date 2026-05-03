-- Refactor: Surférske hranolky 200g (id 75) prestane odpisovať z polotovaru
-- 'Surférske BBQ ragu (vlastné)' a začne odpisovať priamo raw ingrediencie.
-- Operátor takto nemusí ručne pripočítavať polotovar po každej várke
-- — predaj jednej porcie hranoliek vidí kasa rovno v stave Cibula červená
-- a Hovädzieho.
--
-- Yield: várka 4600g raw → 3000g hotového ragu, 1 porcia = 120g cooked
--   = 120/3000 = 4% várky → spotreba per porcia (raw):
--     Cibuľa červená:    2000 × 0.04 = 80 g
--     Hovädzie mleté:    2000 × 0.04 = 80 g
--     BBQ omáčka kup.:    600 × 0.04 = 24 g
--     Soľ + korenie:    negligible (zatiaľ neevidované)

BEGIN;

-- 1) Konverzia jednotky 'Cibuľa červená kal. 60-80' z kg na g
--    (qty × 1000, cost / 1000)
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000
WHERE name='Cibuľa červená kal. 60-80' AND unit='kg';

-- 2) Pridaj 'BBQ omáčka (kupovaná)' ako raw ingredienciu (g, qty=0).
--    Doplníš pri ďalšom nákupe; doteraz nebola na žiadnej faktúre.
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active)
VALUES ('BBQ omáčka (kupovaná)', 'g', 'ingredient', 0, 0, 0, true)
ON CONFLICT DO NOTHING;

-- 3) Vyčisti starý recept (link na polotovar) a vlož nový s raw surovinami
DELETE FROM recipes WHERE menu_item_id = 75;

INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (75, (SELECT id FROM ingredients WHERE name='Cibuľa červená kal. 60-80'),                  80.000),
  (75, (SELECT id FROM ingredients WHERE name='Hovädzie mleté mäso 70/30 cca 5kg Bognár'),   80.000),
  (75, (SELECT id FROM ingredients WHERE name='BBQ omáčka (kupovaná)'),                      24.000);

-- 4) Verify
SELECT mi.name AS menu, i.name AS ingredient, r.qty_per_unit AS g, i.unit
FROM recipes r
JOIN menu_items mi ON mi.id = r.menu_item_id
JOIN ingredients i ON i.id = r.ingredient_id
WHERE r.menu_item_id = 75
ORDER BY r.qty_per_unit DESC;

COMMIT;
