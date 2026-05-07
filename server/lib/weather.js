// Weather fetcher — Open-Meteo forecast API.
// Drazdiak lake = Bratislava-Petrzalka, GPS 48.1014°N, 17.1136°E.
// API je verejné, zadarmo, bez API key. Forecast endpoint vie vrátiť
// past_days (max 92) — používame ho aj na backfill aj na hodinový cron.
//
// Docs: https://open-meteo.com/en/docs

import { db } from '../db/index.js';
import { weatherObservations } from '../db/schema.js';
import { sql } from 'drizzle-orm';

const LAT = 48.1014;
const LON = 17.1136;

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'precipitation',
  'weather_code',
];

function buildUrl({ pastDays = 0 } = {}) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(LAT));
  url.searchParams.set('longitude', String(LON));
  url.searchParams.set('hourly', HOURLY_FIELDS.join(','));
  url.searchParams.set('timezone', 'UTC');     // ukladáme v UTC, formátovanie v UI
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('forecast_days', '1');
  if (pastDays > 0) url.searchParams.set('past_days', String(Math.min(pastDays, 92)));
  return url.toString();
}

/**
 * Fetch from Open-Meteo and upsert into weather_observations.
 * @param {{pastDays?: number}} opts
 * @returns {Promise<{inserted:number, skipped:number, total:number, latestAt:string|null}>}
 */
export async function fetchAndStoreWeather({ pastDays = 0 } = {}) {
  const url = buildUrl({ pastDays });
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error('Open-Meteo unreachable: ' + (e.message || e));
  }
  if (!resp.ok) {
    throw new Error('Open-Meteo HTTP ' + resp.status);
  }
  const data = await resp.json();
  const h = data.hourly || {};
  const times = h.time || [];
  if (!times.length) return { inserted: 0, skipped: 0, total: 0, latestAt: null };

  const rows = times.map((t, i) => ({
    // API vracia 'YYYY-MM-DDTHH:MM' v UTC (lebo timezone=UTC). Pridáme 'Z'.
    observedAt: new Date(t + 'Z'),
    temperatureC:     numOrNull(h.temperature_2m, i),
    apparentTempC:    numOrNull(h.apparent_temperature, i),
    windSpeedKmh:     numOrNull(h.wind_speed_10m, i),
    windDirectionDeg: intOrNull(h.wind_direction_10m, i),
    cloudCoverPct:    intOrNull(h.cloud_cover, i),
    precipitationMm:  numOrNull(h.precipitation, i),
    weatherCode:      intOrNull(h.weather_code, i),
    source: 'open-meteo',
  }));

  // ON CONFLICT DO UPDATE — re-fetched hodina (forecast → measured)
  // môže mať preposnejšie dáta, takže prepisujeme.
  let inserted = 0;
  for (const r of rows) {
    if (!r.observedAt || isNaN(r.observedAt.getTime())) continue;
    const result = await db.execute(sql`
      INSERT INTO weather_observations
        (observed_at, temperature_c, apparent_temp_c, wind_speed_kmh,
         wind_direction_deg, cloud_cover_pct, precipitation_mm,
         weather_code, source)
      VALUES (${r.observedAt}, ${r.temperatureC}, ${r.apparentTempC},
              ${r.windSpeedKmh}, ${r.windDirectionDeg}, ${r.cloudCoverPct},
              ${r.precipitationMm}, ${r.weatherCode}, ${r.source})
      ON CONFLICT (observed_at) DO UPDATE SET
        temperature_c = EXCLUDED.temperature_c,
        apparent_temp_c = EXCLUDED.apparent_temp_c,
        wind_speed_kmh = EXCLUDED.wind_speed_kmh,
        wind_direction_deg = EXCLUDED.wind_direction_deg,
        cloud_cover_pct = EXCLUDED.cloud_cover_pct,
        precipitation_mm = EXCLUDED.precipitation_mm,
        weather_code = EXCLUDED.weather_code,
        source = EXCLUDED.source
    `);
    inserted++;
  }
  const latestAt = rows[rows.length - 1].observedAt.toISOString();
  return { inserted, skipped: 0, total: rows.length, latestAt };
}

function numOrNull(arr, i) {
  if (!arr) return null;
  const v = arr[i];
  return (v === null || v === undefined || Number.isNaN(v)) ? null : String(v);
}
function intOrNull(arr, i) {
  if (!arr) return null;
  const v = arr[i];
  return (v === null || v === undefined || Number.isNaN(v)) ? null : Math.round(Number(v));
}

/**
 * WMO code → ľudská značka (slovak) + emoji.
 * Použité v UI pri zobrazení počasia v hodinovej tabuľke.
 */
export function describeWeather(code) {
  const c = Number(code);
  if (c === 0) return { label: 'jasno', emoji: '☀️' };
  if (c === 1) return { label: 'prevažne jasno', emoji: '🌤️' };
  if (c === 2) return { label: 'polooblačno', emoji: '⛅' };
  if (c === 3) return { label: 'zamračené', emoji: '☁️' };
  if (c === 45 || c === 48) return { label: 'hmla', emoji: '🌫️' };
  if (c >= 51 && c <= 57) return { label: 'mrholenie', emoji: '🌦️' };
  if (c >= 61 && c <= 67) return { label: 'dážď', emoji: '🌧️' };
  if (c >= 71 && c <= 77) return { label: 'sneženie', emoji: '🌨️' };
  if (c >= 80 && c <= 82) return { label: 'prehánky', emoji: '🌧️' };
  if (c === 85 || c === 86) return { label: 'snehové prehánky', emoji: '🌨️' };
  if (c >= 95) return { label: 'búrka', emoji: '⛈️' };
  return { label: '—', emoji: '·' };
}

let _hourlyTimer = null;

/**
 * Štart hourly cron — fetch raz za hodinu (hneď + každých 60 min).
 * Volaj sa raz pri server boot. Idempotent; opakované volanie nezdvojuje.
 */
export function startWeatherHourlyCron() {
  if (_hourlyTimer) return;
  // Initial fetch — neblokuj boot
  setTimeout(() => {
    fetchAndStoreWeather({ pastDays: 1 })
      .then(r => console.log(`[weather] boot fetch: ${r.inserted} rows, latest ${r.latestAt}`))
      .catch(e => console.warn('[weather] boot fetch failed:', e.message));
  }, 5000);
  // Hourly refresh
  _hourlyTimer = setInterval(() => {
    fetchAndStoreWeather({ pastDays: 1 })
      .then(r => console.log(`[weather] hourly fetch: ${r.inserted} rows`))
      .catch(e => console.warn('[weather] hourly fetch failed:', e.message));
  }, 60 * 60 * 1000);
}

export function stopWeatherHourlyCron() {
  if (_hourlyTimer) clearInterval(_hourlyTimer);
  _hourlyTimer = null;
}
