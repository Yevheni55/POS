// Reports page module
import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _lastZData = null;
// Produkty tab sorting — clicking any column header re-sorts client-side
// so the cashier can pick "predalo sa najmenej" or "abecedne" without a
// new request. Default mirrors the natural rank: qty descending.
let _productSort = { col: 'qty', dir: 'desc' };
let _lastProductsData = null;
// Filter Produkty tabu na dest = 'all' | 'kuchyna' | 'bar'. Aplikovany pred
// sortovanim, takze reset zachova zvolene poradie. _productByDayLimit
// controluje kolko top-N items zobrazi v pivot tabulke (vacsie N = vacsia
// tabulka, viac scroll, ale viac videnia).
let _productDestFilter = 'all';
let _productByDayLimit = 20;

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
      renderLaborByStaff(data);
      renderStaffMealByPerson(data);
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
  // The 8-card grid is rendered top-to-bottom: 4 sales KPIs (Trzby, Pocet,
  // Priemerny ucet, Trzby/zam), then 4 hospodársky-výsledok cards (Vyroba,
  // Mzdy, Zam.spotreba, Vysledok). Values flow into them by index because
  // the existing template binds via .stat-value class (no IDs).
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
  // Zamestnanecka spotreba — naklad na suroviny pre staff meals (write_offs
  // s reason='staff_meal'). Server už vie agregovať per period.
  if (data.totalStaffMeal !== undefined && statValues[6]) {
    statValues[6].innerHTML = fmtEur(data.totalStaffMeal);
  }
  // Výsledok = Tržby − Výroba − Mzdy − Zam.spotreba. Farebne zvýrazníme:
  // zelená pre +, červená pre −, šedá pre 0 — operátor potrebuje na prvý
  // pohľad vidieť či je deň/mesiac v pluse.
  if (data.totalProfit !== undefined && statValues[7]) {
    const v = Number(data.totalProfit) || 0;
    const color = v > 0 ? 'var(--color-success, #22c55e)'
                : v < 0 ? 'var(--color-danger, #ef4444)'
                : 'var(--color-text-sec, #94a3b8)';
    statValues[7].innerHTML = '<span style="color:' + color + '">' + fmtEur(v) + '</span>';
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
      <td class="num text-right">${data.totalOrders || ''}</td>
      <td class="num text-right color-accent">${fmtEur(data.totalRevenue)}</td>
      <td class="num text-right">${data.totalCogs !== undefined ? fmtEur(data.totalCogs) : ''}</td>
      <td class="num text-right">${data.totalLabor !== undefined ? fmtEur(data.totalLabor) : ''}</td>
      <td class="num text-right" style="font-weight:700;color:${tProfitColor}">${data.totalProfit !== undefined ? fmtEur(tProfit) : ''}</td>
      <td class="num text-right">${data.avgCheck !== undefined ? fmtEur(data.avgCheck) : ''}</td>
    </tr>`;
  }
}

// Mzdy podla zamestnancov — paired clock_in -> clock_out × hourly_rate.
// Skryje cely panel ked nie su data (napr. obdobie bez zmien).
function renderLaborByStaff(data) {
  const panel = $('#laborByStaffPanel');
  if (!panel) return;
  const rows = (data && Array.isArray(data.laborByStaff)) ? data.laborByStaff : [];
  if (!rows.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const tbody = $('#table-labor-staff tbody');
  const tfoot = $('#table-labor-staff tfoot');
  if (!tbody || !tfoot) return;

  function fmtHours(h) {
    const total = Number(h) || 0;
    const hh = Math.floor(total);
    const mm = Math.round((total - hh) * 60);
    return hh + 'h ' + String(mm).padStart(2, '0') + 'm';
  }

  let totalShifts = 0;
  let totalHours = 0;
  let totalLabor = 0;
  tbody.innerHTML = rows.map(r => {
    const hours = Number(r.hours) || 0;
    const labor = Number(r.labor) || 0;
    const rate = Number(r.hourlyRate) || 0;
    const shifts = Number(r.shifts) || 0;
    totalShifts += shifts;
    totalHours += hours;
    totalLabor += labor;
    return `<tr>
      <td class="td-name">${escapeHtml(r.name || '--')}</td>
      <td>${escapeHtml(r.position) || '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right">${shifts}</td>
      <td class="num text-right">${fmtHours(hours)}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${rate > 0 ? fmtEur(rate) + '/h' : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(labor)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td colspan="2">Spolu</td>
    <td class="num text-right">${totalShifts}</td>
    <td class="num text-right">${fmtHours(totalHours)}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">—</td>
    <td class="num text-right" style="font-weight:var(--weight-bold);color:var(--color-accent, #8b7cf6)">${fmtEur(totalLabor)}</td>
  </tr>`;
}

// Zamestnanecka spotreba podla mena (= meno stola v zone Zamestanci).
// Naklad rozdeleny na jedlo (kuchyna) a napoje (bar) cez category.dest —
// owner vidi ze napr. Yevhen ide hlavne na napoje (kola), Tania na jedlo.
// Skryje cely panel ak nie su data — vacsina periodov ma 0 staff meals,
// nechceme prazdny panel mast vizual.
function renderStaffMealByPerson(data) {
  const panel = $('#staffMealPanel');
  if (!panel) return;
  const rows = (data && Array.isArray(data.staffMealByPerson)) ? data.staffMealByPerson : [];
  if (!rows.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const tbody = $('#table-staff-meal tbody');
  const tfoot = $('#table-staff-meal tfoot');
  if (!tbody || !tfoot) return;

  let totalMeals = 0;
  let totalFood = 0;
  let totalDrink = 0;
  let totalCost = 0;
  let totalMenuValue = 0;
  tbody.innerHTML = rows.map(r => {
    const meals = Number(r.meals) || 0;
    const food = Number(r.foodCost) || 0;
    const drink = Number(r.drinkCost) || 0;
    const cost = Number(r.cost) || 0;
    const menuValue = Number(r.menuValue) || 0;
    totalMeals += meals;
    totalFood += food;
    totalDrink += drink;
    totalCost += cost;
    totalMenuValue += menuValue;
    return `<tr>
      <td class="td-name">${escapeHtml(r.name || '--')}</td>
      <td class="num text-right">${meals}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${food > 0 ? fmtEur(food) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${drink > 0 ? fmtEur(drink) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(cost)}</td>
      <td class="num text-right" style="color:var(--color-text)" title="Koľko by zaplatil zákazník">${fmtEur(menuValue)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td>Spolu</td>
    <td class="num text-right">${totalMeals}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(totalFood)}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(totalDrink)}</td>
    <td class="num text-right" style="font-weight:var(--weight-bold);color:var(--accent-amber, #f59e0b)">${fmtEur(totalCost)}</td>
    <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(totalMenuValue)}</td>
  </tr>`;
}

function renderProdukty(data) {
  const tbody = $('#table-produkty tbody');
  if (!tbody) return;
  // Cache the dataset so a header-click can re-render without a new request.
  _lastProductsData = data;
  updateProductHeaderArrows();
  updateProductFilterStats();
  if (!data.products || !data.products.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    renderProductsByDay(data);
    return;
  }
  // Apply dest filter BEFORE sorting — operator filtruje pred sort-om
  // (logická poradie: výber zóny → poradie v rámci zóny).
  const filtered = (data.products || []).filter(p => {
    if (_productDestFilter === 'all') return true;
    return (p.dest || 'bar') === _productDestFilter;
  });
  if (!filtered.length) {
    const filterLabel = _productDestFilter === 'kuchyna' ? 'kuchyňa' : 'bar';
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Žiadne predaje v zóne ' + filterLabel + ' za toto obdobie</td></tr>';
    renderProductsByDay(data);
    return;
  }
  const sorted = filtered.slice().sort(productComparator(_productSort));
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
    // Dest pill — visual ukazovatel zony (kuchyna vs bar) pri kazdom riadku
    const dest = p.dest || 'bar';
    const destPill = dest === 'kuchyna'
      ? '<span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:6px;background:rgba(217,119,6,.12);color:#92400e;margin-left:6px;letter-spacing:.02em">🍳 KUCH</span>'
      : '<span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:6px;background:rgba(99,102,241,.12);color:#4338ca;margin-left:6px;letter-spacing:.02em">🍹 BAR</span>';
    const categoryCell = (p.category || '') + (_productDestFilter === 'all' ? destPill : '');
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
      <td>${categoryCell}</td>
      <td class="num">${p.qty}</td>
      <td class="num highlight-cell">${fmtEur(p.revenue)}</td>
      <td class="num">${fmtEur(cogs)}</td>
      <td class="num" style="font-weight:700;color:${profitColor}">${fmtEur(profit)}</td>
      <td><div class="progress-wrap"><div class="progress-fill" style="width:${barW}%"></div></div>${pct}%</td>
    </tr>`;
  }).join('');

  renderProductsByDay(data);
}

// Update filter chip stats — kazdy chip ma "(N)" suffix s poctom produktov
// v tej zone. Pomaha rychlo vidiet kolko polozk je v kuchyni vs bare.
function updateProductFilterStats() {
  if (!_container || !_lastProductsData) return;
  const all = (_lastProductsData.products || []).length;
  const kuch = (_lastProductsData.products || []).filter(p => (p.dest || 'bar') === 'kuchyna').length;
  const bar = (_lastProductsData.products || []).filter(p => (p.dest || 'bar') === 'bar').length;
  // Sum qty + revenue per filter for the badge under chips
  function sumFor(dest) {
    const items = (_lastProductsData.products || []).filter(p => dest === 'all' || (p.dest || 'bar') === dest);
    const q = items.reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const r = items.reduce((s, p) => s + (Number(p.revenue) || 0), 0);
    return { q, r };
  }
  const stat = sumFor(_productDestFilter);
  const chipAll = _container.querySelector('#chipDestAll .chip-count');
  const chipKuch = _container.querySelector('#chipDestKuch .chip-count');
  const chipBar = _container.querySelector('#chipDestBar .chip-count');
  if (chipAll) chipAll.textContent = '(' + all + ')';
  if (chipKuch) chipKuch.textContent = '(' + kuch + ')';
  if (chipBar) chipBar.textContent = '(' + bar + ')';
  const filterStats = _container.querySelector('#productFilterStats');
  if (filterStats) {
    const filterLabel = _productDestFilter === 'all' ? 'Všetko'
                      : _productDestFilter === 'kuchyna' ? '🍳 Kuchyňa'
                      : '🍹 Bar';
    filterStats.innerHTML = '<strong>' + filterLabel + ':</strong> '
      + stat.q + ' ks · <strong>' + fmtEur(stat.r) + '</strong>';
  }
  // Toggle active state on chips
  ['chipDestAll', 'chipDestKuch', 'chipDestBar'].forEach(id => {
    const el = _container.querySelector('#' + id);
    if (!el) return;
    const matches = (id === 'chipDestAll' && _productDestFilter === 'all')
                 || (id === 'chipDestKuch' && _productDestFilter === 'kuchyna')
                 || (id === 'chipDestBar' && _productDestFilter === 'bar');
    el.classList.toggle('chip-active', matches);
  });
}

// Per-day pivot — items v riadkoch, dni v stlpcoch. Cellka = qty pre (item,
// day). Pomaha managerovi vidiet "ako sa burgery hybali za tyzden". Top-N
// items podla total qty (po filtri kuchyna/bar/vsetko). Prazdne dni stale
// zobrazujeme aby trend bol vizualne kontinuálny.
function renderProductsByDay(data) {
  const host = $('#productsByDayHost');
  if (!host) return;
  const rows = (data && Array.isArray(data.productsByDay)) ? data.productsByDay : [];
  if (!rows.length) {
    host.innerHTML = '<div class="empty-hint" style="padding:14px">Žiadne predaje za toto obdobie.</div>';
    return;
  }
  // Filter pred pivotom (same filter ako tabulka vyssie)
  const filtered = rows.filter(r => {
    if (_productDestFilter === 'all') return true;
    return (r.dest || 'bar') === _productDestFilter;
  });
  if (!filtered.length) {
    host.innerHTML = '<div class="empty-hint" style="padding:14px">Žiadne predaje pre tento filter.</div>';
    return;
  }
  // Build pivot: pivotMap[name] = { dest, total, days: {date: qty} }
  const pivotMap = {};
  const dateSet = new Set();
  for (const r of filtered) {
    if (!pivotMap[r.name]) pivotMap[r.name] = { name: r.name, dest: r.dest || 'bar', total: 0, days: {} };
    pivotMap[r.name].days[r.date] = (pivotMap[r.name].days[r.date] || 0) + (Number(r.qty) || 0);
    pivotMap[r.name].total += Number(r.qty) || 0;
    dateSet.add(r.date);
  }
  const dates = Array.from(dateSet).sort();
  const items = Object.values(pivotMap).sort((a, b) => b.total - a.total).slice(0, _productByDayLimit);

  // Format date header: '26.5' (SK short) — kratke aby sa zmestilo viac stlpcov
  function shortDate(iso) {
    const parts = iso.split('-'); // [yyyy, mm, dd]
    return parseInt(parts[2], 10) + '.' + parseInt(parts[1], 10) + '.';
  }

  let html = '<div class="table-scroll-wrap"><table class="data-table" style="font-size:13px">';
  html += '<thead><tr>';
  html += '<th>Položka</th>';
  for (const d of dates) {
    html += '<th class="text-right" title="' + d + '">' + shortDate(d) + '</th>';
  }
  html += '<th class="text-right" style="background:rgba(184,84,42,.05)">Σ</th>';
  html += '</tr></thead>';

  // Find max qty across all cells for color intensity
  let maxCell = 0;
  for (const it of items) {
    for (const d of dates) {
      const v = it.days[d] || 0;
      if (v > maxCell) maxCell = v;
    }
  }

  html += '<tbody>';
  for (const it of items) {
    const destPill = it.dest === 'kuchyna'
      ? '<span style="display:inline-block;font-size:9px;font-weight:600;padding:1px 5px;border-radius:5px;background:rgba(217,119,6,.12);color:#92400e;margin-right:5px;vertical-align:middle">🍳</span>'
      : '<span style="display:inline-block;font-size:9px;font-weight:600;padding:1px 5px;border-radius:5px;background:rgba(99,102,241,.12);color:#4338ca;margin-right:5px;vertical-align:middle">🍹</span>';
    html += '<tr>';
    html += '<td class="td-name">' + destPill + escapeHtml(it.name) + '</td>';
    for (const d of dates) {
      const q = it.days[d] || 0;
      if (q === 0) {
        html += '<td class="num text-right" style="color:var(--color-text-dim)">·</td>';
      } else {
        // Heat color: viac qty = intenzivnejsie pozadie
        const intensity = maxCell > 0 ? (q / maxCell) : 0;
        const bg = 'rgba(184,84,42,' + (0.06 + intensity * 0.22).toFixed(3) + ')';
        const fw = intensity > 0.7 ? '700' : intensity > 0.4 ? '600' : '500';
        html += '<td class="num text-right" style="background:' + bg + ';font-weight:' + fw + '">' + q + '</td>';
      }
    }
    html += '<td class="num text-right" style="background:rgba(184,84,42,.05);font-weight:700">' + it.total + '</td>';
    html += '</tr>';
  }
  // Sum row na konci — vertikalny total per den
  html += '</tbody><tfoot><tr>';
  html += '<td><strong>Spolu</strong></td>';
  let grandTotal = 0;
  for (const d of dates) {
    let colSum = 0;
    for (const it of items) colSum += (it.days[d] || 0);
    grandTotal += colSum;
    html += '<td class="num text-right"><strong>' + colSum + '</strong></td>';
  }
  html += '<td class="num text-right" style="background:rgba(184,84,42,.08)"><strong>' + grandTotal + '</strong></td>';
  html += '</tr></tfoot></table></div>';

  // Hint pod tabulkou
  const totalItems = Object.keys(pivotMap).length;
  if (totalItems > _productByDayLimit) {
    html += '<div style="margin-top:8px;font-size:12px;color:var(--color-text-sec);text-align:right">'
      + 'Zobrazený top ' + _productByDayLimit + ' z ' + totalItems + ' položiek. '
      + 'Klik "Všetko" zobrazí kompletný zoznam.</div>';
  }

  host.innerHTML = html;
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
  return doZReport(false);
}

async function digitalZReport() {
  const date = $('#zReportDate').value;
  if (!date) return;
  // Bez potvrdenia? Digitálna uzávierka nemá fiškálny dopad (Portos paragón
  // výberu sa nevystaví) — ale ide o uzávierku dňa. Spýtaj sa pred odoslaním.
  if (typeof showConfirm === 'function') {
    showConfirm(
      'Digitálna uzávierka',
      'Uzávierka sa zapíše do cashflow BEZ vytlačenia papiera. Portos paragón výberu (fiškálny doklad) sa NEVYTVORÍ. Pre fiškálnu kompletnosť pokladne treba neskôr buď vytlačiť uzávierku, alebo manuálne registrovať výber v Portos.',
      function () { doZReport(true); },
      { type: 'info', confirmText: 'Pokračovať bez papiera' }
    );
  } else {
    doZReport(true);
  }
}

async function doZReport(digital) {
  const date = $('#zReportDate').value;
  if (!date) return;
  const btn = $(digital ? '#btnDigitalZReport' : '#btnPrintZReport');
  if (btn) btnLoading(btn);
  try {
    const res = await api.post('/print/z-report', { date, digital: !!digital });
    // Backend pri tlači uzávierky automaticky:
    //  (1) volá Portos /receipts/withdraw (fiškálny paragón výberu)
    //  (2) vytvorí cashflow_entry pre interný report
    // Tu kombinujeme oba výsledky do jedného toastu, aby operátor v jednom
    // toaste videl či sa Portos paragón fakticky vytlačil.
    var w = res && res.withdrawal;
    var pw = res && res.portosWithdraw;
    var amt = w && w.amount != null ? fmtCost(w.amount) + ' €' : '';
    var prefix = digital ? 'Digitálna uzávierka' : 'Z-report vytlačený';
    if (w && w.reason === 'no_cash') {
      showToast(prefix + '. Žiadna hotovosť na výber.', true);
    } else if (digital && w && (w.created || w.alreadyExists)) {
      // Digital mode — Portos paragón sa neprerváša
      showToast(prefix + '. Cashflow výber ' + amt + '. Portos paragón výberu NEvytvorený (bez papiera).', true);
    } else if (pw && pw.ok) {
      // Najlepší scenár: Portos paragón aj cashflow OK
      showToast(prefix + '. Portos výber ' + amt + (pw.receiptId ? ' (' + pw.receiptId + ')' : '') + ' OK.', true);
    } else if (pw && !pw.ok && pw.skipped) {
      // Portos vypnutý — len cashflow zapísané
      showToast(prefix + '. Cashflow výber ' + amt + ' (Portos je vypnutý).', true);
    } else if (pw && !pw.ok) {
      // Portos zlyhal — cashflow OK, ale paragón treba ručne
      showToast(prefix + ' + cashflow ' + amt + '. ⚠ Portos paragón výberu zlyhal: ' + (pw.error || 'unknown') + ' — vytlač ručne.', 'warning');
    } else if (w && w.alreadyExists) {
      showToast(prefix + '. Výber už evidovaný (' + amt + ').', true);
    } else if (w && w.created) {
      showToast(prefix + '. Cashflow výber ' + amt + '.', true);
    } else {
      showToast(digital ? 'Digitálna uzávierka zaznamenaná.' : 'Z-report odoslany na tlaciaren', true);
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
  var digBtn = $('#btnDigitalZReport');
  if (digBtn) digBtn.addEventListener('click', digitalZReport);

  // Produkty tab — clickable column headers re-sort the cached dataset.
  // Single delegated listener on the table beats binding per-th and
  // survives if we ever re-render the thead.
  const produktyTable = $('#table-produkty');
  if (produktyTable) produktyTable.addEventListener('click', onProductHeaderClick);

  // Dest filter chips — toggle medzi all/kuchyna/bar. Re-render produkty
  // tabuľky + per-day pivotu. Bez API requestu, pracujeme s cache-om.
  const chipMap = {
    'chipDestAll': 'all',
    'chipDestKuch': 'kuchyna',
    'chipDestBar': 'bar',
  };
  Object.keys(chipMap).forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('click', () => {
      _productDestFilter = chipMap[id];
      if (_lastProductsData) renderProdukty(_lastProductsData);
    });
  });
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
    <!-- Zamestnanecka spotreba — naklad na suroviny pre staff meals
         uzatvorene cez "Pre zamestnanca" v zone Zamestanci. Nepride do
         Trzieb (ziadna platba), ale ide z Vysledku ako naklad firmy. -->
    <div class="stat-card">
      <div class="stat-icon amber">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/></svg>
      </div>
      <div class="stat-info">
        <div class="stat-label">Zam. spotreba</div>
        <div class="stat-value">-- &euro;</div>
      </div>
    </div>
    <!-- Výsledok = Tržby − Výroba − Mzdy − Zam. spotreba. Hospodársky
         výsledok pred ostatnými nákladmi (energie, nájom, prac. ochranné).
         Zelená/červená farba sa nastavuje v renderStats(). -->
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
            <th class="text-right">Obj.</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Výroba</th>
            <th class="text-right">Mzdy</th>
            <th class="text-right">Výsledok</th>
            <th class="text-right">Priem. účet</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="7" class="td-empty">Načítavam…</td></tr>
        </tbody>
        <tfoot></tfoot>
      </table>
      </div>
    </div>

    <!-- Mzdy podla zamestnancov — viditelny len ked > 0. Renderuje sa
         cez renderLaborByStaff() z dat.laborByStaff. -->
    <div class="panel" id="laborByStaffPanel" style="display:none;margin-top:18px">
      <div class="panel-title">Mzdy podľa zamestnancov</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">
        odpracované hodiny × hodinová sadzba — len uzavreté zmeny (clock_in → clock_out) v tomto období
      </div>
      <div class="table-scroll-wrap">
        <table class="data-table" id="table-labor-staff">
          <thead>
            <tr>
              <th>Meno</th>
              <th>Pozícia</th>
              <th class="text-right">Smeny</th>
              <th class="text-right">Hodiny</th>
              <th class="text-right">Sadzba</th>
              <th class="text-right">Mzda</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
    </div>

    <!-- Zamestnanecka spotreba podla mena — viditelny len ked total > 0.
         Renderuje sa cez renderStaffMealByPerson() z dat.staffMealByPerson.
         Naklad rozdeleny na jedlo (kuchyna) vs napoje (bar) cez category.dest. -->
    <div class="panel" id="staffMealPanel" style="display:none;margin-top:18px">
      <div class="panel-title">Zamestnanecká spotreba podľa mena</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">
        atribúcia podľa mena stola v zóne Zamestanci (Alex / Oleh / Tania / Yevhen…) — náklad firmy na jedlo + nápoje zamestnanca
      </div>
      <div class="table-scroll-wrap">
        <table class="data-table" id="table-staff-meal">
          <thead>
            <tr>
              <th>Meno</th>
              <th class="text-right">Pocet</th>
              <th class="text-right">Jedlo (kuchyňa)</th>
              <th class="text-right">Nápoje (bar)</th>
              <th class="text-right">Náklad spolu</th>
              <th class="text-right" title="Hodnota benefitu — koľko by zákazník zaplatil za rovnaké položky">Cena na predaj</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB: PRODUKTY -->
  <div class="tab-content" id="tab-produkty">
    <!-- Dest filter chips — triedi tabulku produktov na vsetko/kuchyna/bar.
         Pomaha managerovi rychlo videt "len kuchyna" alebo "len bar" bez
         scrollovania zmiesanym zoznamom. Style: vlozenne inline aby sa zladil
         s ostatnymi pages bez extra CSS edit-u. -->
    <div class="panel" style="margin-bottom:14px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--color-text-sec);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Filter zóny:</div>
        <button type="button" id="chipDestAll" class="filter-chip chip-active"
          style="cursor:pointer;padding:7px 14px;border-radius:999px;border:1px solid var(--color-border);background:transparent;font-size:13px;font-weight:600;transition:all .15s">
          Všetko <span class="chip-count" style="opacity:.6;font-weight:500">(0)</span>
        </button>
        <button type="button" id="chipDestKuch" class="filter-chip"
          style="cursor:pointer;padding:7px 14px;border-radius:999px;border:1px solid var(--color-border);background:transparent;font-size:13px;font-weight:600;transition:all .15s">
          🍳 Kuchyňa <span class="chip-count" style="opacity:.6;font-weight:500">(0)</span>
        </button>
        <button type="button" id="chipDestBar" class="filter-chip"
          style="cursor:pointer;padding:7px 14px;border-radius:999px;border:1px solid var(--color-border);background:transparent;font-size:13px;font-weight:600;transition:all .15s">
          🍹 Bar <span class="chip-count" style="opacity:.6;font-weight:500">(0)</span>
        </button>
        <div id="productFilterStats" style="margin-left:auto;font-size:13px;color:var(--color-text-sec)"></div>
      </div>
    </div>

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

    <!-- Per-day pivot — burgers per day per day matrix. Filter (kuchyna/bar)
         zdielany s tabulkou nad. Top-N items, heat-map farby pre rychlu
         identifikaciu peak dni. -->
    <div class="panel" style="margin-top:18px">
      <div class="panel-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
        <span>Predaj za deň</span>
        <span style="font-size:12px;font-weight:400;color:var(--color-text-sec);margin-left:6px">koľko kusov sa predalo každý deň · top ${_productByDayLimit}</span>
      </div>
      <div id="productsByDayHost"></div>
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
            <th class="text-right">Zmeny</th>
            <th class="text-right">Objednávky</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Priem. účet</th>
            <th class="text-right">Hodnotenie</th>
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
            <th class="text-right">Objednávky</th>
            <th class="text-right">Položky</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Priem. účet</th>
            <th class="text-right">Hotovosť</th>
            <th class="text-right">Karta</th>
            <th class="text-right">Storná</th>
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
            <th class="text-right">Obj.</th>
            <th class="text-right">Bar</th>
            <th class="text-right">Kuchyňa</th>
            <th class="text-right">Spolu</th>
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
      <button class="btn-outline-accent" id="btnDigitalZReport" title="Bez tlače papiera. Cashflow zápis prebehne, Portos paragón výberu sa nevytvorí.">
        <svg aria-hidden="true" viewBox="0 0 24 24" style="width:14px;height:14px"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Digitálna uzávierka
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
              <th class="text-right">Tržby</th>
              <th class="text-right">Počet</th>
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
              <th class="text-right">#</th>
              <th>Položka</th>
              <th class="text-right">Počet</th>
              <th class="text-right">Tržby</th>
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

  // Active-state styling pre filter chips. Inline aby sme nemuseli upravovat
  // admin.css — page-scoped <style> bude existovat len pocas zivota tejto
  // stranky a destroy() innerHTML reset ho vycisti.
  if (!document.getElementById('reports-chip-style')) {
    const st = document.createElement('style');
    st.id = 'reports-chip-style';
    st.textContent =
      '.filter-chip:hover{background:var(--color-bg-hover) !important;border-color:var(--color-text-sec) !important}'
      + '.filter-chip.chip-active{background:var(--color-accent, #B85C2A) !important;color:#fff !important;border-color:transparent !important}'
      + '.filter-chip.chip-active .chip-count{color:rgba(255,255,255,.75) !important;opacity:1 !important}';
    document.head.appendChild(st);
  }

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
  _productDestFilter = 'all';
}
