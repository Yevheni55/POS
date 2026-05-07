// Ingredients page module
let ingredients = [];
let editingId = null;
let searchTerm = '';

let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function fmtNum(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// fmtCost — adaptívny formát ceny podľa jej veľkosti.
// Predtým fmtNum (2 desatinné) zobrazoval sub-centové ceny per-gram ako
// "0,00 €" (napr. múka 0,00075 €/g) a operátor mal pocit že cena sa
// stratila / nedelila sa. Teraz: ≥1€ → 2 desatinné, ≥0,01€ → 2-4
// desatinné, sub-cent → 4-5 desatinných miest.
function fmtCost(n) {
  var x = Number(n);
  if (!isFinite(x) || x === 0) return '0,00';
  var abs = Math.abs(x);
  if (abs >= 1) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 0.01) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return x.toLocaleString('sk-SK', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

function getStatusBadge(item) {
  if (item.currentQty <= 0) {
    return '<span class="badge badge-danger">Prazdny</span>';
  }
  if (item.currentQty <= item.minQty) {
    return '<span class="badge badge-warning">Nizky</span>';
  }
  return '<span class="badge badge-success">OK</span>';
}

// === Load data ===
async function loadIngredients() {
  const tableWrap = $('#ingredientsTable');
  if (tableWrap) showLoading(tableWrap, 'Nacitavam suroviny...');
  try {
    ingredients = await api.get('/inventory/ingredients?type=ingredient');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri nacitani surovin', loadIngredients);
  }
}

// === Render table ===
function renderTable() {
  const tableWrap = $('#ingredientsTable');
  if (!tableWrap) return;

  const filtered = ingredients.filter(function (item) {
    if (!searchTerm) return true;
    return item.name.toLowerCase().includes(searchTerm);
  });

  if (!filtered.length) {
    var emptyMsg = searchTerm
      ? 'Ziadne vysledky pre "' + searchTerm + '"'
      : 'Ziadne suroviny. Kliknite "Pridat surovinu" pre vytvorenie.';
    tableWrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div>'
      + '<div class="empty-state-title">' + (searchTerm ? 'Ziadne vysledky' : 'Ziadne suroviny') + '</div>'
      + '<div class="empty-state-text">' + emptyMsg + '</div></div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table">';
  html += '<thead><tr>';
  var ths = ['Názov', 'Jednotka', 'Aktuálne množstvo', 'Minimum', 'Cena/jedn.', 'Stav', 'Akcie'];
  var alignClasses = ['', '', 'text-right', 'text-right', 'text-right', 'text-center', 'text-right'];
  ths.forEach(function (t, idx) {
    html += '<th class="data-th ' + alignClasses[idx] + '">' + t + '</th>';
  });
  html += '</tr></thead><tbody>';

  filtered.forEach(function (item) {
    html += '<tr class="data-row">';
    html += '<td class="data-td td-name">' + item.name + '</td>';
    html += '<td class="data-td td-sec">' + item.unit + '</td>';
    html += '<td class="data-td text-right num">' + fmtNum(item.currentQty) + '</td>';
    html += '<td class="data-td text-right num td-sec">' + fmtNum(item.minQty) + '</td>';
    // \u20AC/jednotka \u2014 pridanie sufixu "/g", "/l", "/ks" hne\u010F za sumou aby
    // bolo jednozna\u010Dn\u00E9 ze cena je per-gram/liter, nie za balenie.
    // Pre sub-centov\u00E9 ceny zobraz\u00EDme 4-5 desatinn\u00FDch miest cez fmtCost.
    html += '<td class="data-td text-right num">' + fmtCost(item.costPerUnit) + '\u00A0\u20AC/' + item.unit + '</td>';
    html += '<td class="data-td text-center">' + getStatusBadge(item) + '</td>';
    html += '<td class="data-td text-right"><div class="prod-actions">';
    html += '<button class="act-btn" data-edit-id="' + item.id + '" title="Upravit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
    html += '<button class="act-btn del" data-delete-id="' + item.id + '" data-delete-name="' + item.name.replace(/"/g, '&quot;') + '" title="Zmazat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
    html += '</div></td></tr>';
  });

  html += '</tbody></table></div>';
  tableWrap.innerHTML = html;
}

// === Modal ===
function openModal(id) {
  editingId = id || null;

  var existing = document.getElementById('ingredientModal');
  if (existing) existing.remove();

  var item = editingId ? ingredients.find(function (i) { return i.id === editingId; }) : null;
  var title = item ? 'Upravit surovinu' : 'Pridat surovinu';

  var unitOptions = ['ks', 'kg', 'g', 'l', 'ml'];
  var unitOpts = unitOptions.map(function (u) {
    var selected = item && item.unit === u ? ' selected' : (!item && u === 'ks' ? ' selected' : '');
    return '<option value="' + u + '"' + selected + '>' + u + '</option>';
  }).join('');

  var qtyValue = item ? item.currentQty : 0;
  var qtyField = '<div class="u-modal-field">'
    + '<label for="fCurrentQty">Aktualne mnozstvo</label>'
    + '<input id="fCurrentQty" type="number" step="0.001" min="0" placeholder="0" value="' + qtyValue + '">'
    + (editingId ? '<div class="text-muted" style="font-size:12px;margin-top:4px">Zmena sa zaznamena do historie skladu ako adjustment.</div>' : '')
    + '</div>';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'ingredientModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:480px">'
    + '<div class="u-modal-title" style="text-align:center">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fName" type="text" placeholder="napr. Muka hladka" aria-required="true" data-validate="required" value="' + (item ? item.name : '') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fUnit">Jednotka</label>'
    + '<select id="fUnit">' + unitOpts + '</select>'
    + '</div>'
    + qtyField
    + '<div class="u-modal-field">'
    + '<label for="fMinQty">Minimalne mnozstvo</label>'
    + '<input id="fMinQty" type="number" step="0.01" min="0" placeholder="0" value="' + (item ? item.minQty : '0') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fCostPerUnit">Cena za jednotku (EUR)</label>'
    + '<input id="fCostPerUnit" type="number" step="0.0001" min="0" placeholder="0,0000" value="' + (item ? item.costPerUnit : '0') + '">'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="ingredientModalCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="ingredientModalSave">Ulozit</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  wireValidation(ov);

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
    editingId = null;
  };

  document.getElementById('ingredientModalCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  document.getElementById('ingredientModalSave').onclick = async function () {
    if (!validateForm(ov)) return;

    var name = document.getElementById('fName').value.trim();
    var unit = document.getElementById('fUnit').value;
    var minQty = parseFloat(document.getElementById('fMinQty').value) || 0;
    var costPerUnit = parseFloat(document.getElementById('fCostPerUnit').value) || 0;

    if (!name) { showToast('Zadajte nazov suroviny'); return; }

    var saveBtn = document.getElementById('ingredientModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      var currentQty = parseFloat(document.getElementById('fCurrentQty').value);
      if (!Number.isFinite(currentQty) || currentQty < 0) currentQty = 0;
      if (editingId) {
        await api.put('/inventory/ingredients/' + editingId, {
          name: name, unit: unit, currentQty: currentQty, minQty: minQty, costPerUnit: costPerUnit,
        });
        showToast('Surovina upravena', true);
      } else {
        await api.post('/inventory/ingredients', {
          name: name, unit: unit, type: 'ingredient', currentQty: currentQty, minQty: minQty, costPerUnit: costPerUnit,
        });
        showToast('Surovina pridana', true);
      }
      closeModal();
      await loadIngredients();
    } catch (err) {
      showToast(err.message || 'Chyba ukladania suroviny', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };
}

// === Delete ===
function deleteIngredient(id, name) {
  showConfirm(
    'Zmazat surovinu',
    'Naozaj chcete zmazat surovinu "' + name + '"? Tato akcia sa neda vratit.',
    async function () {
      try {
        await api.del('/inventory/ingredients/' + id);
        await loadIngredients();
        showToast('Surovina odstranena', true);
      } catch (err) {
        showToast('Chyba: ' + err.message, 'error');
      }
    },
    { type: 'danger' }
  );
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  ingredients = [];
  editingId = null;
  searchTerm = '';

  container.innerHTML = ''
    + '<div class="top-bar">'
    + '<button class="btn-add" id="addIngredientBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Pridat surovinu'
    + '</button>'
    + '<div class="search-wrap">'
    + '<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input class="search-input" id="ingredientSearch" type="text" placeholder="Hladat surovinu...">'
    + '</div>'
    + '</div>'
    + '<div id="ingredientsTable">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';

  // Bind top bar events
  $('#addIngredientBtn').addEventListener('click', function () { openModal(); });
  $('#ingredientSearch').addEventListener('input', function () {
    searchTerm = this.value.toLowerCase();
    renderTable();
  });

  // Event delegation for table actions
  container.addEventListener('click', function (e) {
    var editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      openModal(Number(editBtn.dataset.editId));
      return;
    }
    var deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      deleteIngredient(Number(deleteBtn.dataset.deleteId), deleteBtn.dataset.deleteName);
      return;
    }
  });

  // Escape key handler
  _escHandler = function (e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('ingredientModal');
      if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(function () { modal.remove(); }, 300);
        editingId = null;
      }
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data
  loadIngredients();
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  var modal = document.getElementById('ingredientModal');
  if (modal) modal.remove();

  ingredients = [];
  editingId = null;
  searchTerm = '';
  _container = null;
}
