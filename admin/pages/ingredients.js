// Ingredients page module
import { mountEmptyState } from '../components/empty-state.js';
import { softDelete } from '../components/toast-undo.js';
import { fmtCost, fmtNum } from '../../components/fmt.js';

// Escapovanie: jediná implementácia je /js/pos-escape.js (načítaná v
// admin/index.html). Táto stránka predtým NEescapovala vôbec nič — názov
// kategórie / produktu / stola / suroviny / zamestnanca ide z DB rovno do
// innerHTML, takže čokoľvek, čo si manažér uloží ako názov, sa v admine
// vykoná ako HTML (CSP má 'unsafe-inline', takže aj ako skript).
function escapeHtml(v) {
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


let ingredients = [];
let editingId = null;
let searchTerm = '';
// „Pod minimom" v súčte je zároveň filter — jeden klik ukáže len to, čo treba
// doobjednať. Hľadanie má zmysel až od SEARCH_FROM položiek; pod tým je celý
// zoznam na jednej obrazovke a políčko by len odsúvalo prvú surovinu nižšie.
let _lowOnly = false;
const SEARCH_FROM = 9;

let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

// Pilulka len pre výnimku (prázdne / pod minimom). Bežný stav nemá farbu —
// keď má každý riadok zelené „OK", nehovorí to nič.
function statusPill(item) {
  if (item.currentQty <= 0) return '<span class="sk-pill is-danger">Prázdne</span>';
  if (item.currentQty <= item.minQty) return '<span class="sk-pill is-warn">Pod minimom</span>';
  return '';
}

function itemWord(n) {
  if (n === 1) return 'surovina';
  if (n >= 2 && n <= 4) return 'suroviny';
  return 'surovín';
}

// === Load data ===
async function loadIngredients() {
  const tableWrap = $('#ingredientsTable');
  if (tableWrap) showLoading(tableWrap, 'Načítavam suroviny…');
  try {
    ingredients = await api.get('/inventory/ingredients?type=ingredient');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri načítaní surovín', loadIngredients);
  }
}

// === Render table ===
// Riadok suroviny: názov + cena/jednotka a minimum vľavo, množstvo vpravo,
// pilulka len keď je stav výnimočný. Celý riadok otvára úpravu.
function rowHtml(item) {
  var unit = escapeHtml(item.unit);
  var sub = fmtCost(item.costPerUnit) + '\u00A0\u20AC/' + unit + ' · min. ' + fmtNum(item.minQty) + '\u00A0' + unit;
  return '<button type="button" class="sk-row" data-edit-id="' + item.id + '">'
    + '<span class="sk-row-main">'
    + '<span class="sk-row-name">' + escapeHtml(item.name) + '</span>'
    + '<span class="sk-row-sub">' + sub + '</span>'
    + '</span>'
    + '<span class="sk-row-side">'
    + '<span class="sk-row-num">' + fmtNum(item.currentQty) + ' <small>' + unit + '</small></span>'
    + statusPill(item)
    + '</span>'
    + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>';
}

function renderSum() {
  var sum = $('#ingSum');
  if (!sum) return;
  var low = ingredients.filter(function (i) { return i.currentQty <= i.minQty; }).length;
  var empty = ingredients.filter(function (i) { return i.currentQty <= 0; }).length;
  sum.innerHTML = '<span><strong>' + ingredients.length + '</strong> ' + itemWord(ingredients.length) + '</span>'
    + ((low || _lowOnly)
      ? '<button type="button" class="sk-sum-open' + (empty ? ' is-danger' : '') + (_lowOnly ? ' is-on' : '') + '"'
        + ' id="ingLowToggle" aria-pressed="' + (_lowOnly ? 'true' : 'false') + '">'
        + (_lowOnly ? 'Len pod minimom ✕' : low + ' pod minimom' + (empty ? ' · ' + empty + ' prázdne' : ''))
        + '</button>'
      : '');
}

function renderTable() {
  var tableWrap = $('#ingredientsTable');
  if (!tableWrap) return;

  renderSum();
  var searchWrap = $('#ingredientSearchWrap');
  if (searchWrap) searchWrap.hidden = ingredients.length < SEARCH_FROM;

  var filtered = ingredients.filter(function (item) {
    if (_lowOnly && item.currentQty > item.minQty) return false;
    if (!searchTerm) return true;
    return item.name.toLowerCase().includes(searchTerm);
  });

  if (!filtered.length) {
    if (searchTerm || _lowOnly) {
      mountEmptyState(tableWrap, {
        icon: '🔍',
        title: 'Žiadne výsledky',
        text: searchTerm
          ? 'Pre hľadaný výraz „' + searchTerm + '" sa nenašla žiadna surovina. Skúste iný výraz alebo hľadanie vymažte.'
          : 'Žiadna surovina nie je pod minimom.',
        ctaLabel: searchTerm ? 'Vymazať hľadanie' : 'Zobraziť všetky',
        onCta: function () {
          searchTerm = '';
          _lowOnly = false;
          var s = document.getElementById('ingredientSearch');
          if (s) s.value = '';
          renderTable();
        },
      });
    } else {
      mountEmptyState(tableWrap, {
        icon: '📦',
        title: 'Žiadne suroviny',
        text: 'Tu sa zobrazujú suroviny, ktoré nakupujete pre kuchyňu a bar. Začnite pridaním prvej.',
        ctaLabel: 'Pridať prvú surovinu',
        onCta: function () { openModal(null); },
      });
    }
    return;
  }

  tableWrap.innerHTML = '<div class="sk-list">' + filtered.map(rowHtml).join('') + '</div>';
}

// === Modal ===
function openModal(id) {
  editingId = id || null;

  var existing = document.getElementById('ingredientModal');
  if (existing) existing.remove();

  var item = editingId ? ingredients.find(function (i) { return i.id === editingId; }) : null;
  var title = item ? 'Upraviť surovinu' : 'Pridať surovinu';

  var unitOptions = ['ks', 'kg', 'g', 'l', 'ml'];
  var unitOpts = unitOptions.map(function (u) {
    var selected = item && item.unit === u ? ' selected' : (!item && u === 'ks' ? ' selected' : '');
    return '<option value="' + u + '"' + selected + '>' + u + '</option>';
  }).join('');

  var qtyValue = item ? item.currentQty : 0;
  var qtyField = '<div class="u-modal-field">'
    + '<label for="fCurrentQty">Aktuálne množstvo</label>'
    + '<input id="fCurrentQty" type="number" step="0.001" min="0" placeholder="0" value="' + qtyValue + '">'
    + (editingId ? '<small>Zmena sa zapíše do histórie skladu ako úprava.</small>' : '')
    + '</div>';

  // Mazanie je vo formulári, nie na každom riadku zoznamu — omylný tap na
  // kôš vedľa ceruzky bol najčastejší dôvod „vrátiť späť".
  var deleteBlock = item
    ? '<div class="sk-actions"><button type="button" class="u-btn u-btn-rose" id="ingredientModalDelete">Zmazať surovinu</button></div>'
    : '';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'ingredientModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:480px">'
    + '<div class="u-modal-title">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fName" type="text" placeholder="napr. Múka hladká" aria-required="true" data-validate="required" value="' + (item ? escapeHtml(item.name) : '') + '">'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="fUnit">Jednotka</label>'
    + '<select id="fUnit">' + unitOpts + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fMinQty">Minimum (upozornenie)</label>'
    + '<input id="fMinQty" type="number" step="0.01" min="0" placeholder="0" value="' + (item ? item.minQty : '0') + '">'
    + '</div>'
    + '</div>'
    + qtyField
    + '<div class="u-modal-field">'
    + '<label for="fCostPerUnit">Cena za jednotku (€, bez DPH)</label>'
    + '<input id="fCostPerUnit" type="number" step="0.0001" min="0" placeholder="0,0000" value="' + (item ? item.costPerUnit : '0') + '">'
    + '</div>'
    + deleteBlock
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="ingredientModalCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="ingredientModalSave">' + (item ? 'Uložiť zmeny' : 'Pridať surovinu') + '</button>'
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

  var delBtn = document.getElementById('ingredientModalDelete');
  if (delBtn && item) {
    delBtn.onclick = function () {
      var delId = item.id, delName = item.name;
      closeModal();
      deleteIngredient(delId, delName);
    };
  }

  document.getElementById('ingredientModalSave').onclick = async function () {
    if (!validateForm(ov)) return;

    var name = document.getElementById('fName').value.trim();
    var unit = document.getElementById('fUnit').value;
    var minQty = parseFloat(document.getElementById('fMinQty').value) || 0;
    var costPerUnit = parseFloat(document.getElementById('fCostPerUnit').value) || 0;

    if (!name) { showToast('Zadajte názov suroviny'); return; }

    var saveBtn = document.getElementById('ingredientModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      var currentQty = parseFloat(document.getElementById('fCurrentQty').value);
      if (!Number.isFinite(currentQty) || currentQty < 0) currentQty = 0;
      if (editingId) {
        await api.put('/inventory/ingredients/' + editingId, {
          name: name, unit: unit, currentQty: currentQty, minQty: minQty, costPerUnit: costPerUnit,
        });
        showToast('Surovina upravená', true);
      } else {
        await api.post('/inventory/ingredients', {
          name: name, unit: unit, type: 'ingredient', currentQty: currentQty, minQty: minQty, costPerUnit: costPerUnit,
        });
        showToast('Surovina pridaná', true);
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

// === Delete (optimistic + undo-toast pattern) ===
// Mazanie nepokazi confirm modal. Iba: zmiznе z UI hned, 5s timer v toaste,
// klik "Vratit spat" → vratime do listu. Po vyprsani toastu volame API.
async function deleteIngredient(id, name) {
  const idx = ingredients.findIndex(function (i) { return i.id === id; });
  if (idx < 0) return;
  const snapshot = ingredients[idx];

  // Optimistic remove + render
  ingredients.splice(idx, 1);
  renderTable();

  const result = await softDelete({
    label: '„' + name + '" zmazaná',
    deleteFn: function () { return api.del('/inventory/ingredients/' + id); },
  });

  if (result.undone) {
    // Restore at original position
    ingredients.splice(idx, 0, snapshot);
    renderTable();
    showToast('Vrátené', true);
  } else if (!result.error) {
    // Delete commited — sync from server so currentQty / dependencies sa dosynchronizuju
    await loadIngredients();
  } else {
    // Server delete failed → restore UI (snapshot + render)
    ingredients.splice(idx, 0, snapshot);
    renderTable();
  }
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  ingredients = [];
  editingId = null;
  searchTerm = '';
  _lowOnly = false;

  container.innerHTML = ''
    + '<div class="sk-head">'
    + '<div class="sk-sum" id="ingSum" aria-live="polite"></div>'
    + '<button class="btn-add" id="addIngredientBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Pridať'
    + '</button>'
    + '</div>'
    + '<div class="search-wrap sk-search" id="ingredientSearchWrap" hidden>'
    + '<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input class="search-input" id="ingredientSearch" type="search" placeholder="Hľadať surovinu…" aria-label="Hľadať surovinu">'
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

  // Event delegation for list actions
  container.addEventListener('click', function (e) {
    var lowBtn = e.target.closest('#ingLowToggle');
    if (lowBtn) {
      _lowOnly = !_lowOnly;
      renderTable();
      return;
    }
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

  // Cmd+K action hook — if user picked "Pridať surovinu" from palette,
  // open the modal automatically after page mounts.
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-ingredient') {
      setTimeout(function () { openModal(); }, 120);
    }
  }
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
