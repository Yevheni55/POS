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
// Ktorý prednastavený rozsah je zapnutý ('month' | '7' | '30' | '60' | 'custom')
// — kvôli zvýrazneniu chipu; samotný rozsah drží _from/_to.
let _preset = 'month';
let _moreOpen = false;

function $(sel) { return _container && _container.querySelector(sel); }

function fmtEur(n) { return fmtCost(n) + ' €'; }

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
    if (wrap) wrap.innerHTML = '<div class="error-hint">Prehľad sa nepodarilo načítať: ' + escapeHtml(e.message || 'neznáma chyba') + '</div>';
  }
}

function mealsWord(n) {
  if (n === 1) return 'jedlo';
  if (n >= 2 && n <= 4) return 'jedlá';
  return 'jedál';
}

function render() {
  if (!_data) return;
  const rows = (_data.staffMealByPerson || []).filter(r => Number(r.cost) > 0 || Number(r.menuValue) > 0);
  const daily = (_data.daily || []).filter(d => Number(d.staffMeal) > 0);

  let totalMeals = 0, totalCost = 0, totalFood = 0, totalDrink = 0, totalMenuValue = 0;
  rows.forEach(r => {
    totalMeals += Number(r.meals) || 0;
    totalCost += Number(r.cost) || 0;
    totalFood += Number(r.foodCost) || 0;
    totalDrink += Number(r.drinkCost) || 0;
    totalMenuValue += Number(r.menuValue) || 0;
  });
  const lostMargin = totalMenuValue - totalCost; // marža, ktorej sa firma vzdala

  // Súčet v jednom riadku namiesto troch KPI kariet: koľko jedál, čo to
  // stálo firmu a čo by za to zaplatil hosť.
  const sumHtml = '<div class="doch-sum">'
    + '<span><strong>' + totalMeals + '</strong> ' + mealsWord(totalMeals) + '</span>'
    + '<span><strong>' + fmtEur(totalCost) + '</strong> náklad firmy</span>'
    + '<span><strong>' + fmtEur(totalMenuValue) + '</strong> hodnota pre hosťa</span>'
    + '</div>';

  const splitHtml = totalCost > 0 ? renderSplitBar(totalFood, totalDrink) : '';
  const chartHtml = renderDailyChart(daily);
  const listHtml = rows.length
    ? renderPersonList(rows, { totalMeals, totalCost, totalFood, totalDrink, totalMenuValue, lostMargin })
    : '<p class="zs-empty">V tomto období nikto zo zamestnancov nič nekonzumoval.'
      + '<small>Spotreba sa zapíše, keď čašník uzavrie účet cez „Uzavrieť ako staff meal“ v pokladni.</small></p>';

  const wrap = $('#zsContent');
  if (wrap) {
    wrap.innerHTML = sumHtml + splitHtml + chartHtml
      + '<div class="panel">'
      +   '<div class="panel-title zs-panel-title"><span>Podľa osoby</span><small>náklad firmy · hodnota pre hosťa</small></div>'
      +   listHtml
      + '</div>';
  }
}


function renderSplitBar(food, drink) {
  const total = food + drink;
  if (total <= 0) return '';
  const foodPct = (food / total) * 100;
  const drinkPct = (drink / total) * 100;
  return '<div class="panel" style="margin-bottom:14px">'
    + '<div class="panel-title">Kuchyňa a bar</div>'
    + '<div class="zs-split" role="img" aria-label="Kuchyňa ' + fmtEur(food) + ', bar ' + fmtEur(drink) + '">'
    +   '<div class="zs-split-food" style="width:' + foodPct.toFixed(1) + '%"></div>'
    +   '<div class="zs-split-drink" style="width:' + drinkPct.toFixed(1) + '%"></div>'
    + '</div>'
    + '<div class="zs-legend">'
    +   '<span class="zs-legend-i">Kuchyňa <b>' + fmtEur(food) + '</b> <small>(' + foodPct.toFixed(0) + ' %)</small></span>'
    +   '<span class="zs-legend-i is-drink">Bar <b>' + fmtEur(drink) + '</b> <small>(' + drinkPct.toFixed(0) + ' %)</small></span>'
    + '</div>'
    + '</div>';
}

function renderDailyChart(daily) {
  if (!daily.length) {
    return '<div class="panel" style="margin-bottom:14px"><div class="panel-title">Denný náklad firmy</div>'
      + '<p class="zs-empty">V tomto období bez spotreby.</p></div>';
  }
  const max = Math.max(...daily.map(d => Number(d.staffMeal) || 0));
  if (max <= 0) return '';
  const sorted = daily.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // Stĺpce sa delia o šírku panelu — 31 dní sa zmestí bez rolovania vbok.
  const bars = sorted.map(d => {
    const v = Number(d.staffMeal) || 0;
    const pct = max > 0 ? (v / max) * 100 : 0;
    const parts = String(d.date).split('-');
    const lbl = parseInt(parts[2], 10) + '.' + parseInt(parts[1], 10) + '.';
    return ''
      + '<div class="zs-bar" role="img" aria-label="' + lbl + ' ' + fmtEur(v) + '" title="' + lbl + ' ' + fmtEur(v) + '">'
      +   '<div class="zs-bar-track"><div class="zs-bar-fill" style="height:' + pct.toFixed(1) + '%"></div></div>'
      +   '<div class="zs-bar-lbl">' + lbl + '</div>'
      + '</div>';
  }).join('');
  return '<div class="panel" style="margin-bottom:14px">'
    + '<div class="panel-title">Denný náklad firmy <small class="dsh-muted">suroviny</small></div>'
    + '<div class="zs-chart">' + bars + '</div>'
    + '</div>';
}

function personRow(name, meals, food, drink, cost, menuValue, extra, cls) {
  const parts = [meals + ' ' + mealsWord(meals)];
  if (food > 0) parts.push('kuchyňa ' + fmtEur(food));
  if (drink > 0) parts.push('bar ' + fmtEur(drink));
  return '<div class="set-row zs-person' + (cls ? ' ' + cls : '') + '">'
    + '<span class="set-k">' + name + '<span class="set-sub">' + parts.join(' · ') + '</span></span>'
    + '<span class="set-r"><span class="zs-cost"><b>' + fmtEur(cost) + '</b><small>hosť by zaplatil ' + fmtEur(menuValue) + (extra || '') + '</small></span></span>'
    + '</div>';
}

function renderPersonList(rows, totals) {
  const list = rows.map(r => personRow(
    escapeHtml(r.name || '—'),
    Number(r.meals) || 0,
    Number(r.foodCost) || 0,
    Number(r.drinkCost) || 0,
    Number(r.cost) || 0,
    Number(r.menuValue) || 0,
    '',
    '',
  )).join('');
  const total = personRow(
    'Spolu',
    totals.totalMeals,
    totals.totalFood,
    totals.totalDrink,
    totals.totalCost,
    totals.totalMenuValue,
    ' · ušlá marža ' + fmtEur(totals.lostMargin),
    'zs-total',
  );
  return '<div class="set-group zs-list">' + list + total + '</div>';
}

// Obdobie: tri najpoužívanejšie rozsahy ako chipy, dátumy a 60 dní pod „Iné…“
// — rovnaká hlavička ako v Dochádzke.
const TEMPLATE = ''
  + '<div class="doch-head">'
  +   '<div class="doch-chips" role="group" aria-label="Obdobie" id="zsChips"></div>'
  +   '<div class="doch-more zs-more" id="zsMore" hidden>'
  +     '<label class="doch-toolbar-label">Od<input type="date" id="zsFrom" class="doch-input"></label>'
  +     '<label class="doch-toolbar-label">Do<input type="date" id="zsTo" class="doch-input"></label>'
  +     '<div class="doch-chips doch-chips-more" id="zsChipsMore"></div>'
  +   '</div>'
  +   '<div class="doch-range" id="zsRange"></div>'
  + '</div>'
  + '<div id="zsContent"><div class="loading-hint">Načítavam…</div></div>';

function presetChip(preset, label) {
  const on = _preset === preset;
  return '<button type="button" class="doch-chip' + (on ? ' is-on' : '') + '" data-preset="' + preset + '"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
}

// "1. 9. – 8. 9. 2026" — človek nemá lúštiť ISO dátumy z dvoch políčok.
function fmtRange(fromIso, toIso) {
  const parse = (iso) => { const p = String(iso).split('-').map(Number); return { y: p[0], m: p[1], d: p[2] }; };
  const a = parse(fromIso), b = parse(toIso);
  if (!a.y || !b.y) return fromIso + ' – ' + toIso;
  const left = a.d + '. ' + a.m + '.' + (a.y === b.y ? '' : ' ' + a.y);
  return left + ' – ' + b.d + '. ' + b.m + '. ' + b.y;
}

function applyPreset(preset) {
  if (preset === 'month') {
    _from = firstOfMonth();
    _to = todayIso();
  } else {
    _from = daysAgoIso(parseInt(preset, 10));
    _to = todayIso();
  }
  _preset = preset;
  _moreOpen = false;
  $('#zsFrom').value = _from;
  $('#zsTo').value = _to;
}

function renderChips() {
  const chips = $('#zsChips');
  const more = $('#zsChipsMore');
  const box = $('#zsMore');
  const range = $('#zsRange');
  if (!chips) return;
  chips.innerHTML = presetChip('month', 'Tento mesiac')
    + presetChip('7', '7 dní')
    + presetChip('30', '30 dní')
    + '<button type="button" class="doch-chip' + ((_moreOpen || _preset === 'custom') ? ' is-on' : '') + '"'
      + ' id="zsMoreBtn" aria-expanded="' + (_moreOpen ? 'true' : 'false') + '" aria-controls="zsMore">Iné…</button>';
  if (more) more.innerHTML = presetChip('60', '60 dní');
  if (box) box.hidden = !_moreOpen;
  if (range) range.textContent = fmtRange(_from, _to);

  _container.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyPreset(btn.getAttribute('data-preset'));
      renderChips();
      load();
    });
  });
  const moreBtn = $('#zsMoreBtn');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    _moreOpen = !_moreOpen;
    renderChips();
  });
}

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;
  // Default range = tento mesiac
  _from = firstOfMonth();
  _to = todayIso();
  $('#zsFrom').value = _from;
  $('#zsTo').value = _to;

  // Dátumy sa použijú hneď pri zmene — bez tlačidla „Obnoviť“.
  ['#zsFrom', '#zsTo'].forEach((sel) => {
    $(sel).addEventListener('change', () => {
      const f = $('#zsFrom').value;
      const t = $('#zsTo').value;
      if (!f || !t || f > t) return; // neúplný alebo prevrátený rozsah — počkáme
      _from = f;
      _to = t;
      _preset = 'custom';
      renderChips();
      load();
    });
  });
  _preset = 'month';
  _moreOpen = false;
  renderChips();

  load();
}

export function destroy() {
  _container = null;
  _data = null;
  _preset = 'month';
  _moreOpen = false;
}
