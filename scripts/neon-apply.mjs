#!/usr/bin/env node
// Spustí SQL súbor na Neon (cloudová DB surfspirit.sk).
//   node scripts/neon-apply.mjs server/db/neon/2026-09-12-web-orders.sql
// Pripojenie berie z NEON_DATABASE_URL v server/.env (alebo z prostredia).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..', 'server');
const require = createRequire(path.join(serverDir, 'package.json'));
const pg = require('pg');

function envFromDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = fs.readFileSync(path.join(serverDir, '.env'), 'utf8').match(new RegExp('^' + name + '=(.*)$', 'm'));
    return m ? m[1].replace(/^"|"$/g, '').trim() : '';
  } catch { return ''; }
}

const file = process.argv[2];
if (!file) { console.error('Použitie: node scripts/neon-apply.mjs <subor.sql>'); process.exit(2); }
const url = envFromDotenv('NEON_DATABASE_URL');
if (!url) { console.error('Chýba NEON_DATABASE_URL v server/.env'); process.exit(2); }

const sql = fs.readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]+/, ''), ssl: { rejectUnauthorized: true } });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('OK:', path.basename(file), 'aplikovaný na Neon');
} catch (e) {
  try { await client.query('ROLLBACK'); } catch { /* nič */ }
  console.error('CHYBA:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
