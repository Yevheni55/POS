-- 1) Konverzia ks/kg → g pre suroviny ktoré recepty používajú v gramoch.
--    (qty × balenie, cost ÷ balenie). WHERE filter chráni pred dvojkonverziou
--    keď je už unit='g'.

-- Slanina Bacon plátky 1kg Gierlinger (id 154): 1 ks = 1000 g
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000
  WHERE name='Slanina Bacon plátky 1kg Gierlinger' AND unit='ks';

-- Uhorka hadovka kal. 12P-16 (id 126): 1 kg = 1000 g
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000
  WHERE name='Uhorka hadovka kal. 12P-16' AND unit='kg';

-- Paradajky Cherry oválne 250g (id 130): 1 ks balenie = 250 g
UPDATE ingredients SET unit='g', current_qty=current_qty*250, cost_per_unit=cost_per_unit/250
  WHERE name='Paradajky Cherry oválne 250g' AND unit='ks';


-- 2) Recipe: Vegetarian Halloumi burger (menu_item id=71)
--    Per-burger podľa kuchara (analógia s Big Mac receptom):
--      Žemľa univerzálna       1 ks
--      Pesto omáčka            45 g  (rovnaké množstvo ako Big Mac sauce na burgri)
--      Nakladaná cibuľa červená 10 g
--      Paradajky cherry        30 g  (≈ 3 cherry plátky)
--      Halloumi syr            140 g (2 plátky × 70 g, balenie 850 g ≈ 12 plátkov)
--      Šalát ľadový            20 g
UPDATE menu_items SET track_mode='recipe' WHERE id = 71;
DELETE FROM recipes WHERE menu_item_id = 71;
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (71, (SELECT id FROM ingredients WHERE name='Žemľa burger (univerzálna)'),  1.000),
  (71, (SELECT id FROM ingredients WHERE name='Syr Halloumi 850g Alambra'), 140.000),
  (71, (SELECT id FROM ingredients WHERE name='Pesto'),                      45.000),
  (71, (SELECT id FROM ingredients WHERE name='Paradajky Cherry oválne 250g'), 30.000),
  (71, (SELECT id FROM ingredients WHERE name='Šalát ľadový kal. 10'),       20.000),
  (71, (SELECT id FROM ingredients WHERE name='Nakladaná cibuľa (vlastná)'), 10.000);


-- 3) Combo recepty — combo má vlastný recept ktorý zahŕňa burger + male
--    hranolky 130g + bočnú omáčku ako prílohu. JS companion-logiku odpojím
--    v samostatnom commite, takže sklad sa nebude duplicitne odpisovať.
--
-- Princíp: recept comba = SÚČET (burger.recipe + hranolky_male.recipe + bocna_omacka.recipe).
-- Ak burger používa rovnakú surovinu ako bočná omáčka (napr. majonéza v Big Mac
-- burgeri obsahuje sauce → +30.080g; bočná omáčka Big Mac má +33.422g majonézy
-- → spolu 63.502g v combe), skonsolidujeme do jedného riadku per ingredient.

-- 3a) Combo Big Mac (88) = burger 68 + hranolky_male 73 + bočná Omáčka Big Mac 82
UPDATE menu_items SET track_mode='recipe' WHERE id = 88;
DELETE FROM recipes WHERE menu_item_id = 88;
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
SELECT 88, ingredient_id, SUM(qty_per_unit)
FROM recipes
WHERE menu_item_id IN (68, 73, 82)
GROUP BY ingredient_id;

-- 3b) Combo Chipotle (89) = burger 69 + hranolky_male 73 + bočná Omáčka chilli-mayo 83
UPDATE menu_items SET track_mode='recipe' WHERE id = 89;
DELETE FROM recipes WHERE menu_item_id = 89;
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
SELECT 89, ingredient_id, SUM(qty_per_unit)
FROM recipes
WHERE menu_item_id IN (69, 73, 83)
GROUP BY ingredient_id;

-- 3c) Combo BBQ (90) = burger 70 + hranolky_male 73 + bočná BBQ omáčka kupovaná 50g
--     BBQ omáčka kupovaná je raw ingrediencia (nemá vlastnú menu-recipe), takže
--     pridáme +50 g jednoducho ako extra recipe-line a potom skonsolidujeme.
UPDATE menu_items SET track_mode='recipe' WHERE id = 90;
DELETE FROM recipes WHERE menu_item_id = 90;
WITH side_sauce AS (
  SELECT (SELECT id FROM ingredients WHERE name='BBQ omáčka (kupovaná)') AS ingredient_id, 50.000 AS qty_per_unit
), all_lines AS (
  SELECT ingredient_id, qty_per_unit FROM recipes WHERE menu_item_id IN (70, 73)
  UNION ALL
  SELECT ingredient_id, qty_per_unit FROM side_sauce
)
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
SELECT 90, ingredient_id, SUM(qty_per_unit)
FROM all_lines
GROUP BY ingredient_id;

-- 3d) Combo Vegetarian Halloumi (91) = burger 71 + hranolky_male 73 + bočná Pesto 50g
--     Pesto majonéza zatiaľ nemá vlastnú menu-recipe; bočná omáčka = 50g Pesto raw.
UPDATE menu_items SET track_mode='recipe' WHERE id = 91;
DELETE FROM recipes WHERE menu_item_id = 91;
WITH side_sauce AS (
  SELECT (SELECT id FROM ingredients WHERE name='Pesto') AS ingredient_id, 50.000 AS qty_per_unit
), all_lines AS (
  SELECT ingredient_id, qty_per_unit FROM recipes WHERE menu_item_id IN (71, 73)
  UNION ALL
  SELECT ingredient_id, qty_per_unit FROM side_sauce
)
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit)
SELECT 91, ingredient_id, SUM(qty_per_unit)
FROM all_lines
GROUP BY ingredient_id;


-- 4) Verify — prehľad surovín na 1 combo
SELECT mi.id, mi.name AS combo, COUNT(r.id) AS recipe_lines,
       ROUND(SUM(r.qty_per_unit * i.cost_per_unit::numeric), 4) AS cost_eur
FROM menu_items mi
LEFT JOIN recipes r ON r.menu_item_id = mi.id
LEFT JOIN ingredients i ON i.id = r.ingredient_id
WHERE mi.id IN (71, 88, 89, 90, 91)
GROUP BY mi.id, mi.name
ORDER BY mi.id;
