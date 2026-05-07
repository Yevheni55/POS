// Sezóna — beautiful summary dashboard from opening day (25.04).
// Re-uses existing admin design tokens — no inline mini-design system.
// Štruktúra: filter-bar (period chips) → 4 stat-cards → panely
// (daily chart, top products, dest split, day-of-week heatmap).
// All styling uses .stat-grid / .stat-card / .panel patterns shared
// with dashboard + reports.

let _container = null;
let _data = null;
const SEASON_START = '2026-04-25';

function $(s){ return _container.querySelector(s); }

function fmtEur(n, opts){
  opts = opts || {};
  const x = Number(n) || 0;
  return x.toLocaleString('sk-SK', {
    minimumFractionDigits: opts.dec != null ? opts.dec : 2,
    maximumFractionDigits: opts.dec != null ? opts.dec : 2,
  }) + ' €';
}
function fmtInt(n){ return (Number(n) || 0).toLocaleString('sk-SK'); }
function fmtPct(n){ return (Number(n) || 0).toFixed(1) + ' %'; }
function fmtNumNoEur(n){
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function todayStr(){ return new Date().toISOString().split('T')[0]; }
function daysBetween(a, b){
  const A = new Date(a), B = new Date(b);
  return Math.max(1, Math.round((B - A) / 86400000) + 1);
}
function formatDateSk(iso){
  const [y, m, d] = iso.split('-');
  return d + '.' + m + '.' + y;
}
function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const DAY_LABEL_SK = ['Ne','Po','Ut','St','Št','Pi','So'];
const DAY_FULL_SK  = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'];
const MONTH_FULL_SK = ['januára','februára','marca','apríla','mája','júna','júla','augusta','septembra','októbra','novembra','decembra'];

async function load(){
  try {
    const data = await api.get('/reports/summary?from=' + SEASON_START + '&to=' + todayStr());
    _data = data;
    render();
  } catch (err) {
    $('#seasonContent').innerHTML = '<div class="empty-state" style="padding:60px;text-align:center"><div class="empty-state-title" style="color:var(--color-danger)">Chyba načítania</div><div class="empty-state-text">' + (err.message || 'API zlyhalo') + '</div></div>';
  }
}

function render(){
  const d = _data;
  if (!d) return;

  const days = daysBetween(SEASON_START, todayStr());
  const daysActual = (d.daily || []).filter(x => x.revenue > 0).length;

  const trzba    = Number(d.totalRevenue) || 0;
  const cogs     = Number(d.totalCogs) || 0;
  const mzdy     = Number(d.totalLabor) || 0;
  const vysledok = Number(d.totalProfit) || 0;
  const vysledokPct = trzba > 0 ? (vysledok / trzba) * 100 : 0;
  const avgDaily = daysActual > 0 ? trzba / daysActual : 0;

  const dailySorted = (d.daily || []).slice().sort((a,b) => b.revenue - a.revenue);
  const bestDay = dailySorted[0];
  const worstDayWithSales = (d.daily || []).filter(x => x.revenue > 0).sort((a,b) => a.revenue - b.revenue)[0];

  const profitClass = vysledok >= 0 ? 'up' : '';
  const profitColor = vysledok >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
  const profitSign = vysledok >= 0 ? '+' : '';

  const html = `
    <!-- Filter bar — perioda info, no editable dates (sezóna je fixná) -->
    <div class="filter-bar">
      <div class="period-btns" style="margin-right:auto">
        <span class="period-btn active" style="cursor:default">Sezóna</span>
      </div>
      <div style="font-size:13px;color:var(--color-text-sec)">
        ${formatDateSk(SEASON_START)} – ${formatDateSk(todayStr())} ·
        <strong style="color:var(--color-text)">${daysActual}</strong>/${days} aktívnych dní
      </div>
    </div>

    <!-- 4 main stat cards — same structure as Reporty page -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon ice">
          <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Celkové tržby</div>
          <div class="stat-value">${fmtEur(trzba)}</div>
          <div class="stat-change neutral">${fmtEur(avgDaily)} priemer/deň · ${fmtInt(d.totalOrders)} obj.</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon amber">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 3h18v4H3z"/><path d="M5 7v14h14V7"/><path d="M9 11h6"/><path d="M9 15h6"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Náklady na výrobu</div>
          <div class="stat-value">${fmtEur(cogs)}</div>
          <div class="stat-change neutral">${trzba>0 ? fmtPct(cogs/trzba*100) + ' z tržieb' : '—'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Mzdy</div>
          <div class="stat-value">${fmtEur(mzdy)}</div>
          <div class="stat-change neutral">${trzba>0 ? fmtPct(mzdy/trzba*100) + ' z tržieb' : '—'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon mint">
          <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Výsledok</div>
          <div class="stat-value" style="color:${profitColor}">${profitSign}${fmtEur(vysledok)}</div>
          <div class="stat-change ${profitClass}">${vysledokPct.toFixed(1)} % marža</div>
        </div>
      </div>
    </div>

    <!-- Daily revenue chart panel -->
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Tržby po dňoch</div>
      ${renderDailyChart(d.daily || [])}
    </div>

    <!-- Best / worst day panels (2-col grid) -->
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      ${bestDay ? renderDayCard(bestDay, 'success', 'Najlepší deň') : ''}
      ${worstDayWithSales && worstDayWithSales.date !== (bestDay && bestDay.date) ? renderDayCard(worstDayWithSales, 'danger', 'Najslabší deň') : ''}
    </div>

    <!-- Top products + Bar/Kuchyňa split (2-col grid) -->
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      <div class="panel">
        <div class="panel-title">Top 10 produktov</div>
        <div style="font-size:12px;color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">podľa tržieb za sezónu</div>
        ${renderTopProducts(d.products || [])}
      </div>

      <div class="panel">
        <div class="panel-title">Bar vs Kuchyňa</div>
        <div style="font-size:12px;color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">distribúcia tržieb</div>
        ${renderDestSplit(d.revenueByDest)}
      </div>
    </div>

    <!-- Day-of-week heatmap -->
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Deň v týždni</div>
      <div style="font-size:12px;color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">priemerná tržba podľa dňa v týždni</div>
      ${renderDowHeatmap(d.daily || [])}
    </div>
  `;

  $('#seasonContent').innerHTML = html;
}

// === Daily chart — vertical bars with profit dot under each ===
function renderDailyChart(daily){
  if (!daily.length) return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne dni</div>';
  const maxRev = Math.max(...daily.map(d => d.revenue));
  return `
    <div class="season-chart">
      ${daily.map(d => {
        const h = maxRev > 0 ? (d.revenue / maxRev) * 100 : 0;
        const date = new Date(d.date);
        const dow = DAY_LABEL_SK[date.getDay()];
        const profit = Number(d.profit) || 0;
        const profitClass = profit > 0 ? 'pos' : profit < 0 ? 'neg' : 'zero';
        return `<div class="season-chart-bar" title="${formatDateSk(d.date)} ${dow} — ${fmtEur(d.revenue)} (výsledok ${fmtEur(profit)})">
          <div class="season-chart-val">${fmtNumNoEur(d.revenue)}</div>
          <div class="season-chart-fill" style="height:${h}%"></div>
          <div class="season-chart-dot ${profitClass}"></div>
          <div class="season-chart-day">${dow}</div>
          <div class="season-chart-date">${date.getDate()}.${date.getMonth()+1}.</div>
        </div>`;
      }).join('')}
    </div>
    <div class="season-chart-legend">
      <span><span class="dot pos"></span>výsledok kladný</span>
      <span><span class="dot neg"></span>výsledok záporný</span>
    </div>
  `;
}

// === Best / worst day card — fits the .panel container ===
function renderDayCard(day, kind, title){
  const date = new Date(day.date);
  const dow = DAY_FULL_SK[date.getDay()];
  const fullDate = date.getDate() + '. ' + MONTH_FULL_SK[date.getMonth()] + ' ' + date.getFullYear();
  const profit = Number(day.profit) || 0;
  const profitColor = profit > 0 ? 'var(--color-success)' : 'var(--color-danger)';
  const accentClass = kind === 'success' ? 'season-day-success' : 'season-day-danger';
  return `<div class="panel ${accentClass}">
    <div class="panel-title">${title}</div>
    <div style="font-size:12px;color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">${dow} · ${fullDate}</div>
    <table class="data-table" style="margin-bottom:0">
      <tbody>
        <tr><td>Tržby</td><td class="num text-right highlight-cell">${fmtEur(day.revenue)}</td></tr>
        <tr><td>Objednávky</td><td class="num text-right">${fmtInt(day.orders)}</td></tr>
        <tr><td>Priemerný účet</td><td class="num text-right">${fmtEur(day.avgCheck)}</td></tr>
        <tr><td>Výroba</td><td class="num text-right">${fmtEur(day.cogs || 0)}</td></tr>
        <tr><td>Mzdy</td><td class="num text-right">${fmtEur(day.labor || 0)}</td></tr>
      </tbody>
      <tfoot>
        <tr>
          <td>Výsledok</td>
          <td class="num text-right" style="color:${profitColor}">${profit >= 0 ? '+' : ''}${fmtEur(profit)}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

// === Top products list ===
function renderTopProducts(products){
  const top = products.slice(0, 10);
  if (!top.length) return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne produkty</div>';
  const max = Math.max(...top.map(p => p.revenue));
  return `<table class="data-table">
    <thead>
      <tr>
        <th style="width:32px">#</th>
        <th>Produkt</th>
        <th class="text-right">Ks</th>
        <th class="text-right">Tržby</th>
      </tr>
    </thead>
    <tbody>
      ${top.map((p, i) => {
        const w = max > 0 ? (p.revenue / max) * 100 : 0;
        const profit = Number(p.profit) || 0;
        const margin = p.revenue > 0 ? (profit / p.revenue) * 100 : 0;
        const cogs = Number(p.cogs) || 0;
        let rankStyle = '';
        if (i === 0) rankStyle = 'color:var(--color-accent);font-weight:700';
        else if (i === 1) rankStyle = 'color:var(--color-text-sec);font-weight:700';
        else if (i === 2) rankStyle = 'color:rgba(205,127,50,.7);font-weight:700';
        return `<tr>
          <td class="num" style="${rankStyle}">${i + 1}</td>
          <td class="td-name">${p.emoji || ''} ${escapeHtml(p.name)}<div style="font-size:11px;color:var(--color-text-dim)">${escapeHtml(p.category || '')}</div></td>
          <td class="num text-right">${fmtInt(p.qty)}</td>
          <td class="text-right">
            <div class="progress-wrap"><div class="progress-fill" style="width:${w}%"></div></div>
            <div class="num" style="font-size:13px;margin-top:4px">${fmtEur(p.revenue)}</div>
            ${cogs > 0 ? `<div style="font-size:10px;color:var(--color-text-dim)">marža ${margin.toFixed(0)} %</div>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

// === Bar / Kuchyňa split ===
function renderDestSplit(rev){
  if (!rev) return '<div class="td-empty">—</div>';
  const bar = Number(rev.bar) || 0;
  const kuch = Number(rev.kuchyna) || 0;
  const total = bar + kuch;
  const barPct = total > 0 ? (bar/total)*100 : 0;
  const kuchPct = total > 0 ? (kuch/total)*100 : 0;
  return `
    <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.05);margin-bottom:18px">
      <div style="width:${barPct}%;background:var(--color-accent)" title="Bar — ${fmtEur(bar)}"></div>
      <div style="width:${kuchPct}%;background:var(--color-success)" title="Kuchyňa — ${fmtEur(kuch)}"></div>
    </div>
    <table class="data-table">
      <tbody>
        <tr>
          <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--color-accent);margin-right:8px;vertical-align:middle"></span>Bar</td>
          <td class="num text-right" style="color:var(--color-text-sec);width:60px">${barPct.toFixed(1)} %</td>
          <td class="num text-right highlight-cell">${fmtEur(bar)}</td>
          <td class="num text-right" style="color:var(--color-text-dim);font-size:11px">${fmtInt(rev.itemsBar)} ks</td>
        </tr>
        <tr>
          <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--color-success);margin-right:8px;vertical-align:middle"></span>Kuchyňa</td>
          <td class="num text-right" style="color:var(--color-text-sec)">${kuchPct.toFixed(1)} %</td>
          <td class="num text-right highlight-cell">${fmtEur(kuch)}</td>
          <td class="num text-right" style="color:var(--color-text-dim);font-size:11px">${fmtInt(rev.itemsKuchyna)} ks</td>
        </tr>
      </tbody>
    </table>
  `;
}

// === Day-of-week heatmap (Po-Ne) ===
function renderDowHeatmap(daily){
  const buckets = [0,0,0,0,0,0,0].map(() => ({ rev: 0, count: 0 }));
  for (const d of daily){
    const dow = new Date(d.date).getDay();
    buckets[dow].rev += Number(d.revenue) || 0;
    buckets[dow].count += 1;
  }
  const order = [1,2,3,4,5,6,0]; // Po=1...Ne=0
  const labels = ['Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota','Nedeľa'];
  const avgs = order.map((dow, i) => ({
    label: labels[i],
    short: DAY_LABEL_SK[dow],
    avg: buckets[dow].count > 0 ? buckets[dow].rev / buckets[dow].count : 0,
    count: buckets[dow].count,
  }));
  const max = Math.max(...avgs.map(a => a.avg));
  return `<div class="season-heatmap">${
    avgs.map(a => {
      const pct = max > 0 ? (a.avg/max)*100 : 0;
      const tier = pct === 0 ? 0 : pct < 33 ? 1 : pct < 66 ? 2 : 3;
      return `<div class="season-hm-cell tier-${tier}" title="${a.label} — priemer ${fmtEur(a.avg)} z ${a.count} dní">
        <div class="season-hm-day">${a.short}</div>
        <div class="season-hm-num">${a.count > 0 ? fmtEur(a.avg, {dec:0}) : '—'}</div>
        <div class="season-hm-foot">${a.count} dní</div>
      </div>`;
    }).join('')
  }</div>`;
}

// === Page CSS — používa iba admin tokens. Žiadne novy palety, fonty, hex hodnoty.
//     Dodržuje DESIGN-CODE.md: tokens-first, mobile-first, motion-safe. ===
const PAGE_CSS = `
<style>
  /* Best/worst panel accent — left border in semantic color */
  .season-day-success{ border-left: 3px solid var(--color-success); }
  .season-day-danger { border-left: 3px solid var(--color-danger);  }

  /* Daily revenue chart — vertical bars, fits inside .panel */
  .season-chart{
    display:flex; align-items:flex-end; gap:4px;
    height:180px;
    overflow-x:auto;
    padding:8px 2px 4px;
    scrollbar-width: thin;
  }
  .season-chart-bar{
    flex:1 0 38px;
    min-width:38px;
    display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
    gap:4px;
    height:100%;
    cursor:default;
  }
  .season-chart-fill{
    width:70%;
    background: linear-gradient(180deg, var(--color-accent), var(--color-accent-dim));
    border-radius: var(--radius-xs) var(--radius-xs) 0 0;
    min-height: 2px;
    transition: filter var(--transition-fast);
  }
  .season-chart-bar:hover .season-chart-fill{ filter: brightness(1.15) }
  .season-chart-val{
    font-size: var(--text-2xs);
    color: var(--color-text-dim);
    white-space: nowrap;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }
  .season-chart-bar:hover .season-chart-val{ opacity: 1 }
  .season-chart-dot{
    width: 6px; height: 6px; border-radius: 50%;
    margin-top: -3px;
  }
  .season-chart-dot.pos { background: var(--color-success) }
  .season-chart-dot.neg { background: var(--color-danger) }
  .season-chart-dot.zero{ background: var(--color-text-dim) }
  .season-chart-day{
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    margin-top: 2px;
  }
  .season-chart-date{
    font-size: var(--text-2xs);
    color: var(--color-text-dim);
  }
  .season-chart-legend{
    display: flex;
    gap: 18px;
    margin-top: 12px;
    font-size: var(--text-sm);
    color: var(--color-text-sec);
  }
  .season-chart-legend .dot{
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .season-chart-legend .dot.pos{ background: var(--color-success) }
  .season-chart-legend .dot.neg{ background: var(--color-danger) }

  /* Day-of-week heatmap — same look as admin .stat-card with tier-tinted bg */
  .season-heatmap{
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 8px;
  }
  .season-hm-cell{
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 14px 8px;
    text-align: center;
    transition: transform var(--transition-fast), background var(--transition-fast);
  }
  .season-hm-cell:hover{ transform: translateY(-2px); background: var(--color-bg-hover) }
  .season-hm-cell.tier-0{ opacity: .55 }
  .season-hm-cell.tier-1{ background: rgba(139,124,246,.06); border-color: rgba(139,124,246,.18) }
  .season-hm-cell.tier-2{ background: rgba(139,124,246,.14); border-color: rgba(139,124,246,.30) }
  .season-hm-cell.tier-3{ background: rgba(139,124,246,.24); border-color: var(--color-accent) }
  .season-hm-day{
    font-size: var(--text-sm);
    font-weight: var(--weight-bold);
    color: var(--color-text);
    margin-bottom: 6px;
    letter-spacing: var(--tracking-wide);
  }
  .season-hm-num{
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }
  .season-hm-foot{
    font-size: var(--text-2xs);
    color: var(--color-text-dim);
    margin-top: 4px;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  /* Progress bar (used in Top 10 produktov) — used existing tokens */
  .progress-wrap{
    height: 4px;
    background: rgba(255,255,255,.05);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill{
    height: 100%;
    background: linear-gradient(90deg, var(--color-accent-dim), var(--color-accent));
    border-radius: 2px;
  }

  /* Responsive — 2-col grids stack on narrow screens */
  @media (max-width: 880px){
    .season-page-grid-2col{ grid-template-columns: 1fr !important }
  }
  @media (max-width: 540px){
    .season-heatmap{ grid-template-columns: repeat(7, 1fr); gap: 4px }
    .season-hm-cell{ padding: 10px 4px }
    .season-hm-num{ font-size: var(--text-md) }
  }

  /* Motion-safe — DESIGN-CODE.md § 9.2 */
  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{
      animation-duration: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
    }
  }
</style>
`;

const TEMPLATE = PAGE_CSS + `
<div id="seasonContent">
  <div class="loading-text" style="text-align:center;padding:80px 20px">Načítavam štatistiky sezóny...</div>
</div>
`;

export function init(container){
  _container = container;
  container.innerHTML = TEMPLATE;
  // Apply 2-col stack class to row grids so mobile collapses cleanly
  Array.from(container.querySelectorAll('.row')).forEach(el => el.classList.add('season-page-grid-2col'));
  load();
}

export function destroy(){
  _container = null;
  _data = null;
}
