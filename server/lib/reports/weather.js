import { sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { TZ } from './shared.js';

// GET /api/reports/weather?from=YYYY-MM-DD&to=YYYY-MM-DD
// Hourly weather observations for the period. Used by Tyzden admin
// page to show temperature/wind/cloud/precipitation per hour next
// to sales numbers.
export async function weatherHandler(req, res) {
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const from = req.query.from || to;
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  const rows = await db.execute(sql`
    SELECT
      observed_at AS "observedAt",
      to_char((observed_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      EXTRACT(HOUR FROM (observed_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      EXTRACT(ISODOW FROM (observed_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS weekday,
      temperature_c AS "temperatureC",
      apparent_temp_c AS "apparentTempC",
      wind_speed_kmh AS "windSpeedKmh",
      wind_direction_deg AS "windDirectionDeg",
      cloud_cover_pct AS "cloudCoverPct",
      precipitation_mm AS "precipitationMm",
      weather_code AS "weatherCode"
    FROM weather_observations
    WHERE observed_at >= ${fromBoundary}
      AND observed_at <= ${toBoundary}
    ORDER BY observed_at
  `);

  res.json({
    period: { from, to },
    observations: rows.rows.map(r => ({
      observedAt: r.observedAt,
      date: r.date,
      hour: Number(r.hour),
      weekday: Number(r.weekday),
      temperatureC: r.temperatureC === null ? null : Number(r.temperatureC),
      apparentTempC: r.apparentTempC === null ? null : Number(r.apparentTempC),
      windSpeedKmh: r.windSpeedKmh === null ? null : Number(r.windSpeedKmh),
      windDirectionDeg: r.windDirectionDeg,
      cloudCoverPct: r.cloudCoverPct,
      precipitationMm: r.precipitationMm === null ? null : Number(r.precipitationMm),
      weatherCode: r.weatherCode,
    })),
  });
}
