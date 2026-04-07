// Inventory dashboard page module
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

function getStockBadge(currentQty) {
  if (currentQty <= 0) {
    return '<span class="badge badge-danger">Prazdny</span>';
  }
  return '<span class="badge badge-warning">Nizky</span>';
}

function getMovementBadge(type) {
  var map = {
    purchase:    { cls: 'badge-success',  label: 'Prijem' },
    sale:        { cls: 'badge-purple',   label: 'Predaj' },
    adjustment:  { cls: 'badge-info',     label: 'Uprava' },
    waste:       { cls: 'badge-danger',   label: 'Odpad' },
    inventory:   { cls: 'badge-warning',  label: 'Inventura' }
  };
  var entry = map[type] || { cls: '', label: type || '--' };
  return '<span class="badge ' + entry.cls + '">' + entry.label + '</span>';
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
    showToast(err.message || 'Chyba nacitania inventara', 'error');
  }
}

function renderStats(stats) {
  if (!stats || !_container) return;

  var totalEl = $('#statTotal');
  var lowEl = $('#statLow');
  var movEl = $('#statMov');

  if (totalEl) {
    totalEl.textContent = Number(stats.totalIngredients || 0).toLocaleString('sk-SK');
    totalEl.classList.remove('skeleton', 'skeleton-text');
  }
  if (lowEl) {
    lowEl.textContent = Number(stats.totalLowStock || 0).toLocaleString('sk-SK');
    lowEl.classList.remove('skeleton', 'skeleton-text');
  }
  if (movEl) {
    movEl.textContent = Number(stats.todayMovements || 0).toLocaleString('sk-SK');
    movEl.classList.remove('skeleton', 'skeleton-text');
  }
}

function renderLowStock(ingredients, menuItems) {
  if (!_container) return;
  var tbody = $('#lowStockBody');
  if (!tbody) return;

  var rows = [];

  if (ingredients && ingredients.length > 0) {
    ingredients.forEach(function(item) {
      rows.push({
        name: item.name,
        unit: item.unit || '--',
        current: fmtQty(item.currentQty, item.unit),
        min: fmtQty(item.minQty, item.unit),
        badge: getStockBadge(item.currentQty)
      });
    });
  }

  if (menuItems && menuItems.length > 0) {
    menuItems.forEach(function(item) {
      rows.push({
        name: item.name,
        unit: 'ks',
        current: fmtQty(item.currentQty, 'ks'),
        min: fmtQty(item.minQty, 'ks'),
        badge: getStockBadge(item.currentQty)
      });
    });
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="td-empty">Vsetky zasoby su v poriadku</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(r) {
    return '<tr>' +
      '<td class="td-name">' + r.name + '</td>' +
      '<td>' + r.unit + '</td>' +
      '<td class="num">' + r.current + '</td>' +
      '<td class="num">' + r.min + '</td>' +
      '<td>' + r.badge + '</td>' +
      '</tr>';
  }).join('');
}

function renderMovements(movements) {
  if (!_container) return;
  var tbody = $('#movementsBody');
  if (!tbody) return;

  if (!movements || movements.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="td-empty">Ziadne pohyby dnes</td></tr>';
    return;
  }

  tbody.innerHTML = movements.map(function(m) {
    var sign = '';
    var diff = Number(m.newQty) - Number(m.previousQty);
    if (diff > 0) sign = '+';
    var qtyDisplay = sign + Number(diff).toLocaleString('sk-SK', { maximumFractionDigits: 2 });

    return '<tr>' +
      '<td>' + fmtTime(m.createdAt) + '</td>' +
      '<td>' + getMovementBadge(m.type) + '</td>' +
      '<td class="num">' + qtyDisplay + '</td>' +
      '<td class="num">' + fmtQty(m.previousQty) + ' &rarr; ' + fmtQty(m.newQty) + '</td>' +
      '</tr>';
  }).join('');
}

var TEMPLATE = `
  <!-- STAT CARDS -->
  <div class="stat-grid grid-3col">
    <div class="stat-card">
      <div class="stat-icon mint">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Suroviny</div>
        <div class="stat-value skeleton skeleton-text" id="statTotal">&nbsp;</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(224,112,112,.12);color:var(--color-danger)">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Nizky stav</div>
        <div class="stat-value skeleton skeleton-text" id="statLow">&nbsp;</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon lavender">
        <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Pohyby dnes</div>
        <div class="stat-value skeleton skeleton-text" id="statMov">&nbsp;</div>
      </div>
    </div>
  </div>

  <!-- LOW STOCK + RECENT MOVEMENTS -->
  <div class="row">
    <div class="col-60">
      <div class="panel">
        <div class="panel-title">
          <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Nízky stav zásob
        </div>
        <div class="table-scroll-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Názov</th>
              <th>Jednotka</th>
              <th>Aktuálne</th>
              <th>Minimum</th>
              <th>Stav</th>
            </tr>
          </thead>
          <tbody id="lowStockBody">
            <tr><td colspan="5" class="td-empty">Načítavam…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <div class="col-40">
      <div class="panel" style="height:100%">
        <div class="panel-title">
          <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          Posledné pohyby
        </div>
        <div class="table-scroll-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Čas</th>
              <th>Typ</th>
              <th>Množstvo</th>
              <th>Pred &rarr; Po</th>
            </tr>
          </thead>
          <tbody id="movementsBody">
            <tr><td colspan="4" class="td-empty">Načítavam…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>
  </div>

  <!-- QUICK ACTIONS -->
  <div class="row">
    <div class="col-60">
      <div class="panel">
        <div class="panel-title">Rychle akcie</div>
        <div class="quick-actions-grid">
          <a href="#ingredients" class="btn-outline-accent">
            <svg aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
            Suroviny
          </a>
          <a href="#suppliers" class="btn-outline-accent">
            <svg aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Dodavatelia
          </a>
          <a href="#purchase-orders" class="btn-outline-accent">
            <svg aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
            Objednavky
          </a>
          <a href="#inventory-audit" class="btn-outline-accent">
            <svg aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            Inventura
          </a>
        </div>
      </div>
    </div>
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
