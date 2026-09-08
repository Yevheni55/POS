// Sezóna — beautiful summary dashboard from opening day (25.04).
// Re-uses existing admin design tokens — no inline mini-design system.
// Štruktúra: filter-bar (period chips) → 4 stat-cards → panely
// (daily chart, top products, dest split, day-of-week heatmap).
// All styling uses .stat-grid / .stat-card / .panel patterns shared
// with dashboard + reports.

let _container = null;
let _data = null;
const SEASON_START = '2026-04-25';

// === Rozsah dát ===
// Reporty štandardne filtrujú platby na cash_register_code aktívnej kasy
// ('active'). Na tejto kase sa vystriedali tri daňové subjekty, takže bez
// filtra by sa ich tržby sčítali dokopy — čo je pri platiteľovi DPH zlý
// základ dane. 'all' filter vypne a ukáže celú históriu (len na prehľad).
// Voľba je zdieľaná so stránkou Reporty cez rovnaký localStorage kľúč.
const SCOPE_KEY = 'pos_reports_scope';
function normalizeScope(v){ return v === 'all' ? 'all' : 'active'; }
function readScope(){
  // localStorage môže hodiť (private mode, zakázané cookies) — nesmie to
  // zhodiť celú stránku, default je bezpečnejší 'active'.
  try { return normalizeScope(localStorage.getItem(SCOPE_KEY)); }
  catch (e) { return 'active'; }
}
function writeScope(v){
  const s = normalizeScope(v);
  try { localStorage.setItem(SCOPE_KEY, s); } catch (e) { /* ignore */ }
  return s;
}
let _scope = readScope();
// Čo server reálne použil. Keď pole `scope` v odpovedi (ešte) nie je,
// padáme na lokálnu voľbu — chýbajúce pole nesmie stránku rozbiť.
function effectiveScope(d){
  const fromApi = d && d.scope;
  if (fromApi === 'all' || fromApi === 'active') return fromApi;
  return _scope;
}

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
// Jedno desatinné miesto v sk-SK (čiarka), napr. 58,0.
function fmt1(n){ return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtPct(n){ return fmt1(n) + ' %'; }
function fmtNumNoEur(n){
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
// bratislavaDayIso je zdielany global z /api.js — `toISOString()` nad lokalnym
// Date by medzi polnocou a 02:00 miestneho casu vratil vcerajsok.
function todayStr(){ return bratislavaDayIso(new Date()); }
function daysBetween(a, b){
  const A = new Date(a), B = new Date(b);
  return Math.max(1, Math.round((B - A) / 86400000) + 1);
}
function formatDateSk(iso){
  const [y, m, d] = iso.split('-');
  return d + '.' + m + '.' + y;
}
// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function escapeHtml(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// U platiteľa DPH nie je daň na výstupe príjmom firmy — marža sa preto ráta
// zo základu dane (totalRevenueNet / revenueNet), nie z brutto tržby. Keď
// server pole neposiela (neplatiteľ), padáme späť na brutto a čísla ostávajú
// bit-identické s doterajším stavom.
function netOr(value, fallback){
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== undefined ? n : (Number(fallback) || 0);
}
// Rozpad DPH ukazujeme LEN platiteľovi (server posiela vatRegistered).
// U neplatiteľa je totalRevenueNet === totalRevenue, takže aj keby pole
// prišlo, čísla ostávajú rovnaké — len sa nezobrazí zbytočný riadok.
function hasNetRevenue(d){
  return !!(d && d.vatRegistered === true
    && d.totalRevenueNet !== null && d.totalRevenueNet !== undefined
    && Number.isFinite(Number(d.totalRevenueNet)));
}
function productNetRevenue(p){
  const net = Number(p && p.revenueNet);
  return Number.isFinite(net) && net > 0 ? net : (Number(p && p.revenue) || 0);
}

// Segmentovaný prepínač rozsahu — rovnaká vizuálna rodina ako .period-btn
// (prepínač obdobia), len s väčším tap targetom.
function renderScopeSwitch(){
  const isActive = _scope === 'active';
  return `<div class="scope-switch rp-seg" role="group" aria-label="Rozsah dát">
    <button type="button" class="scope-btn${isActive ? ' active' : ''}" data-scope="active" aria-pressed="${isActive}">Táto kasa</button>
    <button type="button" class="scope-btn${isActive ? '' : ' active'}" data-scope="all" aria-pressed="${!isActive}">Celá história</button>
  </div>`;
}

// Vysvetľujúci pás pri „Celá história“ — bez neho majiteľ nevie, prečo sú
// čísla iné než v daňovom podklade.
function renderScopeBanner(d){
  if (effectiveScope(d) !== 'all') return '';
  return `<div class="doch-owe rp-note" role="note">
    <span>Zobrazenie zahŕňa aj obdobia predchádzajúcich daňových subjektov,
    ktoré na tejto kase pracovali pred aktuálnym. Súčty sú preto prehľadové a
    <strong>nie sú podkladom pre priznanie DPH</strong>. Pre daňové účely
    prepnite späť na rozsah „Táto kasa“.</span>
  </div>`;
}

// Nenápadná poznámka v default režime — inak majiteľ vidí „prepad tržieb“
// a nevie, že staršie obdobia patria inému daňovému subjektu.
function renderScopeHint(d){
  if (effectiveScope(d) !== 'active') return '';
  const code = d && d.cashRegisterCode ? String(d.cashRegisterCode) : '';
  return `<div class="rp-hero-s">obdobie začína prvým dokladom aktuálnej kasy${code ? ' · DKP ' + escapeHtml(code) : ''} — staršie subjekty cez „Celá história“</div>`;
}

const DAY_LABEL_SK = ['Ne','Po','Ut','St','Št','Pi','So'];
const DAY_FULL_SK  = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'];
const MONTH_FULL_SK = ['januára','februára','marca','apríla','mája','júna','júla','augusta','septembra','októbra','novembra','decembra'];

// Poradové číslo requestu. „Celá história“ ťahá rádovo viac riadkov než
// „Táto kasa“, takže pri rýchlom preklikaní môže pomalšia odpoveď doraziť
// ako posledná a prepísať render novšou-staršou dvojicou. Zahodíme ju.
let _loadSeq = 0;

async function load(){
  const seq = ++_loadSeq;
  try {
    const data = await api.get('/reports/summary?from=' + SEASON_START + '&to=' + todayStr()
      + '&scope=' + encodeURIComponent(_scope));
    if (seq !== _loadSeq) return;
    _data = data;
    render();
  } catch (err) {
    if (seq !== _loadSeq) return;
    // Prepínač rozsahu vykresli aj do chybového stavu — inak by sa používateľ
    // pri zlyhaní requestu nemal ako prepnúť späť.
    $('#seasonContent').innerHTML =
      '<div class="doch-head rp-head">' + renderScopeSwitch() + '</div>'
      + '<div class="empty-state" style="padding:60px;text-align:center"><div class="empty-state-title" style="color:var(--color-danger)">Chyba načítania</div><div class="empty-state-text">' + escapeHtml(err.message || 'API zlyhalo') + '</div></div>';
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
  // Základ dane: pri neplatiteľovi === brutto tržba (netVat = false).
  const netVat   = hasNetRevenue(d);
  const trzbaNet = netOr(d.totalRevenueNet, trzba);
  const dphOdvod = netVat ? netOr(d.totalVatOutput, trzba - trzbaNet) : 0;
  const zaklad   = netVat ? ' bez DPH' : '';
  const vysledokPct = trzbaNet > 0 ? (vysledok / trzbaNet) * 100 : 0;
  const avgDaily = daysActual > 0 ? trzba / daysActual : 0;

  const dailySorted = (d.daily || []).slice().sort((a,b) => b.revenue - a.revenue);
  const bestDay = dailySorted[0];
  const worstDayWithSales = (d.daily || []).filter(x => x.revenue > 0).sort((a,b) => a.revenue - b.revenue)[0];

  const profitClass = vysledok >= 0 ? 'up' : '';
  const profitColor = vysledok >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
  const profitSign = vysledok >= 0 ? '+' : '';

  const html = `
    <!-- Rozsah kasy ako segment + rozsah sezóny (dátumy sú fixné) -->
    <div class="doch-head rp-head">
      ${renderScopeSwitch()}
      <div class="doch-range">Sezóna ${formatDateSk(SEASON_START)} – ${formatDateSk(todayStr())} · <strong>${daysActual}</strong>/${days} aktívnych dní</div>
    </div>

    ${renderScopeBanner(d)}

    <!-- Jedno veľké číslo (tržby) + riadok súčtu -->
    <div class="rp-hero">
      <div class="rp-hero-k">Tržby za sezónu</div>
      <div class="rp-hero-v">${fmtEur(trzba)}</div>
      <div class="rp-hero-s">${fmtEur(avgDaily)} priemer na deň · ${fmtInt(d.totalOrders)} objednávok</div>
      ${netVat ? `<div class="rp-hero-s">z toho DPH na odvod ${fmtEur(dphOdvod)} · základ dane ${fmtEur(trzbaNet)}</div>` : ''}
      ${renderScopeHint(d)}
    </div>
    <div class="doch-sum rp-sum">
      <span class="rp-sum-i"><strong>${fmtEur(cogs)}</strong> náklady na výrobu <small>${trzbaNet>0 ? fmtPct(cogs/trzbaNet*100) + ' z tržieb' + zaklad : '—'}</small></span>
      <span class="rp-sum-i"><strong>${fmtEur(mzdy)}</strong> mzdy <small>${trzbaNet>0 ? fmtPct(mzdy/trzbaNet*100) + ' z tržieb' + zaklad : '—'}</small></span>
      <span class="rp-sum-i"><strong class="${vysledok >= 0 ? 'is-pos' : 'is-neg'}">${profitSign}${fmtEur(vysledok)}</strong> výsledok <small>${fmt1(vysledokPct)} % marža${netVat ? ' zo základu dane' : ''}</small></span>
    </div>

    <!-- Predaj podla kategorie — pre fotku majitelovi: hned za KPI kartami
         vidi kolko sa predalo burgerov, salatov, pizz, kavy, piva atd. -->
    <div class="panel rp-panel">
      <div class="panel-title">Predaj podľa kategórie</div>
      <div class="rp-sub">
        koľko kusov a koľko tržieb dostal každý druh tovaru za sezónu
      </div>
      ${renderCategoryBreakdown(d.products || [], trzba)}
    </div>

    <!-- Daily revenue chart panel -->
    <div class="panel rp-panel rp-chart">
      <div class="panel-title">Tržby po dňoch</div>
      ${renderDailyChart(d.daily || [])}
    </div>

    <!-- Best / worst day panels (2-col grid) -->
    <div class="row rp-2col-grid" style="margin-bottom:16px">
      ${bestDay ? renderDayCard(bestDay, 'success', 'Najlepší deň') : ''}
      ${worstDayWithSales && worstDayWithSales.date !== (bestDay && bestDay.date) ? renderDayCard(worstDayWithSales, 'danger', 'Najslabší deň') : ''}
    </div>

    <!-- Top products + Bar/Kuchyňa split (2-col grid) -->
    <div class="row rp-2col-grid" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-title">Top 10 produktov</div>
        <div class="rp-sub">podľa tržieb za sezónu</div>
        ${renderTopProducts(d.products || [])}
      </div>

      <div class="panel">
        <div class="panel-title">Bar vs Kuchyňa</div>
        <div class="rp-sub">distribúcia tržieb</div>
        ${renderDestSplit(d.revenueByDest)}
      </div>
    </div>

    <!-- Day-of-week heatmap -->
    <div class="panel rp-panel">
      <div class="panel-title">Deň v týždni</div>
      <div class="rp-sub">priemerná tržba podľa dňa v týždni</div>
      ${renderDowHeatmap(d.daily || [])}
    </div>
  `;

  $('#seasonContent').innerHTML = html;
}

// === Daily chart — vertical bars with profit dot under each ===
function renderDailyChart(daily){
  if (!daily.length) return '<div class="empty-hint">Žiadne dni</div>';
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
    <div class="rp-sub">${dow} · ${fullDate}</div>
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

// === Predaj podla kategorie — agregacia products[] per category ===
// Pre majitela: jednoznacny pohlad kolko sa predalo "burgrov", "salatov",
// "kávy" atď. Sortuje podla trzieb zostupne, aby najziskovejsie kategorie
// vyplavali nahor.
function renderCategoryBreakdown(products, totalRev){
  if (!products.length) {
    return '<div class="empty-hint">Žiadne dáta</div>';
  }
  // Agreguj per kategoria
  const byCategory = new Map();
  for (const p of products) {
    const cat = p.category || 'Bez kategórie';
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { name: cat, qty: 0, revenue: 0, revenueNet: 0, cogs: 0, profit: 0 });
    }
    const agg = byCategory.get(cat);
    agg.qty += Number(p.qty) || 0;
    agg.revenue += Number(p.revenue) || 0;
    agg.revenueNet += productNetRevenue(p);
    agg.cogs += Number(p.cogs) || 0;
    agg.profit += Number(p.profit) || 0;
  }
  const rows = Array.from(byCategory.values()).sort((a,b) => b.revenue - a.revenue);
  const maxRev = Math.max(...rows.map(r => r.revenue), 1);

  let totalQty = 0, totalRevSum = 0, totalRevNetSum = 0, totalCogs = 0, totalProfit = 0;
  const tbody = rows.map(r => {
    totalQty += r.qty;
    totalRevSum += r.revenue;
    totalRevNetSum += r.revenueNet;
    totalCogs += r.cogs;
    totalProfit += r.profit;
    const w = (r.revenue / maxRev) * 100;
    const pct = totalRev > 0 ? (r.revenue / totalRev) * 100 : 0;
    // Marža = zisk / tržba bez DPH (u neplatiteľa je revenueNet === revenue).
    const margin = r.revenueNet > 0 ? (r.profit / r.revenueNet) * 100 : 0;
    const profitColor = r.profit >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
    return `<tr>
      <td class="td-name" style="font-weight:var(--weight-semibold)">${escapeHtml(r.name)}</td>
      <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtInt(r.qty)} ks</td>
      <td class="text-right rp-scat-rev">
        <div class="progress-wrap"><div class="progress-fill" style="width:${w}%"></div></div>
        <div class="num" style="font-size:13px;margin-top:4px;font-weight:var(--weight-semibold)">${fmtEur(r.revenue)}</div>
        <div style="font-size:10px;color:var(--color-text-dim)">${fmt1(pct)} % z tržieb</div>
      </td>
      <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(r.cogs)}</td>
      <td class="num text-right" style="color:${profitColor};font-weight:var(--weight-bold)">${r.profit >= 0 ? '+' : ''}${fmtEur(r.profit)}</td>
      <td class="num text-right" style="color:${profitColor}">${margin.toFixed(0)} %</td>
    </tr>`;
  }).join('');

  const totalMargin = totalRevNetSum > 0 ? (totalProfit / totalRevNetSum) * 100 : 0;
  return `<div class="table-scroll-wrap">
    <table class="data-table rp-cards rp-t-scat">
      <thead>
        <tr>
          <th>Kategória</th>
          <th class="text-right">Predané</th>
          <th class="text-right">Tržby</th>
          <th class="text-right">Suroviny</th>
          <th class="text-right">Zisk</th>
          <th class="text-right">Marža</th>
        </tr>
      </thead>
      <tbody>${tbody}</tbody>
      <tfoot>
        <tr>
          <td>Spolu</td>
          <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtInt(totalQty)} ks</td>
          <td class="num text-right" style="font-weight:var(--weight-bold);color:var(--color-text)">${fmtEur(totalRevSum)}</td>
          <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(totalCogs)}</td>
          <td class="num text-right" style="font-weight:var(--weight-bold);color:${totalProfit >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">${totalProfit >= 0 ? '+' : ''}${fmtEur(totalProfit)}</td>
          <td class="num text-right" style="font-weight:var(--weight-bold);color:${totalMargin >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">${totalMargin.toFixed(0)} %</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

// === Top products list ===
function renderTopProducts(products){
  const top = products.slice(0, 10);
  if (!top.length) return '<div class="empty-hint">Žiadne produkty</div>';
  const max = Math.max(...top.map(p => p.revenue));
  return `<table class="data-table rp-cards rp-t-stop">
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
        // Marža proti tržbe bez DPH (u neplatiteľa === brutto tržba).
        const netRev = productNetRevenue(p);
        const margin = netRev > 0 ? (profit / netRev) * 100 : 0;
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
    <div class="rp-split-bar" style="height:10px;margin-bottom:14px" aria-hidden="true">
      <div style="width:${barPct}%;background:var(--color-accent)" title="Bar — ${fmtEur(bar)}"></div>
      <div style="width:${kuchPct}%;background:var(--color-success)" title="Kuchyňa — ${fmtEur(kuch)}"></div>
    </div>
    <table class="data-table rp-cards rp-t-dest">
      <tbody>
        <tr>
          <td><span class="rp-dot is-bar" aria-hidden="true"></span>Bar</td>
          <td class="num text-right" style="color:var(--color-text-sec);width:60px">${fmt1(barPct)} %</td>
          <td class="num text-right highlight-cell">${fmtEur(bar)}</td>
          <td class="num text-right" style="color:var(--color-text-dim);font-size:11px">${fmtInt(rev.itemsBar)} ks</td>
        </tr>
        <tr>
          <td><span class="rp-dot is-kuch" aria-hidden="true"></span>Kuchyňa</td>
          <td class="num text-right" style="color:var(--color-text-sec)">${fmt1(kuchPct)} %</td>
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
      return `<div class="season-hm-cell tier-${tier}" title="${escapeHtml(a.label)} — priemer ${fmtEur(a.avg)} z ${a.count} dní">
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
  /* Prepínač rozsahu (.rp-seg) a vysvetľujúci pás (.rp-note) sú v
     admin/ios-reporty.css — spoločné s denným reportom. */

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
  /* Rovnaká sekvenčná škála ako v týždennom reporte (--heat-* v admin.css) —
     jeden odtieň, rastúca intenzita. Predtým fialová z vyradenej palety. */
  .season-hm-cell.tier-1{ background: rgba(var(--heat-rgb), .10); border-color: rgba(var(--heat-rgb), .22) }
  .season-hm-cell.tier-2{ background: rgba(var(--heat-rgb), .22); border-color: rgba(var(--heat-rgb), .38) }
  .season-hm-cell.tier-3{ background: rgba(var(--heat-rgb), .38); border-color: var(--color-accent) }
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
    background: var(--ios-track);
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
  <div class="loading-hint">Načítavam štatistiky sezóny…</div>
</div>
`;

// Delegovaný listener — render() prepisuje #seasonContent, takže priame
// binding na tlačidlá by po prvom prekreslení zaniklo.
function onScopeClick(e){
  if (!_container) return;
  const btn = e.target.closest && e.target.closest('.scope-btn');
  if (!btn || !_container.contains(btn)) return;
  const next = normalizeScope(btn.dataset.scope);
  if (next === _scope) return;
  _scope = writeScope(next);
  // Aktívny stav prepni hneď, nech tlačidlo nereaguje až po odpovedi API.
  Array.from(_container.querySelectorAll('.scope-btn')).forEach(b => {
    const on = b.dataset.scope === _scope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  load();
}

export function init(container){
  _container = container;
  _scope = readScope();
  container.innerHTML = TEMPLATE;
  // Apply 2-col stack class to row grids so mobile collapses cleanly
  Array.from(container.querySelectorAll('.row')).forEach(el => el.classList.add('season-page-grid-2col'));
  container.addEventListener('click', onScopeClick);
  load();
}

export function destroy(){
  if (_container) _container.removeEventListener('click', onScopeClick);
  _container = null;
  _data = null;
}
