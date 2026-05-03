-- Recipe: Surférske hranolky 200g → spotrebuje 120 g BBQ ragu na 1 porciu.
-- Pri každom predaji sa automaticky odpíše 120 g zo skladu polotovaru
-- 'Surférske BBQ ragu (vlastné)'. Várka 3 kg vystačí na ~25 porcií.
--
-- Hranolky samé (mrazené zemiaky) zatiaľ nemáme ako trackovanú surovinu
-- — ak ju neskôr pridáš, len sem pridaj druhý INSERT INTO recipes riadok.

BEGIN;

-- Označ menu item 75 ako recipe-tracked (auto-deduct na ňom funguje).
UPDATE menu_items SET track_mode = 'recipe' WHERE id = 75;

-- Vyčisti staré recept-riadky (idempotentné).
DELETE FROM recipes WHERE menu_item_id = 75;

-- Vlož recipe-riadok: 120 g ragu / porcia.
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (75, (SELECT id FROM ingredients WHERE name = 'Surférske BBQ ragu (vlastné)'), 120);

-- Verify
SELECT mi.name AS menu, i.name AS ingredient, r.qty_per_unit, i.unit
FROM recipes r
JOIN menu_items mi ON mi.id = r.menu_item_id
JOIN ingredients i ON i.id = r.ingredient_id
WHERE r.menu_item_id = 75;

COMMIT;
