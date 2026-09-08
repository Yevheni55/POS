// Inventory audit page module
import { mountEmptyState } from '../components/empty-state.js';

let audits = [];
let currentAudit = null;
let currentView = 'list'; // 'list' | 'detail'
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

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

// Stav ako pilulka: otvorená = treba dokončiť (jantár), zrušená = sivá,
// dokončená = zelená (v zozname ju nezobrazujeme — je to pravidlo).
var STATUS = {
  open:      { cls: 'is-warn', label: 'Otvorená' },
  completed: { cls: 'is-ok',   label: 'Dokončená' },
  cancelled: { cls: 'is-dim',  label: 'Zrušená' }
};
function statusPill(status) {
  var entry = STATUS[status] || { cls: 'is-dim', label: status || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}
function auditWord(n) {
  if (n === 1) return 'inventúra';
  if (n >= 2 && n <= 4) return 'inventúry';
  return 'inventúr';
}

// === Load audit list ===
async function loadAudits() {
  var tableWrap = $('#auditListWrap');
  if (tableWrap) showLoading(tableWrap, 'Načítavam inventúry…');
  try {
    var result = await api.get('/inventory/audits');
    if (tableWrap) hideLoading(tableWrap);
    audits = Array.isArray(result) ? result : [];
    renderList();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri načítaní inventúr', loadAudits);
  }
}

// === Render list view ===
function renderList() {
  var wrap = $('#auditListWrap');
  if (!wrap) return;

  var countEl = $('#auCount');
  if (countEl) {
    var open = audits.filter(function (a) { return a.status === 'open'; }).length;
    countEl.innerHTML = '<span><strong>' + audits.length + '</strong> ' + auditWord(audits.length) + '</span>'
      + (open ? '<span class="sk-pill is-warn">' + open + ' otvoren' + (open === 1 ? 'á' : (open <= 4 ? 'é' : 'ých')) + '</span>' : '');
  }

  if (!audits.length) {
    mountEmptyState(wrap, {
      icon: '📋',
      title: 'Žiadne inventúry',
      text: 'Inventúra zafixuje aktuálny stav skladu a porovná ho so skutočným. Začnite prvú.',
      ctaLabel: 'Nová inventúra',
      onCta: function () { createAudit(); },
    });
    return;
  }

  // Riadok: číslo + dátum, poznámka pod tým; stav ako pilulka len keď nie je
  // dokončená. Celý riadok otvára detail.
  wrap.innerHTML = '<div class="sk-list">' + audits.map(function (a) {
    return '<button type="button" class="sk-row' + (a.status === 'cancelled' ? ' is-off' : '') + '" data-view-id="' + a.id + '">'
      + '<span class="sk-row-main">'
      + '<span class="sk-row-name">Inventúra #' + a.id + '</span>'
      + '<span class="sk-row-sub">' + fmtDate(a.createdAt) + (a.note ? ' · ' + escapeHtml(a.note) : '') + '</span>'
      + '</span>'
      + '<span class="sk-row-side">' + (a.status === 'completed' ? '' : statusPill(a.status)) + '</span>'
      + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</button>';
  }).join('') + '</div>';
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
    showToast(err.message || 'Chyba pri načítaní inventúry', 'error');
    showListView();
  }
}

function renderSkeleton() {
  if (!_container) return;
  _container.innerHTML = ''
    + '<div class="sk-detail-head">'
    + '<button type="button" class="sk-back" id="backToListBtn"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>Späť</button>'
    + '<div class="skeleton skeleton-text" style="width:200px;height:24px"></div>'
    + '</div>'
    + '<div id="auditDetailWrap" class="sk-list">'
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

  var header = '<div class="sk-detail-head">'
    + '<button type="button" class="sk-back" id="backToListBtn"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>Späť</button>'
    + '<h2 class="sk-detail-title">Inventúra #' + a.id + ' ' + statusPill(a.status) + '</h2>';

  // Jedna plná akcia (dokončiť), zrušenie tónované červené.
  if (isOpen) {
    header += '<div class="sk-detail-actions">'
      + '<button type="button" class="btn-secondary is-danger" id="cancelAuditBtn">Zrušiť inventúru</button>'
      + '<button type="button" class="btn-primary" id="completeAuditBtn">Dokončiť inventúru</button>'
      + '</div>';
  }
  header += '</div>';

  var help = isOpen
    ? '<div class="sk-help" style="margin-bottom:var(--space-3)">Do stĺpca „Skutočné" zadajte, koľko ste napočítali. Hodnota sa uloží sama, keď pole opustíte.</div>'
    : '';

  var table = '';
  if (!items.length) {
    table = '<div class="empty-hint">Táto inventúra nemá žiadne položky.</div>';
  } else {
    // Triedy au-c-* sú kotvy pre mobilnú mriežku (surovina + skutočné hore,
    // očakávané + rozdiel dole). Rozdiel MUSÍ ostať posledná bunka —
    // recalcDiff ju hľadá cez td:last-child.
    table = '<div class="sk-table-wrap"><table class="sk-table au-table" id="auditItemsTable"><thead><tr>'
      + '<th class="au-c-name">Surovina</th>'
      + '<th class="num au-c-exp">Očakávané</th>'
      + '<th class="num au-c-actual">Skutočné</th>'
      + '<th class="num au-c-diff">Rozdiel</th>'
      + '</tr></thead><tbody>';

    items.forEach(function (item) {
      var actual = item.actualQty;
      var expected = Number(item.expectedQty) || 0;
      var hasActual = actual != null && actual !== '';
      var diff = hasActual ? (Number(actual) - expected) : null;
      var diffClass = '';
      var diffText = '';
      if (diff !== null) {
        diffClass = diff > 0 ? 'is-up' : (diff < 0 ? 'is-down' : '');
        var sign = diff > 0 ? '+' : '';
        diffText = sign + Number(diff).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      var unit = escapeHtml(item.ingredientUnit || '');

      table += '<tr data-item-id="' + item.id + '">';
      table += '<td class="td-name au-c-name">' + escapeHtml(item.ingredientName || ('Surovina #' + item.ingredientId)) + (unit ? '<span class="td-sub">' + unit + '</span>' : '') + '</td>';
      table += '<td class="num au-c-exp">' + fmtNum(expected) + (unit ? '\u00A0' + unit : '') + '</td>';
      table += '<td class="num au-c-actual">';

      if (isReadonly) {
        table += (hasActual ? fmtNum(actual) : '—');
      } else {
        table += '<input type="number" step="0.01" class="form-input actual-qty-input" '
          + 'data-item-id="' + item.id + '" '
          + 'value="' + (hasActual ? actual : '') + '" '
          + 'placeholder="—" aria-label="Skutočné množstvo">';
      }

      table += '</td>';
      table += '<td class="num au-c-diff ' + diffClass + '">' + diffText + '</td>';
      table += '</tr>';
    });

    table += '</tbody></table></div>';
  }

  _container.innerHTML = header + help + '<div id="auditDetailWrap" class="sk-list">' + table + '</div>';

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
    showToast(err.message || 'Chyba pri ukladaní', 'error');
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
    diffCell.className = 'num au-c-diff';
    diffCell.textContent = '';
    return;
  }

  var actual = parseFloat(val);
  if (isNaN(actual)) return;
  var diff = actual - expected;
  var sign = diff > 0 ? '+' : '';
  var diffText = sign + Number(diff).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var cls = diff > 0 ? 'is-up' : (diff < 0 ? 'is-down' : '');
  diffCell.className = 'num au-c-diff ' + cls;
  diffCell.textContent = diffText;
}

// === Complete audit ===
function completeAudit(auditId) {
  showConfirm(
    'Dokončiť inventúru',
    'Naozaj chcete dokončiť inventúru #' + auditId + '? Po dokončení sa sklad prepíše na napočítané hodnoty a už ich nebude možné upravovať.',
    async function () {
      try {
        await api.post('/inventory/audits/' + auditId + '/complete');
        showToast('Inventúra dokončená', true);
        await showDetail(auditId);
      } catch (err) {
        showToast(err.message || 'Chyba pri dokončovaní inventúry', 'error');
      }
    },
    { confirmText: 'Dokončiť' }
  );
}

// === Cancel audit ===
function cancelAudit(auditId) {
  showConfirm(
    'Zrušiť inventúru',
    'Naozaj chcete zrušiť inventúru #' + auditId + '? Táto akcia sa nedá vrátiť.',
    async function () {
      try {
        await api.post('/inventory/audits/' + auditId + '/cancel');
        showToast('Inventúra zrušená', true);
        await showDetail(auditId);
      } catch (err) {
        showToast(err.message || 'Chyba pri rušení inventúry', 'error');
      }
    },
    { type: 'danger', confirmText: 'Zrušiť inventúru' }
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
      showToast('Inventúra vytvorená', true);
      await showDetail(result.id);
    } else {
      showToast('Inventúra vytvorená', true);
      await loadAudits();
    }
  } catch (err) {
    if (btn) btnReset(btn);
    showToast(err.message || 'Chyba pri vytváraní inventúry', 'error');
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
    + '<div class="sk-head">'
    + '<div class="sk-sum" id="auCount" aria-live="polite"></div>'
    + '<button class="btn-add" id="newAuditBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Nová inventúra'
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

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-audit') {
      setTimeout(function () { createAudit(); }, 120);
    }
  }
}

export function destroy() {
  audits = [];
  currentAudit = null;
  currentView = 'list';
  _savingItems = {};
  _container = null;
}
