let interval = null;
let ktoInterval = null;
let visHandler = null;
let _container = null;

/** Calendar Y-M-D in browser local timezone (restaurant PC). */
function ymdLocal(d) {
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function refreshDashboardData() {
  loadStats();
  loadBarChart();
  loadUzavierka();
  loadActiveStaff();
}

export function init(container) {
  _container = container;
  container.innerHTML = `
    <div class="dashboard-page">
    <div class="row dashboard-row-single dochadzka-active-row">
      <div class="col-50">
        <div class="panel" id="ktoJeVPraciPanel">
          <div class="panel-title">
            <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><circle cx="12" cy="8" r="4"/><path d="M3 21a9 9 0 0118 0"/></svg>
            Kto je v práci
          </div>
          <div id="ktoJeVPraciList" class="loading-placeholder">Načítavam…</div>
        </div>
      </div>
    </div>
    <div class="dashboard-section-label">Prehľad dňa</div>
    <!-- STAT CARDS -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-info" data-stat="revenue">
          <div class="stat-label">Dnešné tržby</div>
          <div class="stat-value skeleton skeleton-text">&nbsp;</div>
          <div class="stat-change skeleton skeleton-text">&nbsp;</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        </div>
        <div class="stat-info" data-stat="orders">
          <div class="stat-label">Objednávky dnes</div>
          <div class="stat-value skeleton skeleton-text">&nbsp;</div>
          <div class="stat-change skeleton skeleton-text">&nbsp;</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        </div>
        <div class="stat-info" data-stat="avg">
          <div class="stat-label">Priemerný účet</div>
          <div class="stat-value skeleton skeleton-text">&nbsp;</div>
          <div class="stat-change skeleton skeleton-text">&nbsp;</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon amber">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
        </div>
        <div class="stat-info" data-stat="occupancy">
          <div class="stat-label">Obsadenosť stolov</div>
          <div class="stat-value skeleton skeleton-text">&nbsp;</div>
          <div class="stat-change skeleton skeleton-text">&nbsp;</div>
        </div>
      </div>
    </div>

    <!-- MIDDLE ROW -->
    <div class="row">
      <!-- Weekly Revenue -->
      <div class="col-60">
        <div class="panel">
          <div class="panel-title">Tržby za týždeň</div>
          <div class="bar-chart" id="barChart">
            <div class="loading-placeholder" style="width:100%">Načítavam…</div>
          </div>
        </div>
      </div>

      <!-- Top Products -->
      <div class="col-40">
        <div class="panel">
          <div class="panel-title">Top produkty dnes</div>
          <div class="product-list dashboard-product-list" id="topProducts">
            <div class="loading-placeholder">Načítavam…</div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAYMENT METHODS -->
    <div class="row dashboard-row-single">
      <div class="col-50">
        <div class="panel">
          <div class="panel-title">Platobné metódy dnes</div>
          <div class="occ-chart" id="occChart">
            <div class="loading-placeholder">Načítavam…</div>
          </div>
        </div>
      </div>
    </div>

    <div class="dashboard-section-label">Uzávierka a tlač</div>
    <!-- DNESNA UZAVIERKA (bez opakovania KPI — tie sú v kartách vyššie) -->
    <div class="row dashboard-row-single">
      <div class="col-50">
        <div class="panel" id="uzavierkaPanel">
          <div class="panel-title">
            <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Dnešná uzávierka
          </div>
          <p class="dashboard-uz-lead">Rozpis platieb pre kontrolu a tlač Z-reportu (súčty sú zhodné s prehľadom vyššie).</p>
          <div id="uzPayments" class="loading-placeholder" style="margin-bottom:12px"></div>
          <div id="uzShisha" style="margin-bottom:12px;font-size:13px;color:var(--color-text-sec);display:none"></div>
          <div class="flex-row">
            <a href="#reports" class="btn-outline-accent">
              Kompletný report
            </a>
            <button id="btnQuickPrintZ" class="btn-outline-accent">
              <svg aria-hidden="true" viewBox="0 0 24 24" style="width:14px;height:14px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Tlačiť uzávierku
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>
  `;

  refreshDashboardData();
  interval = setInterval(function() {
    loadStats();
    loadUzavierka();
  }, 120000);
  ktoInterval = setInterval(loadActiveStaff, 30000);

  visHandler = function() {
    if (document.visibilityState === 'visible') refreshDashboardData();
  };
  document.addEventListener('visibilitychange', visHandler);

  // Print Z-report button
  var btnZ = container.querySelector('#btnQuickPrintZ');
  if (btnZ) {
    btnZ.addEventListener('click', async function() {
      btnLoading(btnZ);
      try {
        var today = ymdLocal(new Date());
        await api.post('/print/z-report', { date: today });
        showToast('Z-report odoslaný na tlačiareň', true);
        refreshDashboardData();
      } catch (err) {
        showToast('Chyba tlače: ' + err.message, 'error');
      } finally {
        btnReset(btnZ);
      }
    });
  }
}

export function destroy() {
  if (interval) { clearInterval(interval); interval = null; }
  if (ktoInterval) { clearInterval(ktoInterval); ktoInterval = null; }
  if (visHandler) {
    document.removeEventListener('visibilitychange', visHandler);
    visHandler = null;
  }
  _container = null;
}

function fmtEur(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

function skOpenOrdersLabel(n) {
  if (n === 0) return 'žiadna otvorená';
  if (n === 1) return '1 otvorená objednávka';
  if (n >= 2 && n <= 4) return n + ' otvorené objednávky';
  return n + ' otvorených objednávok';
}

async function loadStats() {
  if (!_container) return;
  var c = _container;
  var revValue = c.querySelector('[data-stat="revenue"] .stat-value');
  var revChange = c.querySelector('[data-stat="revenue"] .stat-change');
  var ordValue = c.querySelector('[data-stat="orders"] .stat-value');
  var ordChange = c.querySelector('[data-stat="orders"] .stat-change');
  var avgValue = c.querySelector('[data-stat="avg"] .stat-value');
  var avgChange = c.querySelector('[data-stat="avg"] .stat-change');
  var occValue = c.querySelector('[data-stat="occupancy"] .stat-value');
  var occChange = c.querySelector('[data-stat="occupancy"] .stat-change');

  try {
    var today = ymdLocal(new Date());
    var summary = await api.get('/reports/summary?from=' + encodeURIComponent(today) + '&to=' + encodeURIComponent(today));
    if (summary) {
      if (summary.revenue && revValue) {
        revValue.innerHTML = Number(summary.revenue.total).toLocaleString('sk-SK', {minimumFractionDigits:2}) + ' &euro;';
        revValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (revChange) {
        var changeText = summary.revenue.payments + ' platieb';
        if (summary.shisha && summary.shisha.count > 0) {
          changeText += ' • shisha ' + summary.shisha.count + 'x (' +
            Number(summary.shisha.revenue).toLocaleString('sk-SK', {minimumFractionDigits:2}) + ' €)';
        }
        revChange.textContent = changeText;
        revChange.className = 'stat-change ' + (summary.revenue.total > 0 ? 'up' : 'neutral');
      }
      if (summary.orders && ordValue) {
        ordValue.textContent = summary.orders.total;
        ordValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (summary.orders && ordChange) {
        ordChange.textContent = skOpenOrdersLabel(summary.orders.open);
        ordChange.className = 'stat-change ' + (summary.orders.open > 0 ? 'up' : 'neutral');
      }
      if (summary.orders && summary.orders.total > 0 && avgValue) {
        var avg = summary.revenue.total / summary.orders.total;
        avgValue.innerHTML = avg.toLocaleString('sk-SK', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' &euro;';
        avgValue.classList.remove('skeleton', 'skeleton-text');
      } else if (avgValue) {
        avgValue.innerHTML = '0,00 &euro;';
        avgValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (avgChange) {
        avgChange.className = 'stat-change neutral';
        avgChange.textContent = 'priemerný účet';
      }

      // Render top products from summary
      renderTopProducts(summary.topItems || []);
      // Render payment methods from summary
      renderPaymentMethods(summary.methods || []);
    }
  } catch (err) {
    showToast(err.message || 'Chyba načítania štatistík', 'error');
  }

  try {
    var tables = await api.get('/tables');
    var orders = await api.get('/orders');
    if (tables && tables.length > 0) {
      var total = tables.length;
      var tablesWithOrders = new Set();
      if (orders) orders.forEach(function(o) { tablesWithOrders.add(o.tableId); });
      var occupied = tablesWithOrders.size;
      var pct = Math.round((occupied / total) * 100);
      if (occValue) {
        occValue.textContent = pct + '%';
        occValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (occChange) {
        occChange.textContent = occupied + ' / ' + total + ' stolov';
        occChange.className = 'stat-change neutral';
      }
    }
  } catch (err) {
    showToast(err.message || 'Chyba načítania stolov', 'error');
  }
}

async function loadBarChart() {
  if (!_container) return;
  var chartEl = _container.querySelector('#barChart');
  if (!chartEl) return;
  showLoading(chartEl, 'Načítavam graf…');
  try {
    var dayLabels = ['Po', 'Ut', 'St', '\u0160t', 'Pi', 'So', 'Ne'];
    var today = new Date();
    var dayOfWeek = today.getDay();
    var mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    var monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    var dailyRevenues = [];
    var promises = [];
    for (var i = 0; i < 7; i++) {
      (function(idx) {
        var day = new Date(monday);
        day.setDate(monday.getDate() + idx);
        var dateStr = ymdLocal(day);
        promises.push(
          api.get('/reports/summary?from=' + dateStr + '&to=' + dateStr)
            .then(function(s) { dailyRevenues[idx] = (s && s.revenue) ? Number(s.revenue.total) : 0; })
            .catch(function() { dailyRevenues[idx] = 0; })
        );
      })(i);
    }
    await Promise.all(promises);
    hideLoading(chartEl);

    var max = Math.max.apply(null, dailyRevenues);
    if (max === 0) max = 1;
    var weekTotal = dailyRevenues.reduce(function(a, b) { return a + b; }, 0);
    var html = '';
    for (var j = 0; j < 7; j++) {
      var rev = dailyRevenues[j];
      var pct = Math.round((rev / max) * 100);
      var isMax = rev === max && rev > 0;
      var barStyle = isMax ? 'height:' + pct + '%' : 'height:' + pct + '%;background:rgba(139,124,246,.3)';
      var barClass = isMax ? 'bar highlight' : 'bar';
      html += '<div class="bar-col">' +
        '<div class="bar-amount">' + fmtEur(rev) + '</div>' +
        '<div class="bar-wrapper"><div class="' + barClass + '" style="' + barStyle + '"></div></div>' +
        '<div class="bar-label">' + dayLabels[j] + '</div>' +
        '</div>';
    }
    if (weekTotal === 0) {
      html += '<div class="dashboard-chart-hint">Za tento týždeň zatiaľ žiadne tržby.</div>';
    }
    chartEl.innerHTML = html;
  } catch (err) {
    hideLoading(chartEl);
    chartEl.innerHTML = '<div class="loading-placeholder" style="width:100%">Chyba pri načítaní</div>';
  }
}

function renderTopProducts(topItems) {
  if (!_container) return;
  var listEl = _container.querySelector('#topProducts');
  if (!listEl) return;
  if (!topItems || topItems.length === 0) {
    listEl.innerHTML = '<div class="loading-placeholder">Žiadne produkty dnes</div>';
    return;
  }
  var maxQty = topItems[0].qty || 1;
  var html = '';
  topItems.forEach(function(p, i) {
    var barW = Math.round(((p.qty || 0) / maxQty) * 100);
    var displayName = (p.emoji ? p.emoji + ' ' : '') + (p.name || '');
    html += '<div class="product-row">' +
      '<div class="product-rank">' + (i + 1) + '</div>' +
      '<div class="product-name">' + displayName + '</div>' +
      '<div class="product-qty">' + (p.qty || 0) + '</div>' +
      '<div class="product-bar-wrap"><div class="product-bar-fill" style="width:' + barW + '%"></div></div>' +
      '<div class="product-revenue">' + fmtEur(p.revenue || 0) + '</div>' +
      '</div>';
  });
  listEl.innerHTML = html;
}

function renderPaymentMethods(methods) {
  if (!_container) return;
  var chartEl = _container.querySelector('#occChart');
  if (!chartEl) return;
  if (!methods || methods.length === 0) {
    chartEl.innerHTML = '<div class="loading-placeholder">Žiadne platby</div>';
    return;
  }
  var methodLabels = {hotovost: 'Hotovosť', karta: 'Karta', cash: 'Hotovosť', card: 'Karta'};
  var totalAmt = 0;
  methods.forEach(function(m) { totalAmt += Number(m.total) || 0; });
  if (totalAmt <= 0) {
    chartEl.innerHTML = '<div class="loading-placeholder">Žiadne platby</div>';
    return;
  }

  var colors = ['#8b7cf6', '#5cc49e', '#60a5fa', '#d4a853'];
  var html = '';
  var useDonut = methods.length <= 4;

  if (useDonut) {
    var cumPct = 0;
    var stops = [];
    methods.forEach(function(m, i) {
      var t = Number(m.total) || 0;
      var startPct = cumPct;
      cumPct += (t / totalAmt) * 100;
      stops.push(colors[i % colors.length] + ' ' + startPct + '% ' + cumPct + '%');
    });
    html += '<div class="dashboard-pay-visual" role="group" aria-label="Platobné metódy">';
    html += '<div class="dashboard-pay-donut" style="background:conic-gradient(' + stops.join(',') + ')" role="img" aria-hidden="true"></div>';
    html += '<ul class="dashboard-pay-legend">';
    methods.forEach(function(m, i) {
      var label = methodLabels[m.method] || (m.method.charAt(0).toUpperCase() + m.method.slice(1));
      var share = Math.round((Number(m.total) / totalAmt) * 100);
      html += '<li class="dashboard-pay-legend-row">' +
        '<span class="dashboard-pay-swatch" style="background:' + colors[i % colors.length] + '"></span>' +
        '<span class="dashboard-pay-legend-label">' + label + '</span>' +
        '<span class="dashboard-pay-legend-val">' + fmtEur(m.total) + ' · ' + share + '% · ' + m.count + '×</span></li>';
    });
    html += '</ul></div>';
  } else {
    var maxTotal = 0;
    methods.forEach(function(m) { if (m.total > maxTotal) maxTotal = m.total; });
    if (maxTotal === 0) maxTotal = 1;
    html += '<div class="dashboard-pay-bars">';
    methods.forEach(function(m) {
      var pct = Math.round((m.total / maxTotal) * 100);
      var label = methodLabels[m.method] || (m.method.charAt(0).toUpperCase() + m.method.slice(1));
      html += '<div class="occ-row">' +
        '<div class="occ-hour">' + label + '</div>' +
        '<div class="occ-bar-wrap"><div class="occ-bar-fill" style="width:' + pct + '%;background:linear-gradient(90deg,var(--color-accent),var(--color-accent-dim))"></div></div>' +
        '<div class="occ-pct" style="width:auto;min-width:60px;text-align:right">' + fmtEur(m.total) + ' (' + m.count + 'x)</div>' +
        '</div>';
    });
    html += '</div>';
  }
  chartEl.innerHTML = html;
}

async function loadUzavierka() {
  if (!_container) return;
  var uzPanel = _container.querySelector('#uzavierkaPanel');
  if (uzPanel) showLoading(uzPanel, 'Načítavam uzávierku…');
  // Safety net: if api.get hangs (wifi drop, dead proxy, the request
  // never settling for any reason), force the spinner off after 12s and
  // surface a hint instead of leaving "Načítavam uzávierku…" stuck on
  // the dashboard forever. The actual try/catch below races this — it
  // wins on a normal response and the timer is cleared in finally.
  var stuck = setTimeout(function () {
    if (!_container) return;
    if (uzPanel) hideLoading(uzPanel);
    var elP = _container.querySelector('#uzPayments');
    if (elP && elP.classList.contains('loading-placeholder')) {
      elP.classList.remove('loading-placeholder');
      elP.textContent = 'Uzávierka sa nepodarila načítať. Skús obnoviť stránku.';
    }
  }, 12000);
  try {
    var today = ymdLocal(new Date());
    var data = await api.get('/reports/z-report?date=' + encodeURIComponent(today));
    if (uzPanel) hideLoading(uzPanel);
    var el4 = _container.querySelector('#uzPayments');
    if (data && el4) {
      var pmHtml = (data.paymentMethods || []).map(function(pm) {
        var label = pm.method.charAt(0).toUpperCase() + pm.method.slice(1);
        return label + ': ' + fmtEur(pm.total) + ' (' + pm.count + 'x)';
      }).join(' \u00A0|\u00A0 ');
      el4.innerHTML = pmHtml || 'Žiadne platby';
    } else if (el4) {
      el4.textContent = 'Žiadne platby';
    }
    var elShisha = _container.querySelector('#uzShisha');
    if (elShisha) {
      if (data && data.shisha && data.shisha.count > 0) {
        elShisha.innerHTML = '💨 Shisha: <b>' + data.shisha.count + 'x</b>  •  ' +
          fmtEur(data.shisha.revenue) +
          (data.fiscalRevenue !== undefined
            ? '  •  <span style="opacity:.7">Fiskal: ' + fmtEur(data.fiscalRevenue) + '</span>'
            : '');
        elShisha.style.display = '';
      } else {
        elShisha.style.display = 'none';
      }
    }
    // Drop the loading-placeholder class once we have rendered real
    // payment-method content so the safety-net timer cannot revert the
    // panel to the "nepodarilo sa načítať" message after the fact.
    var elPok = _container.querySelector('#uzPayments');
    if (elPok) elPok.classList.remove('loading-placeholder');
  } catch (err) {
    if (uzPanel) hideLoading(uzPanel);
    showToast(err.message || 'Chyba načítania uzávierky', 'error');
  } finally {
    clearTimeout(stuck);
  }
}

async function loadActiveStaff() {
  if (!_container) return;
  const listEl = _container.querySelector('#ktoJeVPraciList');
  if (!listEl) return;
  try {
    const data = await api.get('/attendance/active');
    listEl.classList.remove('loading-placeholder');
    const rows = (data && data.active) || [];
    if (!rows.length) {
      listEl.innerHTML = '<div class="text-muted" style="padding:8px 0">Nikto sa zatiaľ neoznačil.</div>';
      return;
    }
    listEl.innerHTML = '<div class="kto-list">' + rows.map((r) => {
      const h = Math.floor(r.minutes / 60);
      const m = r.minutes % 60;
      const since = new Date(r.clockedInAt).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
      return '<div class="kto-row">' +
        '<div class="kto-name">' + (r.name || '?') + '</div>' +
        (r.position ? '<div class="kto-pos">' + r.position + '</div>' : '') +
        '<div class="kto-time">od ' + since + '</div>' +
        '<div class="kto-mins"><strong>' + h + 'h ' + m + 'm</strong></div>' +
      '</div>';
    }).join('') + '</div>';
  } catch (err) {
    listEl.classList.remove('loading-placeholder');
    listEl.innerHTML = '<div class="text-muted">Chyba načítania (' + (err.message || 'unknown') + ')</div>';
  }
}
