// Inventory dashboard page module

// Escapovanie: jediná implementácia je /js/pos-escape.js (načítaná v
// admin/index.html). Táto stránka predtým NEescapovala vôbec nič — názov
// kategórie / produktu / stola / suroviny / zamestnanca ide z DB rovno do
// innerHTML, takže čokoľvek, čo si manažér uloží ako názov, sa v admine
// vykoná ako HTML (CSP má 'unsafe-inline', takže aj ako skript).
function escapeHtml(v) {
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _container = null;
let _interval = null;

function $(sel) {
  return _container.querySelector(sel);
}

function fmtTime(isoStr) {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

function fmtQty(n, unit) {
  var val = Number(n).toLocaleString('sk-SK', { maximumFractionDigits: 2 });
  return unit ? val + ' ' + unit : val;
}

// Pilulka len pre výnimku — na tejto stránke je každý riadok výnimkou,
// preto rozlišujeme len prázdne (červená) a pod minimom (jantár).
function stockPill(currentQty) {
  if (currentQty <= 0) return '<span class="sk-pill is-danger">Prázdne</span>';
  return '<span class="sk-pill is-warn">Pod minimom</span>';
}

var TYPES = {
  purchase:    { cls: 'is-ok',     label: 'Príjem' },
  sale:        { cls: 'is-dim',    label: 'Predaj' },
  adjustment:  { cls: 'is-accent', label: 'Úprava' },
  waste:       { cls: 'is-danger', label: 'Odpad' },
  inventory:   { cls: 'is-warn',   label: 'Inventúra' }
};
function typePill(type) {
  var entry = TYPES[type] || { cls: 'is-dim', label: type || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}
function word(n, one, few, many) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

async function loadDashboard() {
  if (!_container) return;

  try {
    var data = await api.get('/inventory/dashboard');
    if (!_container) return;
    if (!data) return;

    renderStats(data.stats);
    renderLowStock(data.lowStockIngredients, data.lowStockMenuItems);
    renderMovements(data.recentMovements);
  } catch (err) {
    showToast(err.message || 'Chyba načítania skladu', 'error');
  }
}

function renderStats(stats) {
  if (!stats || !_container) return;

  var total = Number(stats.totalIngredients || 0);
  var low = Number(stats.totalLowStock || 0);
  var mov = Number(stats.todayMovements || 0);

  var totalEl = $('#statTotal');
  var lowEl = $('#statLow');
  var movEl = $('#statMov');

  if (totalEl) {
    totalEl.textContent = total.toLocaleString('sk-SK');
    totalEl.classList.remove('skeleton', 'skeleton-text');
    var tw = $('#statTotalWord'); if (tw) tw.textContent = word(total, 'surovina', 'suroviny', 'surovín');
  }
  if (lowEl) {
    lowEl.textContent = low.toLocaleString('sk-SK');
    lowEl.classList.remove('skeleton', 'skeleton-text');
    // Výnimka dostane farbu: keď nič nechýba, riadok ostane pokojný.
    var lowWrap = $('#statLowWrap'); if (lowWrap) lowWrap.classList.toggle('is-warn', low > 0);
  }
  if (movEl) {
    movEl.textContent = mov.toLocaleString('sk-SK');
    movEl.classList.remove('skeleton', 'skeleton-text');
    var mw = $('#statMovWord'); if (mw) mw.textContent = word(mov, 'pohyb dnes', 'pohyby dnes', 'pohybov dnes');
  }
}

function renderLowStock(ingredients, menuItems) {
  if (!_container) return;
  var list = $('#lowStockBody');
  if (!list) return;

  var rows = [];

  if (ingredients && ingredients.length > 0) {
    ingredients.forEach(function(item) {
      rows.push({ name: item.name, unit: item.unit || '', current: item.currentQty, min: item.minQty });
    });
  }

  if (menuItems && menuItems.length > 0) {
    menuItems.forEach(function(item) {
      rows.push({ name: item.name, unit: 'ks', current: item.currentQty, min: item.minQty });
    });
  }

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-hint">Všetky zásoby sú nad minimom.</div>';
    return;
  }

  list.innerHTML = rows.map(function(r) {
    return '<div class="sk-row is-static">'
      + '<span class="sk-row-main">'
      + '<span class="sk-row-name">' + escapeHtml(r.name) + '</span>'
      + '<span class="sk-row-sub">min. ' + fmtQty(r.min, r.unit) + '</span>'
      + '</span>'
      + '<span class="sk-row-side">'
      + '<span class="sk-row-num">' + fmtQty(r.current, r.unit) + '</span>'
      + stockPill(r.current)
      + '</span>'
      + '</div>';
  }).join('');
}

function renderMovements(movements) {
  if (!_container) return;
  var list = $('#movementsBody');
  if (!list) return;

  if (!movements || movements.length === 0) {
    list.innerHTML = '<div class="empty-hint">Zatiaľ žiadne pohyby.</div>';
    return;
  }

  // API vracia surové pohyby bez názvu položky — riadok nesie typ a čas,
  // vpravo rozdiel a „pred → po".
  list.innerHTML = movements.map(function(m) {
    var diff = Number(m.newQty) - Number(m.previousQty);
    var sign = diff > 0 ? '+' : '';
    var cls = diff > 0 ? 'is-up' : (diff < 0 ? 'is-down' : '');
    return '<div class="sk-row is-static">'
      + '<span class="sk-row-main">'
      + '<span class="sk-row-name">' + typePill(m.type) + '</span>'
      + '<span class="sk-row-sub">' + fmtTime(m.createdAt) + (m.note ? ' · ' + escapeHtml(m.note) : '') + '</span>'
      + '</span>'
      + '<span class="sk-row-side">'
      + '<span class="sk-row-num ' + cls + '">' + sign + Number(diff).toLocaleString('sk-SK', { maximumFractionDigits: 2 }) + '</span>'
      + '<span class="sk-row-meta">' + fmtQty(m.previousQty) + ' → ' + fmtQty(m.newQty) + '</span>'
      + '</span>'
      + '</div>';
  }).join('');
}

var TEMPLATE = `
  <!-- Súčet: jeden riadok namiesto troch kariet. „Pod minimom" vedie na zoznam surovín. -->
  <div class="sk-sum">
    <span><strong id="statTotal" class="skeleton skeleton-text">&nbsp;</strong> <span id="statTotalWord">surovín</span></span>
    <a class="sk-sum-link" id="statLowWrap" href="#sklad-materialy/suroviny"><strong id="statLow" class="skeleton skeleton-text">&nbsp;</strong> pod minimom</a>
    <span><strong id="statMov" class="skeleton skeleton-text">&nbsp;</strong> <span id="statMovWord">pohybov dnes</span></span>
  </div>

  <div class="sk-grid2">
    <div>
      <div class="sk-list-title">Nízky stav zásob</div>
      <div class="sk-list" id="lowStockBody">
        <div class="skeleton-row"></div><div class="skeleton-row"></div>
      </div>
    </div>
    <div>
      <div class="sk-list-title">Posledné pohyby</div>
      <div class="sk-list" id="movementsBody">
        <div class="skeleton-row"></div><div class="skeleton-row"></div>
      </div>
    </div>
  </div>

  <div class="sk-list-title">Rýchle akcie</div>
  <div class="sk-list sk-nav">
    <a class="sk-row" href="#sklad-materialy/suroviny">
      <span class="sk-row-main"><span class="sk-row-name">Suroviny</span><span class="sk-row-sub">Nakupované položky, minimá, ceny</span></span>
      <span class="sk-row-side"></span>
      <svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
    <a class="sk-row" href="#sklad-materialy/dodavatelia">
      <span class="sk-row-main"><span class="sk-row-name">Dodávatelia</span><span class="sk-row-sub">Kontakty a podmienky</span></span>
      <span class="sk-row-side"></span>
      <svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
    <a class="sk-row" href="#purchase-orders">
      <span class="sk-row-main"><span class="sk-row-name">Objednávky skladu</span><span class="sk-row-sub">Príjem faktúr a dodávok</span></span>
      <span class="sk-row-side"></span>
      <svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
    <a class="sk-row" href="#sklad-pohyby/inventura">
      <span class="sk-row-main"><span class="sk-row-name">Inventúra</span><span class="sk-row-sub">Napočítať a porovnať stav</span></span>
      <span class="sk-row-side"></span>
      <svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
  </div>
`;

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;

  loadDashboard();
  _interval = setInterval(loadDashboard, 60000);
}

export function destroy() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _container = null;
}
