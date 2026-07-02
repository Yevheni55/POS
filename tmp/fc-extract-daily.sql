COPY (
  WITH rev AS (
    SELECT (created_at AT TIME ZONE 'Europe/Bratislava')::date AS d,
           sum(amount::numeric)::float AS rev,
           count(*) AS n_pay
    FROM payments GROUP BY 1
  ), wx AS (
    SELECT (observed_at AT TIME ZONE 'Europe/Bratislava')::date AS d,
           max(temperature_c)::float AS tmax,
           min(temperature_c)::float AS tmin,
           max(apparent_temp_c)::float AS appmax,
           COALESCE(sum(precipitation_mm),0)::float AS precip,
           (avg(cloud_cover_pct) FILTER (
              WHERE extract(hour FROM (observed_at AT TIME ZONE 'Europe/Bratislava')) BETWEEN 10 AND 23))::float AS cloud_open,
           count(*) FILTER (
              WHERE weather_code >= 51
                AND extract(hour FROM (observed_at AT TIME ZONE 'Europe/Bratislava')) BETWEEN 10 AND 23)::int AS rain_hours,
           max(weather_code) FILTER (
              WHERE extract(hour FROM (observed_at AT TIME ZONE 'Europe/Bratislava')) BETWEEN 10 AND 23)::int AS worst_code
    FROM weather_observations GROUP BY 1
  )
  SELECT to_char(rev.d,'YYYY-MM-DD') AS day,
         extract(isodow FROM rev.d)::int AS weekday,
         rev.rev, rev.n_pay,
         wx.tmax, wx.tmin, wx.appmax, wx.precip, wx.cloud_open, wx.rain_hours, wx.worst_code
  FROM rev JOIN wx ON wx.d = rev.d
  WHERE rev.rev > 0 AND wx.tmax IS NOT NULL
    AND rev.d < (now() AT TIME ZONE 'Europe/Bratislava')::date -- dnesok je nekompletny
  ORDER BY rev.d
) TO STDOUT WITH CSV HEADER
