-- Konverzia "vsetky suroviny na g alebo l, okrem flaškových"
-- Operátor chce jednotnú evidenciu — sklad v g/l, recepty pišú gramy.
-- Bottled drinks (Coca-Cola, Fanta, Romerquelle, Fuz Tea, Sprite,
-- San Pellegrino, Kinley, Thomas Henry, Tatranský cmar, Relax, Víno),
-- KEG, sachetové cukry/med, balené utierky/slamky/rukavice,
-- chemické (Jar/Linteo/Sanytol/Finish), žemle a zaloha
-- ZOSTÁVAJÚ v ks (sú to počitateľné kusy, nie merané).
--
-- Konverzia: ingredient.unit + multiply current_qty + divide cost,
-- + recipe.qty_per_unit pre receptúry ktoré položku používali.

BEGIN;

-- ============ KG → G (5 položiek, 1 kg = 1000 g) ============
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 1000,
  cost_per_unit = ROUND((cost_per_unit / 1000)::numeric, 5)
WHERE id IN (103, 105, 106, 115, 148) AND unit='kg';

-- Recipes ktoré tieto položky používali boli v kg → multiply qty × 1000
UPDATE recipes SET qty_per_unit = qty_per_unit * 1000
WHERE ingredient_id IN (103, 105, 106, 115, 148);

-- ============ KS → G (varibalné package sizes) ============
-- Cukor trstinový Demerara 1kg balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 1000,
  cost_per_unit = ROUND((cost_per_unit / 1000)::numeric, 5)
WHERE id = 116 AND unit = 'ks';

-- Mrazené Maliny 250g balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 250,
  cost_per_unit = ROUND((cost_per_unit / 250)::numeric, 5)
WHERE id = 118 AND unit = 'ks';

-- Mr. Ananás 2,5kg balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 2500,
  cost_per_unit = ROUND((cost_per_unit / 2500)::numeric, 5)
WHERE id = 120 AND unit = 'ks';

-- Cibuľa smažená 2,5kg balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 2500,
  cost_per_unit = ROUND((cost_per_unit / 2500)::numeric, 5)
WHERE id = 142 AND unit = 'ks';

-- Múka pšeničná 1kg balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 1000,
  cost_per_unit = ROUND((cost_per_unit / 1000)::numeric, 5)
WHERE id = 149 AND unit = 'ks';

-- Kefír 950g
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 950,
  cost_per_unit = ROUND((cost_per_unit / 950)::numeric, 5)
WHERE id = 160 AND unit = 'ks';

-- Mrazená zmes lesné ovocie 2,5kg
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 2500,
  cost_per_unit = ROUND((cost_per_unit / 2500)::numeric, 5)
WHERE id = 163 AND unit = 'ks';

-- Horčica plnotučná vedro 5kg
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 5000,
  cost_per_unit = ROUND((cost_per_unit / 5000)::numeric, 5)
WHERE id = 169 AND unit = 'ks';

-- Ľad mrazený kocky 2kg balenie
UPDATE ingredients SET unit='g',
  current_qty   = current_qty * 2000,
  cost_per_unit = ROUND((cost_per_unit / 2000)::numeric, 5)
WHERE id = 170 AND unit = 'ks';


-- ============ KS → L (1l, 1.5l balenie) ============
-- 4× Mlieko 1l (Bezlaktózové, UHT, Bio Tami, Barista)
UPDATE ingredients SET unit='l',
  current_qty   = current_qty * 1,
  cost_per_unit = ROUND((cost_per_unit / 1)::numeric, 5)
WHERE id IN (102, 114, 150, 165) AND unit = 'ks';

-- Pyré marakuja 1l
UPDATE ingredients SET unit='l',
  current_qty   = current_qty * 1,
  cost_per_unit = ROUND((cost_per_unit / 1)::numeric, 5)
WHERE id = 121 AND unit = 'ks';

-- Citrónka 1,5L
UPDATE ingredients SET unit='l',
  current_qty   = current_qty * 1.5,
  cost_per_unit = ROUND((cost_per_unit / 1.5)::numeric, 5)
WHERE id = 132 AND unit = 'ks';


-- ============ Verify ============
SELECT id, name, unit, current_qty, cost_per_unit FROM ingredients
WHERE id IN (102, 103, 105, 106, 114, 115, 116, 118, 120, 121, 132, 142, 148, 149, 150, 160, 163, 165, 169, 170)
ORDER BY unit, id;

-- Zostávajúce ks položky (mali by byť IBA flaškové / pack / chemia / counted):
SELECT id, name, unit FROM ingredients WHERE active=true AND unit='ks' ORDER BY name;

COMMIT;
