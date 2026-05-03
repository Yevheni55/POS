-- Suroviny pre nálevy + 2 polotovary (nakladaná cibuľa, nakladané uhorky).
-- Polotovary sa správajú ako bežné suroviny — môžeš ich použiť v iných
-- receptoch (napr. burger s nakladanou cibuľou) a sklad bude automaticky
-- klesať pri predaji.
--
-- Dnes sa MNOŽSTVO polotovarov dopĺňa ručne (admin → Sklad → Suroviny →
-- klikni na Nakladaná cibuľa → Upraviť stav → +2500 g po každej várke).
-- Plánovaná feature: "Vyrobiť várku" tlačidlo, ktoré automaticky odpíše
-- vstupné suroviny a pripočíta výstupný polotovar v jednej transakcii.
--
-- Brine recipes (kontext, neukladajú sa do recipes tabuľky):
--   Nálev cibuľa (~3000g, postačí na 2.5-3kg cibule):
--     1000g voda, 1000g ocot, 1000g cukor, 2ks bobkový list, 2ks nové
--     korenie, 5ks čierne korenie celé, ~10g horčičné semienka (1PL),
--     ~10g soľ (2ČL)
--   Nálev uhorky (~2500g, postačí na 2kg uhoriek):
--     500g voda, 1000g ocot, 1000g cukor, ~10g kurkuma, ~10g horčičné
--     semienka, 5ks klinček, 2ks bobkový list, 5ks čierne korenie celé,
--     2ks strúčik cesnaku

BEGIN;

-- 1) Chýbajúce raw suroviny (g, qty=0, cost=0 — doplníš pri nákupe)
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  ('Bobkový list',                'g', 'ingredient', 0, 0, 0, true),
  ('Nové korenie celé',           'g', 'ingredient', 0, 0, 0, true),
  ('Čierne korenie celé',         'g', 'ingredient', 0, 0, 0, true),
  ('Horčičné semienka',           'g', 'ingredient', 0, 0, 0, true),
  ('Kurkuma',                     'g', 'ingredient', 0, 0, 0, true),
  ('Klinček celý',                'g', 'ingredient', 0, 0, 0, true)
ON CONFLICT DO NOTHING;

-- 2) Polotovary (vlastnoručne pripravené, pripočítaš stav po varení)
--
-- BBQ ragu yield kalkulácia (jedna várka):
--   Vstup: 2000g cibuľa červená + 2000g mleté hovädzie + 600g BBQ omáčka
--          + soľ/korenie ≈ 4600g raw
--   Po varení: cibuľa karamelizuje (-50%), hovädzie stráca šťavu+tuk (-25%),
--   BBQ mierne sa odparí. Výsledok ~3000g hotového ragu.
--   Servírovacie porcie: ~30 × 100g  /  ~25 × 120g  /  ~20 × 150g.
INSERT INTO ingredients (name, unit, type, current_qty, min_qty, cost_per_unit, active) VALUES
  ('Nakladaná cibuľa (vlastná)',     'g', 'ingredient', 0, 0, 0, true),
  ('Nakladané uhorky (vlastné)',     'g', 'ingredient', 0, 0, 0, true),
  ('Surférske BBQ ragu (vlastné)',   'g', 'ingredient', 0, 0, 0, true)
ON CONFLICT DO NOTHING;

-- Verify
SELECT id, name, unit, current_qty FROM ingredients
WHERE name IN (
  'Bobkový list','Nové korenie celé','Čierne korenie celé',
  'Horčičné semienka','Kurkuma','Klinček celý',
  'Nakladaná cibuľa (vlastná)','Nakladané uhorky (vlastné)',
  'Surférske BBQ ragu (vlastné)'
)
ORDER BY name;

COMMIT;
