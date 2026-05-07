// Sezóna — beautiful summary dashboard from opening day (25.04)
// Pulls /reports/summary for the full period and renders hero stats,
// daily chart, top products, best/worst days, category split.

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

function todayStr(){ return new Date().toISOString().split('T')[0]; }

function daysBetween(a, b){
  const A = new Date(a), B = new Date(b);
  return Math.max(1, Math.round((B - A) / 86400000) + 1);
}

const DAY_LABEL_SK = ['Ne','Po','Ut','St','Št','Pi','So'];

async function load(){
  try {
    const data = await api.get('/reports/summary?from=' + SEASON_START + '&to=' + todayStr());
    _data = data;
    render();
  } catch (err) {
    $('#seasonContent').innerHTML = '<div class="empty-state" style="padding:60px"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Chyba načítania</div><div class="empty-state-text">' + (err.message || 'API zlyhalo') + '</div></div>';
  }
}

function render(){
  const d = _data;
  if (!d) return;

  const days = daysBetween(SEASON_START, todayStr());
  const daysActual = (d.daily || []).filter(x => x.revenue > 0).length;

  const trzba   = Number(d.totalRevenue) || 0;
  const cogs    = Number(d.totalCogs) || 0;
  const mzdy    = Number(d.totalLabor) || 0;
  const vysledok = Number(d.totalProfit) || 0;
  const vysledokPct = trzba > 0 ? (vysledok / trzba) * 100 : 0;

  const avgDaily = daysActual > 0 ? trzba / daysActual : 0;
  const avgOrder = d.totalOrders > 0 ? trzba / d.totalOrders : 0;

  const profitColor = vysledok > 0 ? 'var(--color-success, #22c55e)' : 'var(--color-danger, #ef4444)';

  // Top revenue and worst days from daily
  const dailySorted = (d.daily || []).slice().sort((a,b) => b.revenue - a.revenue);
  const bestDay = dailySorted[0];
  const worstDayWithSales = (d.daily || []).filter(x => x.revenue > 0).sort((a,b) => a.revenue - b.revenue)[0];

  const html = `
    <!-- HERO -->
    <div class="season-hero">
      <div class="season-hero-grain"></div>
      <div class="season-hero-content">
        <div class="season-eyebrow">— Letná sezóna —</div>
        <h1 class="season-title">Sezóna <em>2026</em></h1>
        <div class="season-tagline">Od ${formatDateSk(SEASON_START)} do <strong>dnes</strong> · ${daysActual} aktívnych dní z ${days}</div>
        <div class="season-hero-revenue">
          <span class="season-currency">€</span>
          <span class="season-bignum">${fmtNumNoEur(trzba)}</span>
          <div class="season-revenue-label">celkové tržby od otvorenia</div>
        </div>
      </div>
    </div>

    <!-- 4 main stat cards -->
    <div class="season-stats-grid">
      <div class="season-stat">
        <div class="season-stat-icon ice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 1v22M5 8h14a3 3 0 0 1 0 6H5a3 3 0 0 0 0 6h14"/></svg>
        </div>
        <div class="season-stat-meta">
          <div class="season-stat-label">Tržby</div>
          <div class="season-stat-num">${fmtEur(trzba)}</div>
          <div class="season-stat-foot">${fmtEur(avgDaily)} priemer/deň · ${fmtInt(d.totalOrders)} objednávok</div>
        </div>
      </div>

      <div class="season-stat">
        <div class="season-stat-icon amber">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3h18v4H3zM5 7v14h14V7"/><path d="M9 11h6M9 15h6"/></svg>
        </div>
        <div class="season-stat-meta">
          <div class="season-stat-label">Náklady na výrobu</div>
          <div class="season-stat-num">${fmtEur(cogs)}</div>
          <div class="season-stat-foot">${trzba>0 ? fmtPct(cogs/trzba*100) : '—'} z tržieb</div>
        </div>
      </div>

      <div class="season-stat">
        <div class="season-stat-icon lavender">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="season-stat-meta">
          <div class="season-stat-label">Mzdy</div>
          <div class="season-stat-num">${fmtEur(mzdy)}</div>
          <div class="season-stat-foot">${trzba>0 ? fmtPct(mzdy/trzba*100) : '—'} z tržieb</div>
        </div>
      </div>

      <div class="season-stat profit ${vysledok > 0 ? 'plus' : 'minus'}">
        <div class="season-stat-icon mint">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="season-stat-meta">
          <div class="season-stat-label">Výsledok</div>
          <div class="season-stat-num" style="color:${profitColor}">${vysledok >= 0 ? '+' : ''}${fmtEur(vysledok)}</div>
          <div class="season-stat-foot">${vysledokPct.toFixed(1)} % marža (pred ostatnými nákladmi)</div>
        </div>
      </div>
    </div>

    <!-- Daily revenue chart -->
    <div class="season-panel">
      <div class="season-panel-head">
        <h3>Tržby po dňoch</h3>
        <div class="season-panel-sub">${daysActual} dní s tržbami</div>
      </div>
      ${renderDailyChart(d.daily || [])}
    </div>

    <!-- Best / worst day -->
    <div class="season-panel-grid">
      ${bestDay ? renderDayCard(bestDay, 'top', '🏆 Najlepší deň') : ''}
      ${worstDayWithSales && worstDayWithSales.date !== (bestDay && bestDay.date) ? renderDayCard(worstDayWithSales, 'low', '🥶 Najslabší deň') : ''}
    </div>

    <!-- Top products + Bar/Kuchyna split -->
    <div class="season-panel-grid">
      <div class="season-panel">
        <div class="season-panel-head">
          <h3>Top 10 produktov</h3>
          <div class="season-panel-sub">podľa tržieb</div>
        </div>
        ${renderTopProducts(d.products || [])}
      </div>

      <div class="season-panel">
        <div class="season-panel-head">
          <h3>Bar vs Kuchyňa</h3>
          <div class="season-panel-sub">distribúcia tržieb</div>
        </div>
        ${renderDestSplit(d.revenueByDest)}
      </div>
    </div>

    <!-- Day-of-week heatmap -->
    <div class="season-panel">
      <div class="season-panel-head">
        <h3>Deň v týždni — priemerné tržby</h3>
        <div class="season-panel-sub">ktorý deň je v Surfke najsilnejší</div>
      </div>
      ${renderDowHeatmap(d.daily || [])}
    </div>

    <!-- Footer note -->
    <div class="season-footnote">
      Údaje od ${formatDateSk(SEASON_START)} do ${formatDateSk(todayStr())} · auto-aktualizácia pri obnovení stránky.
    </div>
  `;

  $('#seasonContent').innerHTML = html;
}

function fmtNumNoEur(n){
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDateSk(iso){
  const [y, m, d] = iso.split('-');
  return d + '.' + m + '.' + y;
}

function renderDailyChart(daily){
  if (!daily.length) return '<div style="text-align:center;color:var(--color-text-dim);padding:30px">Žiadne dni</div>';
  const maxRev = Math.max(...daily.map(d => d.revenue));
  return '<div class="season-chart">'
    + daily.map(d => {
        const h = maxRev > 0 ? (d.revenue / maxRev) * 100 : 0;
        const date = new Date(d.date);
        const dow = DAY_LABEL_SK[date.getDay()];
        const dnum = date.getDate() + '.' + (date.getMonth()+1) + '.';
        const profit = Number(d.profit) || 0;
        const profitColor = profit > 0 ? '#22c55e' : profit < 0 ? '#ef4444' : '#94a3b8';
        return `<div class="season-chart-bar" title="${dnum} ${dow} — ${fmtEur(d.revenue)} (výsledok ${fmtEur(profit)})">
          <div class="season-chart-val">${fmtNumNoEur(d.revenue)}</div>
          <div class="season-chart-fill" style="height:${h}%"></div>
          <div class="season-chart-profit-dot" style="background:${profitColor}"></div>
          <div class="season-chart-day">${dow}</div>
          <div class="season-chart-date">${date.getDate()}.${date.getMonth()+1}.</div>
        </div>`;
      }).join('')
    + '</div>'
    + '<div class="season-chart-legend">'
      + '<span><span class="dot green"></span>výsledok kladný</span>'
      + '<span><span class="dot red"></span>výsledok záporný</span>'
    + '</div>';
}

function renderDayCard(day, kind, title){
  const date = new Date(day.date);
  const dow = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'][date.getDay()];
  const fullDate = date.getDate() + '. ' + ['januára','februára','marca','apríla','mája','júna','júla','augusta','septembra','októbra','novembra','decembra'][date.getMonth()] + ' ' + date.getFullYear();
  const profit = Number(day.profit) || 0;
  const profitColor = profit > 0 ? '#22c55e' : '#ef4444';
  return `<div class="season-panel ${kind}">
    <div class="season-panel-head">
      <h3>${title}</h3>
      <div class="season-panel-sub">${dow} · ${fullDate}</div>
    </div>
    <div class="season-day-stats">
      <div class="season-day-row"><span>Tržby</span><strong>${fmtEur(day.revenue)}</strong></div>
      <div class="season-day-row"><span>Objednávky</span><strong>${fmtInt(day.orders)}</strong></div>
      <div class="season-day-row"><span>Priem. účet</span><strong>${fmtEur(day.avgCheck)}</strong></div>
      <div class="season-day-row"><span>Výroba</span><strong>${fmtEur(day.cogs || 0)}</strong></div>
      <div class="season-day-row"><span>Mzdy</span><strong>${fmtEur(day.labor || 0)}</strong></div>
      <div class="season-day-row big"><span>Výsledok</span><strong style="color:${profitColor}">${profit >= 0 ? '+' : ''}${fmtEur(profit)}</strong></div>
    </div>
  </div>`;
}

function renderTopProducts(products){
  const top = products.slice(0, 10);
  if (!top.length) return '<div style="text-align:center;color:var(--color-text-dim);padding:30px">Žiadne produkty</div>';
  const max = Math.max(...top.map(p => p.revenue));
  return '<div class="season-top-list">'
    + top.map((p, i) => {
        const w = max > 0 ? (p.revenue / max) * 100 : 0;
        const profit = Number(p.profit) || 0;
        const cogs = Number(p.cogs) || 0;
        const margin = p.revenue > 0 ? (profit / p.revenue) * 100 : 0;
        return `<div class="season-top-row">
          <div class="season-top-rank ${i<3?'medal-'+(i+1):''}">${i+1}</div>
          <div class="season-top-info">
            <div class="season-top-name">${p.emoji || ''} ${escapeHtml(p.name)}</div>
            <div class="season-top-meta">${fmtInt(p.qty)} ks · ${escapeHtml(p.category || '')}</div>
          </div>
          <div class="season-top-rev">
            <div class="season-top-rev-bar"><div class="season-top-rev-fill" style="width:${w}%"></div></div>
            <div class="season-top-rev-num">${fmtEur(p.revenue)}</div>
            ${cogs > 0 ? `<div class="season-top-rev-cogs">marža ${margin.toFixed(0)} %</div>` : ''}
          </div>
        </div>`;
      }).join('')
    + '</div>';
}

function renderDestSplit(rev){
  if (!rev) return '<div style="padding:30px">—</div>';
  const bar = Number(rev.bar) || 0;
  const kuch = Number(rev.kuchyna) || 0;
  const total = bar + kuch;
  const barPct = total > 0 ? (bar/total)*100 : 0;
  const kuchPct = total > 0 ? (kuch/total)*100 : 0;
  return `<div class="season-split">
    <div class="season-split-bar">
      <div class="season-split-segment bar" style="width:${barPct}%" title="Bar — ${fmtEur(bar)}"></div>
      <div class="season-split-segment kuch" style="width:${kuchPct}%" title="Kuchyňa — ${fmtEur(kuch)}"></div>
    </div>
    <div class="season-split-rows">
      <div class="season-split-row">
        <div class="season-split-color bar"></div>
        <div class="season-split-label">Bar</div>
        <div class="season-split-pct">${barPct.toFixed(1)} %</div>
        <div class="season-split-num">${fmtEur(bar)}</div>
        <div class="season-split-items">${fmtInt(rev.itemsBar)} ks</div>
      </div>
      <div class="season-split-row">
        <div class="season-split-color kuch"></div>
        <div class="season-split-label">Kuchyňa</div>
        <div class="season-split-pct">${kuchPct.toFixed(1)} %</div>
        <div class="season-split-num">${fmtEur(kuch)}</div>
        <div class="season-split-items">${fmtInt(rev.itemsKuchyna)} ks</div>
      </div>
    </div>
  </div>`;
}

function renderDowHeatmap(daily){
  // Aggregate by day of week (Po..Ne) — sum revenue + count days
  const buckets = [0,0,0,0,0,0,0].map(() => ({ rev: 0, count: 0 }));
  for (const d of daily){
    const dow = new Date(d.date).getDay(); // 0=Ne, 1=Po, ..., 6=So
    buckets[dow].rev += Number(d.revenue) || 0;
    buckets[dow].count += 1;
  }
  // Re-order so Po is first (Slovak convention)
  const order = [1,2,3,4,5,6,0];
  const labels = ['Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota','Nedeľa'];
  const avgs = order.map((dow, i) => ({
    label: labels[i],
    short: DAY_LABEL_SK[dow],
    avg: buckets[dow].count > 0 ? buckets[dow].rev / buckets[dow].count : 0,
    count: buckets[dow].count,
  }));
  const max = Math.max(...avgs.map(a => a.avg));
  return '<div class="season-heatmap">'
    + avgs.map(a => {
        const pct = max > 0 ? (a.avg/max)*100 : 0;
        const tier = pct === 0 ? 0 : pct < 33 ? 1 : pct < 66 ? 2 : 3;
        return `<div class="season-heatmap-cell tier-${tier}" title="${a.label} — priemer ${fmtEur(a.avg)} z ${a.count} dní">
          <div class="hm-day">${a.short}</div>
          <div class="hm-num">${a.count > 0 ? fmtEur(a.avg, {dec:0}) : '—'}</div>
        </div>`;
      }).join('')
    + '</div>';
}

function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const TEMPLATE = `
<style>
  .season-hero{
    position:relative;
    margin: -16px -16px 28px;
    padding: 56px 32px 48px;
    background:
      radial-gradient(70% 80% at 80% 20%, rgba(106,224,226,.25), transparent 55%),
      radial-gradient(60% 70% at 15% 80%, rgba(255,123,84,.18), transparent 50%),
      linear-gradient(160deg, #0c3768 0%, #082248 60%, #04122a 100%);
    color: #fdf9f3;
    border-radius: 0 0 22px 22px;
    overflow:hidden;
    isolation: isolate;
  }
  .season-hero-grain{
    position:absolute; inset:0;
    background:url("data:image/svg+xml;utf8,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' seed='5'/%3E%3CfeColorMatrix values='0 0 0 0 .9 0 0 0 0 .95 0 0 0 0 .95 0 0 0 .35 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity:.45; mix-blend-mode:soft-light; pointer-events:none;
  }
  .season-hero-content{ position:relative; z-index:1; max-width:920px; margin: 0 auto; }
  .season-eyebrow{
    font-size: 11px; letter-spacing: .25em; text-transform: uppercase;
    color: #ffc857; margin-bottom: 14px; font-weight: 600;
  }
  .season-title{
    font-family: Georgia, 'Times New Roman', serif;
    font-size: clamp(2.4rem, 5vw, 3.8rem);
    font-weight: 400;
    line-height: 1;
    margin-bottom: 8px;
    color: #fdf9f3;
    letter-spacing: -.02em;
  }
  .season-title em{
    font-style: italic;
    background: linear-gradient(120deg, #6ae0e2, #ffc857);
    background-clip: text; -webkit-background-clip:text;
    -webkit-text-fill-color: transparent;
  }
  .season-tagline{
    font-size: 14px; color: rgba(253,249,243,.78);
    margin-bottom: 28px;
  }
  .season-hero-revenue{
    display:flex; align-items: baseline; gap:6px; flex-wrap: wrap;
    margin-top: 18px;
  }
  .season-currency{
    font-family: Georgia, serif;
    font-size: 1.8rem;
    font-style: italic;
    color: #ff7b54;
  }
  .season-bignum{
    font-family: Georgia, serif;
    font-size: clamp(3rem, 8vw, 5.5rem);
    font-weight: 400;
    line-height: 1;
    letter-spacing: -.03em;
    background: linear-gradient(120deg, #fdf9f3 0%, #c5f1f2 50%, #ffc857 100%);
    background-clip: text; -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .season-revenue-label{
    width: 100%;
    font-size: 12px; color: rgba(253,249,243,.7);
    letter-spacing: .15em; text-transform: uppercase;
    margin-top: 8px;
  }

  .season-stats-grid{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
    margin-bottom: 28px;
  }
  .season-stat{
    background: var(--color-bg-elev);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    padding: 18px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .season-stat.profit.plus{
    border-color: rgba(34,197,94,.4);
    background: linear-gradient(135deg, rgba(34,197,94,.06), var(--color-bg-elev) 60%);
  }
  .season-stat.profit.minus{
    border-color: rgba(239,68,68,.4);
    background: linear-gradient(135deg, rgba(239,68,68,.06), var(--color-bg-elev) 60%);
  }
  .season-stat-icon{
    width: 40px; height: 40px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .season-stat-icon svg{ width:20px; height:20px }
  .season-stat-icon.ice{ background: rgba(106,224,226,.15); color: #6ae0e2 }
  .season-stat-icon.amber{ background: rgba(255,184,0,.15); color: #ffb800 }
  .season-stat-icon.lavender{ background: rgba(139,124,246,.15); color: #8b7cf6 }
  .season-stat-icon.mint{ background: rgba(34,197,94,.15); color: #22c55e }
  .season-stat-meta{ flex:1; min-width:0 }
  .season-stat-label{
    font-size: 11px; letter-spacing: .15em; text-transform: uppercase;
    color: var(--color-text-dim); margin-bottom: 6px;
  }
  .season-stat-num{
    font-family: Georgia, serif;
    font-size: 1.55rem;
    font-weight: 400;
    line-height: 1;
    color: var(--color-text);
    letter-spacing: -.01em;
  }
  .season-stat-foot{
    font-size: 11px; color: var(--color-text-dim);
    margin-top: 6px;
  }

  .season-panel{
    background: var(--color-bg-elev);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .season-panel.top{ border-color: rgba(34,197,94,.3); background: linear-gradient(135deg, rgba(34,197,94,.04), var(--color-bg-elev) 70%) }
  .season-panel.low{ border-color: rgba(255,123,84,.3); background: linear-gradient(135deg, rgba(255,123,84,.04), var(--color-bg-elev) 70%) }
  .season-panel-head{
    display:flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 16px;
    flex-wrap:wrap; gap:6px;
  }
  .season-panel-head h3{
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 1.2rem;
    font-weight: 400;
    color: var(--color-text);
    margin: 0;
  }
  .season-panel-sub{
    font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--color-text-dim);
  }

  .season-panel-grid{
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    margin-bottom: 16px;
  }
  @media (min-width: 880px){
    .season-panel-grid{ grid-template-columns: 1fr 1fr }
  }

  /* Daily chart */
  .season-chart{
    display:flex; align-items: flex-end; gap: 4px;
    height: 180px;
    overflow-x: auto;
    padding: 8px 0 4px;
    scrollbar-width: thin;
  }
  .season-chart-bar{
    flex: 1 0 38px;
    min-width: 38px;
    display:flex; flex-direction: column; align-items:center;
    justify-content: flex-end;
    gap: 4px;
    height: 100%;
    position:relative;
    cursor: default;
  }
  .season-chart-fill{
    width: 70%;
    background: linear-gradient(180deg, #6ae0e2 0%, #1f64a3 70%, #0c3768 100%);
    border-radius: 4px 4px 0 0;
    min-height: 2px;
    transition: filter .2s;
  }
  .season-chart-bar:hover .season-chart-fill{ filter: brightness(1.15) }
  .season-chart-val{
    font-size: 9px; color: var(--color-text-dim); white-space: nowrap;
    opacity: 0; transition: opacity .15s;
  }
  .season-chart-bar:hover .season-chart-val{ opacity: 1 }
  .season-chart-profit-dot{
    width: 6px; height: 6px; border-radius: 50%;
    margin-top: -3px;
  }
  .season-chart-day{
    font-size: 10px; font-weight: 600; color: var(--color-text-dim);
    margin-top: 2px;
  }
  .season-chart-date{
    font-size: 9px; color: var(--color-text-dim); opacity: .7;
  }
  .season-chart-legend{
    display: flex; gap: 18px; margin-top: 10px;
    font-size: 11px; color: var(--color-text-dim);
  }
  .season-chart-legend .dot{
    display: inline-block;
    width: 8px; height: 8px; border-radius: 50%;
    margin-right: 6px; vertical-align: middle;
  }
  .season-chart-legend .dot.green{ background: #22c55e }
  .season-chart-legend .dot.red{ background: #ef4444 }

  .season-day-stats{ display: flex; flex-direction: column; gap: 8px }
  .season-day-row{
    display: flex; justify-content: space-between;
    font-size: 14px;
    padding: 6px 0;
    border-bottom: 1px dashed rgba(255,255,255,.06);
  }
  .season-day-row:last-child{ border-bottom: none }
  .season-day-row span{ color: var(--color-text-dim) }
  .season-day-row strong{ color: var(--color-text); font-weight: 500 }
  .season-day-row.big{ font-size: 17px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08); margin-top: 4px }
  .season-day-row.big strong{ font-family: Georgia, serif; font-style: italic; font-size: 22px; font-weight: 400 }

  /* Top products */
  .season-top-list{ display: flex; flex-direction: column; gap: 10px }
  .season-top-row{
    display: grid;
    grid-template-columns: 32px 1fr 200px;
    gap: 14px;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px dashed rgba(255,255,255,.05);
  }
  .season-top-row:last-child{ border-bottom: none }
  .season-top-rank{
    font-family: Georgia, serif;
    font-size: 1.2rem;
    color: var(--color-text-dim);
    text-align: center;
    font-weight: 400;
  }
  .season-top-rank.medal-1{ color: #ffd700 }
  .season-top-rank.medal-2{ color: #c0c0c0 }
  .season-top-rank.medal-3{ color: #cd7f32 }
  .season-top-name{
    font-size: 14px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .season-top-meta{
    font-size: 11px; color: var(--color-text-dim); margin-top: 2px;
  }
  .season-top-rev{ text-align: right }
  .season-top-rev-bar{
    height: 4px;
    background: rgba(255,255,255,.05);
    border-radius: 2px;
    margin-bottom: 4px;
    overflow: hidden;
  }
  .season-top-rev-fill{
    height: 100%;
    background: linear-gradient(90deg, #6ae0e2, #1f64a3);
    border-radius: 2px;
  }
  .season-top-rev-num{
    font-family: Georgia, serif;
    font-size: 14px;
    color: var(--color-text);
    font-weight: 500;
  }
  .season-top-rev-cogs{
    font-size: 10px; color: var(--color-text-dim); margin-top: 2px;
  }

  /* Bar/Kuchyňa split */
  .season-split-bar{
    display: flex; height: 12px; border-radius: 6px;
    overflow: hidden; background: rgba(255,255,255,.05);
    margin-bottom: 18px;
  }
  .season-split-segment{ height: 100%; transition: filter .2s }
  .season-split-segment:hover{ filter: brightness(1.15) }
  .season-split-segment.bar{ background: linear-gradient(135deg, #6ae0e2, #18b5bc) }
  .season-split-segment.kuch{ background: linear-gradient(135deg, #ff7b54, #c44023) }
  .season-split-rows{ display: flex; flex-direction: column; gap: 12px }
  .season-split-row{
    display: grid;
    grid-template-columns: 14px 1fr 70px 100px 70px;
    gap: 10px;
    align-items: center;
    font-size: 13px;
  }
  .season-split-color{
    width: 14px; height: 14px; border-radius: 4px;
  }
  .season-split-color.bar{ background: linear-gradient(135deg, #6ae0e2, #18b5bc) }
  .season-split-color.kuch{ background: linear-gradient(135deg, #ff7b54, #c44023) }
  .season-split-label{ font-weight: 500; color: var(--color-text) }
  .season-split-pct{ color: var(--color-text-dim) }
  .season-split-num{ font-family: Georgia, serif; color: var(--color-text); font-weight: 500; text-align: right }
  .season-split-items{ font-size: 11px; color: var(--color-text-dim); text-align: right }

  /* Heatmap */
  .season-heatmap{
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
  }
  .season-heatmap-cell{
    border-radius: 10px;
    padding: 18px 8px;
    text-align: center;
    border: 1px solid var(--color-border);
    background: var(--color-bg-surface);
    transition: transform .15s;
  }
  .season-heatmap-cell:hover{ transform: translateY(-2px) }
  .season-heatmap-cell.tier-0{ opacity: .55 }
  .season-heatmap-cell.tier-1{ background: linear-gradient(135deg, rgba(31,100,163,.18), var(--color-bg-surface)); border-color: rgba(31,100,163,.3) }
  .season-heatmap-cell.tier-2{ background: linear-gradient(135deg, rgba(31,100,163,.4), var(--color-bg-surface)); border-color: rgba(31,100,163,.5) }
  .season-heatmap-cell.tier-3{ background: linear-gradient(135deg, #1f64a3, #0c3768); border-color: #6ae0e2; color: #fdf9f3 }
  .hm-day{
    font-size: 12px; font-weight: 700;
    color: inherit; opacity: .85;
    margin-bottom: 6px;
    letter-spacing: .05em;
  }
  .hm-num{
    font-family: Georgia, serif;
    font-size: 16px; font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .season-footnote{
    text-align: center;
    font-size: 11px;
    color: var(--color-text-dim);
    padding: 24px 0 10px;
    font-style: italic;
  }

  .season-loading{
    text-align: center;
    padding: 80px 20px;
    color: var(--color-text-dim);
    font-style: italic;
  }
</style>
<div id="seasonContent">
  <div class="season-loading">Načítavam štatistiky sezóny…</div>
</div>
`;

export function init(container){
  _container = container;
  container.innerHTML = TEMPLATE;
  load();
}

export function destroy(){
  _container = null;
  _data = null;
}
