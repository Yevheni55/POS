-- Setup zemiaky + recepty pre malé / veľké / surférske hranolky.
-- Cena: 0.72 €/kg = 0.00072 €/g
--
-- Yield odhad: 1 kg raw zemiaky → ~666 g vyprážaných hranoliek (-33%)
-- = ratio 1.5× raw na 1g vyprážaných (typický pomer v reštaurácii).
--
-- Per porcia:
--   Hranolky malé 130g vyprážané → 130 × 1.5 = 195 g raw zemiakov
--   Hranolky veľké 230g vyprážané → 230 × 1.5 = 345 g raw zemiakov
--   Surferské 200g vyprážané      → 200 × 1.5 = 300 g raw zemiakov
--
-- Combo má malé hranolky — vyrieši sa cez combo-companion line (separátny
-- JS commit), pri ktorom sa pri pridaní comba automaticky vytvorí 0-price
-- riadok 'Hranolky malé 130g', ktorý cez svoj recept spotrebuje 195 g
-- zemiakov.

BEGIN;

-- 1) Pridaj Zemiaky ako surovinu (g, 0.00072 €/g)
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active)
VALUES ('Zemiaky', 'g', 'ingredient', 0, 0, 0.00072, true)
ON CONFLICT DO NOTHING;
-- Ak už existuje (race), update ceny
UPDATE ingredients SET cost_per_unit = 0.00072 WHERE name = 'Zemiaky' AND cost_per_unit = 0;

-- 2) Označ hranolky menu items ako recipe-tracked
UPDATE menu_items SET track_mode='recipe' WHERE id IN (73, 74);

-- 3) Vyčisti staré recipe-riadky pre hranolky (id 73, 74).
--    Surferské hranolky (id 75) už majú recept (cibuľa + hovädzie + BBQ);
--    iba pridáme zemiaky.
DELETE FROM recipes WHERE menu_item_id IN (73, 74);

-- 4) Vlož recipe-riadky
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  -- Hranolky malé 130g (id 73): 195g zemiaky
  (73, (SELECT id FROM ingredients WHERE name='Zemiaky'), 195.000),
  -- Hranolky veľké 200g (id 74, ale porcia 230g vyprážaných): 345g zemiaky
  (74, (SELECT id FROM ingredients WHERE name='Zemiaky'), 345.000),
  -- Surférske hranolky 200g (id 75): pridaj 300g zemiaky k existujúcim 3 ingredienciám
  (75, (SELECT id FROM ingredients WHERE name='Zemiaky'), 300.000);

-- 5) Verify
SELECT mi.id, mi.name AS hranolky, COUNT(r.id) AS lines
FROM menu_items mi LEFT JOIN recipes r ON r.menu_item_id = mi.id
WHERE mi.id IN (73, 74, 75) GROUP BY mi.id, mi.name ORDER BY mi.id;

SELECT mi.id, mi.name AS menu, i.name AS ingredient, r.qty_per_unit AS qty, i.unit
FROM recipes r
JOIN menu_items mi ON mi.id = r.menu_item_id
JOIN ingredients i ON i.id = r.ingredient_id
WHERE r.menu_item_id IN (73, 74, 75)
ORDER BY mi.id, r.qty_per_unit DESC;

COMMIT;
