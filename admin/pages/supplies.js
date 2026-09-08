// Supplies (Tovar) page — non-food items (hygiene, cleaning, packaging)
let supplies = [];
let editingId = null;
let searchTerm = '';
// „Pod minimom" v súčte je zároveň filter; hľadanie sa ukáže až od SEARCH_FROM.
let _lowOnly = false;
var SEARCH_FROM = 9;
let _container = null;
let _escHandler = null;

function $(sel) { return _container ? _container.querySelector(sel) : null; }

function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtNum(n) { return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

// Pilulka len pre výnimku (chýba / pod minimom). Bežný stav nemá farbu.
function statusPill(item) {
  if (item.currentQty <= 0) return '<span class="sk-pill is-danger">Chýba</span>';
  if (item.currentQty <= item.minQty) return '<span class="sk-pill is-warn">Pod minimom</span>';
  return '';
}

function itemWord(n) {
  if (n === 1) return 'položka';
  if (n >= 2 && n <= 4) return 'položky';
  return 'položiek';
}

function renderSum() {
  var sum = $('#supSum');
  if (!sum) return;
  var low = supplies.filter(function (i) { return i.currentQty <= i.minQty; }).length;
  var empty = supplies.filter(function (i) { return i.currentQty <= 0; }).length;
  sum.innerHTML = '<span><strong>' + supplies.length + '</strong> ' + itemWord(supplies.length) + '</span>'
    + ((low || _lowOnly)
      ? '<button type="button" class="sk-sum-open' + (empty ? ' is-danger' : '') + (_lowOnly ? ' is-on' : '') + '"'
        + ' id="supLowToggle" aria-pressed="' + (_lowOnly ? 'true' : 'false') + '">'
        + (_lowOnly ? 'Len pod minimom ✕' : low + ' pod minimom' + (empty ? ' · ' + empty + ' chýba' : ''))
        + '</button>'
      : '');
}

async function loadSupplies() {
  var tableWrap = $('#tableWrap');
  if (tableWrap) showLoading(tableWrap, 'Načítavam tovar…');
  try {
    supplies = await api.get('/inventory/ingredients?type=supply');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri načítaní tovaru', loadSupplies);
  }
}

function rowHtml(item) {
  var unit = escHtml(item.unit || 'ks');
  return '<button type="button" class="sk-row" data-edit-id="' + item.id + '">'
    + '<span class="sk-row-main">'
    + '<span class="sk-row-name">' + escHtml(item.name) + '</span>'
    + '<span class="sk-row-sub">min. ' + fmtNum(item.minQty) + '\u00A0' + unit + '</span>'
    + '</span>'
    + '<span class="sk-row-side">'
    + '<span class="sk-row-num">' + fmtNum(item.currentQty) + ' <small>' + unit + '</small></span>'
    + statusPill(item)
    + '</span>'
    + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>';
}

function renderTable() {
  var tableWrap = $('#tableWrap');
  if (!tableWrap) return;

  renderSum();
  var searchWrap = $('#supplySearchWrap');
  if (searchWrap) searchWrap.hidden = supplies.length < SEARCH_FROM;

  var filtered = supplies;
  if (_lowOnly) filtered = filtered.filter(function (s) { return s.currentQty <= s.minQty; });
  if (searchTerm) {
    var q = searchTerm.toLowerCase();
    filtered = filtered.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; });
  }

  if (!filtered.length) {
    var hint = (searchTerm || _lowOnly)
      ? (searchTerm ? 'Nič sa nenašlo. Skúste iný výraz alebo hľadanie vymažte.' : 'Žiadny tovar nie je pod minimom.')
      : 'Zatiaľ žiadny tovar. Pridajte hygienický tovar, čistiace prostriedky, obaly a podobne tlačidlom „Pridať".';
    tableWrap.innerHTML = '<div class="empty-hint">' + hint + '</div>';
    return;
  }

  tableWrap.innerHTML = '<div class="sk-list">' + filtered.map(rowHtml).join('') + '</div>';
}

function openModal(id) {
  editingId = id || null;
  var existing = document.getElementById('supplyModal');
  if (existing) existing.remove();

  var item = editingId ? supplies.find(function (s) { return s.id === editingId; }) : null;
  var title = item ? 'Upraviť tovar' : 'Pridať tovar';

  // Mazanie je vo formulári, nie na každom riadku zoznamu.
  var deleteBlock = item
    ? '<div class="sk-actions"><button type="button" class="u-btn u-btn-rose" id="supplyModalDelete">Vymazať tovar</button></div>'
    : '';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'supplyModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:420px">'
    + '<div class="u-modal-title">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field"><label for="fName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fName" class="form-input" data-validate="required" value="' + escHtml(item ? item.name : '') + '" placeholder="napr. Utierky, Mydlo, Sáčky"></div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field"><label for="fQty">' + (item ? 'Aktuálne množstvo' : 'Počiatočné množstvo') + '</label>'
    + '<input id="fQty" class="form-input" type="number" step="1" min="0" value="' + (item ? item.currentQty : 0) + '"></div>'
    + '<div class="u-modal-field"><label for="fMin">Minimum (upozornenie)</label>'
    + '<input id="fMin" class="form-input" type="number" step="1" min="0" value="' + (item ? item.minQty : 0) + '"></div>'
    + '</div>'
    + (item ? '<div class="sk-help">Zmena množstva sa zapíše do histórie skladu ako úprava.</div>' : '')
    + deleteBlock
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="modalCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="modalSave">' + (item ? 'Uložiť zmeny' : 'Pridať tovar') + '</button>'
    + '</div></div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });
  setTimeout(function () { ov.querySelector('#fName').focus(); }, 100);
  wireValidation(ov);

  var close = function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); };
  ov.querySelector('#modalCancel').onclick = close;
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

  var delBtn = ov.querySelector('#supplyModalDelete');
  if (delBtn && item) {
    delBtn.onclick = function () {
      var delId = item.id, delName = item.name;
      close();
      deleteSupply(delId, delName);
    };
  }

  _escHandler = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', _escHandler);

  ov.querySelector('#modalSave').addEventListener('click', async function () {
    if (!validateForm(ov)) return;
    var btn = ov.querySelector('#modalSave');
    var name = ov.querySelector('#fName').value.trim();
    var qty = parseFloat(ov.querySelector('#fQty').value) || 0;
    var minQty = parseFloat(ov.querySelector('#fMin').value) || 0;

    btnLoading(btn);
    try {
      if (editingId) {
        await api.put('/inventory/ingredients/' + editingId, { name: name, minQty: minQty });
        // Update qty via adjustment if changed
        var old = supplies.find(function (s) { return s.id === editingId; });
        if (old && qty !== old.currentQty) {
          var diff = qty - old.currentQty;
          await api.post('/inventory/movements/adjust', { ingredientId: editingId, quantity: diff, type: 'adjustment', note: 'Ručná úprava množstva' });
        }
        showToast('Tovar upravený', true);
      } else {
        await api.post('/inventory/ingredients', { name: name, unit: 'ks', type: 'supply', currentQty: qty, minQty: minQty, costPerUnit: 0 });
        showToast('Tovar pridaný', true);
      }
      close();
      await loadSupplies();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladaní', 'error');
      btnReset(btn);
    }
  });
}

function deleteSupply(id, name) {
  showConfirm(
    'Vymazať tovar',
    'Naozaj chcete vymazať „' + name + '"?',
    async function () {
      try {
        await api.del('/inventory/ingredients/' + id);
        await loadSupplies();
        showToast('Tovar odstránený', true);
      } catch (err) { showToast(err.message || 'Chyba pri mazaní', 'error'); }
    },
    { type: 'danger', confirmText: 'Vymazať' }
  );
}

export function init(container) {
  _container = container;
  supplies = []; editingId = null; searchTerm = ''; _lowOnly = false;

  container.innerHTML = '<div class="sk-head">'
    + '<div class="sk-sum" id="supSum" aria-live="polite"></div>'
    + '<button class="btn-add" id="addBtn"><svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pridať</button>'
    + '</div>'
    + '<div class="search-wrap sk-search" id="supplySearchWrap" hidden><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input class="search-input" id="searchInput" type="search" placeholder="Hľadať tovar…" aria-label="Hľadať tovar">'
    + '</div>'
    + '<div id="tableWrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>';

  $('#addBtn').addEventListener('click', function () { openModal(); });
  $('#searchInput').addEventListener('input', function () {
    searchTerm = this.value;
    renderTable();
  });

  container.addEventListener('click', function (e) {
    var lowBtn = e.target.closest('#supLowToggle');
    if (lowBtn) { _lowOnly = !_lowOnly; renderTable(); return; }
    var editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) { openModal(Number(editBtn.dataset.editId)); return; }
    var delBtn = e.target.closest('[data-delete-id]');
    if (delBtn) { deleteSupply(Number(delBtn.dataset.deleteId), delBtn.dataset.deleteName); return; }
  });

  loadSupplies();

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-supply') {
      setTimeout(function () { openModal(); }, 120);
    }
  }
}

export function destroy() {
  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  var modal = document.getElementById('supplyModal');
  if (modal) modal.remove();
  supplies = []; _container = null; _escHandler = null;
}
