-- Bulk import suroviny from invoices 2620OE0100192930 (2.5.2026) and
-- 2620OE0100193661 (2.5.2026), LUNYS s.r.o. → Surf Spirit Drazdiak.
-- Already-imported items skipped (Hovädzie mleté mäso, Uhorka hadovka,
-- Pomaranč Navelina, Uhorky steril., Limeta, Citrón Primofiori, Syr
-- Cheddar plátky, Kečup Gurmán, Slanina Bacon).
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  -- ===== 192930 (2.5.2026) =====
  ('Finish Shine & Protect Regular leštidlo 800 ml',          'ks', 'ingredient', 0, 0, 0, true),
  ('Orion Kuchynská utierka My kitchen greenish 2ks',         'ks', 'ingredient', 0, 0, 0, true),
  -- ===== 193661 (2.5.2026) =====
  ('Mrazená Zmes lesné ovocie 2,5kg Viking Frost',            'ks', 'ingredient', 0, 0, 0, true),
  ('Balená Máta 30g',                                          'ks', 'ingredient', 0, 0, 0, true),
  ('Mlieko Barista 3,5% 1l Rajo',                             'l',  'ingredient', 0, 0, 0, true),
  ('Mrazené Mango kocky 2,5kg Viking Frost',                  'ks', 'ingredient', 0, 0, 0, true),
  ('Víno šumivé biele I Heart Prosecco Frizzante 0,75l IT',   'l',  'ingredient', 0, 0, 0, true),
  ('Kuracie prsia rezne cca 700g Hyza',                       'kg', 'ingredient', 0, 0, 0, true),
  ('Horčica plnotučná vedro 5kg',                              'ks', 'ingredient', 0, 0, 0, true),
  ('Ľad mrazený kocky 2kg Ice Service',                       'ks', 'ingredient', 0, 0, 0, true),
  ('Med kvetový HB 200x10g SNOTY',                             'ks', 'ingredient', 0, 0, 0, true),
  ('Thomas Henry Ginger Beer 200ml',                           'ks', 'ingredient', 0, 0, 0, true),
  ('Tatranský cmar 400ml Tami',                                'ks', 'ingredient', 0, 0, 0, true)
RETURNING id, name, unit;
