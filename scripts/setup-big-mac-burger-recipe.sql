-- Recipe: Big Mac Smash burger (menu_item id=68)
-- Per-burger ingredient breakdown ako poslal operátor:
--   Bulka 66g, Mäso 140g, Cheddar 40g, Cibuľa 10g, Uhorka kyslá 16g,
--   Šalát 20g, Slanina 20g, Sos 45g
-- Sos 45g = 90% nášho Big Mac sauce 50g recept → INLINE-ujeme všetky
-- raw ingrediencie sauce (proporčne ×0.9), takže pri predaji burgera
-- sa odpíšu okrem toho čo je viditeľne na burgeri AJ vnútorné suroviny
-- v sose. Nepoužívame tu menu_item Omáčka Big Mac 50ml ako "ingredient"
-- (recipes.ingredient_id musí byť ingredient, nie menu_item) — jediná
-- alternatíva by bol polotovar 'Big Mac sauce hotová', čo by ale dalo
-- duplicitnú evidenciu so štandardnou Omáčkou Big Mac.
--
-- Spojené sumy (visible topping + zo sauce):
--   Cibuľa biela: 10 + 3.611 = 13.611g
--   Uhorky steril.: 16 + 7.222 = 23.222g

BEGIN;

-- 1) Pridaj Bulka Big Mac (chýba)
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active)
VALUES ('Bulka Big Mac', 'g', 'ingredient', 0, 0, 0, true)
ON CONFLICT DO NOTHING;

-- 2) Konverzia jednotiek pre suroviny ktoré recept potrebuje v gramoch
--    (ak už sú v 'g', UPDATE má 0 vplyv vďaka WHERE unit='ks/kg').
--    Hovädzie mleté: 1 ks ≈ 5 kg = 5000 g
UPDATE ingredients SET unit='g', current_qty=current_qty*5000, cost_per_unit=cost_per_unit/5000
  WHERE name='Hovädzie mleté mäso 70/30 cca 5kg Bognár' AND unit='ks';
--    Cheddar plátky 1kg: 1 ks = 1000 g
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000
  WHERE name='Syr Cheddar plátky 1kg Vepo' AND unit='ks';
--    Šalát ľadový kal. 10: 1 ks ≈ 300 g (priemerná hlávka), cena 1.79/300 ≈ 0.00597 €/g
UPDATE ingredients SET unit='g', current_qty=current_qty*300, cost_per_unit=cost_per_unit/300
  WHERE name='Šalát ľadový kal. 10' AND unit='ks';
--    Slanina Bacon plátky 1kg: 1 kg = 1000 g
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000
  WHERE name='Slanina Bacon plátky 1kg Gierlinger' AND unit='kg';

-- 3) Označ Big Mac Smash burger ako recipe-tracked
UPDATE menu_items SET track_mode='recipe' WHERE id = 68;

-- 4) Vyčisti staré recipe-riadky (idempotentné)
DELETE FROM recipes WHERE menu_item_id = 68;

-- 5) Vlož recipe-riadky (qty v g)
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  -- Visible burger toppings
  (68, (SELECT id FROM ingredients WHERE name='Bulka Big Mac'),                              66.000),
  (68, (SELECT id FROM ingredients WHERE name='Hovädzie mleté mäso 70/30 cca 5kg Bognár'),  140.000),
  (68, (SELECT id FROM ingredients WHERE name='Syr Cheddar plátky 1kg Vepo'),               40.000),
  (68, (SELECT id FROM ingredients WHERE name='Šalát ľadový kal. 10'),                       20.000),
  (68, (SELECT id FROM ingredients WHERE name='Slanina Bacon plátky 1kg Gierlinger'),        20.000),
  -- Cibuľa biela: 10g visible + 3.611g zo sauce (4.012 × 0.9)
  (68, (SELECT id FROM ingredients WHERE name='Cibuľa biela kal. 50-70'),                   13.611),
  -- Uhorky steril.: 16g visible + 7.222g zo sauce (8.024 × 0.9)
  (68, (SELECT id FROM ingredients WHERE name='Uhorky sterilizované 9-12cm 3720ml Ady'),    23.222),
  -- Sauce-only suroviny (× 0.9 = 45/50 podiel z full sauce recipe):
  (68, (SELECT id FROM ingredients WHERE name='French''s horčica'),                          2.407),
  (68, (SELECT id FROM ingredients WHERE name='Ocot biely'),                                 0.481),
  (68, (SELECT id FROM ingredients WHERE name='Korenie Paprika sladká 30g Mäspoma'),         0.240),
  (68, (SELECT id FROM ingredients WHERE name='Cukor kryštálový Korunný 1kg'),               0.722),
  (68, (SELECT id FROM ingredients WHERE name='Soľ'),                                        0.120),
  (68, (SELECT id FROM ingredients WHERE name='Cesnak voľný kal. 55-60'),                    0.120),
  (68, (SELECT id FROM ingredients WHERE name='Majonéza Premium 5kg Zárubova'),             30.080);

-- 6) Verify
SELECT mi.name AS burger,
       COUNT(r.id) AS lines,
       ROUND(SUM(r.qty_per_unit), 2) AS total_g_per_burger
FROM menu_items mi LEFT JOIN recipes r ON r.menu_item_id = mi.id
WHERE mi.id = 68 GROUP BY mi.name;

SELECT i.name, r.qty_per_unit AS g, i.unit
FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
WHERE r.menu_item_id = 68
ORDER BY r.qty_per_unit DESC;

COMMIT;
