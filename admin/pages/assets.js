// Asset management (majetok) page module
let assets = [];
let summary = null;
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  kitchen_equipment: { label: 'Kuchyna',     cls: 'badge-success' },
  furniture:         { label: 'Nabytok',     cls: 'badge-info' },
  electronics:       { label: 'Elektronika', cls: 'badge-purple' },
  other:             { label: 'Ine',         cls: '' }
};

function categoryBadge(cat) {
  var entry = CATEGORIES[cat] || CATEGORIES.other;
  return '<span class="badge ' + entry.cls + '">' + escHtml(entry.label) + '</span>';
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
  if (tableWrap) showLoading(tableWrap, 'Nacitavam majetok...');
  try {
    assets = await api.get('/inventory/assets');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri nacitani majetku', loadAssets);
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
  }
}

// === Render table ===
function renderTable() {
  var tableWrap = $('#assetsTable');
  if (!tableWrap) return;

  if (!assets || !assets.length) {
    tableWrap.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">&#128188;</div>'
      + '<div class="empty-state-title">Ziadny majetok</div>'
      + '<div class="empty-state-text">Pridajte zariadenie kliknutim na "Pridat zariadenie".</div>'
      + '</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>';
  html += '<th>Názov</th>';
  html += '<th>Kategória</th>';
  html += '<th class="text-right">Nákupná cena</th>';
  html += '<th>Dátum nákupu</th>';
  html += '<th class="text-right">Mesačný odpis</th>';
  html += '<th class="text-right">Aktuálna hodnota</th>';
  html += '<th>% odpisane</th>';
  html += '<th class="text-right">Akcie</th>';
  html += '</tr></thead><tbody>';

  assets.forEach(function (a) {
    var pct = depreciatedPct(a);
    var barColor = pct >= 90 ? 'var(--color-danger)' : (pct >= 60 ? 'var(--color-warning)' : 'var(--color-success)');

    html += '<tr class="data-row" data-view-id="' + a.id + '" style="cursor:pointer">';
    html += '<td class="td-name">' + escHtml(a.name) + '</td>';
    html += '<td>' + categoryBadge(a.category) + '</td>';
    html += '<td class="text-right num">' + fmtEur(a.purchasePrice) + '</td>';
    html += '<td>' + fmtDate(a.purchaseDate) + '</td>';
    html += '<td class="text-right num">' + fmtEur(a.monthlyDepreciation) + '</td>';
    html += '<td class="text-right num">' + fmtEur(a.currentValue) + '</td>';
    html += '<td>'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<div style="flex:1;height:6px;background:var(--color-border);border-radius:3px;overflow:hidden;min-width:60px">'
      + '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:' + barColor + ';border-radius:3px;transition:width .3s"></div>'
      + '</div>'
      + '<span class="num" style="font-size:11px;min-width:36px;text-align:right">' + pct.toFixed(0) + '%</span>'
      + '</div>'
      + '</td>';
    html += '<td class="text-right"><div class="prod-actions">';
    html += '<button class="act-btn" data-detail-id="' + a.id + '" title="Detail">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
      + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      + '</button>';
    html += '<button class="act-btn" data-edit-id="' + a.id + '" title="Upravit">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>'
      + '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
      + '</button>';
    html += '<button class="act-btn del" data-delete-id="' + a.id + '" data-delete-name="' + escHtml(a.name) + '" title="Zmazat">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<polyline points="3 6 5 6 21 6"/>'
      + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      + '</button>';
    html += '</div></td></tr>';
  });

  html += '</tbody></table></div>';
  tableWrap.innerHTML = html;
}

// === Add/Edit asset modal ===
function openAddEditModal(id) {
  var existing = document.getElementById('assetModal');
  if (existing) existing.remove();

  var item = id ? assets.find(function (a) { return a.id === id; }) : null;
  var title = item ? 'Upravit zariadenie' : 'Pridat zariadenie';

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
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:520px">'
    + '<div class="u-modal-title" style="text-align:center">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fName" class="form-input" type="text" placeholder="napr. Konvekcna rura" data-validate="required" value="' + escHtml(item ? item.name : '') + '">'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="fCategory">Kategoria</label>'
    + '<select id="fCategory" class="form-select">' + catOptions + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fPurchaseDate">Datum nakupu<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fPurchaseDate" class="form-input" type="date" data-validate="required" value="' + purchaseDate + '">'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="fPurchasePrice">Nakupna cena (EUR)<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fPurchasePrice" class="form-input" type="number" step="0.01" min="0" data-validate="required" placeholder="0.00" value="' + (item ? item.purchasePrice : '') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fResidualValue">Zostatkovs hodnota (EUR)</label>'
    + '<input id="fResidualValue" class="form-input" type="number" step="0.01" min="0" placeholder="0" value="' + (item ? (item.residualValue || 0) : '0') + '">'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fUsefulLife">Doba zivotnosti (mesiace)<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fUsefulLife" class="form-input" type="number" step="1" min="1" data-validate="required" placeholder="60" value="' + (item ? item.usefulLifeMonths : '') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fNote">Poznamka</label>'
    + '<input id="fNote" class="form-input" type="text" placeholder="Volitelna poznamka" value="' + escHtml(item ? (item.note || '') : '') + '">'
    + '</div>'
    + '<div id="depPreview" style="padding:10px 14px;background:var(--color-surface-raised);border-radius:8px;font-size:13px;color:var(--color-text-dim);margin-top:4px">'
    + 'Mesacny odpis: --'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="assetModalCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="assetModalSave">' + (item ? 'Ulozit' : 'Pridat') + '</button>'
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
      preview.textContent = 'Mesacny odpis: ' + fmtEur(dep);
    } else {
      preview.textContent = 'Mesacny odpis: --';
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

    if (!name) { showToast('Zadajte nazov zariadenia', 'error'); return; }
    if (!purchaseDateVal) { showToast('Zadajte datum nakupu', 'error'); return; }
    if (usefulLifeMonths < 1) { showToast('Doba zivotnosti musi byt aspon 1 mesiac', 'error'); return; }

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
        showToast('Zariadenie upravene', true);
      } else {
        await api.post('/inventory/assets', payload);
        showToast('Zariadenie pridane', true);
      }
      closeModal();
      loadAssets();
      loadSummary();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladani', 'error');
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
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:600px">'
    + '<div class="u-modal-title" style="text-align:center">Nacitavam detail...</div>'
    + '<div class="u-modal-body" style="min-height:120px">'
    + '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="detailClose">Zavriet</button>'
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
  } catch (err) {
    var modal = ov.querySelector('.u-modal');
    if (modal) {
      modal.querySelector('.u-modal-title').textContent = 'Chyba';
      modal.querySelector('.u-modal-body').innerHTML =
        '<div style="text-align:center;color:var(--color-danger);padding:20px">' + escHtml(err.message || 'Nepodarilo sa nacitat detail') + '</div>';
    }
  }
}

function renderDetailContent(ov, asset) {
  var modal = ov.querySelector('.u-modal');
  if (!modal) return;

  var pct = depreciatedPct(asset);
  var barColor = pct >= 90 ? 'var(--color-danger)' : (pct >= 60 ? 'var(--color-warning)' : 'var(--color-success)');

  var depreciations = Array.isArray(asset.depreciations) ? asset.depreciations : [];

  var infoHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin-bottom:20px">'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Nazov</div><div style="font-weight:600">' + escHtml(asset.name) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Kategoria</div><div>' + categoryBadge(asset.category) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Nakupna cena</div><div class="num" style="font-weight:600">' + fmtEur(asset.purchasePrice) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Datum nakupu</div><div>' + fmtDate(asset.purchaseDate) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Doba zivotnosti</div><div>' + (asset.usefulLifeMonths || '--') + ' mesiacov</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim);margin-bottom:2px">Zostatkovs hodnota</div><div class="num">' + fmtEur(asset.residualValue) + '</div></div>'
    + '</div>';

  var stateHtml = '<div style="padding:14px;background:var(--color-surface-raised);border-radius:10px;margin-bottom:20px">'
    + '<div style="font-weight:600;margin-bottom:10px;font-size:13px">Aktualny stav</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">'
    + '<div><div style="font-size:11px;color:var(--color-text-dim)">Aktualna hodnota</div><div class="num" style="font-weight:600;font-size:15px">' + fmtEur(asset.currentValue) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim)">Celkovo odpisane</div><div class="num" style="font-weight:600;font-size:15px">' + fmtEur(asset.totalDepreciated) + '</div></div>'
    + '<div><div style="font-size:11px;color:var(--color-text-dim)">Mesacny odpis</div><div class="num" style="font-weight:600;font-size:15px">' + fmtEur(asset.monthlyDepreciation) + '</div></div>'
    + '</div>'
    + '<div style="display:flex;align-items:center;gap:10px">'
    + '<div style="flex:1;height:8px;background:var(--color-border);border-radius:4px;overflow:hidden">'
    + '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:' + barColor + ';border-radius:4px;transition:width .3s"></div>'
    + '</div>'
    + '<span class="num" style="font-size:12px;font-weight:600;min-width:40px;text-align:right">' + pct.toFixed(1) + '%</span>'
    + '</div>'
    + '</div>';

  var historyHtml = '';
  if (depreciations.length > 0) {
    historyHtml = '<div style="font-weight:600;margin-bottom:8px;font-size:13px">História odpisov</div>'
      + '<div style="max-height:200px;overflow-y:auto">'
      + '<div class="table-scroll-wrap">'
      + '<table class="data-table"><thead><tr>'
      + '<th>Mesiac</th>'
      + '<th class="text-right">Suma odpisu</th>'
      + '<th class="text-right">Hodnota pred</th>'
      + '<th class="text-right">Hodnota po</th>'
      + '</tr></thead><tbody>';

    depreciations.forEach(function (d) {
      historyHtml += '<tr>';
      historyHtml += '<td>' + fmtMonth(d.month) + '</td>';
      historyHtml += '<td class="text-right num">' + fmtEur(d.amount) + '</td>';
      historyHtml += '<td class="text-right num">' + fmtEur(d.previousValue) + '</td>';
      historyHtml += '<td class="text-right num">' + fmtEur(d.newValue) + '</td>';
      historyHtml += '</tr>';
    });

    historyHtml += '</tbody></table></div></div>';
  } else {
    historyHtml = '<div style="font-weight:600;margin-bottom:8px;font-size:13px">História odpisov</div>'
      + '<div style="text-align:center;color:var(--color-text-dim);padding:16px;font-size:13px">Žiadne odpisy zatiaľ</div>';
  }

  modal.querySelector('.u-modal-title').textContent = escHtml(asset.name);
  modal.querySelector('.u-modal-body').innerHTML = infoHtml + stateHtml + historyHtml;
}

// === Delete asset ===
function deleteAsset(id, name) {
  showConfirm(
    'Zmazat zariadenie',
    'Naozaj chcete zmazat "' + escHtml(name) + '"? Tato akcia sa neda vratit.',
    async function () {
      try {
        await api.del('/inventory/assets/' + id);
        showToast('Zariadenie odstranene', true);
        loadAssets();
        loadSummary();
      } catch (err) {
        showToast(err.message || 'Chyba pri mazani', 'error');
      }
    },
    { type: 'danger' }
  );
}

// === Run depreciation ===
function runDepreciation() {
  showConfirm(
    'Spustit mesacny odpis',
    'Naozaj chcete spustit mesacny odpis pre vsetky zariadenia? Tuto akciu nie je mozne vratit.',
    async function () {
      var btn = $('#runDepBtn');
      if (btn) btnLoading(btn);
      try {
        var result = await api.post('/inventory/assets/run-depreciation');
        var msg = 'Odpis dokonceny: ' + (result.processed || 0) + ' zariadeni';
        if (result.month) msg += ' (' + fmtMonth(result.month) + ')';
        showToast(msg, true);
        loadAssets();
        loadSummary();
      } catch (err) {
        showToast(err.message || 'Chyba pri spusteni odpisu', 'error');
      } finally {
        if (btn) btnReset(btn);
      }
    },
    { confirmText: 'Spustit odpis' }
  );
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  assets = [];
  summary = null;

  container.innerHTML = ''
    // Stat cards
    + '<div class="stat-grid grid-3col">'
    + '<div class="stat-card">'
    + '<div class="stat-icon mint">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Celkova hodnota majetku</div>'
    + '<div class="stat-value skeleton skeleton-text" id="statValue">&nbsp;</div>'
    + '</div>'
    + '</div>'
    + '<div class="stat-card">'
    + '<div class="stat-icon lavender">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Mesacny odpis</div>'
    + '<div class="stat-value skeleton skeleton-text" id="statDep">&nbsp;</div>'
    + '</div>'
    + '</div>'
    + '<div class="stat-card">'
    + '<div class="stat-icon" style="background:rgba(130,170,255,.12);color:var(--color-info)">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Pocet zariadeni</div>'
    + '<div class="stat-value skeleton skeleton-text" id="statCount">&nbsp;</div>'
    + '</div>'
    + '</div>'
    + '</div>'

    // Top bar
    + '<div class="top-bar" style="margin-top:16px">'
    + '<button class="btn-add" id="addAssetBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Pridat zariadenie'
    + '</button>'
    + '<button class="u-btn u-btn-ghost" id="runDepBtn" style="margin-left:auto">'
    + '<svg viewBox="0 0 24 24" width="14" height="14" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:6px">'
    + '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
    + 'Spustit mesacny odpis'
    + '</button>'
    + '</div>'

    // Data table wrapper
    + '<div id="assetsTable">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';

  // Bind buttons
  $('#addAssetBtn').addEventListener('click', function () { openAddEditModal(); });
  $('#runDepBtn').addEventListener('click', function () { runDepreciation(); });

  // Event delegation for table actions
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
