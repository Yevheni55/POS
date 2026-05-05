// Reports page module
let _container = null;
let _lastZData = null;
// Produkty tab sorting — clicking any column header re-sorts client-side
// so the cashier can pick "predalo sa najmenej" or "abecedne" without a
// new request. Default mirrors the natural rank: qty descending.
let _productSort = { col: 'qty', dir: 'desc' };
let _lastProductsData = null;

function $(sel) {
  return _container.querySelector(sel);
}

function $$(sel) {
  return _container.querySelectorAll(sel);
}

function fmtEur(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function weekAgoStr() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().split('T')[0];
}

function monthStartStr() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
}

// ===== LOAD REPORTS FROM API =====
async function loadReports() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const activeTabContent = _container.querySelector('.tab-content.active');
  if (activeTabContent) showLoading(activeTabContent, 'Nacitavam reporty...');
  try {
    const data = await api.get('/reports/summary?from=' + from + '&to=' + to);
    if (activeTabContent) hideLoading(activeTabContent);
    if (data) {
      renderStats(data);
      renderDestSplit(data);
      renderTrzby(data);
      renderProdukty(data);
      renderZamestnanci(data);
      renderHodiny(data);
    } else {
      showEmptyReports();
    }
  } catch (err) {
    if (activeTabContent) hideLoading(activeTabContent);
    showToast(err.message || 'Chyba nacitania reportov', 'error');
  }
}

function showEmptyReports() {
  const emptyHtml = '<tr><td colspan="7" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const trzbyBody = $('#table-trzby tbody');
  if (trzbyBody) trzbyBody.innerHTML = emptyHtml;
  const produktyBody = $('#table-produkty tbody');
  if (produktyBody) produktyBody.innerHTML = '<tr><td colspan="8" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const zamBody = $('#table-zamestnanci tbody');
  if (zamBody) zamBody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const hodBody = $('#table-hodiny tbody');
  if (hodBody) hodBody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
}

function renderStats(data) {
  // The 7-card grid is rendered top-to-bottom: 4 sales KPIs, then 3
  // hospodársky-výsledok cards. Values flow into them by index because the
  // existing template binds via .stat-value class (no IDs).
  const statValues = $$('.stat-value');
  if (data.totalRevenue !== undefined && statValues[0]) {
    statValues[0].innerHTML = fmtEur(data.totalRevenue);
  }
  if (data.totalOrders !== undefined && statValues[1]) {
    statValues[1].textContent = data.totalOrders;
  }
  if (data.avgCheck !== undefined && statValues[2]) {
    statValues[2].innerHTML = fmtEur(data.avgCheck);
  }
  if (data.topRevenue !== undefined && statValues[3]) {
    statValues[3].innerHTML = fmtEur(data.topRevenue);
  }
  // Náklady-na-výrobu (COGS) — sum z receptov × predaj. Položky bez receptu
  // (väčšina barových bezreceptových drinkov, kombá pred recept-update)
  // počítame ako 0 €, čo je dohodnuté zjednodušenie. Číslo sa preto chápe
  // ako "garantované známe COGS", nie horný odhad.
  if (data.totalCogs !== undefined && statValues[4]) {
    statValues[4].innerHTML = fmtEur(data.totalCogs);
  }
  // Mzdy — z attendance_events (clock_in→clock_out) × hourly_rate.
  if (data.totalLabor !== undefined && statValues[5]) {
    statValues[5].innerHTML = fmtEur(data.totalLabor);
  }
  // Výsledok = Tržby − Výroba − Mzdy. Farebne zvýrazníme: zelená pre +,
  // červená pre −, šedá pre 0 — operátor potrebuje na prvý pohľad vidieť
  // či je deň/mesiac v pluse.
  if (data.totalProfit !== undefined && statValues[6]) {
    const v = Number(data.totalProfit) || 0;
    const color = v > 0 ? 'var(--color-success, #22c55e)'
                : v < 0 ? 'var(--color-danger, #ef4444)'
                : 'var(--color-text-sec, #94a3b8)';
    statValues[6].innerHTML = '<span style="color:' + color + '">' + fmtEur(v) + '</span>';
  }
}

// Bar vs Kuchyňa revenue split — sits above the daily Trzby table so the
// owner sees at-a-glance how much was earned by each destination. The
// percentage is computed against the sum of (bar+kuchyna) only, NOT the
// fiscal totalRevenue (which includes shisha + item-less payments).
function renderDestSplit(data) {
  const host = $('#destSplit');
  if (!host) return;
  const r = data.revenueByDest || { bar: 0, kuchyna: 0, itemsBar: 0, itemsKuchyna: 0 };
  const sum = (Number(r.bar) || 0) + (Number(r.kuchyna) || 0);
  const pct = (n) => sum > 0 ? Math.round((n / sum) * 100) : 0;
  host.innerHTML =
    '<div class="stat-card">' +
      '<div class="stat-icon mint">' +
        '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 11h14l-1 9H6z"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
      '</div>' +
      '<div class="stat-info">' +
        '<div class="stat-label">Bar</div>' +
        '<div class="stat-value">' + fmtEur(r.bar || 0) + '</div>' +
        '<div class="stat-change neutral">' + (r.itemsBar || 0) + ' ks · ' + pct(r.bar || 0) + '%</div>' +
      '</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-icon amber">' +
        '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M9 6V3h6v3"/></svg>' +
      '</div>' +
      '<div class="stat-info">' +
        '<div class="stat-label">Kuchyňa</div>' +
        '<div class="stat-value">' + fmtEur(r.kuchyna || 0) + '</div>' +
        '<div class="stat-change neutral">' + (r.itemsKuchyna || 0) + ' ks · ' + pct(r.kuchyna || 0) + '%</div>' +
      '</div>' +
    '</div>';
}

function renderTrzby(data) {
  const tbody = $('#table-trzby tbody');
  if (!tbody) return;
  if (!data.daily || !data.daily.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  // Per-day rows now also show Výroba (COGS), Mzdy, Výsledok. Profit cell
  // is colored — green for positive day, red for negative — so the operator
  // can scan a week and immediately spot bad days. Edge: if revenue=0 but
  // labor>0 (e.g. paid-shift on a closed day), the row appears with red.
  tbody.innerHTML = data.daily.map(d => {
    const profit = Number(d.profit) || 0;
    const profitColor = profit > 0 ? 'var(--color-success, #22c55e)'
                      : profit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    return `<tr>
      <td>${d.date}</td>
      <td class="num">${d.orders}</td>
      <td class="num highlight-cell">${fmtEur(d.revenue)}</td>
      <td class="num">${fmtEur(d.cogs || 0)}</td>
      <td class="num">${fmtEur(d.labor || 0)}</td>
      <td class="num" style="font-weight:700;color:${profitColor}">${fmtEur(profit)}</td>
      <td class="num">${fmtEur(d.avgCheck)}</td>
    </tr>`;
  }).join('');

  const tfoot = $('#table-trzby tfoot');
  if (tfoot && data.totalRevenue !== undefined) {
    const tProfit = Number(data.totalProfit) || 0;
    const tProfitColor = tProfit > 0 ? 'var(--color-success, #22c55e)'
                      : tProfit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    tfoot.innerHTML = `<tr>
      <td>Spolu</td>
      <td>${data.totalOrders || ''}</td>
      <td class="color-accent">${fmtEur(data.totalRevenue)}</td>
      <td>${data.totalCogs !== undefined ? fmtEur(data.totalCogs) : ''}</td>
      <td>${data.totalLabor !== undefined ? fmtEur(data.totalLabor) : ''}</td>
      <td style="font-weight:700;color:${tProfitColor}">${data.totalProfit !== undefined ? fmtEur(tProfit) : ''}</td>
      <td>${data.avgCheck !== undefined ? fmtEur(data.avgCheck) : ''}</td>
    </tr>`;
  }
}

function renderProdukty(data) {
  const tbody = $('#table-produkty tbody');
  if (!tbody) return;
  // Cache the dataset so a header-click can re-render without a new request.
  _lastProductsData = data;
  updateProductHeaderArrows();
  if (!data.products || !data.products.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  // Take a copy so we don't mutate the cached data on each click.
  const sorted = (data.products || []).slice().sort(productComparator(_productSort));
  // The progress bar always uses the period's max revenue as the 100% mark
  // so two products are visually comparable regardless of current sort.
  const maxRev = Math.max(...sorted.map(p => p.revenue));
  tbody.innerHTML = sorted.map((p, i) => {
    const pct = maxRev > 0 ? Math.round((p.revenue / (data.totalRevenue || maxRev)) * 1000) / 10 : 0;
    const barW = maxRev > 0 ? Math.round((p.revenue / maxRev) * 100) : 0;
    let rankStyle = '';
    if (i === 0) rankStyle = 'color:var(--color-accent);font-weight:700';
    else if (i === 1) rankStyle = 'color:var(--color-text-sec);font-weight:700';
    else if (i === 2) rankStyle = 'color:rgba(205,127,50,.7);font-weight:700';
    const display = (p.emoji ? p.emoji + ' ' : '') + (p.name || '');
    // Per-product Výroba & Výsledok — položky bez receptu majú cogs=0,
    // takže ich Výsledok = Tržba (čisté marže). Farba Výsledku zvýrazní
    // straty (záporná marža = chybný recept alebo nákupná cena).
    const cogs = Number(p.cogs) || 0;
    const profit = Number(p.profit) || 0;
    const profitColor = profit > 0 ? 'var(--color-success, #22c55e)'
                      : profit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    return `<tr>
      <td class="num" style="${rankStyle}">${i + 1}</td>
      <td class="td-name">${display}</td>
      <td>${p.category || ''}</td>
      <td class="num">${p.qty}</td>
      <td class="num highlight-cell">${fmtEur(p.revenue)}</td>
      <td class="num">${fmtEur(cogs)}</td>
      <td class="num" style="font-weight:700;color:${profitColor}">${fmtEur(profit)}</td>
      <td><div class="progress-wrap"><div class="progress-fill" style="width:${barW}%"></div></div>${pct}%</td>
    </tr>`;
  }).join('');
}

// Build a stable comparator from the current sort state. Numeric columns
// (qty, revenue, pct) compare as numbers; text columns (name, category)
// use locale-aware compare so 'Špargľa' sorts where a Slovak speaker
// expects. Falls back to qty desc for unknown column ids.
function productComparator(sort) {
  const dir = sort && sort.dir === 'asc' ? 1 : -1;
  const col = sort && sort.col;
  if (col === 'name') {
    return (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'sk') * dir;
  }
  if (col === 'category') {
    return (a, b) => {
      const c = String(a.category || '').localeCompare(String(b.category || ''), 'sk') * dir;
      // Tie-break by qty desc so two items in the same category aren't
      // randomly ordered.
      if (c !== 0) return c;
      return ((Number(b.qty) || 0) - (Number(a.qty) || 0));
    };
  }
  if (col === 'revenue' || col === 'pct') {
    return (a, b) => ((Number(a.revenue) || 0) - (Number(b.revenue) || 0)) * dir;
  }
  if (col === 'cogs') {
    return (a, b) => ((Number(a.cogs) || 0) - (Number(b.cogs) || 0)) * dir;
  }
  if (col === 'profit') {
    return (a, b) => ((Number(a.profit) || 0) - (Number(b.profit) || 0)) * dir;
  }
  // default + 'qty'
  return (a, b) => ((Number(a.qty) || 0) - (Number(b.qty) || 0)) * dir;
}

// Toggle the chevron next to each sortable header so the user can see at
// a glance which column drives the current order.
function updateProductHeaderArrows() {
  const ths = _container && _container.querySelectorAll('#table-produkty thead th[data-sort-col]');
  if (!ths) return;
  ths.forEach((th) => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.sortCol === _productSort.col) {
      arrow.textContent = _productSort.dir === 'asc' ? '▲' : '▼';
      th.classList.add('sort-active');
    } else {
      arrow.textContent = '';
      th.classList.remove('sort-active');
    }
  });
}

// Click handler bound once at init: figures out which column was clicked
// and either flips direction (same col) or sets a sensible default
// direction (numeric → desc, text → asc).
function onProductHeaderClick(e) {
  const th = e.target.closest('#table-produkty thead th[data-sort-col]');
  if (!th) return;
  const col = th.dataset.sortCol;
  if (_productSort.col === col) {
    _productSort.dir = _productSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _productSort.col = col;
    _productSort.dir = (col === 'name' || col === 'category') ? 'asc' : 'desc';
  }
  if (_lastProductsData) renderProdukty(_lastProductsData);
}

function renderZamestnanci(data) {
  const tbody = $('#table-zamestnanci tbody');
  if (!tbody) return;
  if (!data.staff || !data.staff.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  tbody.innerHTML = data.staff.map(s => {
    const starCount = Math.min(5, Math.max(0, Math.round(s.rating || 0)));
    const stars = '\u2605'.repeat(starCount) + '\u2606'.repeat(5 - starCount);
    return `<tr>
      <td class="td-name">${s.name}</td>
      <td class="num">${s.shifts || ''}</td>
      <td class="num">${s.orders || ''}</td>
      <td class="num highlight-cell">${fmtEur(s.revenue)}</td>
      <td class="num">${fmtEur(s.avgCheck)}</td>
      <td><span class="stars">${stars}</span></td>
    </tr>`;
  }).join('');
}

function renderHodiny(data) {
  const tbody = $('#table-hodiny tbody');
  if (!tbody) return;
  if (!data.hourly || !data.hourly.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    const tfootEmpty = $('#table-hodiny tfoot');
    if (tfootEmpty) tfootEmpty.innerHTML = '';
    return;
  }
  // Peak detection still uses the per-hour share of the period's busiest
  // hour (>= 85% of max orders) so the cashier can spot rush hours.
  // Bar/Kuchyňa columns are item-based (qty * price) — the 'Spolu' column
  // shows the payment-based total, so Bar+Kuchyňa may not sum exactly to
  // Spolu when discounts or partial-pay scenarios are involved.
  const maxOrders = Math.max(...data.hourly.map(h => h.orders));
  let totBar = 0, totKuch = 0, totSpolu = 0, totObj = 0;
  tbody.innerHTML = data.hourly.map(h => {
    const pct = maxOrders > 0 ? Math.round((h.orders / maxOrders) * 100) : 0;
    const isPeak = pct >= 85;
    const bar = Number(h.barRevenue) || 0;
    const kuch = Number(h.kuchynaRevenue) || 0;
    totBar += bar; totKuch += kuch;
    totSpolu += Number(h.revenue) || 0;
    totObj += Number(h.orders) || 0;
    return `<tr${isPeak ? ' class="peak-row"' : ''}>
      <td class="num">${h.hour}</td>
      <td class="num">${h.orders}</td>
      <td class="num">${bar > 0 ? fmtEur(bar) : '<span class="color-dim">—</span>'}</td>
      <td class="num">${kuch > 0 ? fmtEur(kuch) : '<span class="color-dim">—</span>'}</td>
      <td class="num${isPeak ? ' highlight-cell' : ''}">${fmtEur(h.revenue)}</td>
      <td>${isPeak ? '<span class="peak-badge">PEAK</span>' : ''}</td>
    </tr>`;
  }).join('');
  const tfoot = $('#table-hodiny tfoot');
  if (tfoot) {
    tfoot.innerHTML = `<tr>
      <td>Spolu</td>
      <td class="num">${totObj}</td>
      <td class="num">${fmtEur(totBar)}</td>
      <td class="num">${fmtEur(totKuch)}</td>
      <td class="num color-accent">${fmtEur(totSpolu)}</td>
      <td></td>
    </tr>`;
  }
}

// ===== STAFF REPORT (CISNICKY TAB) =====
async function loadStaffReport() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const tabContent = _container.querySelector('#tab-cisnicky');
  if (tabContent) showLoading(tabContent, 'Nacitavam cisnicky...');
  try {
    const data = await api.get('/reports/staff?from=' + from + '&to=' + to);
    if (tabContent) hideLoading(tabContent);
    if (!data || data.length === 0) {
      $('#staffTableBody').innerHTML = '<tr><td colspan="9" class="td-empty">Ziadne data</td></tr>';
      $('#staffBars').innerHTML = '<div class="loading-placeholder">Ziadne data pre zvolene obdobie</div>';
      return;
    }

    // Bar chart
    const maxRevenue = Math.max(...data.map(s => s.revenue));
    $('#staffBars').innerHTML = data.map(s => {
      const pct = maxRevenue > 0 ? Math.round((s.revenue / maxRevenue) * 100) : 0;
      return `<div class="staff-bar-row">
        <div class="staff-bar-name">${s.name}</div>
        <div class="staff-bar" style="width:${pct}%"><span class="staff-bar-value">${fmtEur(s.revenue)}</span></div>
      </div>`;
    }).join('');

    // Table
    $('#staffTableBody').innerHTML = data.map(s =>
      `<tr>
        <td class="td-name">${s.name}</td>
        <td>${s.role}</td>
        <td class="num">${s.ordersCount}</td>
        <td class="num">${s.itemsCount}</td>
        <td class="num highlight-cell">${fmtEur(s.revenue)}</td>
        <td class="num">${fmtEur(s.averageOrder)}</td>
        <td class="num">${fmtEur(s.cashPayments)}</td>
        <td class="num">${fmtEur(s.cardPayments)}</td>
        <td class="num color-danger">${s.cancelledOrders}</td>
      </tr>`
    ).join('');
  } catch (err) {
    if (tabContent) hideLoading(tabContent);
    showToast(err.message || 'Chyba nacitania cisnikov', 'error');
    $('#staffTableBody').innerHTML = '<tr><td colspan="9" class="td-empty color-danger">Chyba: ' + err.message + '</td></tr>';
  }
}

// ===== Z-REPORT (UZAVIERKA) =====
async function generateZReport() {
  const date = $('#zReportDate').value;
  if (!date) return;
  const btn = $('#btnGenZReport');
  if (btn) btnLoading(btn);
  try {
    const data = await api.get('/reports/z-report?date=' + date);
    _lastZData = data;
    $('#zReportContent').style.display = 'block';

    $('#zTotalRevenue').innerHTML = fmtEur(data.totalRevenue);
    $('#zOrdersItems').textContent = data.totalOrders + ' / ' + data.totalItems;
    $('#zAvgOrder').innerHTML = fmtEur(data.averageOrder);

    // Payment methods
    const pmDiv = $('#zPaymentMethods');
    if (data.paymentMethods.length === 0) {
      pmDiv.innerHTML = '<div class="loading-placeholder">Ziadne platby</div>';
    } else {
      pmDiv.innerHTML = data.paymentMethods.map(pm => {
        const label = pm.method.charAt(0).toUpperCase() + pm.method.slice(1);
        return `<div class="z-payment-row">
          <span class="td-name">${label} <span class="color-dim">(${pm.count}x)</span></span>
          <span class="uzavierka-value-accent" style="font-size:inherit">${fmtEur(pm.total)}</span></div>`;
      }).join('');
    }

    // Cancelled
    $('#zCancelled').innerHTML =
      `<div class="uzavierka-value color-danger" style="margin-bottom:4px">${data.cancelledItems}</div>` +
      `<div class="loading-placeholder">${data.cancelledTotal > 0 ? 'Strata: ' + fmtEur(data.cancelledTotal) : 'Ziadne storna'}</div>`;

    // Category table
    _container.querySelector('#zCategoryTable tbody').innerHTML = data.categoryBreakdown.map(c =>
      `<tr><td class="td-name">${c.category}</td><td class="num highlight-cell">${fmtEur(c.total)}</td><td class="num">${c.count}x</td></tr>`
    ).join('');

    // Top items table
    _container.querySelector('#zTopItemsTable tbody').innerHTML = data.topItems.map((item, i) => {
      const rankStyle = i === 0 ? 'color:var(--color-accent);font-weight:700' : (i < 3 ? 'color:var(--color-text-sec);font-weight:700' : '');
      return `<tr><td class="num" style="${rankStyle}">${i + 1}</td><td class="td-name">${item.emoji || ''} ${item.name}</td><td class="num">${item.qty}x</td><td class="num highlight-cell">${fmtEur(item.revenue)}</td></tr>`;
    }).join('');

  } catch (err) {
    showToast(err.message || 'Chyba generovania Z-reportu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

async function printZReport() {
  const date = $('#zReportDate').value;
  if (!date) return;
  const btn = $('#btnPrintZReport');
  if (btn) btnLoading(btn);
  try {
    const res = await api.post('/print/z-report', { date });
    // Backend pri tlači uzávierky automaticky:
    //  (1) volá Portos /receipts/withdraw (fiškálny paragón výberu)
    //  (2) vytvorí cashflow_entry pre interný report
    // Tu kombinujeme oba výsledky do jedného toastu, aby operátor v jednom
    // toaste videl či sa Portos paragón fakticky vytlačil.
    var w = res && res.withdrawal;
    var pw = res && res.portosWithdraw;
    var amt = w && w.amount != null ? Number(w.amount).toFixed(2).replace('.', ',') + ' €' : '';
    if (w && w.reason === 'no_cash') {
      showToast('Z-report vytlačený. Žiadna hotovosť na výber.', true);
    } else if (pw && pw.ok) {
      // Najlepší scenár: Portos paragón aj cashflow OK
      showToast('Z-report vytlačený. Portos výber ' + amt + (pw.receiptId ? ' (' + pw.receiptId + ')' : '') + ' OK.', true);
    } else if (pw && !pw.ok && pw.skipped) {
      // Portos vypnutý — len cashflow zapísané
      showToast('Z-report vytlačený. Cashflow výber ' + amt + ' (Portos je vypnutý).', true);
    } else if (pw && !pw.ok) {
      // Portos zlyhal — cashflow OK, ale paragón treba ručne
      showToast('Z-report OK + cashflow ' + amt + '. ⚠ Portos paragón výberu zlyhal: ' + (pw.error || 'unknown') + ' — vytlač ručne.', 'warning');
    } else if (w && w.alreadyExists) {
      showToast('Z-report vytlačený. Výber už evidovaný (' + amt + ').', true);
    } else if (w && w.created) {
      showToast('Z-report vytlačený. Cashflow výber ' + amt + '.', true);
    } else {
      showToast('Z-report odoslany na tlaciaren', true);
    }
  } catch (err) {
    showToast('Chyba tlace: ' + err.message, 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

// ===== EXPORT =====
function exportCSV() {
  const activeTab = _container.querySelector('.tab-content.active');
  const table = activeTab.querySelector('.data-table');
  if (!table) return;
  const rows = [];
  // Header
  const headerCells = [];
  table.querySelectorAll('thead th').forEach(th => {
    headerCells.push('"' + th.textContent.trim().replace(/"/g, '""') + '"');
  });
  rows.push(headerCells.join(';'));
  // Body
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('td').forEach(td => {
      const val = td.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '""');
      cells.push('"' + val + '"');
    });
    rows.push(cells.join(';'));
  });
  // Footer
  const tfoot = table.querySelector('tfoot');
  if (tfoot) {
    tfoot.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach(td => {
        const val = td.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '""');
        cells.push('"' + val + '"');
      });
      rows.push(cells.join(';'));
    });
  }
  const csv = '\uFEFF' + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tabName = _container.querySelector('.tab-btn.active').dataset.tab;
  a.href = url;
  a.download = 'pos-report-' + tabName + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function exportAPI() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const format = $('#exportFormat').value;
  const token = api.getToken();
  const url = '/api/reports/export?from=' + from + '&to=' + to + '&format=' + format;
  const btn = $('#btnExportAPI');
  if (btn) btnLoading(btn);

  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    })
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'pos-export-' + from + '-' + to + '.' + format;
      a.click();
      URL.revokeObjectURL(blobUrl);
      showToast('Export stiahnuty', true);
    })
    .catch(err => showToast('Chyba exportu: ' + err.message, 'error'))
    .finally(() => { if (btn) btnReset(btn); });
}

// ===== BIND EVENTS =====
function bindEvents() {
  // Period buttons
  $$('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const dr = $('#dateRange');
      const ds = $('#dateSingle');
      // Two pickers are mutually exclusive — only one shows at a time
      dr.classList.toggle('visible', btn.dataset.period === 'custom');
      ds.classList.toggle('visible', btn.dataset.period === 'single');

      const dateFrom = $('#dateFrom');
      const dateTo = $('#dateTo');
      const dateSingle = $('#dateSingleInput');

      if (btn.dataset.period === 'today') {
        dateTo.value = todayStr();
        dateFrom.value = dateTo.value;
      } else if (btn.dataset.period === 'single') {
        // Default the picker to today on first reveal so the user can just
        // change it; if they previously picked a day, keep that selection.
        if (!dateSingle.value) dateSingle.value = todayStr();
        dateFrom.value = dateSingle.value;
        dateTo.value = dateSingle.value;
      } else if (btn.dataset.period === 'week') {
        dateTo.value = todayStr();
        dateFrom.value = weekAgoStr();
      } else if (btn.dataset.period === 'month') {
        dateTo.value = todayStr();
        dateFrom.value = monthStartStr();
      }
      if (btn.dataset.period !== 'custom') loadReports();
    });
  });

  // Single-day picker — sets both from and to to the chosen date so every
  // tab (Trzby, Produkty, Zamestnanci, Hodiny, Bar/Kuchyňa split) reflects
  // exactly that one calendar day.
  $('#dateSingleInput').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    $('#dateFrom').value = v;
    $('#dateTo').value = v;
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });

  // Custom date change
  $('#dateFrom').addEventListener('change', () => {
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });
  $('#dateTo').addEventListener('change', () => {
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });

  // Tab switching
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      _container.querySelector('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'cisnicky') loadStaffReport();
    });
  });

  // CSV Export
  $('#btnExport').addEventListener('click', exportCSV);

  // Export to accounting
  $('#btnExportAPI').addEventListener('click', exportAPI);

  // Z-report
  $('#btnGenZReport').addEventListener('click', generateZReport);
  $('#btnPrintZReport').addEventListener('click', printZReport);

  // Produkty tab — clickable column headers re-sort the cached dataset.
  // Single delegated listener on the table beats binding per-th and
  // survives if we ever re-render the thead.
  const produktyTable = $('#table-produkty');
  if (produktyTable) produktyTable.addEventListener('click', onProductHeaderClick);
}

// ===== TEMPLATE =====
const TEMPLATE = `
  <!-- FILTER BAR -->
  <div class="filter-bar">
    <div class="period-btns">
      <button class="period-btn" data-period="today">Dnes</button>
      <button class="period-btn" data-period="single">Vybra\u0165 de\u0148</button>
      <button class="period-btn active" data-period="week">Tento tyzden</button>
      <button class="period-btn" data-period="month">Tento mesiac</button>
      <button class="period-btn" data-period="custom">Vlastne obdobie</button>
    </div>
    <div class="date-single" id="dateSingle">
      <input type="date" class="date-input" id="dateSingleInput">
    </div>
    <div class="date-range" id="dateRange">
      <input type="date" class="date-input" id="dateFrom">
      <span class="date-sep">\u2014</span>
      <input type="date" class="date-input" id="dateTo">
    </div>
    <div class="filter-bar-actions">
      <select id="exportFormat" class="filter-select">
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
      <button class="btn-export" id="btnExportAPI">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export do uctovania
      </button>
      <button class="btn-export" id="btnExport">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Exportovat CSV
      </button>
    </div>
  </div>

  <!-- STAT CARDS -->
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-icon ice">
        <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Celkove trzby</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon lavender">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Pocet objednavok</div>
        <div class="stat-value">--</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon mint">
        <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Priemerny ucet</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon amber">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Trzby na zamestnanca</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <!-- Náklady na výrobu — sum recipe_qty × ingredient_cost over predaj.
         Položky bez receptu = 0 € (po dohode s prevádzkou). -->
    <div class="stat-card">
      <div class="stat-icon amber">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 3h18v4H3z"/><path d="M5 7v14h14V7"/><path d="M9 11h6"/><path d="M9 15h6"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Naklady na vyrobu</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <!-- Mzdy — clock_in→clock_out × hourly_rate. -->
    <div class="stat-card">
      <div class="stat-icon lavender">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Mzdy</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <!-- Výsledok = Tržby − Výroba − Mzdy. Hospodársky výsledok pred ostat-
         nými nákladmi (energie, nájom, prac. ochranné). Zelená/červená farba
         sa nastavuje v renderStats(). -->
    <div class="stat-card">
      <div class="stat-icon mint">
        <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Vysledok</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
  </div>

  <!-- TABS -->
  <div class="tabs">
    <button class="tab-btn active" data-tab="trzby">Trzby</button>
    <button class="tab-btn" data-tab="produkty">Produkty</button>
    <button class="tab-btn" data-tab="zamestnanci">Zamestnanci</button>
    <button class="tab-btn" data-tab="cisnicky">Cisnicky</button>
    <button class="tab-btn" data-tab="hodiny">Hodiny</button>
    <button class="tab-btn" data-tab="uzavierka">Uzavierka</button>
  </div>

  <!-- TAB: TRZBY -->
  <div class="tab-content active" id="tab-trzby">
    <div class="stat-grid" id="destSplit" style="margin-bottom:18px"></div>
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="table-trzby">
        <thead>
          <tr>
            <th>Dátum</th>
            <th>Obj.</th>
            <th>Tržby</th>
            <th>Výroba</th>
            <th>Mzdy</th>
            <th>Výsledok</th>
            <th>Priem. účet</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="7" class="td-empty">Načítavam…</td></tr>
        </tbody>
        <tfoot></tfoot>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: PRODUKTY -->
  <div class="tab-content" id="tab-produkty">
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table sortable-table" id="table-produkty">
        <thead>
          <tr>
            <th>Poradie</th>
            <th class="sortable-th" data-sort-col="name">Produkt <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="category">Kategória <span class="sort-arrow"></span></th>
            <th class="sortable-th sort-active" data-sort-col="qty">Predaných ks <span class="sort-arrow">▼</span></th>
            <th class="sortable-th" data-sort-col="revenue">Tržby <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="cogs">Výroba <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="profit">Výsledok <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="pct">% z celku <span class="sort-arrow"></span></th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="8" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: ZAMESTNANCI -->
  <div class="tab-content" id="tab-zamestnanci">
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="table-zamestnanci">
        <thead>
          <tr>
            <th>Meno</th>
            <th>Zmeny</th>
            <th>Objednávky</th>
            <th>Tržby</th>
            <th>Priem. účet</th>
            <th>Hodnotenie</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: CISNICKY -->
  <div class="tab-content" id="tab-cisnicky">
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-subtitle">Vykon cisnikov</div>
      <div id="staffBars" class="staff-bars-container"></div>
    </div>
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="table-cisnicky">
        <thead>
          <tr>
            <th>Meno</th>
            <th>Rola</th>
            <th>Objednávky</th>
            <th>Položky</th>
            <th>Tržby</th>
            <th>Priem. účet</th>
            <th>Hotovosť</th>
            <th>Karta</th>
            <th>Storná</th>
          </tr>
        </thead>
        <tbody id="staffTableBody">
          <tr><td colspan="9" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: HODINY -->
  <div class="tab-content" id="tab-hodiny">
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="table-hodiny">
        <thead>
          <tr>
            <th>Hodina</th>
            <th>Obj.</th>
            <th>Bar</th>
            <th>Kuchyňa</th>
            <th>Spolu</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
        </tbody>
        <tfoot></tfoot>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: UZAVIERKA -->
  <div class="tab-content" id="tab-uzavierka">
    <div class="z-report-bar">
      <label class="z-report-label">Datum:</label>
      <input type="date" class="date-input" id="zReportDate">
      <button class="btn-outline-accent" id="btnGenZReport">
        <svg aria-hidden="true" viewBox="0 0 24 24" style="width:14px;height:14px"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        Generovat Z-report
      </button>
      <button class="btn-outline-accent" id="btnPrintZReport">
        <svg aria-hidden="true" viewBox="0 0 24 24" style="width:14px;height:14px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Tlacit Z-report
      </button>
    </div>

    <div id="zReportContent" style="display:none">
      <div class="stat-grid grid-3col">
        <div class="stat-card">
          <div class="stat-icon ice">
            <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Celkove trzby</div>
            <div class="stat-value" id="zTotalRevenue">--</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon lavender">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Objednavky / Polozky</div>
            <div class="stat-value" id="zOrdersItems">--</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon mint">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          </div>
          <div class="stat-info">
            <div class="stat-label">Priemerna objednavka</div>
            <div class="stat-value" id="zAvgOrder">--</div>
          </div>
        </div>
      </div>

      <div class="grid-2col">
        <div class="panel">
          <div class="panel-subtitle">Platobne metody</div>
          <div id="zPaymentMethods"></div>
        </div>
        <div class="panel">
          <div class="panel-subtitle">Storna</div>
          <div id="zCancelled" class="loading-placeholder">--</div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:16px">
        <div class="panel-subtitle">Kategórie</div>
        <div class="table-scroll-wrap">
        <table class="data-table" id="zCategoryTable">
          <thead>
            <tr>
              <th>Kategória</th>
              <th>Tržby</th>
              <th>Počet</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-subtitle">Top 10 položky</div>
        <div class="table-scroll-wrap">
        <table class="data-table" id="zTopItemsTable">
          <thead>
            <tr>
              <th>#</th>
              <th>Položka</th>
              <th>Počet</th>
              <th>Tržby</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        </div>
      </div>
    </div>
  </div>
`;

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;

  // Set default dates
  $('#dateFrom').value = weekAgoStr();
  $('#dateTo').value = todayStr();
  $('#zReportDate').value = todayStr();

  bindEvents();
  loadReports();
}

export function destroy() {
  _container = null;
  _lastZData = null;
  _lastProductsData = null;
  _productSort = { col: 'qty', dir: 'desc' };
}
