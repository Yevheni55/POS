let interval = null;
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
}

export function init(container) {
  _container = container;
  container.innerHTML = `
    <div class="dashboard-page">
    <div class="dashboard-exec-head">
      <h2 class="dashboard-exec-title">Prehľad pre vedenie</h2>
      <p class="dashboard-exec-sub" id="dashboardExecDate"></p>
    </div>
    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="stat-card-main">
          <div class="stat-icon accent">
            <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div class="stat-info" data-stat="revenue">
            <div class="stat-label">Dnešné tržby</div>
            <div class="stat-value skeleton skeleton-text">&nbsp;</div>
            <div class="stat-change skeleton skeleton-text">&nbsp;</div>
          </div>
        </div>
        <div class="stat-progress-bar" aria-hidden="true"><span class="stat-progress-fill stat-progress-fill--accent" data-stat-fill="revenue" style="width:0%"></span></div>
      </div>
      <div class="stat-card mint">
        <div class="stat-card-main">
          <div class="stat-icon mint">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          </div>
          <div class="stat-info" data-stat="orders">
            <div class="stat-label">Objednávky dnes</div>
            <div class="stat-value skeleton skeleton-text">&nbsp;</div>
            <div class="stat-change skeleton skeleton-text">&nbsp;</div>
          </div>
        </div>
        <div class="stat-progress-bar" aria-hidden="true"><span class="stat-progress-fill stat-progress-fill--mint" data-stat-fill="orders" style="width:0%"></span></div>
      </div>
      <div class="stat-card amber">
        <div class="stat-card-main">
          <div class="stat-icon amber">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          </div>
          <div class="stat-info" data-stat="avg">
            <div class="stat-label">Priemerný účet</div>
            <div class="stat-value skeleton skeleton-text">&nbsp;</div>
            <div class="stat-change skeleton skeleton-text">&nbsp;</div>
          </div>
        </div>
        <div class="stat-progress-bar" aria-hidden="true"><span class="stat-progress-fill stat-progress-fill--amber" data-stat-fill="avg" style="width:0%"></span></div>
      </div>
      <div class="stat-card rose">
        <div class="stat-card-main">
          <div class="stat-icon rose">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
          </div>
          <div class="stat-info" data-stat="occupancy">
            <div class="stat-label">Obsadenosť stolov</div>
            <div class="stat-value skeleton skeleton-text">&nbsp;</div>
            <div class="stat-change skeleton skeleton-text">&nbsp;</div>
          </div>
        </div>
        <div class="stat-progress-bar" aria-hidden="true"><span class="stat-progress-fill stat-progress-fill--rose" data-stat-fill="occupancy" style="width:0%"></span></div>
      </div>
    </div>

    <div class="row">
      <div class="col-60">
        <div class="panel">
          <div class="panel-title">Výkon tržieb (týždeň)</div>
          <p class="panel-sublegend"><span class="legend-dot legend-dot--this"></span> Tento týždeň</p>
          <div class="bar-chart bar-chart--area" id="barChart">
            <div class="loading-placeholder" style="width:100%">Načítavam…</div>
          </div>
        </div>
      </div>
      <div class="col-40">
        <div class="panel">
          <div class="panel-title">Top predaj dnes</div>
          <div class="product-list dashboard-product-list dashboard-top-sellers" id="topProducts">
            <div class="loading-placeholder">Načítavam…</div>
          </div>
        </div>
      </div>
    </div>

    <div class="row dashboard-row-single">
      <div class="col-100">
        <div class="panel">
          <div class="panel-title">Rozdelenie platieb</div>
          <div class="pay-distribution-grid" id="payDistributionGrid">
            <div class="loading-placeholder">Načítavam…</div>
          </div>
        </div>
      </div>
    </div>

    <div class="row dashboard-row-single">
      <div class="col-100">
        <div class="panel closure-panel" id="closurePanel">
          <div class="panel-title">
            <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            Stav uzávierky
          </div>
          <div class="closure-card" id="closureChecklist"></div>
          <div class="closure-actions">
            <button type="button" class="btn-outline-accent" id="btnClosureRemind">Pripomenúť tím</button>
            <a href="#reports" class="btn-outline-muted">Detailný audit / reporty</a>
            <button type="button" class="btn-outline-accent" id="btnQuickPrintZ">
              <svg aria-hidden="true" viewBox="0 0 24 24" style="width:14px;height:14px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Tlačiť Z-report
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>
  `;

  var execDate = container.querySelector('#dashboardExecDate');
  if (execDate) {
    execDate.textContent = new Date().toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  var remindBtn = container.querySelector('#btnClosureRemind');
  if (remindBtn) {
    remindBtn.addEventListener('click', function() {
      showToast('Pripomienka: skontrolujte uzávierku a tlač Z-reportu.', true);
    });
  }

  refreshDashboardData();
  interval = setInterval(function() {
    loadStats();
    loadUzavierka();
  }, 120000);

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

function setStatFill(which, pct) {
  if (!_container) return;
  var el = _container.querySelector('[data-stat-fill="' + which + '"]');
  if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
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
  var revNum = 0;
  var ordNum = 0;
  var avgNum = 0;
  var occPct = 0;

  try {
    var today = ymdLocal(new Date());
    var summary = await api.get('/reports/summary?from=' + encodeURIComponent(today) + '&to=' + encodeURIComponent(today));
    if (summary) {
      if (summary.revenue && revValue) {
        revNum = Number(summary.revenue.total) || 0;
        revValue.innerHTML = revNum.toLocaleString('sk-SK', {minimumFractionDigits:2}) + ' &euro;';
        revValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (revChange) {
        revChange.textContent = summary.revenue.payments + ' platieb · dnes';
        revChange.className = 'stat-change ' + (summary.revenue.total > 0 ? 'up' : 'neutral');
      }
      if (summary.orders && ordValue) {
        ordNum = summary.orders.total;
        ordValue.textContent = ordNum;
        ordValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (summary.orders && ordChange) {
        ordChange.textContent = skOpenOrdersLabel(summary.orders.open);
        ordChange.className = 'stat-change ' + (summary.orders.open > 0 ? 'up' : 'neutral');
      }
      if (summary.orders && summary.orders.total > 0 && avgValue) {
        avgNum = summary.revenue.total / summary.orders.total;
        avgValue.innerHTML = avgNum.toLocaleString('sk-SK', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' &euro;';
        avgValue.classList.remove('skeleton', 'skeleton-text');
      } else if (avgValue) {
        avgValue.innerHTML = '0,00 &euro;';
        avgValue.classList.remove('skeleton', 'skeleton-text');
      }
      if (avgChange) {
        avgChange.className = 'stat-change neutral';
        avgChange.textContent = 'priemerný účet';
      }

      renderTopProducts(summary.topItems || []);
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
      occPct = Math.round((occupied / total) * 100);
      if (occValue) {
        occValue.textContent = occPct + '%';
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

  setStatFill('revenue', Math.min(100, (revNum / 2800) * 100));
  setStatFill('orders', Math.min(100, (ordNum / 55) * 100));
  setStatFill('avg', Math.min(100, (avgNum / 45) * 100));
  setStatFill('occupancy', occPct);
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
      var barClass = isMax ? 'bar highlight bar--gradient' : 'bar bar--gradient';
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
  var slice = topItems.slice(0, 5);
  var maxRev = 0;
  slice.forEach(function(p) {
    var r = Number(p.revenue) || 0;
    if (r > maxRev) maxRev = r;
  });
  if (maxRev === 0) maxRev = 1;
  var colors = ['var(--color-accent)', '#00E5B9', '#E8B84A', 'var(--color-accent-dim)', 'var(--color-danger)'];
  var html = '';
  slice.forEach(function(p, i) {
    var barW = Math.round(((Number(p.revenue) || 0) / maxRev) * 100);
    var displayName = (p.emoji ? p.emoji + ' ' : '') + (p.name || '');
    var fillColor = colors[i % colors.length];
    html += '<div class="product-row product-row--seller">' +
      '<div class="product-rank">' + (i + 1) + '</div>' +
      '<div class="product-name-block"><div class="product-name">' + displayName + '</div>' +
      '<div class="product-bar-wrap product-bar-wrap--seller"><div class="product-bar-fill" style="width:' + barW + '%;background:' + fillColor + '"></div></div></div>' +
      '<div class="product-revenue">' + fmtEur(p.revenue || 0) + '</div>' +
      '</div>';
  });
  listEl.innerHTML = html;
}

function renderPaymentMethods(methods) {
  if (!_container) return;
  var grid = _container.querySelector('#payDistributionGrid');
  if (!grid) return;
  if (!methods || methods.length === 0) {
    grid.innerHTML = '<div class="loading-placeholder">Žiadne platby</div>';
    return;
  }
  var buckets = [
    { label: 'VISA / MC', short: 'Karta', icon: '💳', color: '#6366f1', amt: 0, count: 0 },
    { label: 'AMEX', short: 'AMEX', icon: '💳', color: '#38bdf8', amt: 0, count: 0 },
    { label: 'Hotovosť', short: 'Hotovosť', icon: '💵', color: '#4ade80', amt: 0, count: 0 },
    { label: 'Digitálne', short: 'Iné', icon: '📱', color: '#c799ff', amt: 0, count: 0 }
  ];
  methods.forEach(function(m) {
    var raw = String(m.method || '').toLowerCase();
    var t = Number(m.total) || 0;
    var cnt = Number(m.count) || 0;
    var idx = 3;
    if (raw === 'hotovost' || raw === 'cash') idx = 2;
    else if (raw.indexOf('amex') >= 0) idx = 1;
    else if (raw === 'karta' || raw === 'card' || raw.indexOf('visa') >= 0 || raw.indexOf('mc') >= 0) idx = 0;
    buckets[idx].amt += t;
    buckets[idx].count += cnt;
  });
  var totalAmt = buckets.reduce(function(s, b) { return s + b.amt; }, 0);
  if (totalAmt <= 0) {
    grid.innerHTML = '<div class="loading-placeholder">Žiadne platby</div>';
    return;
  }
  var html = '';
  buckets.forEach(function(b) {
    var share = Math.round((b.amt / totalAmt) * 100);
    html += '<div class="pay-method-card">' +
      '<div class="pay-method-icon" style="background:' + b.color + '22;color:' + b.color + ';box-shadow:0 0 20px ' + b.color + '33">' + b.icon + '</div>' +
      '<div class="pay-method-body">' +
      '<div class="pay-method-name">' + b.label + '</div>' +
      '<div class="pay-method-amt">' + fmtEur(b.amt) + '</div>' +
      '<div class="pay-method-meta">' + share + '% · ' + b.count + '×</div>' +
      '</div></div>';
  });
  grid.innerHTML = html;
}

function closureRow(done, title, sub) {
  var icon = done
    ? '<span class="closure-icon closure-icon--ok" aria-hidden="true">&#10003;</span>'
    : '<span class="closure-icon closure-icon--pending" aria-hidden="true">&#9711;</span>';
  var cls = done ? 'closure-item closure-item--done' : 'closure-item closure-item--pending';
  return '<div class="' + cls + '">' + icon + '<div class="closure-item-text"><div class="closure-item-title">' + title + '</div>' +
    (sub ? '<div class="closure-item-sub">' + sub + '</div>' : '') + '</div></div>';
}

async function loadUzavierka() {
  if (!_container) return;
  var listEl = _container.querySelector('#closureChecklist');
  var closurePanel = _container.querySelector('#closurePanel');
  if (closurePanel) showLoading(closurePanel, 'Načítavam uzávierku…');
  try {
    var today = ymdLocal(new Date());
    var data = await api.get('/reports/z-report?date=' + encodeURIComponent(today));
    if (closurePanel) hideLoading(closurePanel);
    var pm = (data && data.paymentMethods) ? data.paymentMethods : [];
    var hasPm = pm.length > 0;
    var summaryLine = hasPm
      ? pm.map(function(x) {
        return x.method.charAt(0).toUpperCase() + x.method.slice(1) + ': ' + fmtEur(x.total);
      }).join(' · ')
      : 'Žiadne platby v dátach uzávierky';
    if (listEl) {
      listEl.innerHTML =
        closureRow(true, 'Denné dáta načítané', today) +
        closureRow(hasPm, 'Platobné súčty skontrolované', summaryLine) +
        closureRow(false, 'Tlač Z-reportu', 'Odporúčame pred koncom zmeny');
    }
  } catch (err) {
    if (closurePanel) hideLoading(closurePanel);
    if (listEl) {
      listEl.innerHTML = closureRow(true, 'Prehľad dostupný', 'Detail uzávierky nie je k dispozícii') +
        closureRow(false, 'Skúste neskôr', err.message || 'Chyba API');
    }
    showToast(err.message || 'Chyba načítania uzávierky', 'error');
  }
}
