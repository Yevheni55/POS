// Denný export sezónneho P&L do Google Sheets.
//
// Čísla idú z summaryHandler (rovnaký kód ako admin stránka Sezóna/Reporty),
// takže sheet vždy sedí 1:1 s reportom. Zápis do tabuľky robí Google Apps
// Script webhook (scripts/sheets-export-webhook.gs) nasadený ako Web App —
// server mu POSTne hotovú 2D maticu hodnôt a script prepíše celý list.
// Full-rewrite namiesto append: idempotentné, a spätné opravy (storno,
// doúčtovaná dochádzka) sa v historických riadkoch samé zahoja.
//
// Konfigurácia (server/.env):
//   SHEETS_EXPORT_URL   — URL Web App deploymentu (bez neho je export vypnutý)
//   SHEETS_EXPORT_TOKEN — zdieľaný secret, overuje ho Apps Script
//   SHEETS_EXPORT_FROM  — začiatok sezóny (default 2026-04-25, rovnaký ako
//                         SEASON_START v admin/pages/season.js)
//
// Cron beží denne o 05:10 Europe/Bratislava — až PO 04:00 auto-close
// zabudnutých zmien (server.js), aby včerajšie mzdy boli už uzavreté.

import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { summaryHandler } from './reports/summary.js';
import { TZ, roundMoney } from './reports/shared.js';

const SEASON_START_DEFAULT = '2026-04-25';

const DAY_SK = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
const MONTH_SK = ['Január', 'Február', 'Marec', 'Apríl', 'Máj', 'Jún', 'Júl',
  'August', 'September', 'Október', 'November', 'December'];

function getConfig() {
  return {
    url: process.env.SHEETS_EXPORT_URL || '',
    token: process.env.SHEETS_EXPORT_TOKEN || '',
    from: process.env.SHEETS_EXPORT_FROM || SEASON_START_DEFAULT,
  };
}

export function isSheetsExportEnabled() {
  return Boolean(getConfig().url);
}

function todayBratislava() {
  // en-CA locale = YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function fmtDateSk(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}.${m}.${y}`;
}

function weekdaySk(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return DAY_SK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// summaryHandler je Express handler, ale používa iba req.query a res.json —
// zavoláme ho s mock objektmi namiesto duplikovania jeho SQL logiky.
async function fetchSummary(from, to) {
  let payload = null;
  await summaryHandler({ query: { from, to } }, { json: (b) => { payload = b; } });
  if (!payload) throw new Error('summaryHandler nevrátil dáta');
  // Keď sa nepodarilo zistiť režim DPH, summary počíta brutto (ako neplatiteľ).
  // Taký P&L sa do sheetu NESMIE zapísať — prepísal by správne čísla nesprávnymi
  // a cron by to zopakoval každý deň. Radšej necháme sheet nezmenený.
  if (payload.vatModeError) {
    throw new Error('Režim DPH sa nepodarilo overiť — sheet nezapisujem: ' + payload.vatModeError);
  }
  return payload;
}

/**
 * Poskladá 2D maticu pre sheet — rovnaké rozloženie ako pôvodná ručná
 * tabuľka: hlavička, SÚHRN, PO MESIACOCH (+ shisha + SPOLU), PO DŇOCH.
 * Čísla ostávajú number (Apps Script setValues ich zapíše ako čísla,
 * žiadne locale parsovanie).
 */
export function buildSheetValues(d, { from, to, updatedAt }) {
  // U PLATITEĽA DPH nie je daň na výstupe príjmom firmy — percentá aj VÝSLEDOK
  // sa musia počítať zo základu dane, nie z brutto tržby. U neplatiteľa je
  // `vatRegistered` false, žiadne DPH riadky nepribudnú a sheet je bajt-identický.
  const isVatPayer = d.vatRegistered === true;
  const base = isVatPayer ? d.totalRevenueNet : d.totalRevenue;
  const pct = (v) => base > 0 ? (v / base * 100).toFixed(1) + ' %' : '—';
  const rows = [];

  rows.push([`SurfSpirit — Sezóna ${from.slice(0, 4)} (${fmtDateSk(from)} – ${fmtDateSk(to)})`]);
  rows.push([isVatPayer
    ? `Automaticky aktualizované ${updatedAt} · zdroj: report Sezóna (tržby bez DPH = fiškálne platby − DPH na výstupe + shisha + odpis; výsledok = tržby bez DPH − výroba − mzdy − zam. spotreba; % sú z tržieb bez DPH). Shisha a odpis cez eKasu neprešli, DPH nenesú. Mesačné aj denné riadky sú TIEŽ bez DPH, aby riadok vychádzal.`
    : `Automaticky aktualizované ${updatedAt} · zdroj: report Sezóna (tržby = fiškálne platby + shisha + odpis; výsledok = tržby − výroba − mzdy − zam. spotreba)`]);
  rows.push([]);

  rows.push(['SÚHRN ZA SEZÓNU', '€', isVatPayer ? '% z tržieb bez DPH' : '% z tržieb']);
  rows.push(['Celkové tržby', d.totalRevenue, '', `z toho odpis ${d.totalOdpis} €, shisha ${d.shisha.revenue} €`]);
  if (isVatPayer) {
    rows.push(['z toho DPH (odvod štátu)', d.totalVatOutput, '', (d.vat?.byRate || [])
      .map(r => `${r.vatRate} %: ${r.amount} €`).join(', ')]);
    rows.push(['Tržby bez DPH (základ dane)', d.totalRevenueNet, '', 'podklad pre maržu aj priznanie DPH']);
  }
  rows.push(['Náklady na výrobu', d.totalCogs, pct(d.totalCogs), 'suroviny podľa receptúr']);
  rows.push(['Mzdy', d.totalLabor, pct(d.totalLabor), 'dochádzka × hodinovka']);
  rows.push(['Zamestnanecká spotreba', d.totalStaffMeal, pct(d.totalStaffMeal), 'suroviny staff meals']);
  rows.push(['VÝSLEDOK', d.totalProfit, pct(d.totalProfit) + ' marža']);
  rows.push([]);

  // Tržba denného/mesačného riadku musí stáť na ROVNAKOM základe ako jeho
  // Výsledok (ten je od auditu [09] netto), inak riadok „Tržby − náklady"
  // nevychádza. U neplatiteľa je `revenueNet` bit-identické s `revenue`
  // (summary.js ho počíta rovnakým výrazom s faktorom 1), takže sheet ostáva
  // nezmenený. `?? r.revenue` chráni pred starším payloadom bez tohto poľa.
  const dayRevenue = (r) => {
    if (!isVatPayer) return r.revenue;
    const net = Number(r.revenueNet);
    return Number.isFinite(net) ? net : r.revenue;
  };
  const revenueHeader = isVatPayer ? 'Tržby bez DPH' : 'Tržby';

  rows.push(['PO MESIACOCH', revenueHeader, 'Výroba', 'Mzdy', 'Zam. spotreba', 'Výsledok', 'Aktívnych dní']);
  const months = {};
  for (const r of d.daily) {
    const k = r.date.slice(0, 7);
    months[k] ??= { rev: 0, cogs: 0, labor: 0, sm: 0, profit: 0, dni: 0 };
    const m = months[k];
    m.rev += dayRevenue(r); m.cogs += r.cogs; m.labor += r.labor;
    m.sm += r.staffMeal; m.profit += r.profit;
    if (r.revenue > 0) m.dni++;
  }
  const keys = Object.keys(months).sort();
  const tot = { rev: d.shisha.revenue, cogs: 0, labor: 0, sm: 0, profit: d.shisha.revenue, dni: 0 };
  for (const k of keys) {
    const m = months[k];
    let label = MONTH_SK[Number(k.slice(5, 7)) - 1];
    if (k === from.slice(0, 7)) label += ` (od ${fmtDateSk(from).slice(0, -5)}.)`;
    if (k === to.slice(0, 7)) label += ` (do ${fmtDateSk(to).slice(0, -5)}.)`;
    rows.push([label, roundMoney(m.rev), roundMoney(m.cogs), roundMoney(m.labor), roundMoney(m.sm), roundMoney(m.profit), m.dni]);
    tot.rev += m.rev; tot.cogs += m.cogs; tot.labor += m.labor; tot.sm += m.sm; tot.profit += m.profit; tot.dni += m.dni;
  }
  // Shisha nie je v denných riadkoch (interný predaj mimo fiškálu, iba v
  // totalRevenue) — samostatný riadok, aby SPOLU sedelo s KPI reportu.
  rows.push([`Shisha (celá sezóna, ${d.shisha.count} ks — nie je v denných riadkoch)`, d.shisha.revenue, 0, 0, 0, d.shisha.revenue, '']);
  rows.push(['SPOLU', roundMoney(tot.rev), roundMoney(tot.cogs), roundMoney(tot.labor), roundMoney(tot.sm), roundMoney(tot.profit), tot.dni]);
  rows.push([]);

  rows.push(['PO DŇOCH']);
  rows.push(['Dátum', 'Deň', 'Účty', revenueHeader, 'Výroba', 'Mzdy', 'Zam. spotreba', 'Výsledok']);
  const sum = { orders: 0, revenue: 0, cogs: 0, labor: 0, staffMeal: 0, profit: 0 };
  for (const r of d.daily) {
    const rev = dayRevenue(r);
    rows.push([fmtDateSk(r.date), weekdaySk(r.date), r.orders, rev, r.cogs, r.labor, r.staffMeal, r.profit]);
    for (const k of Object.keys(sum)) sum[k] += (k === 'revenue' ? (rev || 0) : (r[k] || 0));
  }
  rows.push(['SPOLU (bez shisha)', '', sum.orders, roundMoney(sum.revenue), roundMoney(sum.cogs),
    roundMoney(sum.labor), roundMoney(sum.staffMeal), roundMoney(sum.profit)]);

  return rows;
}

/**
 * Jeden beh exportu: report → matica → POST na Apps Script webhook.
 * @returns {Promise<{skipped?:true, ok?:boolean, rows?:number, from?:string, to?:string}>}
 */
export async function runSheetsExportOnce() {
  const cfg = getConfig();
  if (!cfg.url) return { skipped: true, reason: 'SHEETS_EXPORT_URL nie je nastavené' };

  const from = cfg.from;
  const to = todayBratislava();
  const data = await fetchSummary(from, to);
  const updatedAt = new Intl.DateTimeFormat('sk-SK', {
    timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  const values = buildSheetValues(data, { from, to, updatedAt });

  // Apps Script Web App odpovedá 302 na script.googleusercontent.com —
  // fetch redirect sleduje sám, doPost sa vykoná na prvom requeste.
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.token, values }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error('Sheets webhook unreachable: ' + (e.message || e));
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Sheets webhook HTTP ${resp.status}: ${text.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  // Apps Script vracia 200 aj pri vlastnej chybe (napr. zlý token) —
  // skutočný výsledok je v JSON tele.
  if (!body || body.ok !== true) {
    throw new Error('Sheets webhook odmietol zápis: ' + text.slice(0, 200));
  }
  return { ok: true, rows: values.length, from, to };
}

// POST /api/reports/sheets-export — manuálny trigger (manazer/admin).
// Hodí sa na overenie po nasadení a na okamžitý refresh mimo cron času.
export async function sheetsExportHandler(req, res) {
  try {
    const result = await runSheetsExportOnce();
    res.status(result.skipped ? 409 : 200).json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
}

let _timer = null;

// Ďalší beh o 05:10 Europe/Bratislava — Postgres počíta epochu, takže DST
// prechody sedia (rovnaký prístup ako scheduleAutoClose v server.js).
// Dnešných 05:10 ak ešte nebolo, inak zajtrajších.
function msUntilNext0510Local() {
  return db.execute(sql`
    SELECT EXTRACT(EPOCH FROM (
      CASE WHEN (NOW() AT TIME ZONE 'Europe/Bratislava')::time < TIME '05:10'
        THEN (date_trunc('day', NOW() AT TIME ZONE 'Europe/Bratislava')
                + INTERVAL '5 hours 10 minutes') AT TIME ZONE 'Europe/Bratislava'
        ELSE (date_trunc('day', (NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '1 day')
                + INTERVAL '5 hours 10 minutes') AT TIME ZONE 'Europe/Bratislava'
      END - NOW()
    )) * 1000 AS ms
  `).then(r => Math.max(60_000, Number(r.rows[0]?.ms) || 24 * 60 * 60 * 1000));
}

/**
 * Denný cron — volaj raz pri server boote. Bez SHEETS_EXPORT_URL sa iba
 * zaloguje a nič neplánuje. Chyba behu NESMIE zabiť ďalšie tiky (kasa beží
 * bez dozoru) — zaloguje sa a plánuje sa ďalší deň.
 */
export function startSheetsExportCron() {
  if (_timer) return;
  if (!isSheetsExportEnabled()) {
    console.log('[sheets-export] disabled (SHEETS_EXPORT_URL not set)');
    return;
  }
  async function loop() {
    try {
      const r = await runSheetsExportOnce();
      console.log(`[sheets-export] daily run ok: ${r.rows} rows (${r.from} – ${r.to})`);
    } catch (e) {
      console.error('[sheets-export] daily run failed:', e?.message || e);
    }
    const ms = await msUntilNext0510Local();
    _timer = setTimeout(loop, ms);
  }
  msUntilNext0510Local().then((ms) => {
    console.log(`[sheets-export] enabled, first run in ${Math.round(ms / 60000)} min`);
    _timer = setTimeout(loop, ms);
  });
}

export function stopSheetsExportCron() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}
