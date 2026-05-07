#!/usr/bin/env node
// Backfill weather observations for Drazdiak from season opening (25.04)
// to today. Uses Open-Meteo forecast API with past_days=92 (max).
//
// Usage (run inside the kasa pos-app-1 container so DB connection works):
//   docker exec pos-app-1 node /app/scripts/backfill-weather.mjs
//
// Or locally with a writable connection string in DATABASE_URL:
//   DATABASE_URL=postgres://... node scripts/backfill-weather.mjs

import { fetchAndStoreWeather } from '../server/lib/weather.js';

(async () => {
  console.log('[backfill-weather] starting…');
  try {
    const result = await fetchAndStoreWeather({ pastDays: 14 });
    console.log('[backfill-weather] done:', result);
  } catch (e) {
    console.error('[backfill-weather] FAILED:', e.message || e);
    process.exit(1);
  }
  process.exit(0);
})();
