// Inventory audit page module
let audits = [];
let currentAudit = null;
let currentView = 'list'; // 'list' | 'detail'
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(isoStr) {
  if (!isoStr) return '--';
  var d = new Date(isoStr);
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getStatusBadge(status) {
  var map = {
    open:      { cls: 'badge-warning', label: 'Otvorena' },
    completed: { cls: 'badge-success', label: 'Dokoncena' },
    cancelled: { cls: 'badge-danger',  label: 'Zrusena' }
  };
  var entry = map[status] || { cls: '', label: status || '--' };
  return '<span class="badge ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}

// === Load audit list ===
async function loadAudits() {
  var tableWrap = $('#auditListWrap');
  if (tableWrap) showLoading(tableWrap, 'Nacitavam inventury...');
  try {
    var result = await api.get('/inventory/audits');
    if (tableWrap) hideLoading(tableWrap);
    audits = Array.isArray(result) ? result : [];
    renderList();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri nacitani inventur', loadAudits);
  }
}

// === Render list view ===
function renderList() {
  var wrap = $('#auditListWrap');
  if (!wrap) return;

  if (!audits.length) {
    wrap.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">&#128203;</div>'
      + '<div class="empty-state-title">Ziadne inventury</div>'
      + '<div class="empty-state-text">Vytvorte prvu inventuru kliknutim na tlacidlo vyssie.</div>'
      + '</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>'
    + '<th>ID</th>'
    + '<th>Dátum</th>'
    + '<th>Stav</th>'
    + '<th>Poznámka</th>'
    + '<th class="text-right">Akcie</th>'
    + '</tr></thead><tbody>';

  audits.forEach(function (a) {
    html += '<tr class="data-row">';
    html += '<td class="num">#' + a.id + '</td>';
    html += '<td>' + fmtDate(a.createdAt) + '</td>';
    html += '<td>' + getStatusBadge(a.status) + '</td>';
    html += '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      + escapeHtml(a.note || '') + '</td>';
    html += '<td class="text-right">';
    html += '<button class="btn-outline-accent" data-view-id="' + a.id + '" style="padding:4px 12px;font-size:12px">Detail</button>';
    html += '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

// === Switch to detail view ===
async function showDetail(auditId) {
  currentView = 'detail';
  renderSkeleton();

  try {
    var result = await api.get('/inventory/audits/' + auditId);
    currentAudit = result;
    renderDetail();
  } catch (err) {
    showToast(err.message || 'Chyba pri nacitani inventury', 'error');
    showListView();
  }
}

function renderSkeleton() {
  if (!_container) return;
  _container.innerHTML = ''
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">'
    + '<button class="btn-outline-accent" id="backToListBtn" style="padding:6px 14px">'
    + '&larr; Spat'
    + '</button>'
    + '<div class="skeleton skeleton-text" style="width:200px;height:24px"></div>'
    + '</div>'
    + '<div id="auditDetailWrap">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';
  $('#backToListBtn').addEventListener('click', function () { showListView(); });
}

// === Render detail view ===
function renderDetail() {
  if (!_container || !currentAudit) return;

  var a = currentAudit;
  var isOpen = a.status === 'open';
  var isReadonly = !isOpen;
  var items = Array.isArray(a.items) ? a.items : [];

  var header = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">'
    + '<button class="btn-outline-accent" id="backToListBtn" style="padding:6px 14px">&larr; Spat</button>'
    + '<h2 style="font-family:var(--font-display);font-size:var(--text-4xl);font-weight:var(--weight-bold);margin:0">'
    + 'Inventura #' + a.id + '</h2>'
    + getStatusBadge(a.status);

  if (isOpen) {
    header += '<div style="margin-left:auto;display:flex;gap:8px">'
      + '<button class="u-btn u-btn-ice" id="completeAuditBtn" style="padding:6px 18px;min-height:auto">Dokoncit inventuru</button>'
      + '<button class="u-btn u-btn-rose" id="cancelAuditBtn" style="padding:6px 18px;min-height:auto">Zrusit</button>'
      + '</div>';
  }
  header += '</div>';

  var table = '';
  if (!items.length) {
    table = '<div class="empty-state">'
      + '<div class="empty-state-title">Ziadne polozky</div>'
      + '<div class="empty-state-text">Tato inventura nema ziadne polozky.</div>'
      + '</div>';
  } else {
    table = '<div class="table-scroll-wrap"><table class="data-table" id="auditItemsTable"><thead><tr>'
      + '<th>Surovina</th>'
      + '<th>Jednotka</th>'
      + '<th class="text-right">Očakávané</th>'
      + '<th class="text-right">Skutočné</th>'
      + '<th class="text-right">Rozdiel</th>'
      + '</tr></thead><tbody>';

    items.forEach(function (item) {
      var actual = item.actualQty;
      var expected = Number(item.expectedQty) || 0;
      var hasActual = actual != null && actual !== '';
      var diff = hasActual ? (Number(actual) - expected) : null;
      var diffClass = '';
      var diffText = '--';
      if (diff !== null) {
        diffClass = diff > 0 ? 'color-success' : (diff < 0 ? 'color-danger' : '');
        var sign = diff > 0 ? '+' : '';
        diffText = sign + Number(diff).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      table += '<tr data-item-id="' + item.id + '">';
      table += '<td class="td-name">' + escapeHtml(item.ingredientName || ('Surovina #' + item.ingredientId)) + '</td>';
      table += '<td>' + escapeHtml(item.ingredientUnit || '--') + '</td>';
      table += '<td class="text-right num">' + fmtNum(expected) + '</td>';
      table += '<td class="text-right">';

      if (isReadonly) {
        table += '<span class="num">' + (hasActual ? fmtNum(actual) : '--') + '</span>';
      } else {
        table += '<input type="number" step="0.01" class="form-input actual-qty-input" '
          + 'style="width:100px;padding:5px 8px;text-align:right;font-size:12px" '
          + 'data-item-id="' + item.id + '" '
          + 'value="' + (hasActual ? actual : '') + '" '
          + 'placeholder="--">';
      }

      table += '</td>';
      table += '<td class="text-right num ' + diffClass + '">' + diffText + '</td>';
      table += '</tr>';
    });

    table += '</tbody></table></div>';
  }

  _container.innerHTML = header + '<div id="auditDetailWrap">' + table + '</div>';

  // Wire back button
  $('#backToListBtn').addEventListener('click', function () { showListView(); });

  // Wire action buttons for open audits
  if (isOpen) {
    var completeBtn = $('#completeAuditBtn');
    if (completeBtn) {
      completeBtn.addEventListener('click', function () { completeAudit(a.id); });
    }
    var cancelBtn = $('#cancelAuditBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () { cancelAudit(a.id); });
    }

    // Wire actualQty inputs
    var inputs = _container.querySelectorAll('.actual-qty-input');
    inputs.forEach(function (inp) {
      var saveTimeout = null;
      inp.addEventListener('change', function () { saveActualQty(this); });
      inp.addEventListener('blur', function () { saveActualQty(this); });
      inp.addEventListener('input', function () {
        var self = this;
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function () { recalcDiff(self); }, 200);
      });
    });
  }
}

// === Save actual quantity ===
var _savingItems = {};

async function saveActualQty(inputEl) {
  var itemId = inputEl.dataset.itemId;
  var val = inputEl.value.trim();
  if (val === '' || !currentAudit) return;

  var actualQty = parseFloat(val);
  if (isNaN(actualQty)) return;

  // Prevent duplicate saves for same value
  if (_savingItems[itemId] === actualQty) return;
  _savingItems[itemId] = actualQty;

  try {
    await api.put('/inventory/audits/' + currentAudit.id + '/items/' + itemId, { actualQty: actualQty });

    // Update local state
    var items = currentAudit.items || [];
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].id) === String(itemId)) {
        items[i] = Object.assign({}, items[i], { actualQty: actualQty });
        break;
      }
    }

    recalcDiff(inputEl);
  } catch (err) {
    showToast(err.message || 'Chyba pri ukladani', 'error');
  } finally {
    delete _savingItems[itemId];
  }
}

function recalcDiff(inputEl) {
  var row = inputEl.closest('tr');
  if (!row) return;
  var itemId = inputEl.dataset.itemId;
  var items = (currentAudit && currentAudit.items) || [];
  var item = null;
  for (var i = 0; i < items.length; i++) {
    if (String(items[i].id) === String(itemId)) { item = items[i]; break; }
  }
  if (!item) return;

  var expected = Number(item.expectedQty) || 0;
  var val = inputEl.value.trim();
  var diffCell = row.querySelector('td:last-child');
  if (!diffCell) return;

  if (val === '') {
    diffCell.className = 'text-right num';
    diffCell.textContent = '--';
    return;
  }

  var actual = parseFloat(val);
  if (isNaN(actual)) return;
  var diff = actual - expected;
  var sign = diff > 0 ? '+' : '';
  var diffText = sign + Number(diff).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var cls = diff > 0 ? 'color-success' : (diff < 0 ? 'color-danger' : '');
  diffCell.className = 'text-right num ' + cls;
  diffCell.textContent = diffText;
}

// === Complete audit ===
function completeAudit(auditId) {
  showConfirm(
    'Dokoncit inventuru',
    'Naozaj chcete dokoncit inventuru #' + auditId + '? Po dokonceni uz nebude mozne upravovat hodnoty.',
    async function () {
      try {
        await api.post('/inventory/audits/' + auditId + '/complete');
        showToast('Inventura dokoncena', true);
        await showDetail(auditId);
      } catch (err) {
        showToast(err.message || 'Chyba pri dokoncovani inventury', 'error');
      }
    },
    { confirmText: 'Dokoncit' }
  );
}

// === Cancel audit ===
function cancelAudit(auditId) {
  showConfirm(
    'Zrusit inventuru',
    'Naozaj chcete zrusit inventuru #' + auditId + '? Tato akcia sa neda vratit.',
    async function () {
      try {
        await api.post('/inventory/audits/' + auditId + '/cancel');
        showToast('Inventura zrusena', true);
        await showDetail(auditId);
      } catch (err) {
        showToast(err.message || 'Chyba pri ruseni inventury', 'error');
      }
    },
    { type: 'danger', confirmText: 'Zrusit inventuru' }
  );
}

// === Create new audit ===
async function createAudit() {
  var btn = $('#newAuditBtn');
  if (btn) btnLoading(btn);
  try {
    var result = await api.post('/inventory/audits', {});
    if (btn) btnReset(btn);
    if (result && result.id) {
      showToast('Inventura vytvorena', true);
      await showDetail(result.id);
    } else {
      showToast('Inventura vytvorena', true);
      await loadAudits();
    }
  } catch (err) {
    if (btn) btnReset(btn);
    showToast(err.message || 'Chyba pri vytvarani inventury', 'error');
  }
}

// === Switch to list view ===
function showListView() {
  currentView = 'list';
  currentAudit = null;
  _savingItems = {};
  renderLayout();
  loadAudits();
}

// === Render layout ===
function renderLayout() {
  if (!_container) return;
  _container.innerHTML = ''
    + '<div class="top-bar">'
    + '<button class="btn-add" id="newAuditBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Nova inventura'
    + '</button>'
    + '</div>'
    + '<div id="auditListWrap">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';

  $('#newAuditBtn').addEventListener('click', function () { createAudit(); });

  // Event delegation for detail buttons
  _container.addEventListener('click', function (e) {
    var viewBtn = e.target.closest('[data-view-id]');
    if (viewBtn) {
      showDetail(Number(viewBtn.dataset.viewId));
    }
  });
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  audits = [];
  currentAudit = null;
  currentView = 'list';
  _savingItems = {};

  renderLayout();
  loadAudits();
}

export function destroy() {
  audits = [];
  currentAudit = null;
  currentView = 'list';
  _savingItems = {};
  _container = null;
}
