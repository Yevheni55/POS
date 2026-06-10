// Zamestnanecká spotreba — samostatná stránka v admin sidebar.
// Manazer chce rýchly prehlad benefitu poskytnutého zamestnancom:
//   - koľko meals za obdobie (rast/pokles)
//   - kto najviac konzumuje
//   - rozdelenie bar vs kuchyna
//   - daily trend graf
//
// Data source: GET /api/reports/summary?from=X&to=Y vracia:
//   - staffMealByPerson [{name, meals, foodCost, drinkCost, cost, menuValue}]
//   - daily[].staffMeal — per-day staff meal cost (pre chart)
//
// UX: stat cards na vrchu, daily chart pod nimi, per-person tabuľka dole.
import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _from = '';
let _to = '';
let _data = null;

function $(sel) { return _container && _container.querySelector(sel); }

function fmtEur(n) { return fmtCost(n) + ' €'; }

function escapeHtml(v) {
  const d = document.createElement('div');
  d.textContent = String(v == null ? '' : v);
  return d.innerHTML;
}

// bratislavaDayIso je zdielany global z /api.js (preco nie UTC — viz tam).
function todayIso() { return bratislavaDayIso(new Date()); }

// Odvodene z bratislavskeho dna, nie z lokalneho Date + toISOString (UTC):
// lokalna polnoc 1. dna je v UTC este predosly mesiac, takze stary kod
// vracal posledny den predosleho mesiaca.
function firstOfMonth() {
  return todayIso().slice(0, 8) + '01';
}

function daysAgoIso(n) {
  const t = todayIso();
  const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function load() {
  if (!_from || !_to) return;
  try {
    _data = await api.get('/reports/summary?from=' + _from + '&to=' + _to);
    render();
  } catch (e) {
    console.error('Zam-spotreba load error:', e);
    const wrap = $('#zsContent');
    if (wrap) wrap.innerHTML = '<div class="empty-hint">Chyba načítania: ' + escapeHtml(e.message || 'unknown') + '</div>';
  }
}

function render() {
  if (!_data) return;
  const rows = (_data.staffMealByPerson || []).filter(r => Number(r.cost) > 0 || Number(r.menuValue) > 0);
  const daily = (_data.daily || []).filter(d => Number(d.staffMeal) > 0);

  // === Stat cards ===
  let totalMeals = 0, totalCost = 0, totalFood = 0, totalDrink = 0, totalMenuValue = 0;
  rows.forEach(r => {
    totalMeals += Number(r.meals) || 0;
    totalCost += Number(r.cost) || 0;
    totalFood += Number(r.foodCost) || 0;
    totalDrink += Number(r.drinkCost) || 0;
    totalMenuValue += Number(r.menuValue) || 0;
  });
  const lostMargin = totalMenuValue - totalCost; // "neutilízovaný" profit

  const statsHtml = ''
    + '<div class="stat-grid grid-3col" style="margin-bottom:18px">'
    + statCard('Počet jedál', String(totalMeals), totalMeals === 1 ? 'meal' : 'meals', 'mint')
    + statCard('Náklad firmy', fmtEur(totalCost), 'reálne suroviny + bar', 'lavender')
    + statCard('Hodnota benefitu', fmtEur(totalMenuValue), 'koľko by zaplatil zákazník', 'ice')
    + '</div>';

  // Bar vs kuchyna split bar
  const splitHtml = totalCost > 0
    ? renderSplitBar(totalFood, totalDrink)
    : '';

  // Per-day chart
  const chartHtml = renderDailyChart(daily);

  // Per-person table
  const tableHtml = rows.length
    ? renderPersonTable(rows, { totalMeals, totalCost, totalFood, totalDrink, totalMenuValue, lostMargin })
    : '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">'
      + 'V tomto období nebola zaznamenaná žiadna zamestnanecká spotreba.<br>'
      + '<small>Staff meal sa registruje pri zatvorení účtu cez tlačidlo "Uzavrieť ako staff meal" v POS.</small>'
      + '</div>';

  const wrap = $('#zsContent');
  if (wrap) {
    wrap.innerHTML = statsHtml + splitHtml + chartHtml
      + '<div class="panel" style="margin-top:18px">'
      +   '<div class="panel-title">Podrobnosti podľa osoby</div>'
      +   tableHtml
      + '</div>';
  }
}

function statCard(label, value, sub, iconClass) {
  return ''
    + '<div class="stat-card">'
    +   '<div class="stat-icon ' + iconClass + '">'
    +     '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>'
    +   '</div>'
    +   '<div class="stat-info">'
    +     '<div class="stat-label">' + escapeHtml(label) + '</div>'
    +     '<div class="stat-value">' + value + '</div>'
    +     '<div class="stat-change neutral">' + escapeHtml(sub) + '</div>'
    +   '</div>'
    + '</div>';
}

function renderSplitBar(food, drink) {
  const total = food + drink;
  if (total <= 0) return '';
  const foodPct = (food / total) * 100;
  const drinkPct = (drink / total) * 100;
  return '<div class="panel" style="margin-bottom:18px">'
    + '<div class="panel-title">Rozdelenie kuchyňa vs bar</div>'
    + '<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:rgba(0,0,0,.04);margin-bottom:14px;border:1px solid var(--color-border)">'
    +   '<div style="width:' + foodPct.toFixed(1) + '%;background:var(--color-success)" title="Kuchyňa ' + fmtEur(food) + '"></div>'
    +   '<div style="width:' + drinkPct.toFixed(1) + '%;background:var(--color-accent)" title="Bar ' + fmtEur(drink) + '"></div>'
    + '</div>'
    + '<div style="display:flex;gap:24px;font-size:13px">'
    +   '<div style="display:flex;align-items:center;gap:8px"><span style="width:12px;height:12px;background:var(--color-success);border-radius:3px"></span>Kuchyňa <strong style="font-family:var(--font-display)">' + fmtEur(food) + '</strong> <span style="color:var(--color-text-sec);font-size:11px">(' + foodPct.toFixed(1) + ' %)</span></div>'
    +   '<div style="display:flex;align-items:center;gap:8px"><span style="width:12px;height:12px;background:var(--color-accent);border-radius:3px"></span>Bar <strong style="font-family:var(--font-display)">' + fmtEur(drink) + '</strong> <span style="color:var(--color-text-sec);font-size:11px">(' + drinkPct.toFixed(1) + ' %)</span></div>'
    + '</div>'
    + '</div>';
}

function renderDailyChart(daily) {
  if (!daily.length) {
    return '<div class="panel" style="margin-bottom:18px"><div class="panel-title">Denný trend</div><div class="td-empty" style="padding:20px;text-align:center;color:var(--color-text-dim)">Žiadne dáta v období</div></div>';
  }
  const max = Math.max(...daily.map(d => Number(d.staffMeal) || 0));
  if (max <= 0) return '';
  // Sort ascending by date
  const sorted = daily.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const bars = sorted.map(d => {
    const v = Number(d.staffMeal) || 0;
    const pct = max > 0 ? (v / max) * 100 : 0;
    const parts = String(d.date).split('-');
    const lbl = parts[2] + '.' + parts[1] + '.';
    return ''
      + '<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:34px">'
      +   '<div style="height:80px;width:24px;display:flex;align-items:flex-end;border-radius:4px;background:rgba(0,0,0,.03);overflow:hidden">'
      +     '<div style="width:100%;height:' + pct.toFixed(1) + '%;background:var(--color-accent);transition:height .3s" title="' + lbl + ': ' + fmtEur(v) + '"></div>'
      +   '</div>'
      +   '<div style="font-size:10px;color:var(--color-text-dim);font-family:var(--font-mono);margin-top:4px;writing-mode:vertical-rl;text-orientation:mixed;white-space:nowrap">' + lbl + '</div>'
      + '</div>';
  }).join('');
  return '<div class="panel" style="margin-bottom:18px">'
    + '<div class="panel-title">Denný náklad firmy (suroviny)</div>'
    + '<div style="display:flex;gap:6px;align-items:flex-end;padding:8px 0;overflow-x:auto;min-height:120px">' + bars + '</div>'
    + '</div>';
}

function renderPersonTable(rows, totals) {
  return '<div class="table-scroll-wrap">'
    + '<table class="data-table">'
    +   '<thead><tr>'
    +     '<th>Meno</th>'
    +     '<th class="text-right">Počet</th>'
    +     '<th class="text-right">Jedlo (kuch.)</th>'
    +     '<th class="text-right">Nápoje (bar)</th>'
    +     '<th class="text-right">Náklad spolu</th>'
    +     '<th class="text-right" title="Hodnota benefitu — koľko by zaplatil zákazník za rovnaké položky">Cena na predaj</th>'
    +     '<th class="text-right" title="Cena na predaj − náklad. Marža na ktorú firma rezignovala.">Stratená marža</th>'
    +   '</tr></thead>'
    +   '<tbody>'
    +   rows.map(r => {
        const food = Number(r.foodCost) || 0;
        const drink = Number(r.drinkCost) || 0;
        const cost = Number(r.cost) || 0;
        const menuValue = Number(r.menuValue) || 0;
        const lostMargin = menuValue - cost;
        return '<tr>'
          + '<td class="td-name"><strong>' + escapeHtml(r.name || '--') + '</strong></td>'
          + '<td class="num text-right">' + (Number(r.meals) || 0) + '</td>'
          + '<td class="num text-right" style="color:var(--color-text-sec)">' + (food > 0 ? fmtEur(food) : '<span style="color:var(--color-text-dim)">—</span>') + '</td>'
          + '<td class="num text-right" style="color:var(--color-text-sec)">' + (drink > 0 ? fmtEur(drink) : '<span style="color:var(--color-text-dim)">—</span>') + '</td>'
          + '<td class="num text-right" style="font-weight:var(--weight-bold)">' + fmtEur(cost) + '</td>'
          + '<td class="num text-right">' + fmtEur(menuValue) + '</td>'
          + '<td class="num text-right" style="color:var(--color-text-sec)">' + fmtEur(lostMargin) + '</td>'
          + '</tr>';
      }).join('')
    +   '</tbody>'
    +   '<tfoot><tr>'
    +     '<td><strong>Spolu</strong></td>'
    +     '<td class="num text-right">' + totals.totalMeals + '</td>'
    +     '<td class="num text-right" style="color:var(--color-text-sec)">' + fmtEur(totals.totalFood) + '</td>'
    +     '<td class="num text-right" style="color:var(--color-text-sec)">' + fmtEur(totals.totalDrink) + '</td>'
    +     '<td class="num text-right" style="font-weight:var(--weight-bold);color:var(--accent-amber, #f59e0b)">' + fmtEur(totals.totalCost) + '</td>'
    +     '<td class="num text-right" style="font-weight:var(--weight-bold)">' + fmtEur(totals.totalMenuValue) + '</td>'
    +     '<td class="num text-right" style="color:var(--color-text-sec)">' + fmtEur(totals.lostMargin) + '</td>'
    +   '</tr></tfoot>'
    + '</table>'
    + '</div>';
}

const TEMPLATE = ''
  + '<div class="top-bar">'
  +   '<div class="top-bar-left" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
  +     '<label class="doch-toolbar-label">Od <input type="date" id="zsFrom" class="doch-input"></label>'
  +     '<label class="doch-toolbar-label">Do <input type="date" id="zsTo" class="doch-input"></label>'
  +     '<button class="doch-preset" data-preset="month">Tento mesiac</button>'
  +     '<button class="doch-preset" data-preset="7">7 dní</button>'
  +     '<button class="doch-preset" data-preset="30">30 dní</button>'
  +     '<button class="doch-preset" data-preset="60">60 dní</button>'
  +   '</div>'
  + '</div>'
  + '<div id="zsContent"><div class="loading-placeholder" style="padding:30px;text-align:center">Načítavam…</div></div>';

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;
  // Default range = tento mesiac
  _from = firstOfMonth();
  _to = todayIso();
  $('#zsFrom').value = _from;
  $('#zsTo').value = _to;

  $('#zsFrom').addEventListener('change', (e) => {
    _from = e.target.value;
    load();
  });
  $('#zsTo').addEventListener('change', (e) => {
    _to = e.target.value;
    load();
  });
  _container.querySelectorAll('.doch-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      if (preset === 'month') {
        _from = firstOfMonth();
        _to = todayIso();
      } else {
        _from = daysAgoIso(parseInt(preset, 10));
        _to = todayIso();
      }
      $('#zsFrom').value = _from;
      $('#zsTo').value = _to;
      load();
    });
  });

  load();
}

export function destroy() {
  _container = null;
  _data = null;
}
