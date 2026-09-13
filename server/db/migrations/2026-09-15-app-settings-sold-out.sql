-- Iterácia 3 rozvozu: prvá serverová tabuľka nastavení + „vypredané do rána" po položke.
-- app_settings: kľúč → JSON (online_orders.pause = pauza príjmu s časom a dôvodom,
-- online_orders.auto_accept = režim automatického prijímania). Nahrádza .env pre veci,
-- ktoré obsluha mení počas dňa a nesmú vyžadovať reštart kasy.
CREATE TABLE IF NOT EXISTS app_settings (
  key        varchar(60) PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by integer
);

-- „Dnes vypredané": položka ostáva v menu, ale web ju ukáže ako vypredanú a Wolt ju
-- dočasne vypne; o 5:00 ráno strážca sold_out_until vymaže a položka sa vráti sama.
-- Nie je to active=false — to skrýva položku natrvalo aj na kase.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sold_out_until timestamp;
