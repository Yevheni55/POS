-- Bulk import suroviny from invoices 2620OE0100188818 (29.4.2026) and
-- 2620OE0100191379 (30.4.2026), LUNYS s.r.o. → Surf Spirit Drazdiak.
-- "bez množstva, len položky" — all rows insert at qty=0, cost=0.
-- Two items appear in both invoices (Cibuľa červená kal. 60-80,
-- Horčica dijónska 1kg Dijona) — kept once.
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  -- ===== Invoice 188818 (29.4.2026) =====
  ('Korenie Paprika sladká 30g Mäspoma',                    'ks', 'ingredient', 0, 0, 0, true),
  ('Korenie Chilli papričky celé 7g Mäspoma',                'ks', 'ingredient', 0, 0, 0, true),
  ('Šalát ľadový kal. 10, I.trieda',                          'ks', 'ingredient', 0, 0, 0, true),
  ('Uhorka hadovka (kg) kal. 12P-16',                        'kg', 'ingredient', 0, 0, 0, true),
  ('Cibuľa biela kal. 50-70',                                 'kg', 'ingredient', 0, 0, 0, true),
  ('Cibuľa červená kal. 60-80',                              'kg', 'ingredient', 0, 0, 0, true),
  ('Uhorky sterilizované 9-12cm 3720ml Ady',                 'ks', 'ingredient', 0, 0, 0, true),
  ('Paradajky Cherry oválne kal. 25-35 250g, I.trieda',       'ks', 'ingredient', 0, 0, 0, true),
  ('Jalapeños papričky krájané 3100ml Bassta',                'ks', 'ingredient', 0, 0, 0, true),
  ('Citrónka NATUR FARM 40% 1,5L',                            'l',  'ingredient', 0, 0, 0, true),
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
  ('Majster Papier Papierové utierky 2 vrstvy 6roliek',       'ks', 'ingredient', 0, 0, 0, true),
  ('Linteo tekuté mydlo 5l',                                  'ks', 'ingredient', 0, 0, 0, true),
  -- ===== Invoice 191379 (30.4.2026) — duplicates with 188818 omitted =====
  ('Pomaranč na šťavu Navelina kal. 6/7, II.trieda',          'kg', 'ingredient', 0, 0, 0, true),
  ('Múka pšeničná polohrubá výberová 1kg Kolárovo',          'kg', 'ingredient', 0, 0, 0, true),
  ('Mlieko plnotučné 3,6% Bio čerstvé 1l Tami',              'l',  'ingredient', 0, 0, 0, true),
  ('Olej olivový z výliskov 1l Bassta',                       'l',  'ingredient', 0, 0, 0, true),
  ('Kečup jemný Gurmán 860g Otma',                            'ks', 'ingredient', 0, 0, 0, true),
  ('Kuracie prsia cca 600g TopFarm',                          'kg', 'ingredient', 0, 0, 0, true),
  ('Slanina Bacon plátky 1kg Gierlinger',                    'kg', 'ingredient', 0, 0, 0, true),
  ('Kinley Pink Aromatic Berry 500ml ZO',                    'ks', 'ingredient', 0, 0, 0, true),
  ('Rukavice jednorazové nitrilové čierne v.L 100ks',         'ks', 'ingredient', 0, 0, 0, true),
  ('Rukavice jednorazové nitrilové čierne v.M 100ks',         'ks', 'ingredient', 0, 0, 0, true),
  ('Slamky papierové 15x0,8cm čierne 100ks',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Slamky papierové 25x0,8cm čierne 100ks',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Kefír plnotučný 3,3% 950g Babička',                      'ks', 'ingredient', 0, 0, 0, true)
RETURNING id, name, unit;
