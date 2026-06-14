-- ============================================================
-- Vyhodnotenie odhadov tržieb (revenue_forecasts) oproti realite.
-- Spúšťaj kedykoľvek (napr. raz za týždeň/mesiac):
--   cat scripts/eval-forecasts.sql | ssh surfs@100.95.64.38 \
--     "docker exec -i pos-db-1 psql -U pos -d pos"
-- Doplní actual_eur + error_pct pre už UZAVRETÉ dni (target_date < dnes lokálne).
-- error_pct = 100*(actual-estimate)/actual:  +X% = PODcenil som, -X% = NADcenil.
-- ============================================================

UPDATE revenue_forecasts f
SET actual_eur   = a.trzba,
    error_pct    = CASE WHEN a.trzba > 0
                        THEN round(100 * (a.trzba - f.estimate_eur) / a.trzba, 2) END,
    evaluated_at = now()
FROM (
  SELECT (created_at AT TIME ZONE 'Europe/Bratislava')::date AS d,
         sum(amount::numeric) AS trzba
  FROM payments GROUP BY 1
) a
WHERE a.d = f.target_date
  AND f.target_date < (now() AT TIME ZONE 'Europe/Bratislava')::date;

-- Detail po dňoch
SELECT target_date, weekday, method, estimate_eur, low_eur, high_eur, actual_eur,
       error_pct,
       (actual_eur BETWEEN low_eur AND high_eur) AS v_rozpati
FROM revenue_forecasts
WHERE actual_eur IS NOT NULL
ORDER BY target_date;

-- Súhrn presnosti per model
SELECT method,
       count(*)                                   AS vyhodnotenych_dni,
       round(avg(abs(error_pct)), 1)              AS priem_abs_chyba_pct,
       round(avg(error_pct), 1)                   AS bias_pct,
       count(*) FILTER (WHERE actual_eur BETWEEN low_eur AND high_eur) AS dni_v_rozpati
FROM revenue_forecasts
WHERE actual_eur IS NOT NULL
GROUP BY method
ORDER BY method;
