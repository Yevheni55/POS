-- One-shot import of suroviny from invoice 2620OE0100180530 (LUNYS s.r.o., 24.4.2026).
-- Adds 21 ingredient rows with name + sensible unit; cost / quantity stay at 0 per
-- the operator's request ("bez množstva, len položky"). ON CONFLICT skip (although
-- there's no unique constraint on name today — re-running this would just create
-- duplicates, so don't re-run without first deleting these by name).
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  ('Mlieko plnotučné 3,5% bezlaktózové 1l Rajo',   'l',  'ingredient', 0, 0, 0, true),
  ('Zázvor kal. 250+',                              'kg', 'ingredient', 0, 0, 0, true),
  ('Relax Džús Jablko 200 ml',                      'ks', 'ingredient', 0, 0, 0, true),
  ('Limeta zelená (kg) kal. 48-54, I.trieda',       'kg', 'ingredient', 0, 0, 0, true),
  ('Citrón Primofiori ukladaný kal. 4-5, I.trieda', 'kg', 'ingredient', 0, 0, 0, true),
  ('Bylinky - Máta',                                 'ks', 'ingredient', 0, 0, 0, true),
  ('Cukor kryštálový Korunný 1kg',                  'kg', 'ingredient', 0, 0, 0, true),
  ('Víno biele Rizling rýnsky suchý VZT 0,75l SK',  'l',  'ingredient', 0, 0, 0, true),
  ('Relax Džús Pomaranč 200 ml',                    'ks', 'ingredient', 0, 0, 0, true),
  ('Coca Cola 500ml ZO',                             'ks', 'ingredient', 0, 0, 0, true),
  ('San Pellegrino Máta & citrón 330ml ZO',         'ks', 'ingredient', 0, 0, 0, true),
  ('Sprite Citrón limetka 500 ml ZO',                'ks', 'ingredient', 0, 0, 0, true),
  ('Mlieko plnotučné 3,5% UHT 1l Rajo',             'l',  'ingredient', 0, 0, 0, true),
  ('Kiwi Hayward voľne kal. 23-27, I.Tr',            'kg', 'ingredient', 0, 0, 0, true),
  ('Cukor trstinový Demerara 1kg Vido',              'kg', 'ingredient', 0, 0, 0, true),
  ('Prosecco Valfonda D.O.C Extra Dry 0,75l IT',     'l',  'ingredient', 0, 0, 0, true),
  ('Mrazené Maliny 250g Sládkovičovo',               'ks', 'ingredient', 0, 0, 0, true),
  ('Mrazené Mango kocky 200g Nowaco',                'ks', 'ingredient', 0, 0, 0, true),
  ('Mr. Ananás extra sladký 2,5kg Ardo',             'ks', 'ingredient', 0, 0, 0, true),
  ('Pyré svieža marakuja 1l Pureé',                   'l',  'ingredient', 0, 0, 0, true),
  ('Kofola Original KEG 50l ZO',                      'l',  'ingredient', 0, 0, 0, true)
RETURNING id, name, unit;
