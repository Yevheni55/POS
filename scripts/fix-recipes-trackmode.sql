-- Zapne track_mode = 'recipe' pre vsetky menu_items, ktore maju zapis v recipes
-- ale ostali s track_mode = 'none' (spusti sa raz, nasledujuce volania PUT /recipes uz robi server).

UPDATE menu_items
   SET track_mode = 'recipe'
 WHERE track_mode = 'none'
   AND id IN (SELECT menu_item_id FROM recipes);

SELECT id, name, track_mode
  FROM menu_items
 WHERE id IN (SELECT menu_item_id FROM recipes)
 ORDER BY id;
