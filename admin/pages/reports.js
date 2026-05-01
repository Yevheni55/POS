// Reports page module
let _container = null;
let _lastZData = null;

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
  const emptyHtml = '<tr><td colspan="5" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const trzbyBody = $('#table-trzby tbody');
  if (trzbyBody) trzbyBody.innerHTML = emptyHtml;
  const produktyBody = $('#table-produkty tbody');
  if (produktyBody) produktyBody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const zamBody = $('#table-zamestnanci tbody');
  if (zamBody) zamBody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
  const hodBody = $('#table-hodiny tbody');
  if (hodBody) hodBody.innerHTML = emptyHtml;
}

function renderStats(data) {
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
}

function renderTrzby(data) {
  const tbody = $('#table-trzby tbody');
  if (!tbody) return;
  if (!data.daily || !data.daily.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  tbody.innerHTML = data.daily.map(d =>
    `<tr>
      <td>${d.date}</td>
      <td class="num">${d.orders}</td>
      <td class="num highlight-cell">${fmtEur(d.revenue)}</td>
      <td class="num">${fmtEur(d.avgCheck)}</td>
      <td>${d.peakHours || ''}</td>
    </tr>`
  ).join('');

  const tfoot = $('#table-trzby tfoot');
  if (tfoot && data.totalRevenue !== undefined) {
    tfoot.innerHTML = `<tr>
      <td>Spolu</td>
      <td>${data.totalOrders || ''}</td>
      <td class="color-accent">${fmtEur(data.totalRevenue)}</td>
      <td>${data.avgCheck !== undefined ? fmtEur(data.avgCheck) : ''}</td>
      <td></td>
    </tr>`;
  }
}

function renderProdukty(data) {
  const tbody = $('#table-produkty tbody');
  if (!tbody) return;
  if (!data.products || !data.products.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  const maxRev = Math.max(...data.products.map(p => p.revenue));
  tbody.innerHTML = data.products.map((p, i) => {
    const pct = maxRev > 0 ? Math.round((p.revenue / (data.totalRevenue || maxRev)) * 1000) / 10 : 0;
    const barW = maxRev > 0 ? Math.round((p.revenue / maxRev) * 100) : 0;
    let rankStyle = '';
    if (i === 0) rankStyle = 'color:var(--color-accent);font-weight:700';
    else if (i === 1) rankStyle = 'color:var(--color-text-sec);font-weight:700';
    else if (i === 2) rankStyle = 'color:rgba(205,127,50,.7);font-weight:700';
    return `<tr>
      <td class="num" style="${rankStyle}">${i + 1}</td>
      <td class="td-name">${p.name}</td>
      <td>${p.category || ''}</td>
      <td class="num">${p.qty}</td>
      <td class="num highlight-cell">${fmtEur(p.revenue)}</td>
      <td><div class="progress-wrap"><div class="progress-fill" style="width:${barW}%"></div></div>${pct}%</td>
    </tr>`;
  }).join('');
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
    tbody.innerHTML = '<tr><td colspan="4" class="td-empty">Ziadne dáta pre toto obdobie</td></tr>';
    return;
  }
  // Peak detection still uses the per-hour share of the period's busiest
  // hour (>= 85% of max orders) so the cashier can spot rush hours, but
  // the dedicated "Obsadenosť %" column with the progress bar was removed
  // — the Tržby column carries the same information and the bar was
  // visually heavy. PEAK badge stays as a compact rush indicator.
  const maxOrders = Math.max(...data.hourly.map(h => h.orders));
  tbody.innerHTML = data.hourly.map(h => {
    const pct = maxOrders > 0 ? Math.round((h.orders / maxOrders) * 100) : 0;
    const isPeak = pct >= 85;
    return `<tr${isPeak ? ' class="peak-row"' : ''}>
      <td class="num">${h.hour}</td>
      <td class="num">${h.orders}</td>
      <td class="num${isPeak ? ' highlight-cell' : ''}">${fmtEur(h.revenue)}</td>
      <td>${isPeak ? '<span class="peak-badge">PEAK</span>' : ''}</td>
    </tr>`;
  }).join('');
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
    await api.post('/print/z-report', { date });
    showToast('Z-report odoslany na tlaciaren', true);
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
      dr.classList.toggle('visible', btn.dataset.period === 'custom');

      const dateFrom = $('#dateFrom');
      const dateTo = $('#dateTo');
      dateTo.value = todayStr();

      if (btn.dataset.period === 'today') {
        dateFrom.value = dateTo.value;
      } else if (btn.dataset.period === 'week') {
        dateFrom.value = weekAgoStr();
      } else if (btn.dataset.period === 'month') {
        dateFrom.value = monthStartStr();
      }
      if (btn.dataset.period !== 'custom') loadReports();
    });
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
}

// ===== TEMPLATE =====
const TEMPLATE = `
  <!-- FILTER BAR -->
  <div class="filter-bar">
    <div class="period-btns">
      <button class="period-btn" data-period="today">Dnes</button>
      <button class="period-btn active" data-period="week">Tento tyzden</button>
      <button class="period-btn" data-period="month">Tento mesiac</button>
      <button class="period-btn" data-period="custom">Vlastne obdobie</button>
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
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="table-trzby">
        <thead>
          <tr>
            <th>Dátum</th>
            <th>Objednávky</th>
            <th>Tržby</th>
            <th>Priem. účet</th>
            <th>Najlepšie hodiny</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="5" class="td-empty">Načítavam…</td></tr>
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
      <table class="data-table" id="table-produkty">
        <thead>
          <tr>
            <th>Poradie</th>
            <th>Produkt</th>
            <th>Kategória</th>
            <th>Predaných ks</th>
            <th>Tržby</th>
            <th>% z celku</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
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
            <th>Objednávky</th>
            <th>Tržby</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="4" class="td-empty">Načítavam…</td></tr>
        </tbody>
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
}
