SELECT mi.id, mi.name, mc.label as kategoria
FROM menu_items mi
JOIN menu_categories mc ON mc.id = mi.category_id
WHERE mi.active = true
  AND (mi.image_url IS NULL OR mi.image_url = '')
  AND mc.label != 'Čísla'
  AND mi.name NOT IN ('Plastovy pohar', 'Záloha fľaša', 'Doblok', 'Platok limetky')
ORDER BY mc.label, mi.name;
