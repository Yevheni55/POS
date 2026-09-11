#!/usr/bin/env node
// Registrácia webhooku vo Wolt Drive (raz, po získaní tokenu a verejnej URL POS-u).
//
// Použitie (z koreňa repa, načíta server/.env):
//   node scripts/wolt-register-webhook.mjs https://objednavky.surfspirit.sk/api/public/online-orders/wolt/webhook
//   node scripts/wolt-register-webhook.mjs --list
//   node scripts/wolt-register-webhook.mjs --delete <webhook_id>
//
// Potrebuje v server/.env: WOLT_DRIVE_MODE (development|production), WOLT_DRIVE_TOKEN,
// WOLT_MERCHANT_ID, WOLT_WEBHOOK_SECRET (ten istý secret Wolt použije na podpis JWT).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, 'server', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
}
const { woltConfig } = await import('../server/lib/wolt-drive.js');
const cfg = woltConfig();
if (!['development', 'production'].includes(cfg.mode)) { console.error('WOLT_DRIVE_MODE musí byť development alebo production (teraz: ' + cfg.mode + ')'); process.exit(1); }
if (!cfg.token || !cfg.merchantId) { console.error('Chýba WOLT_DRIVE_TOKEN alebo WOLT_MERCHANT_ID'); process.exit(1); }

const base = `${cfg.baseUrl}/v1/merchants/${encodeURIComponent(cfg.merchantId)}/webhooks`;
const headers = { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json', Accept: 'application/json' };
async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  console.log(method, url, '→', res.status);
  console.log(text);
  if (!res.ok) process.exit(2);
}

const [arg, arg2] = process.argv.slice(2);
if (arg === '--list') await call('GET', base);
else if (arg === '--delete' && arg2) await call('DELETE', base + '/' + encodeURIComponent(arg2));
else if (arg && /^https:\/\//.test(arg)) {
  if (!cfg.webhookSecret) { console.error('Nastav WOLT_WEBHOOK_SECRET (min. 32 znakov) — tým Wolt podpíše každú udalosť'); process.exit(1); }
  await call('POST', base, {
    callback_url: arg,
    client_secret: cfg.webhookSecret,
    callback_config: { exponential_retry_backoff: { exponent_base: 2, max_retry_count: 8 } },
    disabled: false,
  });
} else {
  console.log('Použitie: node scripts/wolt-register-webhook.mjs <https://…/api/public/online-orders/wolt/webhook> | --list | --delete <id>');
}
