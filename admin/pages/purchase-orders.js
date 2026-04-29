// Purchase orders page module
let orders = [];
let suppliers = [];
let ingredients = [];
let activeStatus = '';
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function $$(sel) {
  return _container.querySelectorAll(sel);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtEur(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

function fmtDate(isoStr) {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function statusBadge(status) {
  var map = {
    draft:     { cls: 'badge-warning', label: 'Rozpracovana' },
    received:  { cls: 'badge-success', label: 'Prijata' },
    cancelled: { cls: 'badge-danger',  label: 'Zrusena' }
  };
  var entry = map[status] || { cls: '', label: status || '--' };
  return '<span class="badge ' + entry.cls + '">' + entry.label + '</span>';
}

// ===== LOAD =====
async function loadOrders() {
  var panel = $('#ordersPanel');
  if (panel) showLoading(panel, 'Nacitavam objednavky...');
  try {
    var url = '/inventory/purchase-orders';
    if (activeStatus) url += '?status=' + activeStatus;
    orders = await api.get(url);
    if (panel) hideLoading(panel);
    renderTable();
  } catch (err) {
    if (panel) hideLoading(panel);
    if (panel) renderError(panel, err.message || 'Chyba pri nacitani objednavok', loadOrders);
  }
}

async function loadSuppliers() {
  try {
    suppliers = await api.get('/inventory/suppliers?active=true');
  } catch (_err) {
    suppliers = [];
  }
}

async function loadIngredients() {
  try {
    ingredients = await api.get('/inventory/ingredients?active=true');
  } catch (_err) {
    ingredients = [];
  }
}

// ===== RENDER TABLE =====
function renderTable() {
  var panel = $('#ordersPanel');
  if (!panel) return;

  if (!orders || orders.length === 0) {
    var emptyLabel = activeStatus ? 'Ziadne objednavky pre zvoleny filter' : 'Ziadne objednavky. Vytvorte novu objednavku.';
    panel.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">&#128230;</div>'
      + '<div class="empty-state-title">Ziadne objednavky</div>'
      + '<div class="empty-state-text">' + emptyLabel + '</div>'
      + '</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table" id="ordersTable">';
  html += '<thead><tr>';
  html += '<th>ID</th>';
  html += '<th>Dodávateľ</th>';
  html += '<th>Položky</th>';
  html += '<th class="text-right">Celková cena</th>';
  html += '<th>Dátum</th>';
  html += '<th class="text-center">Stav</th>';
  html += '<th class="text-right">Akcie</th>';
  html += '</tr></thead><tbody>';

  orders.forEach(function (po) {
    var supplierName = po.supplier ? escapeHtml(po.supplier.name) : '--';
    var itemCount = po.items ? po.items.length : 0;

    html += '<tr>';
    html += '<td class="td-name">#' + po.id + '</td>';
    html += '<td>' + supplierName + '</td>';
    html += '<td>' + itemCount + '</td>';
    html += '<td class="text-right num">' + fmtEur(po.totalCost || 0) + '</td>';
    html += '<td>' + fmtDate(po.createdAt) + '</td>';
    html += '<td class="text-center">' + statusBadge(po.status) + '</td>';
    html += '<td class="text-right nowrap">';
    html += '<div class="prod-actions" style="justify-content:flex-end">';
    if (po.hasImage) {
      html += '<button class="act-btn" data-image-id="' + po.id + '" title="Zobrazit fakturu" style="color:var(--color-accent)">'
        + '<svg viewBox="0 0 24 24" width="14" height="14" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
        + '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
        + '</button>';
    }
    html += '<button class="act-btn" data-detail-id="' + po.id + '" title="Detail">'
      + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
      + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      + '</button>';
    if (po.status === 'draft') {
      html += '<button class="act-btn" data-receive-id="' + po.id + '" title="Prijat" style="color:var(--color-success)">'
        + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
        + '<polyline points="20 6 9 17 4 12"/></svg>'
        + '</button>';
      html += '<button class="act-btn del" data-cancel-id="' + po.id + '" title="Zrusit">'
        + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
        + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        + '</button>';
    }
    html += '<button class="act-btn del" data-delete-id="' + po.id + '" title="Vymazat">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
      + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      + '</button>';
    html += '</div>';
    html += '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  panel.innerHTML = html;
}

// ===== RECEIVE =====
function receiveOrder(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;
  showConfirm(
    'Prijat objednavku',
    'Naozaj chcete prijat objednavku #' + po.id + '? Suroviny budu pridane do skladu.',
    async function () {
      try {
        await api.post('/inventory/purchase-orders/' + id + '/receive');
        showToast('Objednavka #' + id + ' prijata', true);
        await loadOrders();
      } catch (err) {
        showToast(err.message || 'Chyba pri prijmani objednavky', 'error');
      }
    },
    { type: 'info', confirmText: 'Prijat' }
  );
}

// ===== CANCEL =====
function cancelOrder(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;
  showConfirm(
    'Zrusit objednavku',
    'Naozaj chcete zrusit objednavku #' + po.id + '?',
    async function () {
      try {
        await api.post('/inventory/purchase-orders/' + id + '/cancel');
        showToast('Objednavka #' + id + ' zrusena', true);
        await loadOrders();
      } catch (err) {
        showToast(err.message || 'Chyba pri ruseni objednavky', 'error');
      }
    },
    { type: 'danger', confirmText: 'Zrusit objednavku' }
  );
}

function deleteOrder(id) {
  showConfirm(
    'Vymazat objednavku',
    'Naozaj chcete vymazat objednavku #' + id + '? Tato akcia sa neda vratit.',
    async function () {
      try {
        await api.del('/inventory/purchase-orders/' + id);
        showToast('Objednavka #' + id + ' vymazana', true);
        await loadOrders();
      } catch (err) {
        showToast(err.message || 'Chyba pri mazani', 'error');
      }
    },
    { type: 'danger', confirmText: 'Vymazat' }
  );
}

async function showInvoiceImage(id) {
  try {
    var data = await api.get('/inventory/purchase-orders/' + id + '/image');
    if (!data.imageData) { showToast('Faktura nema obrazok'); return; }

    var ov = document.createElement('div');
    ov.className = 'u-overlay';
    ov.id = 'invoiceImageModal';
    ov.innerHTML = '<div class="u-modal" style="max-width:90vw;max-height:90vh;padding:16px;overflow:auto">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'
      + '<div class="u-modal-title" style="margin:0">Faktura #' + id + '</div>'
      + '<button class="act-btn" id="closeImgModal" title="Zavriet" style="font-size:18px">\u2715</button>'
      + '</div>'
      + '<img src="' + data.imageData + '" style="max-width:100%;border-radius:var(--radius-sm);border:1px solid var(--color-border)" alt="Faktura">'
      + '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });

    var close = function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); };
    ov.querySelector('#closeImgModal').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  } catch (err) {
    showToast('Chyba nacitania obrazku: ' + err.message, 'error');
  }
}

// ===== DETAIL MODAL =====
function openDetailModal(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;

  var existing = document.getElementById('poDetailModal');
  if (existing) existing.remove();

  var supplierName = po.supplier ? escapeHtml(po.supplier.name) : '--';

  var itemsHtml = '';
  if (po.items && po.items.length > 0) {
    itemsHtml = '<div class="table-scroll-wrap"><table class="data-table" style="margin-top:12px">'
      + '<thead><tr>'
      + '<th>Surovina</th>'
      + '<th>Jednotka</th>'
      + '<th class="text-right">Množstvo</th>'
      + '<th class="text-right">Jedn. cena</th>'
      + '<th class="text-right">Spolu</th>'
      + '</tr></thead><tbody>';
    po.items.forEach(function (item) {
      var conv = parseFloat(item.conversionFactor) || 1;
      var stockAdded = Math.round(Number(item.quantity) * conv * 1000) / 1000;
      var convInfo = conv !== 1
        ? '<div style="font-size:var(--text-xs);color:var(--color-accent);margin-top:2px">' + Number(item.quantity).toLocaleString('sk-SK') + ' ' + escapeHtml(item.invoiceUnit || 'ks') + ' x ' + conv + ' = ' + stockAdded.toLocaleString('sk-SK') + ' ' + escapeHtml(item.ingredientUnit || '') + '</div>'
        : '';
      itemsHtml += '<tr>';
      itemsHtml += '<td class="td-name">' + escapeHtml(item.ingredientName || '--') + convInfo + '</td>';
      itemsHtml += '<td>' + escapeHtml(item.ingredientUnit || '--') + '</td>';
      itemsHtml += '<td class="text-right num">' + Number(item.quantity).toLocaleString('sk-SK', { maximumFractionDigits: 2 }) + (item.invoiceUnit && conv !== 1 ? ' ' + escapeHtml(item.invoiceUnit) : '') + '</td>';
      itemsHtml += '<td class="text-right num">' + fmtEur(item.unitCost || 0) + '</td>';
      itemsHtml += '<td class="text-right num">' + fmtEur(item.totalCost || 0) + '</td>';
      itemsHtml += '</tr>';
    });
    itemsHtml += '</tbody></table></div>';
  } else {
    itemsHtml = '<div class="td-empty" style="padding:16px;text-align:center">Žiadne položky</div>';
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poDetailModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:640px">'
    + '<div class="u-modal-title" style="text-align:center">Objednavka #' + po.id + '</div>'
    + '<div class="u-modal-body" style="gap:10px">'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap">'
    + '<div style="flex:1;min-width:140px"><div class="form-label">Dodavatel</div><div style="font-weight:600">' + supplierName + '</div></div>'
    + '<div style="flex:1;min-width:140px"><div class="form-label">Datum</div><div style="font-weight:600">' + fmtDate(po.createdAt) + '</div></div>'
    + '<div style="flex:1;min-width:140px"><div class="form-label">Stav</div><div>' + statusBadge(po.status) + '</div></div>'
    + '</div>'
    + (po.note ? '<div><div class="form-label">Poznamka</div><div style="font-size:13px;color:var(--color-text-sec)">' + escapeHtml(po.note) + '</div></div>' : '')
    + '<div><div class="form-label">Polozky</div>' + itemsHtml + '</div>'
    + '<div style="text-align:right;font-weight:700;font-size:14px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)">'
    + 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">' + fmtEur(po.totalCost || 0) + '</span>'
    + '</div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--color-border);margin-top:4px">'
    + '<div class="form-label" style="width:100%;margin-bottom:2px">Zmenit stav</div>'
    + (po.status !== 'draft' ? '<button class="u-btn u-btn-ghost" id="poSetDraft" style="flex:1">Rozpracovana</button>' : '')
    + (po.status !== 'received' ? '<button class="u-btn u-btn-ice" id="poSetReceived" style="flex:1">Prijata</button>' : '')
    + (po.status !== 'cancelled' ? '<button class="u-btn u-btn-rose" id="poSetCancelled" style="flex:1">Zrusena</button>' : '')
    + '</div>'
    + '<div class="u-modal-btns" style="margin-top:16px">'
    + (po.status !== 'cancelled' ? '<button class="u-btn u-btn-ghost" id="poEdit" style="flex:1">Upravit polozky</button>' : '')
    + '<button class="u-btn u-btn-ghost" id="poDetailClose">Zavriet</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  document.getElementById('poDetailClose').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  // Status change buttons
  var setDraftBtn = ov.querySelector('#poSetDraft');
  var setReceivedBtn = ov.querySelector('#poSetReceived');
  var setCancelledBtn = ov.querySelector('#poSetCancelled');

  if (setReceivedBtn) setReceivedBtn.addEventListener('click', async function () {
    btnLoading(setReceivedBtn);
    try {
      await api.post('/inventory/purchase-orders/' + po.id + '/receive');
      closeModal();
      showToast('Objednavka #' + po.id + ' prijata — sklad doplneny', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setReceivedBtn); }
  });

  if (setCancelledBtn) setCancelledBtn.addEventListener('click', async function () {
    btnLoading(setCancelledBtn);
    try {
      await api.post('/inventory/purchase-orders/' + po.id + '/cancel');
      closeModal();
      showToast('Objednavka #' + po.id + ' zrusena', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setCancelledBtn); }
  });

  if (setDraftBtn) setDraftBtn.addEventListener('click', async function () {
    btnLoading(setDraftBtn);
    try {
      await api.post('/inventory/purchase-orders/' + po.id + '/reopen');
      closeModal();
      showToast('Objednavka #' + po.id + ' vratena do rozpracovania', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setDraftBtn); }
  });

  var editBtn = ov.querySelector('#poEdit');
  if (editBtn) editBtn.addEventListener('click', function () {
    closeModal();
    openEditOrderModal(po);
  });
}

// ===== EDIT EXISTING PURCHASE ORDER (works for draft + received) =====
function openEditOrderModal(po) {
  var existing = document.getElementById('poEditModal');
  if (existing) existing.remove();

  var ingOpts = ingredients
    .filter(function (i) { return (i.type || 'ingredient') === 'ingredient'; })
    .map(function (ing) {
      return '<option value="' + ing.id + '">' + escapeHtml(ing.name) + ' (' + ing.unit + ')</option>';
    }).join('');

  function rowHtml(item, idx) {
    var selectOpts = '<option value="">-- vyber --</option>' + ingOpts;
    var h = '<div data-edit-row="' + idx + '" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">';
    h += '<select class="form-select form-select-sm edit-ing" data-idx="' + idx + '" style="flex:2;min-width:160px">' + selectOpts + '</select>';
    h += '<input type="number" class="form-input form-input-sm edit-qty" step="0.01" min="0" value="' + (item ? item.quantity : '') + '" style="width:80px;text-align:right" placeholder="Mnoz.">';
    h += '<input type="text" class="form-input form-input-sm edit-unit" value="' + escapeHtml(item ? (item.invoiceUnit || item.ingredientUnit || '') : '') + '" style="width:70px" placeholder="ks">';
    h += '<input type="number" class="form-input form-input-sm edit-conv" step="0.01" min="0.01" value="' + (item ? (item.conversionFactor || 1) : 1) + '" style="width:70px;text-align:right" title="Konverzny faktor (napr. sud 50L → 50)">';
    h += '<input type="number" class="form-input form-input-sm edit-cost" step="0.01" min="0" value="' + (item ? item.unitCost : '') + '" style="width:90px;text-align:right" placeholder="Cena">';
    h += '<span class="edit-total" style="min-width:80px;text-align:right;font-family:var(--font-display);color:var(--color-accent)">' + (item ? fmtEur(item.totalCost || 0) : '0.00 €') + '</span>';
    h += '<button class="act-btn del edit-remove" data-idx="' + idx + '" title="Odstranit" style="width:28px;height:28px"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    h += '</div>';
    return h;
  }

  var rowsHtml = (po.items || []).map(function (it, i) { return rowHtml(it, i); }).join('');

  var warning = po.status === 'received'
    ? '<div style="background:rgba(255,179,71,.1);color:#FFB347;padding:8px 12px;border-radius:var(--radius-xs);font-size:var(--text-sm);margin-bottom:10px">⚠ Faktura je uz prijata. Po ulozeni sa stare mnozstva odcitaju zo skladu a nove sa pripocitaju — historia skladu zaznamena opravu.</div>'
    : '';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poEditModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:880px;max-height:90vh;overflow-y:auto">'
    + '<div class="u-modal-title" style="text-align:center">Upravit objednavku #' + po.id + '</div>'
    + '<div class="u-modal-body" style="gap:10px">'
    + warning
    + '<div class="u-modal-field">'
    + '<label for="fEditNote">Poznamka</label>'
    + '<textarea id="fEditNote" class="form-input" rows="2">' + escapeHtml(po.note || '') + '</textarea>'
    + '</div>'
    + '<div class="form-label">Polozky</div>'
    + '<div id="editItemsWrap">' + rowsHtml + '</div>'
    + '<button class="u-btn u-btn-ghost btn-sm" id="btnEditAddRow" style="align-self:flex-start">+ Pridat polozku</button>'
    + '<div style="text-align:right;font-weight:700;font-size:var(--text-lg);padding-top:10px;border-top:1px solid var(--color-border)">'
    + 'Celkom: <span id="editGrandTotal" style="color:var(--color-accent);font-family:var(--font-display);font-size:var(--text-2xl)">' + fmtEur(po.totalCost || 0) + '</span>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns" style="margin-top:16px">'
    + '<button class="u-btn u-btn-ghost" id="poEditCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="poEditSave">Ulozit zmeny</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  var editingCounter = (po.items || []).length;

  function selectInitialValues() {
    (po.items || []).forEach(function (item, i) {
      var sel = ov.querySelector('.edit-ing[data-idx="' + i + '"]');
      if (sel) sel.value = String(item.ingredientId);
    });
  }
  selectInitialValues();

  function updateRow(rowEl) {
    var qty = parseFloat(rowEl.querySelector('.edit-qty')?.value) || 0;
    var cost = parseFloat(rowEl.querySelector('.edit-cost')?.value) || 0;
    var totalEl = rowEl.querySelector('.edit-total');
    if (totalEl) totalEl.textContent = fmtEur(qty * cost);
  }
  function updateTotals() {
    var sum = 0;
    ov.querySelectorAll('[data-edit-row]').forEach(function (rowEl) {
      var qty = parseFloat(rowEl.querySelector('.edit-qty')?.value) || 0;
      var cost = parseFloat(rowEl.querySelector('.edit-cost')?.value) || 0;
      sum += qty * cost;
    });
    var el = ov.querySelector('#editGrandTotal');
    if (el) el.textContent = fmtEur(sum);
  }

  function close() {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  }

  ov.addEventListener('input', function (e) {
    if (
      e.target.classList.contains('edit-qty') ||
      e.target.classList.contains('edit-cost')
    ) {
      var rowEl = e.target.closest('[data-edit-row]');
      if (rowEl) updateRow(rowEl);
      updateTotals();
    }
  });

  ov.addEventListener('click', function (e) {
    var rm = e.target.closest('.edit-remove');
    if (rm) {
      var rowEl = rm.closest('[data-edit-row]');
      if (rowEl) rowEl.remove();
      updateTotals();
    }
  });

  ov.querySelector('#btnEditAddRow').addEventListener('click', function () {
    var idx = editingCounter++;
    var wrap = ov.querySelector('#editItemsWrap');
    wrap.insertAdjacentHTML('beforeend', rowHtml(null, idx));
  });

  ov.querySelector('#poEditCancel').addEventListener('click', close);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

  ov.querySelector('#poEditSave').addEventListener('click', async function () {
    var btn = ov.querySelector('#poEditSave');
    btnLoading(btn);
    try {
      var items = [];
      ov.querySelectorAll('[data-edit-row]').forEach(function (rowEl) {
        var ingId = Number(rowEl.querySelector('.edit-ing')?.value);
        var qty = parseFloat(rowEl.querySelector('.edit-qty')?.value);
        var cost = parseFloat(rowEl.querySelector('.edit-cost')?.value);
        var conv = parseFloat(rowEl.querySelector('.edit-conv')?.value);
        var unit = (rowEl.querySelector('.edit-unit')?.value || '').trim();
        if (!ingId || !Number.isFinite(qty) || qty <= 0) return;
        items.push({
          ingredientId: ingId,
          quantity: qty,
          unitCost: Number.isFinite(cost) ? cost : 0,
          invoiceUnit: unit,
          conversionFactor: Number.isFinite(conv) && conv > 0 ? conv : 1,
        });
      });
      if (!items.length) {
        showToast('Pridaj aspon jednu polozku', 'error');
        btnReset(btn);
        return;
      }
      await api.put('/inventory/purchase-orders/' + po.id, {
        note: ov.querySelector('#fEditNote').value,
        items: items,
      });
      close();
      showToast('Objednavka upravena', true);
      await loadOrders();
    } catch (err) {
      showToast(err.message || 'Chyba ukladania', 'error');
      btnReset(btn);
    }
  });
}

// ===== NEW ORDER MODAL =====
var itemCounter = 0;

function openNewOrderModal() {
  var existing = document.getElementById('poNewModal');
  if (existing) existing.remove();

  itemCounter = 0;

  var supplierOpts = '<option value="">-- Vyberte dodavatela --</option>';
  suppliers.forEach(function (s) {
    supplierOpts += '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>';
  });

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poNewModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:720px">'
    + '<div class="u-modal-title" style="text-align:center">Nova objednavka</div>'
    + '<div class="u-modal-body" style="gap:14px">'
    + '<div class="u-modal-field">'
    + '<label for="fPoSupplier">Dodavatel<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="fPoSupplier" data-validate="required">' + supplierOpts + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fPoNote">Poznamka</label>'
    + '<textarea id="fPoNote" class="form-input" rows="2" placeholder="Dodacie podmienky, poznamky..."></textarea>'
    + '</div>'
    + '<div>'
    + '<div class="form-label" style="margin-bottom:4px">Polozky<span class="required-mark" aria-hidden="true"> *</span></div>'
    + '<div style="font-size:var(--text-xs);color:var(--color-text-sec);margin-bottom:8px;line-height:1.5">'
    + 'Mnozstvo a cena su vzdy v JEDNOTKE suroviny (ks / L / kg — vidis ju pri nazve v dropdowne).'
    + '<br>Priklad: 6× flasa 1.5L Kinley za 11.24 € → ak surovina je v <code>ks</code> zadaj <code>6</code> a <code>1.87</code>; ak v <code>L</code> zadaj <code>9</code> a <code>1.25</code>.'
    + '<br>Zadavaj cenu BEZ DPH a BEZ vratneho obalu.'
    + '</div>'
    + '<div id="poItemsWrap"></div>'
    + '<button class="btn-outline-accent" id="poAddItemBtn" type="button" style="margin-top:8px">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14" style="width:12px;height:12px"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + ' Pridat polozku'
    + '</button>'
    + '</div>'
    + '<div id="poGrandTotal" style="text-align:right;font-weight:700;font-size:14px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)">'
    + 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">0,00 \u20AC</span>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="poNewCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="poNewSave">Ulozit</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  wireValidation(ov);

  // Add first item row
  addItemRow();

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  document.getElementById('poNewCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  document.getElementById('poAddItemBtn').onclick = function () {
    addItemRow();
  };

  document.getElementById('poNewSave').onclick = async function () {
    if (!validateForm(ov)) return;

    var supplierId = Number(document.getElementById('fPoSupplier').value);
    var note = document.getElementById('fPoNote').value.trim();

    if (!supplierId) {
      showToast('Vyberte dodavatela');
      return;
    }

    var itemRows = document.querySelectorAll('#poItemsWrap .po-item-row');
    var items = [];
    var hasError = false;

    itemRows.forEach(function (row) {
      var ingredientId = Number(row.querySelector('.po-ingredient-select').value);
      var quantity = parseFloat(row.querySelector('.po-qty-input').value) || 0;
      var unitCost = parseFloat(row.querySelector('.po-cost-input').value) || 0;

      if (!ingredientId) { hasError = true; return; }
      if (quantity <= 0) { hasError = true; return; }
      if (unitCost < 0) { hasError = true; return; }

      items.push({ ingredientId: ingredientId, quantity: quantity, unitCost: unitCost });
    });

    if (items.length === 0 || hasError) {
      showToast('Pridajte aspon jednu polozku s platnym mnozstvom');
      return;
    }

    var saveBtn = document.getElementById('poNewSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      await api.post('/inventory/purchase-orders', {
        supplierId: supplierId,
        note: note,
        items: items
      });
      showToast('Objednavka vytvorena', true);
      closeModal();
      await loadOrders();
    } catch (err) {
      showToast(err.message || 'Chyba pri vytvarani objednavky', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };
}

function addItemRow() {
  var wrap = document.getElementById('poItemsWrap');
  if (!wrap) return;

  itemCounter++;
  var rowId = 'poItem_' + itemCounter;

  var ingredientOpts = '<option value="">-- Surovina --</option>';
  ingredients.forEach(function (ing) {
    ingredientOpts += '<option value="' + ing.id + '">' + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
  });

  var row = document.createElement('div');
  row.className = 'po-item-row';
  row.id = rowId;
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap';
  row.innerHTML = ''
    + '<select class="po-ingredient-select" style="flex:2;min-width:140px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--color-border);background:rgba(255,255,255,.04);font-family:var(--font-body);font-size:13px;color:var(--color-text);outline:none">'
    + ingredientOpts
    + '</select>'
    + '<input class="po-qty-input" type="number" step="0.01" min="0" placeholder="Mnozstvo" title="Pocet jednotiek surovinky (ks / L / kg)" style="flex:1;min-width:80px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--color-border);background:rgba(255,255,255,.04);font-family:var(--font-body);font-size:13px;color:var(--color-text);outline:none">'
    + '<input class="po-cost-input" type="number" step="0.0001" min="0" placeholder="Cena za jednotku" title="Cena za 1 jednotku surovinky bez DPH a bez vratneho obalu" style="flex:1;min-width:80px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--color-border);background:rgba(255,255,255,.04);font-family:var(--font-body);font-size:13px;color:var(--color-text);outline:none">'
    + '<span class="po-unit-hint" aria-hidden="true" style="flex:0 0 auto;font-size:11px;color:var(--color-text-sec);font-family:var(--font-body);min-width:36px"></span>'
    + '<span class="po-line-total" style="flex:0 0 90px;text-align:right;font-family:var(--font-display);font-weight:600;font-size:13px;color:var(--color-text-sec)">0,00 \u20AC</span>'
    + '<button class="act-btn del po-remove-btn" type="button" title="Odstranit" style="flex-shrink:0">'
    + '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + '</button>';

  wrap.appendChild(row);

  // Wire up line total calculation
  var ingSelect = row.querySelector('.po-ingredient-select');
  var qtyInput = row.querySelector('.po-qty-input');
  var costInput = row.querySelector('.po-cost-input');
  var lineTotal = row.querySelector('.po-line-total');
  var unitHint = row.querySelector('.po-unit-hint');

  // Relabel placeholders + show unit suffix once an ingredient is picked, so
  // the manager always knows whether they are entering ks / L / kg and can't
  // confuse "cena za fl'asu" with "cena za liter".
  function applyUnitLabels() {
    var id = Number(ingSelect.value);
    var ing = id ? ingredients.find(function (x) { return x.id === id; }) : null;
    var unit = ing && ing.unit ? ing.unit : '';
    if (unit) {
      qtyInput.placeholder = 'Mnozstvo (' + unit + ')';
      costInput.placeholder = 'Cena (\u20AC/' + unit + ')';
      unitHint.textContent = '\u20AC/' + unit;
      unitHint.title = 'Cena je za 1 ' + unit;
    } else {
      qtyInput.placeholder = 'Mnozstvo';
      costInput.placeholder = 'Cena za jednotku';
      unitHint.textContent = '';
      unitHint.title = '';
    }
  }

  function updateLineTotal() {
    var qty = parseFloat(qtyInput.value) || 0;
    var cost = parseFloat(costInput.value) || 0;
    lineTotal.textContent = fmtEur(qty * cost);
    updateGrandTotal();
  }

  ingSelect.addEventListener('change', applyUnitLabels);
  qtyInput.addEventListener('input', updateLineTotal);
  costInput.addEventListener('input', updateLineTotal);

  // Remove button
  row.querySelector('.po-remove-btn').addEventListener('click', function () {
    row.remove();
    updateGrandTotal();
  });
}

function updateGrandTotal() {
  var totalEl = document.getElementById('poGrandTotal');
  if (!totalEl) return;

  var total = 0;
  var rows = document.querySelectorAll('#poItemsWrap .po-item-row');
  rows.forEach(function (row) {
    var qty = parseFloat(row.querySelector('.po-qty-input').value) || 0;
    var cost = parseFloat(row.querySelector('.po-cost-input').value) || 0;
    total += qty * cost;
  });

  totalEl.innerHTML = 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">' + fmtEur(total) + '</span>';
}

// ===== TAB SWITCHING =====
function setActiveTab(status) {
  activeStatus = status;
  $$('.po-tab-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  loadOrders();
}

// ===== INVOICE SCAN =====
async function handleInvoiceScan(file) {
  var isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  // Show scanning overlay
  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'scanOverlay';
  ov.innerHTML = '<div class="u-modal" style="text-align:center;max-width:400px">'
    + '<div style="font-size:48px;margin-bottom:12px;animation:spin 2s linear infinite">&#128270;</div>'
    + '<div class="u-modal-title" id="scanStatus">' + (isPdf ? 'Konvertujem PDF...' : 'Skenujem fakturu...') + '</div>'
    + '<div class="u-modal-text">AI analyzuje dokument a extrahuje polozky. Trvanie: 5-20 sekund.</div>'
    + '<style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>'
    + '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  try {
    var images;
    if (isPdf) {
      images = await pdfToImages(file);
      var statusEl = ov.querySelector('#scanStatus');
      if (statusEl) statusEl.textContent = 'Skenujem ' + images.length + ' stran...';
    } else {
      var base64 = await fileToBase64(file);
      images = [base64];
    }

    // Send each page, merge results
    var allItems = [];
    var supplier = null;
    var invoiceNumber = null;
    var date = null;

    for (var i = 0; i < images.length; i++) {
      var statusEl = ov.querySelector('#scanStatus');
      if (statusEl && images.length > 1) statusEl.textContent = 'Skenujem stranu ' + (i + 1) + ' z ' + images.length + '...';

      var result = await api.post('/invoice-scan', { image: images[i] });
      if (result.items) allItems = allItems.concat(result.items);
      if (!supplier && result.supplier) supplier = result.supplier;
      if (!invoiceNumber && result.invoiceNumber) invoiceNumber = result.invoiceNumber;
      if (!date && result.date) date = result.date;
    }

    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);

    openScanReviewModal({ items: allItems, supplier: supplier, invoiceNumber: invoiceNumber, date: date, _imageData: images[0] });
  } catch (err) {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
    showToast('Chyba skenovania: ' + (err.message || 'Neznama chyba'), 'error');
  }
}

function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function pdfToImages(file) {
  // Load pdf.js from CDN if not loaded
  if (!window.pdfjsLib) {
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
      s.type = 'module';
      // pdf.js 4.x is ESM, use a classic build instead
      s.remove();
      var s2 = document.createElement('script');
      s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s2.onload = resolve;
      s2.onerror = reject;
      document.head.appendChild(s2);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var arrayBuffer = await file.arrayBuffer();
  var pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  var images = [];
  var maxPages = Math.min(pdf.numPages, 10); // limit to 10 pages — pokryje aj viacstránkové faktúry s pokračujúcimi riadkami

  for (var i = 1; i <= maxPages; i++) {
    var page = await pdf.getPage(i);
    // OpenAI v detail:"high" škáluje na max 2048px v dlhšej hrane. Scale 2.5 pokryje A4 so solídnou ostrosťou bez zbytočnej veľkosti.
    var viewport = page.getViewport({ scale: 2.5 });
    // Ak je stránka príliš veľká, zmenšíme, aby sme neposielali 20 MB base64
    var MAX_SIDE = 2200;
    var finalWidth = viewport.width;
    var finalHeight = viewport.height;
    var scaleDown = 1;
    if (Math.max(finalWidth, finalHeight) > MAX_SIDE) {
      scaleDown = MAX_SIDE / Math.max(finalWidth, finalHeight);
      finalWidth = Math.round(finalWidth * scaleDown);
      finalHeight = Math.round(finalHeight * scaleDown);
    }
    var canvas = document.createElement('canvas');
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, finalWidth, finalHeight);
    if (scaleDown !== 1) {
      ctx.scale(scaleDown, scaleDown);
    }
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    // JPEG 0.92 je pre OCR prakticky na nerozoznanie od PNG, ale 4–6× menší.
    images.push(canvas.toDataURL('image/jpeg', 0.92));
    canvas.remove();
  }

  return images;
}

function openScanReviewModal(scanResult) {
  var items = scanResult.items || [];
  if (!items.length) {
    showToast('AI nenasla ziadne polozky na fakture', 'error');
    return;
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'scanReviewModal';

  var html = '<div class="u-modal" style="text-align:left;max-width:860px;max-height:90vh;overflow-y:auto">';
  html += '<div class="u-modal-title" style="text-align:center">Skenovana faktura</div>';

  // Invoice info bar
  if (scanResult.supplier || scanResult.invoiceNumber || scanResult.date) {
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;padding:12px;background:var(--color-bg-surface);border-radius:var(--radius-sm);border:1px solid var(--color-border)">';
    if (scanResult.supplier) html += '<div><span style="font-size:var(--text-xs);color:var(--color-text-dim);text-transform:uppercase;letter-spacing:.8px;display:block">Dodavatel</span><span style="font-weight:var(--weight-bold)">' + escapeHtml(scanResult.supplier) + '</span></div>';
    if (scanResult.invoiceNumber) html += '<div><span style="font-size:var(--text-xs);color:var(--color-text-dim);text-transform:uppercase;letter-spacing:.8px;display:block">Cislo faktury</span><span style="font-weight:var(--weight-bold)">' + escapeHtml(scanResult.invoiceNumber) + '</span></div>';
    if (scanResult.date) html += '<div><span style="font-size:var(--text-xs);color:var(--color-text-dim);text-transform:uppercase;letter-spacing:.8px;display:block">Datum</span><span style="font-weight:var(--weight-bold)">' + escapeHtml(scanResult.date) + '</span></div>';
    html += '</div>';
  }

  // Items as cards
  html += '<div class="form-label" style="margin-bottom:10px">Polozky z faktury <span style="color:var(--color-text-dim);font-weight:400;text-transform:none;letter-spacing:0">(' + items.length + ')</span></div>';
  html += '<div id="scanItemsWrap" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">';

  items.forEach(function (item, idx) {
    html += buildScanItemCard(item, idx);
  });

  html += '</div>';

  // Grand total (updates on qty/cost change)
  var grandTotal = items.reduce(function (s, i) {
    var q = Number(i.quantity) || 0;
    var uc = Number(i.unitCost) || 0;
    var tot = Number(i.totalCost) || 0;
    return s + (tot > 0 ? tot : q * uc);
  }, 0);
  html += '<div id="scanGrandTotal" style="text-align:right;font-weight:700;font-size:var(--text-lg);padding-top:10px;border-top:1px solid var(--color-border)">';
  html += 'Celkom: <span id="scanGrandTotalValue" style="color:var(--color-accent);font-family:var(--font-display);font-size:var(--text-2xl)">' + grandTotal.toFixed(2) + ' \u20AC</span>';
  html += '<div style="font-size:var(--text-xs);color:var(--color-text-dim);margin-top:4px">Suma sa prepocita po uprave mnozstiev. Skontroluj, ci zodpoveda sume na fakture (bez DPH).</div>';
  html += '</div>';

  html += '<div class="u-modal-btns" style="margin-top:20px">';
  html += '<button class="u-btn u-btn-ghost" id="scanCancel">Zrusit</button>';
  html += '<button class="u-btn u-btn-ice" id="scanConfirm">Potvrdit a vytvorit objednavku</button>';
  html += '</div>';
  html += '</div>';

  ov.innerHTML = html;
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  var scanData = { items: items.map(function (it) { return Object.assign({}, it); }), supplier: scanResult.supplier, note: scanResult.invoiceNumber ? 'Faktura: ' + scanResult.invoiceNumber : '', imageData: scanResult._imageData || null };

  // Event delegation on the modal
  ov.addEventListener('click', function (e) {
    // Remove card
    var removeBtn = e.target.closest('.scan-remove');
    if (removeBtn) {
      var idx = Number(removeBtn.dataset.idx);
      var card = ov.querySelector('[data-scan-row="' + idx + '"]');
      if (card) { card.style.opacity = '0'; card.style.transform = 'translateX(20px)'; setTimeout(function () { card.remove(); }, 200); }
      scanData.items[idx] = null;
      return;
    }
  });

  // Ingredient select change — handle "+ Vytvorit novu" and update conversion unit
  ov.addEventListener('change', function (e) {
    if (e.target.classList.contains('scan-ing')) {
      var sel = e.target;
      var idx = sel.dataset.idx;
      var card = ov.querySelector('[data-scan-row="' + idx + '"]');
      if (sel.value === '__new__') {
        var newRow = card.querySelector('.scan-new-ing');
        if (newRow) { newRow.style.display = 'flex'; }
        sel.value = '';
      }
      // Update conversion unit label
      updateConversionLabel(card, sel.value);
    }
    if (e.target.classList.contains('scan-conv') || e.target.classList.contains('scan-qty')) {
      var card = e.target.closest('[data-scan-row]');
      if (card) updateConversionResult(card);
    }
  });
  ov.addEventListener('input', function (e) {
    if (e.target.classList.contains('scan-conv') || e.target.classList.contains('scan-qty')) {
      var card = e.target.closest('[data-scan-row]');
      if (card) updateConversionResult(card);
    }
    if (
      e.target.classList.contains('scan-qty') ||
      e.target.classList.contains('scan-cost')
    ) {
      var card = e.target.closest('[data-scan-row]');
      if (card) {
        var qty = parseFloat(card.querySelector('.scan-qty')?.value) || 0;
        var cost = parseFloat(card.querySelector('.scan-cost')?.value) || 0;
        var totalEl = card.querySelector('.scan-total-display');
        if (totalEl) totalEl.textContent = (qty * cost).toFixed(2) + ' \u20AC';
      }
      updateGrandTotal();
    }
  });

  function updateGrandTotal() {
    var rows = ov.querySelectorAll('[data-scan-row]');
    var sum = 0;
    rows.forEach(function (row) {
      var qty = parseFloat(row.querySelector('.scan-qty')?.value) || 0;
      var cost = parseFloat(row.querySelector('.scan-cost')?.value) || 0;
      sum += qty * cost;
    });
    var el = ov.querySelector('#scanGrandTotalValue');
    if (el) el.textContent = sum.toFixed(2) + ' \u20AC';
  }

  function updateConversionLabel(card, ingId) {
    var unitEl = card.querySelector('.scan-conv-unit');
    if (!unitEl) return;
    var ing = ingredients.find(function (i) { return String(i.id) === String(ingId); });
    unitEl.textContent = ing ? ing.unit : '—';
    updateConversionResult(card);
  }
  function updateConversionResult(card) {
    var qty = parseFloat(card.querySelector('.scan-qty')?.value) || 0;
    var conv = parseFloat(card.querySelector('.scan-conv')?.value) || 1;
    var unitEl = card.querySelector('.scan-conv-unit');
    var resultEl = card.querySelector('.scan-conv-result');
    if (!resultEl) return;
    var unit = unitEl ? unitEl.textContent : '';
    if (conv !== 1 && qty > 0) {
      resultEl.textContent = '= ' + (qty * conv).toLocaleString('sk-SK', { maximumFractionDigits: 2 }) + ' ' + unit + ' na sklad';
      resultEl.style.color = 'var(--color-success)';
    } else {
      resultEl.textContent = '';
    }
  }

  // Init conversion labels for matched items
  ov.querySelectorAll('.scan-ing').forEach(function (sel) {
    if (sel.value && sel.value !== '__new__') updateConversionLabel(sel.closest('[data-scan-row]'), sel.value);
  });

  // Cancel
  ov.querySelector('#scanCancel').addEventListener('click', function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  });

  // Confirm
  ov.querySelector('#scanConfirm').addEventListener('click', async function () {
    var btn = ov.querySelector('#scanConfirm');
    btnLoading(btn);

    try {
      // First: create any new ingredients
      var rows = ov.querySelectorAll('[data-scan-row]');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var sel = row.querySelector('.scan-ing');
        if (sel && !sel.value) {
          // Check if user filled new ingredient form
          var newRow = row.querySelector('.scan-new-ing');
          if (newRow && newRow.style.display !== 'none') {
            var newName = newRow.querySelector('.scan-new-name').value.trim();
            var newUnit = newRow.querySelector('.scan-new-unit').value;
            if (newName) {
              var rowIdx = Number(row.dataset.scanRow);
              var itemCat = (scanData.items[rowIdx] && scanData.items[rowIdx].category === 'supply') ? 'supply' : 'ingredient';
              var created = await api.post('/inventory/ingredients', { name: newName, unit: newUnit, type: itemCat, currentQty: 0, minQty: 0, costPerUnit: 0 });
              sel.innerHTML += '<option value="' + created.id + '">' + escapeHtml(created.name) + ' (' + created.unit + ')</option>';
              sel.value = String(created.id);
              newRow.style.display = 'none';
              // Update local list
              ingredients.push({ id: created.id, name: created.name, unit: created.unit });
            }
          }
        }
      }

      // Collect items
      var poItems = [];
      rows.forEach(function (row) {
        var sel = row.querySelector('.scan-ing');
        var ingId = sel ? Number(sel.value) : 0;
        var qty = parseFloat(row.querySelector('.scan-qty').value) || 0;
        var cost = parseFloat(row.querySelector('.scan-cost').value) || 0;
        var conv = parseFloat(row.querySelector('.scan-conv')?.value) || 1;
        var invoiceUnit = row.querySelector('.scan-unit')?.value || '';
        if (!ingId || qty <= 0) return;
        poItems.push({ ingredientId: ingId, quantity: qty, invoiceUnit: invoiceUnit, conversionFactor: conv, unitCost: cost });
      });

      if (!poItems.length) {
        showToast('Priradte suroviny k polozkam alebo vytvorte nove', 'error');
        btnReset(btn);
        return;
      }

      // Match supplier
      var supplierId = null;
      if (scanData.supplier) {
        var match = suppliers.find(function (s) {
          return s.name.toLowerCase().indexOf(scanData.supplier.toLowerCase()) !== -1
            || scanData.supplier.toLowerCase().indexOf(s.name.toLowerCase()) !== -1;
        });
        if (match) supplierId = match.id;
      }
      if (!supplierId && suppliers.length) supplierId = suppliers[0].id;
      if (!supplierId) {
        showToast('Najprv pridajte dodavatela v sekcii Dodavatelia', 'error');
        btnReset(btn);
        return;
      }

      var poBody = { supplierId: supplierId, note: scanData.note || '', items: poItems };
      if (scanData.imageData) poBody.imageData = scanData.imageData;
      await api.post('/inventory/purchase-orders', poBody);

      ov.classList.remove('show');
      setTimeout(function () { ov.remove(); }, 300);
      showToast('Objednavka vytvorena zo skenu', true);
      loadOrders();
    } catch (err) {
      showToast('Chyba: ' + (err.message || 'Neznama chyba'), 'error');
      btnReset(btn);
    }
  });
}

function buildScanItemCard(item, idx) {
  var matched = item.matchedIngredientId || '';
  var isUnmatched = !matched;
  var borderColor = isUnmatched ? 'rgba(224,112,112,.2)' : 'var(--color-border)';
  var bgColor = isUnmatched ? 'rgba(224,112,112,.04)' : 'var(--color-bg-surface)';

  var isSupply = item.category === 'supply';
  var ingOpts = '<option value="">-- priradit ' + (isSupply ? 'tovar' : 'surovinu') + ' --</option>';
  ingOpts += '<option value="__new__" style="color:#5CC49E;font-weight:700">+ Vytvorit ' + (isSupply ? 'novy tovar' : 'novu surovinu') + '</option>';
  ingredients.forEach(function (ing) {
    // Show matching type first, then all
    var ingType = ing.type || 'ingredient';
    var matchesType = (isSupply && ingType === 'supply') || (!isSupply && ingType === 'ingredient');
    var prefix = matchesType ? '' : (ingType === 'supply' ? '[T] ' : '[S] ');
    ingOpts += '<option value="' + ing.id + '"' + (String(ing.id) === String(matched) ? ' selected' : '') + '>' + prefix + escapeHtml(ing.name) + ' (' + ing.unit + ')</option>';
  });

  var h = '';
  h += '<div data-scan-row="' + idx + '" style="padding:12px 14px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:var(--radius-sm);transition:all .2s">';

  // Row 1: invoice name + category badge + remove
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">';
  h += '<div style="font-size:var(--text-md);font-weight:var(--weight-bold);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.invoiceName || item.name || '') + '</div>';
  var catBadge = (item.category === 'supply')
    ? '<span style="font-size:var(--text-xs);font-weight:var(--weight-bold);padding:2px 8px;background:rgba(125,211,252,.1);color:#7DD3FC;border-radius:var(--radius-xs);white-space:nowrap">Tovar</span>'
    : '<span style="font-size:var(--text-xs);font-weight:var(--weight-bold);padding:2px 8px;background:rgba(92,196,158,.1);color:var(--color-success);border-radius:var(--radius-xs);white-space:nowrap">Surovina</span>';
  h += catBadge;
  if (isUnmatched) h += '<span style="font-size:var(--text-xs);color:var(--color-danger);font-weight:var(--weight-bold);padding:2px 8px;background:rgba(224,112,112,.1);border-radius:var(--radius-xs);white-space:nowrap">Nepriradena</span>';

  // Detekcia podozrivého množstva: ak total/unitCost dáva iné číslo než quantity, alebo ak je quantity oveľa menšie
  // než posledné číslo v názve, upozorni manažéra — najčastejšie OCR zamení stĺpec „množstvo" s číslom v popise.
  var qty = Number(item.quantity) || 0;
  var total = Number(item.totalCost) || 0;
  var unitCost = Number(item.unitCost) || 0;
  var expectedFromTotal = unitCost > 0 ? total / unitCost : null;
  var totalMismatch = expectedFromTotal !== null && Math.abs(expectedFromTotal - qty) >= 1 && Math.abs(expectedFromTotal - qty) / Math.max(qty, 1) > 0.1;
  var nameNumbers = String(item.invoiceName || '').match(/\d+/g) || [];
  var biggestInName = nameNumbers.reduce(function (m, s) { var n = parseInt(s, 10); return n > m ? n : m; }, 0);
  var nameMuchBigger = biggestInName > qty && biggestInName >= 4 && qty > 0 && biggestInName / qty >= 3;
  if (totalMismatch || nameMuchBigger) {
    var hint = totalMismatch && expectedFromTotal
      ? 'Total/unit napoveda ' + Math.round(expectedFromTotal) + ' ks'
      : 'V nazve je vacsie cislo (' + biggestInName + ')';
    h += '<span title="Skontrolujte mnozstvo - OCR casto zamena stlpec mnozstvo s cislom v nazve" style="font-size:var(--text-xs);font-weight:var(--weight-bold);padding:2px 8px;background:rgba(255,179,71,.12);color:#FFB347;border-radius:var(--radius-xs);white-space:nowrap">? ' + escapeHtml(hint) + '</span>';
  }

  h += '<button class="scan-remove" data-idx="' + idx + '" title="Odstranit" style="width:28px;height:28px;border-radius:var(--radius-xs);border:none;background:transparent;color:var(--color-text-dim);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">\u2715</button>';
  h += '</div>';

  // Row 2: ingredient select + values
  h += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  h += '<select class="form-select form-select-sm scan-ing" data-idx="' + idx + '" style="flex:2;min-width:160px">' + ingOpts + '</select>';
  h += '<input type="number" class="form-input form-input-sm scan-qty" data-idx="' + idx + '" value="' + (item.quantity || 0) + '" step="0.01" min="0" style="width:75px;text-align:right" placeholder="Mnoz.">';
  h += '<select class="form-select form-select-sm scan-unit" data-idx="' + idx + '" style="width:65px">';
  ['ks','kg','g','l','ml'].forEach(function (u) {
    h += '<option value="' + u + '"' + (item.unit === u ? ' selected' : '') + '>' + u + '</option>';
  });
  h += '</select>';
  h += '<input type="number" class="form-input form-input-sm scan-cost" data-idx="' + idx + '" value="' + (item.unitCost || 0) + '" step="0.01" min="0" style="width:80px;text-align:right" placeholder="Cena">';
  h += '<span class="scan-total-display" style="font-family:var(--font-display);font-weight:700;color:var(--color-accent);min-width:90px;text-align:right">' + Number(item.totalCost || 0).toFixed(2) + ' \u20AC</span>';
  h += '</div>';

  // Row 3: conversion factor (e.g. 1 ks = 500g)
  h += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed rgba(139,124,246,.1)">';
  var aiConv = parseFloat(item.conversionFactor) || 1;
  h += '<span style="font-size:var(--text-xs);color:var(--color-text-sec);white-space:nowrap">Konverzia: 1 ' + escapeHtml(item.unit || 'ks') + ' =</span>';
  h += '<input type="number" class="form-input form-input-sm scan-conv" data-idx="' + idx + '" value="' + aiConv + '" step="0.01" min="0.01" style="width:80px;text-align:right">';
  h += '<span class="scan-conv-unit" style="font-size:var(--text-sm);color:var(--color-accent);font-weight:var(--weight-bold);min-width:20px">—</span>';
  h += '<span class="scan-conv-result" style="font-size:var(--text-xs);color:var(--color-text-dim)"></span>';
  h += '</div>';

  // Row 4: new ingredient/supply form (hidden by default)
  var newIngUnit = isSupply ? 'ks' : (item.targetUnit || item.unit || 'ks');
  h += '<div class="scan-new-ing" style="display:none;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--color-border)">';
  h += '<input class="form-input form-input-sm scan-new-name" placeholder="Nazov ' + (isSupply ? 'noveho tovaru' : 'novej suroviny') + '" value="' + escapeHtml(item.suggestedName || '') + '" style="flex:2">';
  h += '<select class="form-select form-select-sm scan-new-unit" style="width:70px">';
  ['ks','kg','g','l','ml'].forEach(function (u) {
    h += '<option value="' + u + '"' + (newIngUnit === u ? ' selected' : '') + '>' + u + '</option>';
  });
  h += '</select>';
  h += '<span style="font-size:var(--text-xs);color:var(--color-success)">' + (isSupply ? 'Novy tovar' : 'Nova surovina') + '</span>';
  h += '</div>';

  h += '</div>';
  return h;
}

// ===== INIT / DESTROY =====
export function init(container) {
  _container = container;
  // Reset state
  orders = [];
  suppliers = [];
  ingredients = [];
  activeStatus = '';
  itemCounter = 0;

  container.innerHTML = ''
    + '<div class="top-bar">'
    + '<button class="btn-add" id="addOrderBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Nova objednavka'
    + '</button>'
    + '<button class="btn-outline-accent" id="scanInvoiceBtn" style="display:inline-flex;align-items:center;gap:6px">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
    + 'Skenovat fakturu'
    + '</button>'
    + '<input type="file" id="invoiceFileInput" accept="image/*,application/pdf" capture="environment" style="display:none">'
    + '</div>'
    + '<div class="tabs" id="poTabs">'
    + '<button class="tab-btn po-tab-btn active" data-status="">Vsetky</button>'
    + '<button class="tab-btn po-tab-btn" data-status="draft">Rozpracovane</button>'
    + '<button class="tab-btn po-tab-btn" data-status="received">Prijate</button>'
    + '<button class="tab-btn po-tab-btn" data-status="cancelled">Zrusene</button>'
    + '</div>'
    + '<div class="panel" id="ordersPanel">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>';

  // Top bar events
  $('#addOrderBtn').addEventListener('click', function () {
    openNewOrderModal();
  });

  // Invoice scan
  $('#scanInvoiceBtn').addEventListener('click', function () {
    $('#invoiceFileInput').click();
  });
  $('#invoiceFileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    handleInvoiceScan(file);
  });

  // Tab events
  $('#poTabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.po-tab-btn');
    if (!btn) return;
    setActiveTab(btn.dataset.status);
  });

  // Table event delegation
  container.addEventListener('click', function (e) {
    var detailBtn = e.target.closest('[data-detail-id]');
    if (detailBtn) {
      openDetailModal(Number(detailBtn.dataset.detailId));
      return;
    }
    var receiveBtn = e.target.closest('[data-receive-id]');
    if (receiveBtn) {
      receiveOrder(Number(receiveBtn.dataset.receiveId));
      return;
    }
    var cancelBtn = e.target.closest('[data-cancel-id]');
    if (cancelBtn) {
      cancelOrder(Number(cancelBtn.dataset.cancelId));
      return;
    }
    var deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      deleteOrder(Number(deleteBtn.dataset.deleteId));
      return;
    }
    var imageBtn = e.target.closest('[data-image-id]');
    if (imageBtn) {
      showInvoiceImage(Number(imageBtn.dataset.imageId));
      return;
    }
  });

  // Escape key handler
  _escHandler = function (e) {
    if (e.key === 'Escape') {
      var modals = ['poDetailModal', 'poNewModal'];
      modals.forEach(function (modalId) {
        var modal = document.getElementById(modalId);
        if (modal && modal.classList.contains('show')) {
          modal.classList.remove('show');
          setTimeout(function () { modal.remove(); }, 300);
        }
      });
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load reference data in parallel, then load orders
  Promise.all([loadSuppliers(), loadIngredients()]).then(function () {
    loadOrders();
  });
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  ['poDetailModal', 'poNewModal'].forEach(function (modalId) {
    var modal = document.getElementById(modalId);
    if (modal) modal.remove();
  });

  orders = [];
  suppliers = [];
  ingredients = [];
  activeStatus = '';
  itemCounter = 0;
  _container = null;
}
