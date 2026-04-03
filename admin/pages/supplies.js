// Supplies (Tovar) page — non-food items (hygiene, cleaning, packaging)
let supplies = [];
let editingId = null;
let searchTerm = '';
let _container = null;
let _escHandler = null;

function $(sel) { return _container ? _container.querySelector(sel) : null; }

function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtNum(n) { return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

function getStatusBadge(item) {
  if (item.currentQty <= 0) return '<span class="badge badge-danger">Chyba</span>';
  if (item.currentQty <= item.minQty) return '<span class="badge badge-warning">Malo</span>';
  return '<span class="badge badge-success">OK</span>';
}

async function loadSupplies() {
  var tableWrap = $('#tableWrap');
  if (tableWrap) showLoading(tableWrap, 'Nacitavam tovar...');
  try {
    supplies = await api.get('/inventory/ingredients?type=supply');
    if (tableWrap) hideLoading(tableWrap);
    renderTable();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba', loadSupplies);
  }
}

function renderTable() {
  var tableWrap = $('#tableWrap');
  if (!tableWrap) return;

  var filtered = supplies;
  if (searchTerm) {
    var q = searchTerm.toLowerCase();
    filtered = supplies.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; });
  }

  if (!filtered.length) {
    tableWrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83E\uDDF4</div>'
      + '<div class="empty-state-title">' + (searchTerm ? 'Ziadne vysledky' : 'Ziadny tovar') + '</div>'
      + '<div class="empty-state-text">Pridajte hygienicky tovar, cistiace prostriedky, obaly a pod.</div></div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>';
  html += '<th>Názov</th><th class="text-right">Množstvo</th><th class="text-right">Minimum</th><th class="text-center">Stav</th><th class="text-right">Akcie</th>';
  html += '</tr></thead><tbody>';

  filtered.forEach(function (item) {
    html += '<tr class="data-row">';
    html += '<td class="td-name">' + escHtml(item.name) + '</td>';
    html += '<td class="text-right num">' + fmtNum(item.currentQty) + ' ' + escHtml(item.unit) + '</td>';
    html += '<td class="text-right num td-sec">' + fmtNum(item.minQty) + '</td>';
    html += '<td class="text-center">' + getStatusBadge(item) + '</td>';
    html += '<td class="text-right"><div class="prod-actions">';
    html += '<button class="act-btn" data-edit-id="' + item.id + '" title="Upravit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
    html += '<button class="act-btn del" data-delete-id="' + item.id + '" data-delete-name="' + escHtml(item.name) + '" title="Vymazat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
    html += '</div></td></tr>';
  });

  html += '</tbody></table></div>';
  tableWrap.innerHTML = html;
}

function openModal(id) {
  editingId = id || null;
  var existing = document.getElementById('supplyModal');
  if (existing) existing.remove();

  var item = editingId ? supplies.find(function (s) { return s.id === editingId; }) : null;
  var title = item ? 'Upravit tovar' : 'Pridat tovar';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'supplyModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:420px">'
    + '<div class="u-modal-title" style="text-align:center">' + title + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field"><label for="fName">Nazov<span class="required-mark"> *</span></label>'
    + '<input id="fName" class="form-input" data-validate="required" value="' + escHtml(item ? item.name : '') + '" placeholder="napr. Utierky, Sapun, Sacky"></div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field"><label for="fQty">' + (item ? 'Aktualne mnozstvo' : 'Pociatocne mnozstvo') + '</label>'
    + '<input id="fQty" class="form-input" type="number" step="1" min="0" value="' + (item ? item.currentQty : 0) + '"></div>'
    + '<div class="u-modal-field"><label for="fMin">Minimum (upozornenie)</label>'
    + '<input id="fMin" class="form-input" type="number" step="1" min="0" value="' + (item ? item.minQty : 0) + '"></div>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="modalCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="modalSave">Ulozit</button>'
    + '</div></div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });
  setTimeout(function () { ov.querySelector('#fName').focus(); }, 100);
  wireValidation(ov);

  var close = function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); };
  ov.querySelector('#modalCancel').onclick = close;
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

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
          await api.post('/inventory/movements/adjust', { ingredientId: editingId, quantity: diff, type: 'adjustment', note: 'Rucna uprava mnozstva' });
        }
        showToast('Tovar upraveny', true);
      } else {
        await api.post('/inventory/ingredients', { name: name, unit: 'ks', type: 'supply', currentQty: qty, minQty: minQty, costPerUnit: 0 });
        showToast('Tovar pridany', true);
      }
      close();
      await loadSupplies();
    } catch (err) {
      showToast(err.message || 'Chyba', 'error');
      btnReset(btn);
    }
  });
}

function deleteSupply(id, name) {
  showConfirm(
    'Vymazat tovar',
    'Naozaj chcete vymazat "' + name + '"?',
    async function () {
      try {
        await api.del('/inventory/ingredients/' + id);
        await loadSupplies();
        showToast('Tovar odstraneny', true);
      } catch (err) { showToast(err.message || 'Chyba', 'error'); }
    },
    { type: 'danger' }
  );
}

export function init(container) {
  _container = container;
  supplies = []; editingId = null; searchTerm = '';

  container.innerHTML = '<div class="top-bar">'
    + '<button class="btn-add" id="addBtn"><svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pridat tovar</button>'
    + '<div class="search-wrap"><svg style="position:absolute;left:11px;top:50%;transform:translateY(-50%);width:14px;height:14px;fill:var(--color-text-dim);pointer-events:none" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/></svg>'
    + '<input class="search-input" id="searchInput" placeholder="Hladat tovar...">'
    + '</div></div>'
    + '<div id="tableWrap"></div>';

  $('#addBtn').addEventListener('click', function () { openModal(); });
  $('#searchInput').addEventListener('input', function () {
    searchTerm = this.value;
    renderTable();
  });

  container.addEventListener('click', function (e) {
    var editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) { openModal(Number(editBtn.dataset.editId)); return; }
    var delBtn = e.target.closest('[data-delete-id]');
    if (delBtn) { deleteSupply(Number(delBtn.dataset.deleteId), delBtn.dataset.deleteName); return; }
  });

  loadSupplies();
}

export function destroy() {
  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  var modal = document.getElementById('supplyModal');
  if (modal) modal.remove();
  supplies = []; _container = null; _escHandler = null;
}
