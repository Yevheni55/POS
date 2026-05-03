-- ============================================================================
-- Cleanup + import of 5 LUNYS invoices (24.4 - 2.5.2026) as proper purchase
-- orders. Replaces the earlier hand-INSERTed ingredients (id 30-101) with a
-- normalized flow:
--   1. DELETE the bare ingredient rows
--   2. Re-INSERT ingredients (deduped across invoices)
--   3. Per invoice: INSERT purchase_orders (status='received', received_at =
--      invoice date), INSERT purchase_order_items with quantity + unit_cost
--      WITH VAT, UPDATE ingredients.current_qty (sum across invoices), set
--      cost_per_unit to the most-recent unit cost, INSERT stock_movements.
--
-- All unit_cost values are the "Jedn. cena s DPH" column from the PDF
-- (i.e. what the operator actually paid per unit). Quantities come from
-- the "Pocet" column.
-- ============================================================================

BEGIN;

-- 1) CLEANUP. Drop the 72 bare-ingredient rows we hand-added across the
-- previous 3 import scripts. No PO items reference them yet, so no FK
-- violation. attendance_payouts.cashflow_entry_id and other unrelated FKs
-- are unaffected because we only touch ingredients id 30-101.
DELETE FROM stock_movements WHERE ingredient_id BETWEEN 30 AND 101;
DELETE FROM ingredients WHERE id BETWEEN 30 AND 101;

-- 2) Re-INSERT all unique ingredient names (deduped across the 5 invoices).
-- Names match exactly what the PO items will look up by (SELECT id FROM
-- ingredients WHERE name=...) so any typo here breaks the import.
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  ('Mlieko plnotučné 3,5% bezlaktózové 1l Rajo',           'ks', 'ingredient', 0, 0, 0, true),
  ('Zázvor kal. 250+',                                      'kg', 'ingredient', 0, 0, 0, true),
  ('Relax Džús Jablko 200 ml',                              'ks', 'ingredient', 0, 0, 0, true),
  ('Limeta zelená (kg) kal. 48-54',                         'kg', 'ingredient', 0, 0, 0, true),
  ('Citrón Primofiori ukladaný kal. 4-5',                   'kg', 'ingredient', 0, 0, 0, true),
  ('Bylinky - Máta',                                         'kg', 'ingredient', 0, 0, 0, true),
  ('Cukor kryštálový Korunný 1kg',                          'ks', 'ingredient', 0, 0, 0, true),
  ('Víno biele Rizling rýnsky suchý 0,75l SK',              'ks', 'ingredient', 0, 0, 0, true),
  ('Relax Džús Pomaranč 200 ml',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Coca Cola 500ml',                                        'ks', 'ingredient', 0, 0, 0, true),
  ('San Pellegrino Máta & citrón 330ml',                    'ks', 'ingredient', 0, 0, 0, true),
  ('Sprite Citrón limetka 500 ml',                           'ks', 'ingredient', 0, 0, 0, true),
  ('Mlieko plnotučné 3,5% UHT 1l Rajo',                     'ks', 'ingredient', 0, 0, 0, true),
  ('Kiwi Hayward voľne kal. 23-27',                          'kg', 'ingredient', 0, 0, 0, true),
  ('Cukor trstinový Demerara 1kg Vido',                      'ks', 'ingredient', 0, 0, 0, true),
  ('Prosecco Valfonda D.O.C Extra Dry 0,75l IT',             'ks', 'ingredient', 0, 0, 0, true),
  ('Mrazené Maliny 250g Sládkovičovo',                       'ks', 'ingredient', 0, 0, 0, true),
  ('Mrazené Mango kocky 200g Nowaco',                        'ks', 'ingredient', 0, 0, 0, true),
  ('Mr. Ananás extra sladký 2,5kg Ardo',                     'ks', 'ingredient', 0, 0, 0, true),
  ('Pyré svieža marakuja 1l Pureé',                           'ks', 'ingredient', 0, 0, 0, true),
  ('Kofola Original KEG 50l',                                 'ks', 'ingredient', 0, 0, 0, true),
  ('Korenie Paprika sladká 30g Mäspoma',                     'ks', 'ingredient', 0, 0, 0, true),
  ('Korenie Chilli papričky celé 7g Mäspoma',                 'ks', 'ingredient', 0, 0, 0, true),
  ('Šalát ľadový kal. 10',                                     'ks', 'ingredient', 0, 0, 0, true),
  ('Uhorka hadovka kal. 12P-16',                             'kg', 'ingredient', 0, 0, 0, true),
  ('Cibuľa biela kal. 50-70',                                 'kg', 'ingredient', 0, 0, 0, true),
  ('Cibuľa červená kal. 60-80',                              'kg', 'ingredient', 0, 0, 0, true),
  ('Uhorky sterilizované 9-12cm 3720ml Ady',                 'ks', 'ingredient', 0, 0, 0, true),
  ('Paradajky Cherry oválne 250g',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Jalapeños papričky krájané 3100ml Bassta',                'ks', 'ingredient', 0, 0, 0, true),
  ('Citrónka NATUR FARM 40% 1,5L',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Cesnak voľný kal. 55-60',                                 'kg', 'ingredient', 0, 0, 0, true),
  ('Sanytol Dezinfekčné mydlo do kuchyne 250 ml',            'ks', 'ingredient', 0, 0, 0, true),
  ('Syr Halloumi 850g Alambra',                               'ks', 'ingredient', 0, 0, 0, true),
  ('Syr Cheddar plátky 1kg Vepo',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Cukor biely porciovaný HB 40x5g SNOTY',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Cukor trstinový porciovaný HB 40x4,3g SNOTY',            'ks', 'ingredient', 0, 0, 0, true),
  ('Horčica dijónska 1kg Dijona',                             'ks', 'ingredient', 0, 0, 0, true),
  ('Jar Professional na umývanie riadu 5l',                   'ks', 'ingredient', 0, 0, 0, true),
  ('Korenie Paprika údená sladká mletá 25g Kotányi',         'ks', 'ingredient', 0, 0, 0, true),
  ('Cibuľa smažená chrumkavá 2,5kg Royal Orient',            'ks', 'ingredient', 0, 0, 0, true),
  ('Saláma Chorizo nárez 500g ElPozo',                        'ks', 'ingredient', 0, 0, 0, true),
  ('Hovädzie mleté mäso 70/30 cca 5kg Bognár',                'ks', 'ingredient', 0, 0, 0, true),
  ('Majonéza Premium 5kg Zárubova',                          'ks', 'ingredient', 0, 0, 0, true),
  ('Majster Papier utierky 2 vrstvy 6roliek',                 'ks', 'ingredient', 0, 0, 0, true),
  ('Linteo tekuté mydlo 5l',                                  'ks', 'ingredient', 0, 0, 0, true),
  ('Pomaranč na šťavu Navelina kal. 6/7',                     'kg', 'ingredient', 0, 0, 0, true),
  ('Múka pšeničná polohrubá výberová 1kg Kolárovo',          'ks', 'ingredient', 0, 0, 0, true),
  ('Mlieko plnotučné 3,6% Bio čerstvé 1l Tami',              'ks', 'ingredient', 0, 0, 0, true),
  ('Olej olivový z výliskov 1l Bassta',                       'ks', 'ingredient', 0, 0, 0, true),
  ('Kečup jemný Gurmán 860g Otma',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Kuracie prsia cca 600g TopFarm',                          'ks', 'ingredient', 0, 0, 0, true),
  ('Slanina Bacon plátky 1kg Gierlinger',                    'ks', 'ingredient', 0, 0, 0, true),
  ('Kinley Pink Aromatic Berry 500ml',                        'ks', 'ingredient', 0, 0, 0, true),
  ('Rukavice nitrilové čierne v.L 100ks',                     'ks', 'ingredient', 0, 0, 0, true),
  ('Rukavice nitrilové čierne v.M 100ks',                     'ks', 'ingredient', 0, 0, 0, true),
  ('Slamky papierové 15x0,8cm čierne 100ks',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Slamky papierové 25x0,8cm čierne 100ks',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Kefír plnotučný 3,3% 950g Babička',                      'ks', 'ingredient', 0, 0, 0, true),
  ('Finish Shine & Protect Regular leštidlo 800 ml',          'ks', 'ingredient', 0, 0, 0, true),
  ('Orion Kuchynská utierka My kitchen greenish 2ks',         'ks', 'ingredient', 0, 0, 0, true),
  ('Mrazená Zmes lesné ovocie 2,5kg Viking Frost',            'ks', 'ingredient', 0, 0, 0, true),
  ('Balená Máta 30g',                                          'ks', 'ingredient', 0, 0, 0, true),
  ('Mlieko Barista 3,5% 1l Rajo',                             'ks', 'ingredient', 0, 0, 0, true),
  ('Mrazené Mango kocky 2,5kg Viking Frost',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Víno šumivé biele I Heart Prosecco Frizzante 0,75l IT',   'ks', 'ingredient', 0, 0, 0, true),
  ('Kuracie prsia rezne cca 700g Hyza',                       'ks', 'ingredient', 0, 0, 0, true),
  ('Horčica plnotučná vedro 5kg',                              'ks', 'ingredient', 0, 0, 0, true),
  ('Ľad mrazený kocky 2kg Ice Service',                       'ks', 'ingredient', 0, 0, 0, true),
  ('Med kvetový HB 200x10g SNOTY',                             'ks', 'ingredient', 0, 0, 0, true),
  ('Thomas Henry Ginger Beer 200ml',                           'ks', 'ingredient', 0, 0, 0, true),
  ('Tatranský cmar 400ml Tami',                                'ks', 'ingredient', 0, 0, 0, true);

-- 3) Helper: PL/pgSQL block to insert one PO + its items + update ingredient
-- qty + cost + record stock movements. Repeated for each invoice.
-- ============================================================================

DO $$
DECLARE
  po_id INT;
  v_ingredient_id INT;
  v_qty NUMERIC;
  v_cost NUMERIC;
  v_total NUMERIC;
  v_prev NUMERIC;
  v_next NUMERIC;
  -- supplier=3 (Lunys), creator=1 (Yevhen admin), receiver=1
  v_supplier INT := 3;
  v_staff INT := 1;
  v_invoice_total NUMERIC;
  -- One row per (ingredient_name, qty, unit_cost_with_vat). PG arrays of
  -- composite types would be cleaner; cursor over a temp table is simpler.
BEGIN
  -- Each invoice block: (1) compute total, (2) insert PO, (3) insert items
  -- via temp table loop, (4) finalize PO.

  -- =================== INVOICE 2620OE0100180530 (24.4.2026) ===================
  CREATE TEMP TABLE _inv1(name TEXT, qty NUMERIC, unit_cost NUMERIC) ON COMMIT DROP;
  INSERT INTO _inv1 VALUES
    ('Mlieko plnotučné 3,5% bezlaktózové 1l Rajo', 1,   2.00),
    ('Zázvor kal. 250+',                            1,   1.14),
    ('Relax Džús Jablko 200 ml',                    5,   0.60),
    ('Limeta zelená (kg) kal. 48-54',               1,   4.99),
    ('Citrón Primofiori ukladaný kal. 4-5',         1,   3.99),
    ('Bylinky - Máta',                              0.1, 19.69),
    ('Cukor kryštálový Korunný 1kg',                1,   1.25),
    ('Víno biele Rizling rýnsky suchý 0,75l SK',    3,   4.10),
    ('Relax Džús Pomaranč 200 ml',                  5,   0.70),
    ('Coca Cola 500ml',                             4,   1.40),
    ('San Pellegrino Máta & citrón 330ml',          4,   1.30),
    ('Sprite Citrón limetka 500 ml',                4,   1.40),
    ('Mlieko plnotučné 3,5% UHT 1l Rajo',           2,   1.40),
    ('Kiwi Hayward voľne kal. 23-27',               15,  0.46),
    ('Cukor trstinový Demerara 1kg Vido',           1,   2.10),
    ('Prosecco Valfonda D.O.C Extra Dry 0,75l IT',  4,   5.70),
    ('Mrazené Maliny 250g Sládkovičovo',            3,   3.90),
    ('Mrazené Mango kocky 200g Nowaco',             2,   2.05),
    ('Mr. Ananás extra sladký 2,5kg Ardo',          1,   12.90),
    ('Pyré svieža marakuja 1l Pureé',                1,   16.90),
    ('Kofola Original KEG 50l',                      1,   75.40);
  SELECT COALESCE(SUM(qty * unit_cost), 0) INTO v_invoice_total FROM _inv1;
  INSERT INTO purchase_orders (supplier_id, status, total_cost, note, created_by, received_by, created_at, received_at)
  VALUES (v_supplier, 'received', v_invoice_total, 'Faktúra 2620OE0100180530 (LUNYS, 24.4.2026)', v_staff, v_staff, '2026-04-24'::timestamp, '2026-04-24'::timestamp)
  RETURNING id INTO po_id;

  FOR v_ingredient_id, v_qty, v_cost IN
    SELECT i.id, _inv1.qty, _inv1.unit_cost
    FROM _inv1 JOIN ingredients i ON i.name = _inv1.name
  LOOP
    v_total := ROUND(v_qty * v_cost, 2);
    INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, invoice_unit, conversion_factor, unit_cost, total_cost)
    VALUES (po_id, v_ingredient_id, v_qty, '', 1, v_cost, v_total);
    SELECT current_qty INTO v_prev FROM ingredients WHERE id = v_ingredient_id;
    v_next := ROUND(v_prev + v_qty, 3);
    UPDATE ingredients SET current_qty = v_next, cost_per_unit = v_cost WHERE id = v_ingredient_id;
    INSERT INTO stock_movements (type, ingredient_id, quantity, previous_qty, new_qty, reference_type, reference_id, staff_id)
    VALUES ('purchase', v_ingredient_id, v_qty, v_prev, v_next, 'purchase_order', po_id, v_staff);
  END LOOP;
  DROP TABLE _inv1;

  -- =================== INVOICE 2620OE0100188818 (29.4.2026) ===================
  CREATE TEMP TABLE _inv2(name TEXT, qty NUMERIC, unit_cost NUMERIC) ON COMMIT DROP;
  INSERT INTO _inv2 VALUES
    ('Korenie Paprika sladká 30g Mäspoma',          4,    0.55),
    ('Korenie Chilli papričky celé 7g Mäspoma',     5,    0.60),
    ('Šalát ľadový kal. 10',                         5,    1.79),
    ('Uhorka hadovka kal. 12P-16',                  2,    0.81),
    ('Cibuľa biela kal. 50-70',                     2.94, 2.39),
    ('Cibuľa červená kal. 60-80',                   2.98, 1.59),
    ('Uhorky sterilizované 9-12cm 3720ml Ady',      1,    5.10),
    ('Paradajky Cherry oválne 250g',                 3,    1.89),
    ('Jalapeños papričky krájané 3100ml Bassta',     1,    6.50),
    ('Citrónka NATUR FARM 40% 1,5L',                 1,    1.70),
    ('Cesnak voľný kal. 55-60',                     0.5,  5.09),
    ('Sanytol Dezinfekčné mydlo do kuchyne 250 ml', 1,    2.15),
    ('Syr Halloumi 850g Alambra',                    2,    12.60),
    ('Syr Cheddar plátky 1kg Vepo',                 2,    10.40),
    ('Cukor biely porciovaný HB 40x5g SNOTY',       7,    0.90),
    ('Cukor trstinový porciovaný HB 40x4,3g SNOTY', 7,    1.00),
    ('Horčica dijónska 1kg Dijona',                  1,    5.20),
    ('Jar Professional na umývanie riadu 5l',        1,    11.75),
    ('Korenie Paprika údená sladká mletá 25g Kotányi', 5, 0.70),
    ('Cibuľa smažená chrumkavá 2,5kg Royal Orient', 1,    15.00),
    ('Saláma Chorizo nárez 500g ElPozo',             2,    7.20),
    ('Hovädzie mleté mäso 70/30 cca 5kg Bognár',     1,    51.00),
    ('Majonéza Premium 5kg Zárubova',               2,    15.90),
    ('Majster Papier utierky 2 vrstvy 6roliek',      1,    14.39),
    ('Linteo tekuté mydlo 5l',                       1,    6.39);
  SELECT COALESCE(SUM(qty * unit_cost), 0) INTO v_invoice_total FROM _inv2;
  INSERT INTO purchase_orders (supplier_id, status, total_cost, note, created_by, received_by, created_at, received_at)
  VALUES (v_supplier, 'received', v_invoice_total, 'Faktúra 2620OE0100188818 (LUNYS, 29.4.2026)', v_staff, v_staff, '2026-04-29'::timestamp, '2026-04-29'::timestamp)
  RETURNING id INTO po_id;

  FOR v_ingredient_id, v_qty, v_cost IN
    SELECT i.id, _inv2.qty, _inv2.unit_cost
    FROM _inv2 JOIN ingredients i ON i.name = _inv2.name
  LOOP
    v_total := ROUND(v_qty * v_cost, 2);
    INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, invoice_unit, conversion_factor, unit_cost, total_cost)
    VALUES (po_id, v_ingredient_id, v_qty, '', 1, v_cost, v_total);
    SELECT current_qty INTO v_prev FROM ingredients WHERE id = v_ingredient_id;
    v_next := ROUND(v_prev + v_qty, 3);
    UPDATE ingredients SET current_qty = v_next, cost_per_unit = v_cost WHERE id = v_ingredient_id;
    INSERT INTO stock_movements (type, ingredient_id, quantity, previous_qty, new_qty, reference_type, reference_id, staff_id)
    VALUES ('purchase', v_ingredient_id, v_qty, v_prev, v_next, 'purchase_order', po_id, v_staff);
  END LOOP;
  DROP TABLE _inv2;

  -- =================== INVOICE 2620OE0100191379 (30.4.2026) ===================
  CREATE TEMP TABLE _inv3(name TEXT, qty NUMERIC, unit_cost NUMERIC) ON COMMIT DROP;
  INSERT INTO _inv3 VALUES
    ('Cibuľa červená kal. 60-80',                   4,   1.59),
    ('Pomaranč na šťavu Navelina kal. 6/7',         3,   0.42),
    ('Múka pšeničná polohrubá výberová 1kg Kolárovo', 1, 0.75),
    ('Mlieko plnotučné 3,6% Bio čerstvé 1l Tami',   2,   1.45),
    ('Olej olivový z výliskov 1l Bassta',            2,   7.00),
    ('Kečup jemný Gurmán 860g Otma',                 1,   3.70),
    ('Kuracie prsia cca 600g TopFarm',               1,   5.07),
    ('Horčica dijónska 1kg Dijona',                  1,   5.20),
    ('Slanina Bacon plátky 1kg Gierlinger',          1,   11.00),
    ('Kinley Pink Aromatic Berry 500ml',             3,   1.40),
    ('Rukavice nitrilové čierne v.L 100ks',          1,   5.95),
    ('Rukavice nitrilové čierne v.M 100ks',          1,   5.95),
    ('Slamky papierové 15x0,8cm čierne 100ks',       2,   1.55),
    ('Slamky papierové 25x0,8cm čierne 100ks',       2,   1.75),
    ('Kefír plnotučný 3,3% 950g Babička',            1,   1.85);
  SELECT COALESCE(SUM(qty * unit_cost), 0) INTO v_invoice_total FROM _inv3;
  INSERT INTO purchase_orders (supplier_id, status, total_cost, note, created_by, received_by, created_at, received_at)
  VALUES (v_supplier, 'received', v_invoice_total, 'Faktúra 2620OE0100191379 (LUNYS, 30.4.2026)', v_staff, v_staff, '2026-04-30'::timestamp, '2026-04-30'::timestamp)
  RETURNING id INTO po_id;

  FOR v_ingredient_id, v_qty, v_cost IN
    SELECT i.id, _inv3.qty, _inv3.unit_cost
    FROM _inv3 JOIN ingredients i ON i.name = _inv3.name
  LOOP
    v_total := ROUND(v_qty * v_cost, 2);
    INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, invoice_unit, conversion_factor, unit_cost, total_cost)
    VALUES (po_id, v_ingredient_id, v_qty, '', 1, v_cost, v_total);
    SELECT current_qty INTO v_prev FROM ingredients WHERE id = v_ingredient_id;
    v_next := ROUND(v_prev + v_qty, 3);
    UPDATE ingredients SET current_qty = v_next, cost_per_unit = v_cost WHERE id = v_ingredient_id;
    INSERT INTO stock_movements (type, ingredient_id, quantity, previous_qty, new_qty, reference_type, reference_id, staff_id)
    VALUES ('purchase', v_ingredient_id, v_qty, v_prev, v_next, 'purchase_order', po_id, v_staff);
  END LOOP;
  DROP TABLE _inv3;

  -- =================== INVOICE 2620OE0100192930 (2.5.2026) ====================
  CREATE TEMP TABLE _inv4(name TEXT, qty NUMERIC, unit_cost NUMERIC) ON COMMIT DROP;
  INSERT INTO _inv4 VALUES
    ('Finish Shine & Protect Regular leštidlo 800 ml',  1, 3.69),
    ('Hovädzie mleté mäso 70/30 cca 5kg Bognár',        5, 10.20),
    ('Orion Kuchynská utierka My kitchen greenish 2ks', 1, 7.20);
  SELECT COALESCE(SUM(qty * unit_cost), 0) INTO v_invoice_total FROM _inv4;
  INSERT INTO purchase_orders (supplier_id, status, total_cost, note, created_by, received_by, created_at, received_at)
  VALUES (v_supplier, 'received', v_invoice_total, 'Faktúra 2620OE0100192930 (LUNYS, 2.5.2026)', v_staff, v_staff, '2026-05-02'::timestamp, '2026-05-02 09:00'::timestamp)
  RETURNING id INTO po_id;

  FOR v_ingredient_id, v_qty, v_cost IN
    SELECT i.id, _inv4.qty, _inv4.unit_cost
    FROM _inv4 JOIN ingredients i ON i.name = _inv4.name
  LOOP
    v_total := ROUND(v_qty * v_cost, 2);
    INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, invoice_unit, conversion_factor, unit_cost, total_cost)
    VALUES (po_id, v_ingredient_id, v_qty, '', 1, v_cost, v_total);
    SELECT current_qty INTO v_prev FROM ingredients WHERE id = v_ingredient_id;
    v_next := ROUND(v_prev + v_qty, 3);
    UPDATE ingredients SET current_qty = v_next, cost_per_unit = v_cost WHERE id = v_ingredient_id;
    INSERT INTO stock_movements (type, ingredient_id, quantity, previous_qty, new_qty, reference_type, reference_id, staff_id)
    VALUES ('purchase', v_ingredient_id, v_qty, v_prev, v_next, 'purchase_order', po_id, v_staff);
  END LOOP;
  DROP TABLE _inv4;

  -- =================== INVOICE 2620OE0100193661 (2.5.2026) ====================
  CREATE TEMP TABLE _inv5(name TEXT, qty NUMERIC, unit_cost NUMERIC) ON COMMIT DROP;
  INSERT INTO _inv5 VALUES
    ('Uhorka hadovka kal. 12P-16',                         4,   0.81),
    ('Mrazená Zmes lesné ovocie 2,5kg Viking Frost',       1,   12.30),
    ('Pomaranč na šťavu Navelina kal. 6/7',                1.5, 2.09),
    ('Balená Máta 30g',                                     2,   1.39),
    ('Uhorky sterilizované 9-12cm 3720ml Ady',             1,   5.10),
    ('Limeta zelená (kg) kal. 48-54',                      2,   4.59),
    ('Mlieko Barista 3,5% 1l Rajo',                        2,   1.45),
    ('Citrón Primofiori ukladaný kal. 4-5',                2,   3.99),
    ('Syr Cheddar plátky 1kg Vepo',                        2,   10.40),
    ('Mrazené Mango kocky 2,5kg Viking Frost',             1,   10.30),
    ('Kečup jemný Gurmán 860g Otma',                       2,   3.70),
    ('Víno šumivé biele I Heart Prosecco Frizzante 0,75l IT', 4, 4.90),
    ('Kuracie prsia rezne cca 700g Hyza',                  1,   5.01),
    ('Horčica plnotučná vedro 5kg',                         1,   8.00),
    ('Ľad mrazený kocky 2kg Ice Service',                  3,   2.42),
    ('Med kvetový HB 200x10g SNOTY',                        1,   19.30),
    ('Thomas Henry Ginger Beer 200ml',                      4,   1.40),
    ('Slanina Bacon plátky 1kg Gierlinger',                1,   11.00),
    ('Tatranský cmar 400ml Tami',                           3,   0.70);
  SELECT COALESCE(SUM(qty * unit_cost), 0) INTO v_invoice_total FROM _inv5;
  INSERT INTO purchase_orders (supplier_id, status, total_cost, note, created_by, received_by, created_at, received_at)
  VALUES (v_supplier, 'received', v_invoice_total, 'Faktúra 2620OE0100193661 (LUNYS, 2.5.2026)', v_staff, v_staff, '2026-05-02'::timestamp, '2026-05-02 14:00'::timestamp)
  RETURNING id INTO po_id;

  FOR v_ingredient_id, v_qty, v_cost IN
    SELECT i.id, _inv5.qty, _inv5.unit_cost
    FROM _inv5 JOIN ingredients i ON i.name = _inv5.name
  LOOP
    v_total := ROUND(v_qty * v_cost, 2);
    INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, invoice_unit, conversion_factor, unit_cost, total_cost)
    VALUES (po_id, v_ingredient_id, v_qty, '', 1, v_cost, v_total);
    SELECT current_qty INTO v_prev FROM ingredients WHERE id = v_ingredient_id;
    v_next := ROUND(v_prev + v_qty, 3);
    UPDATE ingredients SET current_qty = v_next, cost_per_unit = v_cost WHERE id = v_ingredient_id;
    INSERT INTO stock_movements (type, ingredient_id, quantity, previous_qty, new_qty, reference_type, reference_id, staff_id)
    VALUES ('purchase', v_ingredient_id, v_qty, v_prev, v_next, 'purchase_order', po_id, v_staff);
  END LOOP;
  DROP TABLE _inv5;

END $$;

-- 4) Verify: counts, ingredient summary, PO summary
SELECT 'ingredients_added' AS metric, COUNT(*)::text AS value FROM ingredients WHERE id >= 30
UNION ALL SELECT 'purchase_orders_added', COUNT(*)::text FROM purchase_orders WHERE supplier_id = 3 AND created_at >= '2026-04-24'
UNION ALL SELECT 'purchase_order_items_added', COUNT(*)::text FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE supplier_id = 3 AND created_at >= '2026-04-24')
UNION ALL SELECT 'stock_movements_added', COUNT(*)::text FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id IN (SELECT id FROM purchase_orders WHERE supplier_id = 3 AND created_at >= '2026-04-24')
UNION ALL SELECT 'po_total_eur', ROUND(SUM(total_cost), 2)::text FROM purchase_orders WHERE supplier_id = 3 AND created_at >= '2026-04-24';

COMMIT;
