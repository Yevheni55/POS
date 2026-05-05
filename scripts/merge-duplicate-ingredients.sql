-- Konsolidácia duplicitných surovín v sklade.
-- Všetko v jednej transakcii — pri akejkoľvek chybe sa nič neaplikuje.
--
-- Pre každý merge:
--   * konvertujeme jednotky na spoločnú (g pre potraviny, ks pre fľaše/kegy)
--   * repointujeme historické referencie (po_items, stock_movements, recipes) na cieľové ID
--   * sčítame current_qty + spočítame VÁŽENÚ priemernú cenu
--   * zmažeme zdrojový (duplicitný) ingredient

BEGIN;

-- ============================================================
-- 1) Mŕtve duplikáty (0 stock, 0 referencií) — len delete
-- ============================================================
DELETE FROM ingredients WHERE id IN (26, 28, 29);


-- ============================================================
-- 2) Kuracie prsia: 168 (Hyza 700g) → 153 (TopFarm 600g)
--    Konverzia ks → g (lebo recepty budú odpisovať per gramy).
--    153: 1 ks × 600 g = 600 g, cena 5.07 / 600 = 0.00845 €/g
--    168: 1 ks × 700 g = 700 g, cena 5.01 / 700 = 0.00716 €/g
--    Spolu: 1300 g, vážená cena = (5.07 + 5.01) / 1300 = 0.00775 €/g
-- ============================================================
UPDATE ingredients SET unit='g', current_qty=current_qty*600, cost_per_unit=ROUND((cost_per_unit/600)::numeric, 5)
  WHERE id=153 AND unit='ks';
UPDATE ingredients SET unit='g', current_qty=current_qty*700, cost_per_unit=ROUND((cost_per_unit/700)::numeric, 5)
  WHERE id=168 AND unit='ks';

UPDATE purchase_order_items SET ingredient_id=153 WHERE ingredient_id=168;
UPDATE stock_movements      SET ingredient_id=153 WHERE ingredient_id=168;
UPDATE recipes              SET ingredient_id=153 WHERE ingredient_id=168;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 0.00716 * 700) / (current_qty + 700))::numeric, 5),
  current_qty   = current_qty + 700,
  name          = 'Kuracie prsia'
WHERE id = 153;

DELETE FROM ingredients WHERE id = 168;


-- ============================================================
-- 3) Coca-Cola: 111 (4 ks @ 1.40) → 15 (12 ks @ 1.5875)
--    Spolu 16 ks, vážená cena = (12×1.5875 + 4×1.40) / 16 = 1.5409 €/ks
-- ============================================================
UPDATE purchase_order_items SET ingredient_id=15 WHERE ingredient_id=111;
UPDATE stock_movements      SET ingredient_id=15 WHERE ingredient_id=111;
UPDATE recipes              SET ingredient_id=15 WHERE ingredient_id=111;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 1.40 * 4) / (current_qty + 4))::numeric, 4),
  current_qty   = current_qty + 4
WHERE id = 15;

DELETE FROM ingredients WHERE id = 111;


-- ============================================================
-- 4) KEG: 1 (generický KEG @ 40 €) → 11 (5xOD 50L KEG @ 15.97 €)
--    Mažeme generický (id 1), keepujeme špecifický (id 11).
--    Spolu 28 ks, vážená cena = (14×15.97 + 14×40) / 28 = 27.985 €/ks
-- ============================================================
UPDATE purchase_order_items SET ingredient_id=11 WHERE ingredient_id=1;
UPDATE stock_movements      SET ingredient_id=11 WHERE ingredient_id=1;
UPDATE recipes              SET ingredient_id=11 WHERE ingredient_id=1;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 40.00 * 14) / (current_qty + 14))::numeric, 4),
  current_qty   = current_qty + 14
WHERE id = 11;

DELETE FROM ingredients WHERE id = 1;


-- ============================================================
-- 5) Máta: 164 (Balená 30g, 2 ks) → 107 (Bylinky-Máta, 0.1 kg)
--    Konverzia kg → g pre 107, ks → g pre 164.
--    107: 0.1 kg → 100 g, cena 19.69 / 1000 = 0.01969 €/g
--    164: 2 ks × 30 g = 60 g, cena 1.39 / 30 = 0.04633 €/g
--    Spolu 160 g, vážená cena = (100×0.01969 + 60×0.04633) / 160 = 0.02968 €/g
-- ============================================================
UPDATE ingredients SET unit='g', current_qty=current_qty*1000, cost_per_unit=ROUND((cost_per_unit/1000)::numeric, 5)
  WHERE id=107 AND unit='kg';
UPDATE ingredients SET unit='g', current_qty=current_qty*30, cost_per_unit=ROUND((cost_per_unit/30)::numeric, 5)
  WHERE id=164 AND unit='ks';

UPDATE purchase_order_items SET ingredient_id=107 WHERE ingredient_id=164;
UPDATE stock_movements      SET ingredient_id=107 WHERE ingredient_id=164;
UPDATE recipes              SET ingredient_id=107 WHERE ingredient_id=164;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 0.04633 * 60) / (current_qty + 60))::numeric, 5),
  current_qty   = current_qty + 60,
  name          = 'Máta'
WHERE id = 107;

DELETE FROM ingredients WHERE id = 164;


-- ============================================================
-- 6) Mango: 166 (2.5 kg/ks Viking Frost) → 119 (200g/ks Nowaco)
--    Konverzia ks → g.
--    119: 2 ks × 200 g = 400 g, cena 2.05 / 200 = 0.01025 €/g
--    166: 1 ks × 2500 g = 2500 g, cena 10.30 / 2500 = 0.00412 €/g
--    Spolu 2900 g, vážená cena = (400×0.01025 + 2500×0.00412) / 2900 = 0.00497 €/g
-- ============================================================
UPDATE ingredients SET unit='g', current_qty=current_qty*200, cost_per_unit=ROUND((cost_per_unit/200)::numeric, 5)
  WHERE id=119 AND unit='ks';
UPDATE ingredients SET unit='g', current_qty=current_qty*2500, cost_per_unit=ROUND((cost_per_unit/2500)::numeric, 5)
  WHERE id=166 AND unit='ks';

UPDATE purchase_order_items SET ingredient_id=119 WHERE ingredient_id=166;
UPDATE stock_movements      SET ingredient_id=119 WHERE ingredient_id=166;
UPDATE recipes              SET ingredient_id=119 WHERE ingredient_id=166;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 0.00412 * 2500) / (current_qty + 2500))::numeric, 5),
  current_qty   = current_qty + 2500,
  name          = 'Mrazené Mango kocky'
WHERE id = 119;

DELETE FROM ingredients WHERE id = 166;


-- ============================================================
-- 7) Coca-Cola Zero (16) → Coca-Cola (15)
--    16: 12 ks @ 1.5875. Po merge: 15 má 16 + 12 = 28 ks (po kroku 3 už malo 16 ks).
-- ============================================================
UPDATE purchase_order_items SET ingredient_id=15 WHERE ingredient_id=16;
UPDATE stock_movements      SET ingredient_id=15 WHERE ingredient_id=16;
UPDATE recipes              SET ingredient_id=15 WHERE ingredient_id=16;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 1.5875 * 12) / (current_qty + 12))::numeric, 4),
  current_qty   = current_qty + 12
WHERE id = 15;

DELETE FROM ingredients WHERE id = 16;


-- ============================================================
-- 8) Romerquelle: 22 (perliva, 24 ks) → 21 (neperliva, 24 ks)
--    KEEP 23 (citronova trava) — separátne, podľa user inštrukcie.
--    Spolu 48 ks, vážená cena = (24×0.8017 + 24×0.8017) / 48 = 0.8017 €/ks
-- ============================================================
UPDATE purchase_order_items SET ingredient_id=21 WHERE ingredient_id=22;
UPDATE stock_movements      SET ingredient_id=21 WHERE ingredient_id=22;
UPDATE recipes              SET ingredient_id=21 WHERE ingredient_id=22;

UPDATE ingredients SET
  cost_per_unit = ROUND(((cost_per_unit * current_qty + 0.8017 * 24) / (current_qty + 24))::numeric, 4),
  current_qty   = current_qty + 24,
  name          = 'Romerquelle 0,5l'
WHERE id = 21;

DELETE FROM ingredients WHERE id = 22;


-- ============================================================
-- Verify
-- ============================================================
SELECT id, name, unit, current_qty, cost_per_unit FROM ingredients
WHERE id IN (11, 15, 21, 23, 107, 119, 153)
ORDER BY id;

COMMIT;
