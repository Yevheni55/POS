// Asset management (majetok) page module
import { mountEmptyState } from '../components/empty-state.js';
import { softDelete } from '../components/toast-undo.js';

let assets = [];
let summary = null;
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
function escHtml(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtEur(n) {
  return Number(n || 0).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

function fmtDate(isoStr) {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtMonth(isoStr) {
  if (!isoStr) return '--';
  var d = new Date(isoStr);
  return d.toLocaleDateString('sk-SK', { month: '2-digit', year: 'numeric' });
}

var CATEGORIES = {
  kitchen_equipment: { label: 'Kuchyňa' },
  furniture:         { label: 'Nábytok' },
  electronics:       { label: 'Elektronika' },
  other:             { label: 'Iné' }
};

// Kategória je zaradenie, nie stav — text, nie farebná pilulka.
function categoryLabel(cat) {
  return (CATEGORIES[cat] || CATEGORIES.other).label;
}
function assetWord(n) {
  if (n === 1) return 'zariadenie';
  if (n >= 2 && n <= 4) return 'zariadenia';
  return 'zariadení';
}
function meterClass(pct) {
  return pct >= 90 ? ' is-danger' : (pct >= 60 ? ' is-warn' : '');
}

function calcMonthlyDep(purchasePrice, residualValue, usefulLifeMonths) {
  var pp = parseFloat(purchasePrice) || 0;
  var rv = parseFloat(residualValue) || 0;
  var months = parseInt(usefulLifeMonths) || 1;
  if (months <= 0) months = 1;
  var dep = (pp - rv) / months;
  return dep > 0 ? dep : 0;
}

function depreciatedPct(asset) {
  var pp = Number(asset.purchasePrice) || 0;
  var rv = Number(asset.residualValue) || 0;
  var depreciable = pp - rv;
  if (depreciable <= 0) return 0;
  var totalDep = Number(asset.totalDepreciated) || 0;
  var pct = (totalDep / depreciable) * 100;
  return Math.min(pct, 100);
}

// === Load data ===
async function loadAssets() {
  var tableWrap = $('#assetsTable');
  if (tableWrap) showLoading(tableWrap, 'Načítavam majetok…');
  try {
    assets = await api.get('/inventory/assets');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri načítaní majetku', loadAssets);
  }
}

async function loadSummary() {
  try {
    summary = await api.get('/inventory/assets-summary');
    renderStats();
  } catch (_err) {
    summary = null;
  }
}

function renderStats() {
  if (!summary || !_container) return;

  var valEl = $('#statValue');
  var depEl = $('#statDep');
  var cntEl = $('#statCount');

  if (valEl) {
    valEl.textContent = fmtEur(summary.totalCurrentValue);
    valEl.classList.remove('skeleton', 'skeleton-text');
  }
  if (depEl) {
    depEl.textContent = fmtEur(summary.totalMonthlyDepreciation);
    depEl.classList.remove('skeleton', 'skeleton-text');
  }
  if (cntEl) {
    cntEl.textContent = Number(summary.count || 0).toLocaleString('sk-SK');
    cntEl.classList.remove('skeleton', 'skeleton-text');
    var w = $('#statCountWord'); if (w) w.textContent = assetWord(Number(summary.count || 0));
  }
}

// === Render table ===
function renderTable() {
  var tableWrap = $('#assetsTable');
  if (!tableWrap) return;

  if (!assets || !assets.length) {
    mountEmptyState(tableWrap, {
      icon: '💼',
      title: 'Žiadny majetok',
      text: 'Tu sa zobrazujú odpisovateľné zariadenia (chladnička, espresso, nábytok). Pridajte prvé.',
      ctaLabel: 'Pridať zariadenie',
      onCta: function () { openAddEditModal(null); },
    });
    return;
  }

  // Riadok: názov + kategória · dátum nákupu · mesačný odpis; vpravo aktuálna
  // hodnota a % odpísané; pod riadkom tenký ukazovateľ. Celý riadok otvára
  // detail (upraviť / odstrániť sú v ňom).
  tableWrap.innerHTML = '<div class="sk-list">' + assets.map(function (a) {
    var pct = depreciatedPct(a);
    return '<button type="button" class="sk-row" data-view-id="' + a.id + '">'
      + '<span class="sk-row-main">'
      + '<span class="sk-row-name">' + escHtml(a.name) + '</span>'
      + '<span class="sk-row-sub">' + escHtml(categoryLabel(a.category)) + ' · kúpené ' + fmtDate(a.purchaseDate) + ' · odpis ' + fmtEur(a.monthlyDepreciation) + '/mes.</span>'
      + '</span>'
      + '<span class="sk-row-side">'
      + '<span class="sk-row-num">' + fmtEur(a.currentValue) + '</span>'
      + '<span class="sk-row-meta">odpísané ' + pct.toFixed(0) + ' % z ' + fmtEur(a.purchasePrice) + '</span>'
      + '</span>'
      + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '<span class="sk-meter' + meterClass(pct) + '" aria-hidden="true"><span style="width:' + pct.toFixed(1) + '%"></span></span>'
      + '</button>';
  }).join('') + '</div>';
}

// === Add/Edit asset modal ===
function openAddEditModal(id) {
  var existing = document.getElementById('assetModal');
  if (existing) existing.remove();

  var item = id ? assets.find(function (a) { return a.id === id; }) : null;
  var title = item ? 'Upraviť zariadenie' : 'Pridať zariadenie';

  var catOptions = Object.keys(CATEGORIES).map(function (key) {
    var sel = item && item.category === key ? ' selected' : (!item && key === 'kitchen_equipment' ? ' selected' : '');
    return '<option value="' + key + '"' + sel + '>' + CATEGORIES[key].label + '</option>';
  }).join('');

  var purchaseDate = '';
  if (item && item.purchaseDate) {
    purchaseDate = item.purchaseDate.substring(0, 10);
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'assetModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:520px">'
    + '<div class="u-modal-title">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fName" class="form-input" type="text" placeholder="napr. Konvekčná rúra" data-validate="required" value="' + escHtml(item ? item.name : '') + '">'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="fCategory">Kategória</label>'
    + '<select id="fCategory" class="form-select">' + catOptions + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fPurchaseDate">Dátum nákupu<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fPurchaseDate" class="form-input" type="date" data-validate="required" value="' + purchaseDate + '">'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="fPurchasePrice">Nákupná cena (€)<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fPurchasePrice" class="form-input" type="number" step="0.01" min="0" data-validate="required" placeholder="0,00" value="' + (item ? item.purchasePrice : '') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fResidualValue">Zostatková hodnota (€)</label>'
    + '<input id="fResidualValue" class="form-input" type="number" step="0.01" min="0" placeholder="0" value="' + (item ? (item.residualValue || 0) : '0') + '">'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fUsefulLife">Doba životnosti (mesiace)<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fUsefulLife" class="form-input" type="number" step="1" min="1" data-validate="required" placeholder="60" value="' + (item ? item.usefulLifeMonths : '') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fNote">Poznámka</label>'
    + '<input id="fNote" class="form-input" type="text" placeholder="Voliteľná poznámka" value="' + escHtml(item ? (item.note || '') : '') + '">'
    + '</div>'
    + '<div id="depPreview" class="sk-preview" aria-live="polite">Mesačný odpis: —</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="assetModalCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="assetModalSave">' + (item ? 'Uložiť zmeny' : 'Pridať zariadenie') + '</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });
  setTimeout(function () { ov.querySelector('#fName').focus(); }, 100);

  wireValidation(ov);

  // Depreciation preview
  function updatePreview() {
    var pp = ov.querySelector('#fPurchasePrice').value;
    var rv = ov.querySelector('#fResidualValue').value;
    var months = ov.querySelector('#fUsefulLife').value;
    var preview = ov.querySelector('#depPreview');
    if (!preview) return;

    if (pp && months && parseInt(months) > 0) {
      var dep = calcMonthlyDep(pp, rv, months);
      preview.innerHTML = 'Mesačný odpis: <strong>' + fmtEur(dep) + '</strong>';
    } else {
      preview.textContent = 'Mesačný odpis: —';
    }
  }

  ov.querySelector('#fPurchasePrice').addEventListener('input', updatePreview);
  ov.querySelector('#fResidualValue').addEventListener('input', updatePreview);
  ov.querySelector('#fUsefulLife').addEventListener('input', updatePreview);
  updatePreview();

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  ov.querySelector('#assetModalCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  ov.querySelector('#assetModalSave').addEventListener('click', async function () {
    if (!validateForm(ov)) return;

    var name = ov.querySelector('#fName').value.trim();
    var category = ov.querySelector('#fCategory').value;
    var purchasePrice = parseFloat(ov.querySelector('#fPurchasePrice').value) || 0;
    var purchaseDateVal = ov.querySelector('#fPurchaseDate').value;
    var usefulLifeMonths = parseInt(ov.querySelector('#fUsefulLife').value) || 0;
    var residualValue = parseFloat(ov.querySelector('#fResidualValue').value) || 0;
    var note = ov.querySelector('#fNote').value.trim();

    if (!name) { showToast('Zadajte názov zariadenia', 'error'); return; }
    if (!purchaseDateVal) { showToast('Zadajte dátum nákupu', 'error'); return; }
    if (usefulLifeMonths < 1) { showToast('Doba životnosti musí byť aspoň 1 mesiac', 'error'); return; }

    var btn = ov.querySelector('#assetModalSave');
    btnLoading(btn);
    try {
      var payload = {
        name: name,
        category: category,
        purchasePrice: purchasePrice,
        purchaseDate: purchaseDateVal,
        usefulLifeMonths: usefulLifeMonths,
        residualValue: residualValue,
        note: note || undefined
      };

      if (id) {
        await api.put('/inventory/assets/' + id, payload);
        showToast('Zariadenie upravené', true);
      } else {
        await api.post('/inventory/assets', payload);
        showToast('Zariadenie pridané', true);
      }
      closeModal();
      loadAssets();
      loadSummary();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladaní', 'error');
    } finally {
      btnReset(btn);
    }
  });
}

// === Detail modal ===
async function openDetailModal(id) {
  var existing = document.getElementById('assetDetailModal');
  if (existing) existing.remove();

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'assetDetailModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:600px">'
    + '<div class="u-modal-title">Načítavam…</div>'
    + '<div class="u-modal-body">'
    + '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="detailClose">Zavrieť</button>'
    + '</div></div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  ov.querySelector('#detailClose').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  try {
    var asset = await api.get('/inventory/assets/' + id);
    renderDetailContent(ov, asset);
    // Upraviť / odstrániť boli ikony na každom riadku zoznamu — patria sem.
    var editBtn = ov.querySelector('#assetDetailEdit');
    if (editBtn) editBtn.addEventListener('click', function () { closeModal(); openAddEditModal(id); });
    var delBtn = ov.querySelector('#assetDetailDelete');
    if (delBtn) delBtn.addEventListener('click', function () { closeModal(); deleteAsset(id, asset.name); });
  } catch (err) {
    var modal = ov.querySelector('.u-modal');
    if (modal) {
      modal.querySelector('.u-modal-title').textContent = 'Chyba';
      modal.querySelector('.u-modal-body').innerHTML =
        '<div class="error-hint">' + escHtml(err.message || 'Nepodarilo sa načítať detail') + '</div>';
    }
  }
}

function renderDetailContent(ov, asset) {
  var modal = ov.querySelector('.u-modal');
  if (!modal) return;

  var pct = depreciatedPct(asset);
  var depreciations = Array.isArray(asset.depreciations) ? asset.depreciations : [];

  var kv = function (k, v, num) {
    return '<div><span class="sk-kv-k">' + k + '</span><span class="sk-kv-v' + (num ? ' num' : '') + '">' + v + '</span></div>';
  };

  // Aktuálna hodnota je hlavná odpoveď — veľké číslo + ukazovateľ; zvyšok
  // ako kľúč–hodnota.
  var stateHtml = '<div class="sk-total" style="border-top:0;padding-top:0"><span>Aktuálna hodnota</span><strong>' + fmtEur(asset.currentValue) + '</strong></div>'
    + '<span class="sk-meter' + meterClass(pct) + '" aria-hidden="true"><span style="width:' + pct.toFixed(1) + '%"></span></span>'
    + '<div class="sk-note">Odpísané ' + pct.toFixed(1).replace('.', ',') + ' % — ' + fmtEur(asset.totalDepreciated) + ' z ' + fmtEur(asset.purchasePrice) + ', ' + fmtEur(asset.monthlyDepreciation) + ' mesačne.</div>';

  var infoHtml = '<div class="sk-kv">'
    + kv('Kategória', escHtml(categoryLabel(asset.category)))
    + kv('Dátum nákupu', fmtDate(asset.purchaseDate), true)
    + kv('Nákupná cena', fmtEur(asset.purchasePrice), true)
    + kv('Zostatková hodnota', fmtEur(asset.residualValue), true)
    + kv('Doba životnosti', (asset.usefulLifeMonths || '—') + ' mesiacov', true)
    + (asset.note ? kv('Poznámka', escHtml(asset.note)) : '')
    + '</div>';

  var historyHtml = '<div class="sk-label">História odpisov</div>';
  if (depreciations.length > 0) {
    historyHtml += '<div class="sk-items">' + depreciations.map(function (d) {
      return '<div class="sk-item">'
        + '<div class="sk-item-main"><span class="sk-item-name">' + fmtMonth(d.month) + '</span></div>'
        + '<div class="sk-item-side"><span class="sk-item-num">−' + fmtEur(d.amount) + '</span>'
        + '<span class="sk-item-meta">' + fmtEur(d.previousValue) + ' → ' + fmtEur(d.newValue) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
  } else {
    historyHtml += '<div class="empty-hint">Zatiaľ žiadne odpisy. Mesačný odpis spustíte tlačidlom na stránke Majetok.</div>';
  }

  var actions = '<div class="sk-actions">'
    + '<button type="button" class="u-btn u-btn-ghost" id="assetDetailEdit">Upraviť</button>'
    + '<button type="button" class="u-btn u-btn-rose" id="assetDetailDelete">Odstrániť</button>'
    + '</div>';

  modal.querySelector('.u-modal-title').textContent = asset.name;
  modal.querySelector('.u-modal-body').innerHTML = stateHtml + infoHtml + historyHtml + actions;
}

// === Delete asset (optimistic + undo-toast) ===
async function deleteAsset(id, name) {
  const idx = assets.findIndex(a => a.id === id);
  if (idx < 0) return;
  const snapshot = assets[idx];

  // Optimistic remove
  assets.splice(idx, 1);
  renderTable();

  const result = await softDelete({
    label: '„' + name + '" odstránené',
    deleteFn: function () { return api.del('/inventory/assets/' + id); },
  });

  if (result.undone) {
    assets.splice(idx, 0, snapshot);
    renderTable();
    showToast('Vrátené', true);
  } else if (result.error) {
    assets.splice(idx, 0, snapshot);
    renderTable();
  } else {
    // Commited — reload summary stats (depreciation totals zmenene)
    loadSummary();
  }
}

// === Run depreciation ===
function runDepreciation() {
  showConfirm(
    'Spustiť mesačný odpis',
    'Naozaj chcete spustiť mesačný odpis pre všetky zariadenia? Túto akciu nie je možné vrátiť.',
    async function () {
      var btn = $('#runDepBtn');
      if (btn) btnLoading(btn);
      try {
        var result = await api.post('/inventory/assets/run-depreciation');
        var msg = 'Odpis dokončený: ' + (result.processed || 0) + ' ' + assetWord(result.processed || 0);
        if (result.month) msg += ' (' + fmtMonth(result.month) + ')';
        showToast(msg, true);
        loadAssets();
        loadSummary();
      } catch (err) {
        showToast(err.message || 'Chyba pri spustení odpisu', 'error');
      } finally {
        if (btn) btnReset(btn);
      }
    },
    { confirmText: 'Spustiť odpis' }
  );
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  assets = [];
  summary = null;

  container.innerHTML = ''
    // Súčet: jeden riadok namiesto troch kariet
    + '<div class="sk-sum">'
    + '<span>Hodnota majetku <strong id="statValue" class="skeleton skeleton-text">&nbsp;</strong></span>'
    + '<span>Mesačný odpis <strong id="statDep" class="skeleton skeleton-text">&nbsp;</strong></span>'
    + '<span><strong id="statCount" class="skeleton skeleton-text">&nbsp;</strong> <span id="statCountWord">zariadení</span></span>'
    + '</div>'

    // Hlavička: jedna plná akcia, odpis tónovaný
    + '<div class="sk-head">'
    + '<div class="sk-head-actions">'
    + '<button class="btn-secondary" id="runDepBtn" type="button">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
    + 'Spustiť mesačný odpis'
    + '</button>'
    + '<button class="btn-add" id="addAssetBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Pridať zariadenie'
    + '</button>'
    + '</div>'
    + '</div>'

    // Zoznam
    + '<div id="assetsTable">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';

  // Bind buttons
  $('#addAssetBtn').addEventListener('click', function () { openAddEditModal(); });
  $('#runDepBtn').addEventListener('click', function () { runDepreciation(); });

  // Event delegation for list actions
  container.addEventListener('click', function (e) {
    var detailBtn = e.target.closest('[data-detail-id]');
    if (detailBtn) {
      e.stopPropagation();
      openDetailModal(Number(detailBtn.dataset.detailId));
      return;
    }
    var editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      e.stopPropagation();
      openAddEditModal(Number(editBtn.dataset.editId));
      return;
    }
    var deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      e.stopPropagation();
      deleteAsset(Number(deleteBtn.dataset.deleteId), deleteBtn.dataset.deleteName);
      return;
    }
    // Row click opens detail
    var row = e.target.closest('[data-view-id]');
    if (row) {
      openDetailModal(Number(row.dataset.viewId));
      return;
    }
  });

  // Escape key handler
  _escHandler = function (e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('assetModal');
      if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(function () { modal.remove(); }, 300);
        return;
      }
      var detailModal = document.getElementById('assetDetailModal');
      if (detailModal && detailModal.classList.contains('show')) {
        detailModal.classList.remove('show');
        setTimeout(function () { detailModal.remove(); }, 300);
      }
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data
  loadAssets();
  loadSummary();

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-asset') {
      setTimeout(function () { openAddEditModal(); }, 120);
    }
  }
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  var modal = document.getElementById('assetModal');
  if (modal) modal.remove();
  var detailModal = document.getElementById('assetDetailModal');
  if (detailModal) detailModal.remove();

  assets = [];
  summary = null;
  _container = null;
}
