-- ============================================================================
-- Recepty pre 3 domáce omáčky (BIG MAC majo, Tatárka, Zaúdená chilli) +
-- auto-odpis surovín pri každom predaji (50 ml porcia).
--
-- Yields per recept:
--   BIG MAC majonéza    : 7480g  / 50g porcia ≈ 149.6 porcií
--   Tatárka              : ~5950g / 50g porcia ≈ 119  porcií
--   Zaúdená chilli       : 5852g  / 50g porcia ≈ 117  porcií
--
-- Aby auto-odpis fungoval gram-presne (3 desatinné miesta v recipes.qty),
-- musíme konvertovať jednotky surovín z "ks/kg" na "g" + prepočítať
-- current_qty a cost_per_unit. Po-merge všetky polčky sú v gramoch.
--
-- Existujúce po_items.conversion_factor sa neaktualizujú (boli už received,
-- current_qty je správna v gramoch po konverzii). Pre BUDÚCE PO bude treba
-- pri vytvorení vyplniť conversion_factor = veľkosť balenia v gramoch.
-- ============================================================================

BEGIN;

-- 1) KONVERZIA existujúcich surovín do gramov.
-- Vzorec: nová qty = stará qty × balenie_g; nová cena/g = stará cena / balenie_g
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000 WHERE name='Cukor kryštálový Korunný 1kg';
UPDATE ingredients SET unit='g', current_qty=current_qty*30,   cost_per_unit=cost_per_unit/30   WHERE name='Korenie Paprika sladká 30g Mäspoma';
UPDATE ingredients SET unit='g', current_qty=current_qty*25,   cost_per_unit=cost_per_unit/25   WHERE name='Korenie Paprika údená sladká mletá 25g Kotányi';
UPDATE ingredients SET unit='g', current_qty=current_qty*7,    cost_per_unit=cost_per_unit/7    WHERE name='Korenie Chilli papričky celé 7g Mäspoma';
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000 WHERE name='Cesnak voľný kal. 55-60';
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=cost_per_unit/1000 WHERE name='Cibuľa biela kal. 50-70';
UPDATE ingredients SET unit='g', current_qty=current_qty*3500, cost_per_unit=cost_per_unit/3500 WHERE name='Uhorky sterilizované 9-12cm 3720ml Ady';
UPDATE ingredients SET unit='g', current_qty=current_qty*3000, cost_per_unit=cost_per_unit/3000 WHERE name='Jalapeños papričky krájané 3100ml Bassta';
UPDATE ingredients SET unit='g', current_qty=current_qty*5000, cost_per_unit=cost_per_unit/5000 WHERE name='Majonéza Premium 5kg Zárubova';

-- 2) Pridaj NOVÉ suroviny potrebné pre recepty (qty=0, doplníš po nákupe).
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  ('French''s horčica',         'g', 'ingredient', 0, 0, 0, true),
  ('Ocot biely',                 'g', 'ingredient', 0, 0, 0, true),
  ('Soľ',                        'g', 'ingredient', 0, 0, 0, true),
  ('Kapary',                     'g', 'ingredient', 0, 0, 0, true),
  ('Nálev z domácich uhoriek',   'g', 'ingredient', 0, 0, 0, true),
  ('Pažitka čerstvá',            'g', 'ingredient', 0, 0, 0, true),
  ('Chipotles',                  'g', 'ingredient', 0, 0, 0, true),
  ('Čierne mleté korenie',       'g', 'ingredient', 0, 0, 0, true),
  ('Citrónová šťava',            'g', 'ingredient', 0, 0, 0, true)
ON CONFLICT DO NOTHING;

-- 3) Označ menu items 82/83/84 ako recipe-tracked (auto-deduct zapne sa
--    iba pre trackMode='recipe').
UPDATE menu_items SET track_mode='recipe' WHERE id IN (82, 83, 84);

-- 4) Vymaž staré recept-riadky (keby existovali z predchádzajúcich pokusov).
DELETE FROM recipes WHERE menu_item_id IN (82, 83, 84);

-- 5) Vlož recept-riadky. qty_per_unit je v gramoch, ingredient.unit je 'g'.
-- ====== BIG MAC MAJONÉZA (menu_item_id=82, yield 149.6 porcií @ 50g) ======
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (82, (SELECT id FROM ingredients WHERE name='Uhorky sterilizované 9-12cm 3720ml Ady'), 8.024),
  (82, (SELECT id FROM ingredients WHERE name='Cibuľa biela kal. 50-70'),                 4.012),
  (82, (SELECT id FROM ingredients WHERE name='French''s horčica'),                       2.674),
  (82, (SELECT id FROM ingredients WHERE name='Ocot biely'),                              0.535),
  (82, (SELECT id FROM ingredients WHERE name='Korenie Paprika sladká 30g Mäspoma'),      0.267),
  (82, (SELECT id FROM ingredients WHERE name='Cukor kryštálový Korunný 1kg'),            0.802),
  (82, (SELECT id FROM ingredients WHERE name='Soľ'),                                     0.134),
  (82, (SELECT id FROM ingredients WHERE name='Cesnak voľný kal. 55-60'),                 0.134),
  (82, (SELECT id FROM ingredients WHERE name='Majonéza Premium 5kg Zárubova'),           33.422);

-- ====== TATÁRKA (menu_item_id=84, yield 119 porcií @ 50g) ======
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (84, (SELECT id FROM ingredients WHERE name='Kapary'),                                  2.521),
  (84, (SELECT id FROM ingredients WHERE name='Cibuľa biela kal. 50-70'),                 2.521),
  (84, (SELECT id FROM ingredients WHERE name='Uhorky sterilizované 9-12cm 3720ml Ady'),  1.681),
  (84, (SELECT id FROM ingredients WHERE name='Nálev z domácich uhoriek'),                1.008),
  (84, (SELECT id FROM ingredients WHERE name='Majonéza Premium 5kg Zárubova'),           42.017),
  (84, (SELECT id FROM ingredients WHERE name='Pažitka čerstvá'),                         0.252);

-- ====== ZAÚDENÁ CHILLI (menu_item_id=83, yield 117 porcií @ 50g) ======
INSERT INTO recipes (menu_item_id, ingredient_id, qty_per_unit) VALUES
  (83, (SELECT id FROM ingredients WHERE name='Jalapeños papričky krájané 3100ml Bassta'),3.418),
  (83, (SELECT id FROM ingredients WHERE name='Chipotles'),                               0.854),
  (83, (SELECT id FROM ingredients WHERE name='Korenie Paprika údená sladká mletá 25g Kotányi'), 0.427),
  (83, (SELECT id FROM ingredients WHERE name='Korenie Chilli papričky celé 7g Mäspoma'), 0.427),
  (83, (SELECT id FROM ingredients WHERE name='Cesnak voľný kal. 55-60'),                 0.342),
  (83, (SELECT id FROM ingredients WHERE name='Citrónová šťava'),                         1.709),
  (83, (SELECT id FROM ingredients WHERE name='Čierne mleté korenie'),                    0.103),
  (83, (SELECT id FROM ingredients WHERE name='Majonéza Premium 5kg Zárubova'),           42.717);

-- 6) Verify
SELECT mi.id, mi.name AS sauce, COUNT(r.id) AS lines, ROUND(SUM(r.qty_per_unit), 2) AS total_g_per_50ml
FROM menu_items mi LEFT JOIN recipes r ON r.menu_item_id = mi.id
WHERE mi.id IN (82, 83, 84) GROUP BY mi.id, mi.name ORDER BY mi.id;

SELECT 'ingredients_now_g' AS metric, COUNT(*)::text AS value FROM ingredients WHERE unit='g'
UNION ALL SELECT 'menu_items_recipe_tracked', COUNT(*)::text FROM menu_items WHERE track_mode='recipe' AND id IN (82,83,84)
UNION ALL SELECT 'recipe_rows_added', COUNT(*)::text FROM recipes WHERE menu_item_id IN (82,83,84);

COMMIT;
