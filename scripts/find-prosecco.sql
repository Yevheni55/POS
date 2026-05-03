SELECT id, name, unit, current_qty, cost_per_unit
FROM ingredients
WHERE name ILIKE '%prosecco%' OR name ILIKE '%prossecco%'
ORDER BY id;
