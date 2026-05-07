// Týždeň — detailná štatistika podľa hodín:
//   • predaj podľa hodín (stacked bar/kuchyňa)
//   • zaťaženosť kuchyne podľa hodín
//   • efektivita kuchára (kitchen €/hod cook)
//
// Dodržuje DESIGN-CODE.md — žiadne hex hodnoty, žiadne nové fonty,
// všetko cez tokens.css a admin patterns (.stat-grid, .panel, .data-table).

let _container = null;
let _data = null;
let _from = null;
let _to = null;

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
function fmtHours(min){
  const h = Math.floor((min || 0) / 60);
  const m = Math.round((min || 0) % 60);
  return h + 'h ' + String(m).padStart(2,'0') + 'm';
}
function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Pondelok = ISO 1, Nedeľa = ISO 7
const DOW_LABEL = { 1:'Po', 2:'Ut', 3:'St', 4:'Št', 5:'Pi', 6:'So', 7:'Ne' };
const DOW_FULL  = { 1:'Pondelok', 2:'Utorok', 3:'Streda', 4:'Štvrtok', 5:'Piatok', 6:'Sobota', 7:'Nedeľa' };

function todayStr(){ return new Date().toISOString().split('T')[0]; }
function thisMondayStr(){
  const d = new Date();
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // Po=0..Ne=6
  d.setDate(d.getDate() - dow);
  return d.toISOString().split('T')[0];
}
function lastSundayStr(){
  const d = new Date();
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - dow + 6);
  return d.toISOString().split('T')[0];
}
function shiftWeek(deltaWeeks){
  const fromD = new Date(_from);
  fromD.setDate(fromD.getDate() + deltaWeeks * 7);
  const toD = new Date(_to);
  toD.setDate(toD.getDate() + deltaWeeks * 7);
  _from = fromD.toISOString().split('T')[0];
  _to = toD.toISOString().split('T')[0];
  load();
}
function fmtDateSk(iso){
  const [y,m,d] = iso.split('-');
  return d + '.' + m + '.';
}

async function load(){
  $('#weeklyContent').innerHTML = '<div class="loading-text" style="text-align:center;padding:60px 20px">Načítavam...</div>';
  try {
    const data = await api.get('/reports/weekly?from=' + _from + '&to=' + _to);
    _data = data;
    render();
  } catch (err) {
    $('#weeklyContent').innerHTML = '<div class="empty-state" style="padding:60px;text-align:center"><div class="empty-state-title" style="color:var(--color-danger)">Chyba načítania</div><div class="empty-state-text">' + (err.message || 'API zlyhalo') + '</div></div>';
  }
}

function render(){
  const d = _data;
  if (!d) return;

  const totals = d.totals || {};
  const totalRev = (totals.kitchenRevenue || 0) + (totals.barRevenue || 0);
  const kitchenPct = totalRev > 0 ? ((totals.kitchenRevenue || 0) / totalRev * 100) : 0;

  const peakHourSale = (d.byHour || []).reduce((best, h) =>
    (h.totalRevenue > (best?.totalRevenue || 0)) ? h : best, null);
  const peakHourKitchen = (d.byHour || []).reduce((best, h) =>
    (h.kitchenRevenue > (best?.kitchenRevenue || 0)) ? h : best, null);

  const html = `
    <div class="filter-bar">
      <div class="period-btns">
        <button class="period-btn" id="prevWeek">‹ Predošlý</button>
        <button class="period-btn active" style="cursor:default">${fmtDateSk(_from)} – ${fmtDateSk(_to)}</button>
        <button class="period-btn" id="nextWeek">Ďalší ›</button>
        <button class="period-btn" id="thisWeek">Tento týždeň</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon ice">
          <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby týždňa</div>
          <div class="stat-value">${fmtEur(totalRev)}</div>
          <div class="stat-change neutral">${fmtPct(kitchenPct)} z kuchyne</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon mint">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M9 6V3h6v3"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby kuchyne</div>
          <div class="stat-value">${fmtEur(totals.kitchenRevenue || 0)}</div>
          <div class="stat-change neutral">${peakHourKitchen && peakHourKitchen.kitchenRevenue > 0 ? 'peak ' + String(peakHourKitchen.hour).padStart(2,'0') + ':00' : '—'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Hodiny v kuchyni</div>
          <div class="stat-value">${fmtHours((totals.cookHours || 0) * 60)}</div>
          <div class="stat-change neutral">${(d.cooks || []).length} ${(d.cooks || []).length === 1 ? 'osoba' : 'os.'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon amber">
          <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Efektivita kuchár</div>
          <div class="stat-value">${fmtEur(totals.avgKitchenEfficiency || 0)}</div>
          <div class="stat-change neutral">€ kuchyne / hod práce</div>
        </div>
      </div>
    </div>

    ${d.noKitchenStaff ? `
      <div class="panel" style="margin-bottom:16px;border-color:rgba(232,184,74,.3);background:rgba(232,184,74,.06)">
        <div style="display:flex;gap:14px;align-items:center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="var(--accent-amber)"/></svg>
          <div>
            <div style="font-weight:var(--weight-semibold);color:var(--color-text);font-size:var(--text-md)">Žiadny zamestnanec s pozíciou „kuchár"</div>
            <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:2px">
              Pre presnú efektivitu kuchára nastav v admin → Zamestnanci → pozícia text obsahujúci „kuchár"/„cook"/„chef".
              Teraz počítam s celým personálom.
            </div>
          </div>
        </div>
      </div>
    ` : ''}

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Predaj podľa hodín</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">stĺpce ukazujú tržby bar + kuchyňa</div>
      ${renderHourlyChart(d.byHour || [])}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Zaťaženosť kuchyne</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">tržby kuchyne podľa dňa × hodiny</div>
      ${renderHeatmap(d.heatmap || [])}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Efektivita kuchára</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">koľko € v kuchyni vyprodukoval každý kuchár za hodinu</div>
      ${renderCookTable(d.cooks || [])}
    </div>

    <div class="panel">
      <div class="panel-title">Hodinová tabuľka</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">presné čísla pre každú hodinu</div>
      ${renderHourTable(d.byHour || [])}
    </div>
  `;

  $('#weeklyContent').innerHTML = html;
  $('#prevWeek').addEventListener('click', () => shiftWeek(-1));
  $('#nextWeek').addEventListener('click', () => shiftWeek(1));
  $('#thisWeek').addEventListener('click', () => {
    _from = thisMondayStr();
    _to = lastSundayStr();
    load();
  });
}

function fmtPct(n){ return (Number(n) || 0).toFixed(1) + ' %'; }

// === Hourly chart — stacked bars (bar + kitchen) ===
function renderHourlyChart(byHour){
  const max = Math.max(...byHour.map(h => h.totalRevenue), 1);
  return `
    <div class="weekly-hourly-chart">
      ${byHour.map(h => {
        const total = h.totalRevenue || 0;
        const heightPct = (total / max) * 100;
        const barH = total > 0 ? (h.barRevenue / total) * heightPct : 0;
        const kitchH = total > 0 ? (h.kitchenRevenue / total) * heightPct : 0;
        return `<div class="weekly-bar" title="${String(h.hour).padStart(2,'0')}:00 — ${fmtEur(total)} (kuchyňa ${fmtEur(h.kitchenRevenue)} · bar ${fmtEur(h.barRevenue)})">
          <div class="weekly-bar-stack">
            <div class="weekly-bar-fill kitchen" style="height:${kitchH}%"></div>
            <div class="weekly-bar-fill bar" style="height:${barH}%"></div>
          </div>
          <div class="weekly-bar-hour">${String(h.hour).padStart(2,'0')}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="weekly-chart-legend">
      <span><span class="legend-dot kitchen"></span>Kuchyňa</span>
      <span><span class="legend-dot bar"></span>Bar</span>
    </div>
  `;
}

// === Weekday × hour heatmap of kitchen revenue ===
function renderHeatmap(heatmap){
  // Build 7×24 grid (filter to active hour range)
  const max = Math.max(...heatmap.map(c => c.kitchenRevenue), 0);
  const minHour = Math.min(...heatmap.map(c => c.hour), 23);
  const maxHour = Math.max(...heatmap.map(c => c.hour), 0);
  if (max === 0) return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne kuchynské tržby v období</div>';

  const cellMap = new Map();
  for (const c of heatmap) cellMap.set(c.weekday + '|' + c.hour, c);

  let html = '<div class="weekly-heatmap"><table class="weekly-hm-table">';
  // Header row — hours
  html += '<thead><tr><th></th>';
  for (let h = minHour; h <= maxHour; h++){
    html += '<th>' + String(h).padStart(2,'0') + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let dow = 1; dow <= 7; dow++){
    html += '<tr><th class="dow-label">' + DOW_LABEL[dow] + '</th>';
    for (let h = minHour; h <= maxHour; h++){
      const c = cellMap.get(dow + '|' + h);
      const val = c ? c.kitchenRevenue : 0;
      const pct = max > 0 ? (val / max) * 100 : 0;
      const tier = pct === 0 ? 0 : pct < 25 ? 1 : pct < 50 ? 2 : pct < 75 ? 3 : 4;
      html += `<td class="hm-cell tier-${tier}" title="${DOW_FULL[dow]} ${String(h).padStart(2,'0')}:00 — ${fmtEur(val)}">${val > 0 ? Math.round(val) : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="weekly-chart-legend"><span><span class="legend-dot tier-1"></span>menej</span><span><span class="legend-dot tier-2"></span></span><span><span class="legend-dot tier-3"></span></span><span><span class="legend-dot tier-4"></span>viac</span></div>';
  return html;
}

function renderCookTable(cooks){
  if (!cooks.length){
    return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne smeny v týždni</div>';
  }
  return `
    <div class="table-scroll-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Meno</th>
          <th>Pozícia</th>
          <th class="text-right">Hodiny</th>
          <th class="text-right">Mzda</th>
          <th class="text-right">Tržby kuchyne</th>
          <th class="text-right">€/hod efektivita</th>
        </tr>
      </thead>
      <tbody>
        ${cooks.map(c => `<tr>
          <td class="td-name">${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.position) || '<span style="color:var(--color-text-dim)">—</span>'}</td>
          <td class="num text-right">${fmtHours(c.minutes)}</td>
          <td class="num text-right">${fmtEur(c.wage)}</td>
          <td class="num text-right">${fmtEur(c.kitchenRevenue)}</td>
          <td class="num text-right highlight-cell">${fmtEur(c.efficiency)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderHourTable(byHour){
  const filtered = byHour.filter(h => h.totalRevenue > 0 || h.cookMinutes > 0);
  if (!filtered.length){
    return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne dáta</div>';
  }
  return `
    <div class="table-scroll-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Hodina</th>
          <th class="text-right">Obj.</th>
          <th class="text-right">Bar</th>
          <th class="text-right">Kuchyňa</th>
          <th class="text-right">Spolu</th>
          <th class="text-right">Hodiny v kuchyni</th>
          <th class="text-right">€/hod efektivita</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(h => `<tr>
          <td class="num">${String(h.hour).padStart(2,'0')}:00</td>
          <td class="num text-right">${fmtInt(h.orders)}</td>
          <td class="num text-right">${h.barRevenue > 0 ? fmtEur(h.barRevenue) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
          <td class="num text-right">${h.kitchenRevenue > 0 ? fmtEur(h.kitchenRevenue) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
          <td class="num text-right highlight-cell">${fmtEur(h.totalRevenue)}</td>
          <td class="num text-right">${h.cookMinutes > 0 ? fmtHours(h.cookMinutes) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
          <td class="num text-right">${h.kitchenEfficiency > 0 ? fmtEur(h.kitchenEfficiency) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
  `;
}

// Page CSS — only chart/heatmap specific styles. Everything else cez tokens + admin.css.
const PAGE_CSS = `
<style>
  .weekly-hourly-chart{
    display:flex;
    align-items:flex-end;
    gap:3px;
    height:200px;
    padding:8px 2px 4px;
    overflow-x:auto;
  }
  .weekly-bar{
    flex:1 0 32px;
    min-width:32px;
    height:100%;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:flex-end;
    gap:4px;
  }
  .weekly-bar-stack{
    width:100%;
    height:calc(100% - 18px);
    display:flex;
    flex-direction:column;
    justify-content:flex-end;
  }
  .weekly-bar-fill{
    width:100%;
    transition: filter var(--transition-fast);
  }
  .weekly-bar-fill.kitchen{
    background: linear-gradient(180deg, var(--color-success), rgba(92,196,158,.7));
    border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  }
  .weekly-bar-fill.bar{
    background: linear-gradient(180deg, var(--color-accent-dim), rgba(123,110,199,.6));
  }
  .weekly-bar:hover .weekly-bar-fill{ filter: brightness(1.2) }
  .weekly-bar-hour{
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    font-variant-numeric: tabular-nums;
  }

  .weekly-chart-legend{
    display:flex;
    gap:18px;
    margin-top:14px;
    font-size: var(--text-sm);
    color: var(--color-text-sec);
    flex-wrap:wrap;
  }
  .weekly-chart-legend .legend-dot{
    display:inline-block;
    width:10px; height:10px;
    border-radius: var(--radius-xs);
    margin-right:6px;
    vertical-align: middle;
  }
  .legend-dot.kitchen{ background: var(--color-success) }
  .legend-dot.bar    { background: var(--color-accent) }
  .legend-dot.tier-1 { background: rgba(139,124,246,.18) }
  .legend-dot.tier-2 { background: rgba(139,124,246,.40) }
  .legend-dot.tier-3 { background: rgba(139,124,246,.65) }
  .legend-dot.tier-4 { background: var(--color-accent) }

  /* Heatmap — 7 rows (Po-Ne) × N hours */
  .weekly-heatmap{ overflow-x: auto; -webkit-overflow-scrolling: touch }
  .weekly-hm-table{
    border-collapse: separate;
    border-spacing: 2px;
    font-size: var(--text-xs);
  }
  .weekly-hm-table th{
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    padding: 4px 6px;
    text-align: center;
    background: transparent;
    border-bottom: none;
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }
  .weekly-hm-table th.dow-label{
    text-align: right;
    padding-right: 10px;
    color: var(--color-text);
    font-weight: var(--weight-bold);
    background: transparent;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--text-sm);
  }
  .weekly-hm-table td.hm-cell{
    width: 38px; height: 30px;
    text-align: center;
    border-radius: var(--radius-xs);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    font-variant-numeric: tabular-nums;
    transition: transform var(--transition-fast);
  }
  .weekly-hm-table td.hm-cell:hover{ transform: scale(1.08) }
  .hm-cell.tier-0{ background: rgba(255,255,255,.03); color: var(--color-text-dim) }
  .hm-cell.tier-1{ background: rgba(139,124,246,.18); color: var(--color-text) }
  .hm-cell.tier-2{ background: rgba(139,124,246,.40); color: var(--color-text) }
  .hm-cell.tier-3{ background: rgba(139,124,246,.65); color: #fff; font-weight: var(--weight-bold) }
  .hm-cell.tier-4{ background: var(--color-accent); color: #fff; font-weight: var(--weight-bold) }

  /* Motion-safe — DESIGN-CODE.md § 9.2 */
  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{
      animation-duration: 0s !important;
      transition-duration: 0s !important;
    }
  }
</style>
`;

const TEMPLATE = PAGE_CSS + `
<div id="weeklyContent">
  <div class="loading-text" style="text-align:center;padding:80px 20px">Načítavam...</div>
</div>
`;

export function init(container){
  _container = container;
  container.innerHTML = TEMPLATE;
  _from = thisMondayStr();
  _to   = lastSundayStr();
  load();
}

export function destroy(){
  _container = null;
  _data = null;
}
