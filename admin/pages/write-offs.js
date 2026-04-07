// Write-offs (odpisy) page module
let writeOffs = [];
let ingredients = [];
let summary = null;
let activeStatus = '';
let activeReason = '';
let currentView = 'list'; // 'list' | 'summary'
let _container = null;
let _escHandler = null;
var itemCounter = 0;

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
  var d = new Date(isoStr);
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function reasonBadge(reason) {
  var map = {
    expiration: { cls: 'badge-warning', label: 'Expiracia' },
    damage:     { cls: 'badge-danger',  label: 'Poskodenie' },
    theft:      { cls: 'badge-purple',  label: 'Kradez' },
    other:      { cls: '',              label: 'Ine' }
  };
  var entry = map[reason] || { cls: '', label: reason || '--' };
  return '<span class="badge ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}

function statusBadge(status) {
  var map = {
    pending:  { cls: 'badge-warning', label: 'Caka' },
    approved: { cls: 'badge-success', label: 'Schvaleny' },
    rejected: { cls: 'badge-danger',  label: 'Zamietnuty' }
  };
  var entry = map[status] || { cls: '', label: status || '--' };
  return '<span class="badge ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}

// ===== LOAD DATA =====
async function loadIngredients() {
  try {
    ingredients = await api.get('/inventory/ingredients?active=true');
    if (!Array.isArray(ingredients)) ingredients = [];
  } catch (_err) {
    ingredients = [];
  }
}

async function loadWriteOffs() {
  var panel = $('#writeOffsPanel');
  if (panel) showLoading(panel, 'Nacitavam odpisy...');
  try {
    var params = [];
    if (activeStatus) params.push('status=' + encodeURIComponent(activeStatus));
    if (activeReason) params.push('reason=' + encodeURIComponent(activeReason));
    var url = '/inventory/write-offs';
    if (params.length) url += '?' + params.join('&');

    var result = await api.get(url);
    if (panel) hideLoading(panel);
    writeOffs = Array.isArray(result) ? result : [];
    renderTable();
  } catch (err) {
    if (panel) hideLoading(panel);
    if (panel) renderError(panel, err.message || 'Chyba pri nacitani odpisov', loadWriteOffs);
  }
}

async function loadSummary() {
  var wrap = $('#summaryWrap');
  if (wrap) showLoading(wrap, 'Nacitavam prehlad...');
  try {
    var now = new Date();
    var from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    var to = now.toISOString().slice(0, 10);
    summary = await api.get('/inventory/write-offs-summary?from=' + from + '&to=' + to);
    if (wrap) hideLoading(wrap);
    renderSummary();
  } catch (err) {
    if (wrap) hideLoading(wrap);
    if (wrap) renderError(wrap, err.message || 'Chyba pri nacitani prehladu', loadSummary);
  }
}

// ===== RENDER TABLE =====
function renderTable() {
  var panel = $('#writeOffsPanel');
  if (!panel) return;

  if (!writeOffs || writeOffs.length === 0) {
    var emptyLabel = activeStatus || activeReason
      ? 'Ziadne odpisy pre zvoleny filter'
      : 'Ziadne odpisy. Vytvorte novy odpis.';
    panel.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">&#128203;</div>'
      + '<div class="empty-state-title">Ziadne odpisy</div>'
      + '<div class="empty-state-text">' + emptyLabel + '</div>'
      + '</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>'
    + '<th>ID</th>'
    + '<th>Dátum</th>'
    + '<th>Dôvod</th>'
    + '<th class="text-right">Položky</th>'
    + '<th class="text-right">Celková cena</th>'
    + '<th class="text-center">Stav</th>'
    + '<th>Kto vytvoril</th>'
    + '<th class="text-right">Akcie</th>'
    + '</tr></thead><tbody>';

  writeOffs.forEach(function (wo) {
    var itemCount = Array.isArray(wo.items) ? wo.items.length : 0;
    html += '<tr>';
    html += '<td class="td-name">#' + wo.id + '</td>';
    html += '<td>' + fmtDate(wo.createdAt) + '</td>';
    html += '<td>' + reasonBadge(wo.reason) + '</td>';
    html += '<td class="text-right num">' + itemCount + '</td>';
    html += '<td class="text-right num">' + fmtEur(wo.totalCost || 0) + '</td>';
    html += '<td class="text-center">' + statusBadge(wo.status) + '</td>';
    html += '<td>' + escapeHtml(wo.createdByName || '--') + '</td>';
    html += '<td class="text-right nowrap">';
    html += '<div class="prod-actions" style="justify-content:flex-end">';
    // Detail button (eye)
    html += '<button class="act-btn" data-detail-id="' + wo.id + '" title="Detail">'
      + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
      + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      + '</button>';
    // Approve button (checkmark, only pending)
    if (wo.status === 'pending') {
      html += '<button class="act-btn" data-approve-id="' + wo.id + '" title="Schvalit" style="color:var(--color-success)">'
        + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
        + '<polyline points="20 6 9 17 4 12"/></svg>'
        + '</button>';
      // Reject button (X, only pending)
      html += '<button class="act-btn del" data-reject-id="' + wo.id + '" title="Zamietnuť">'
        + '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">'
        + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        + '</button>';
    }
    html += '</div>';
    html += '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  panel.innerHTML = html;
}

// ===== RENDER SUMMARY =====
function renderSummary() {
  var wrap = $('#summaryWrap');
  if (!wrap || !summary) return;

  var byReason = summary.byReason || {};
  var html = '<div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">'

    + '<div class="stat-card accent">'
    + '<div class="stat-icon accent">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Celkom odpisy</div>'
    + '<div class="stat-value">' + fmtEur(summary.total || 0) + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="stat-card amber">'
    + '<div class="stat-icon amber">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Expiracia</div>'
    + '<div class="stat-value">' + fmtEur(byReason.expiration || 0) + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="stat-card rose">'
    + '<div class="stat-icon rose">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Poskodenie</div>'
    + '<div class="stat-value">' + fmtEur(byReason.damage || 0) + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="stat-card accent">'
    + '<div class="stat-icon accent">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Kradez</div>'
    + '<div class="stat-value">' + fmtEur(byReason.theft || 0) + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="stat-card">'
    + '<div class="stat-icon" style="background:rgba(255,255,255,.08);color:var(--color-text-sec)">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    + '</div>'
    + '<div class="stat-info">'
    + '<div class="stat-label">Ine (storno, spotreba)</div>'
    + '<div class="stat-value">' + fmtEur(byReason.other || 0) + '</div>'
    + '</div>'
    + '</div>'

    + '</div>';

  // Top write-offs by cost table
  var sorted = writeOffs.slice().sort(function (a, b) {
    return (b.totalCost || 0) - (a.totalCost || 0);
  });
  var topItems = sorted.slice(0, 10);

  if (topItems.length) {
    html += '<div class="panel" style="margin-top:20px">'
      + '<div style="font-family:var(--font-display);font-weight:var(--weight-bold);font-size:var(--text-lg);margin-bottom:12px">Najvyssie odpisy podla nakladov</div>'
      + '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>'
      + '<th>ID</th>'
      + '<th>Dátum</th>'
      + '<th>Dôvod</th>'
      + '<th class="text-right">Celková cena</th>'
      + '<th class="text-center">Stav</th>'
      + '<th>Kto vytvoril</th>'
      + '</tr></thead><tbody>';

    topItems.forEach(function (wo) {
      html += '<tr>';
      html += '<td class="td-name">#' + wo.id + '</td>';
      html += '<td>' + fmtDate(wo.createdAt) + '</td>';
      html += '<td>' + reasonBadge(wo.reason) + '</td>';
      html += '<td class="text-right num">' + fmtEur(wo.totalCost || 0) + '</td>';
      html += '<td class="text-center">' + statusBadge(wo.status) + '</td>';
      html += '<td>' + escapeHtml(wo.createdByName || '--') + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div></div>';
  }

  wrap.innerHTML = html;
}

// ===== APPROVE / REJECT =====
function approveWriteOff(id) {
  showConfirm(
    'Schvalit odpis',
    'Naozaj chcete schvalit odpis #' + id + '?',
    async function () {
      try {
        await api.post('/inventory/write-offs/' + id + '/approve');
        showToast('Odpis #' + id + ' schvaleny', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri schvalovani odpisu', 'error');
      }
    },
    { type: 'info', confirmText: 'Schvalit' }
  );
}

function rejectWriteOff(id) {
  showConfirm(
    'Zamietnuť odpis',
    'Naozaj chcete zamietnuť odpis #' + id + '?',
    async function () {
      try {
        await api.post('/inventory/write-offs/' + id + '/reject');
        showToast('Odpis #' + id + ' zamietnuty', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri zamietani odpisu', 'error');
      }
    },
    { type: 'danger', confirmText: 'Zamietnuť' }
  );
}

// ===== DETAIL MODAL =====
function openDetailModal(id) {
  var wo = writeOffs.find(function (w) { return w.id === id; });
  if (!wo) return;

  var existing = document.getElementById('woDetailModal');
  if (existing) existing.remove();

  var items = Array.isArray(wo.items) ? wo.items : [];

  var itemsHtml = '';
  if (items.length > 0) {
    itemsHtml = '<div class="table-scroll-wrap"><table class="data-table" style="margin-top:12px">'
      + '<thead><tr>'
      + '<th>Surovina</th>'
      + '<th>Jednotka</th>'
      + '<th class="text-right">Množstvo</th>'
      + '<th class="text-right">Jedn. cena</th>'
      + '<th class="text-right">Spolu</th>'
      + '</tr></thead><tbody>';
    items.forEach(function (item) {
      itemsHtml += '<tr>';
      itemsHtml += '<td class="td-name">' + escapeHtml(item.ingredientName || '--') + '</td>';
      itemsHtml += '<td>' + escapeHtml(item.ingredientUnit || '--') + '</td>';
      itemsHtml += '<td class="text-right num">' + fmtNum(item.quantity) + '</td>';
      itemsHtml += '<td class="text-right num">' + fmtEur(item.unitCost || 0) + '</td>';
      itemsHtml += '<td class="text-right num">' + fmtEur(item.totalCost || 0) + '</td>';
      itemsHtml += '</tr>';
    });
    itemsHtml += '</tbody></table></div>';
  } else {
    itemsHtml = '<div class="td-empty" style="padding:16px;text-align:center">Ziadne polozky</div>';
  }

  var actionBtns = '';
  if (wo.status === 'pending') {
    actionBtns = '<div style="display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--color-border);margin-top:4px">'
      + '<button class="u-btn u-btn-ice" id="woDetailApprove" style="flex:1">Schvalit</button>'
      + '<button class="u-btn u-btn-rose" id="woDetailReject" style="flex:1">Zamietnuť</button>'
      + '</div>';
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'woDetailModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:640px">'
    + '<div class="u-modal-title" style="text-align:center">Odpis #' + wo.id + '</div>'
    + '<div class="u-modal-body" style="gap:10px">'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap">'
    + '<div style="flex:1;min-width:120px"><div class="form-label">Dovod</div><div>' + reasonBadge(wo.reason) + '</div></div>'
    + '<div style="flex:1;min-width:120px"><div class="form-label">Datum</div><div style="font-weight:600">' + fmtDate(wo.createdAt) + '</div></div>'
    + '<div style="flex:1;min-width:120px"><div class="form-label">Stav</div><div>' + statusBadge(wo.status) + '</div></div>'
    + '</div>'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap">'
    + '<div style="flex:1;min-width:120px"><div class="form-label">Vytvoril</div><div style="font-weight:600">' + escapeHtml(wo.createdByName || '--') + '</div></div>'
    + (wo.approvedByName ? '<div style="flex:1;min-width:120px"><div class="form-label">Schvalil</div><div style="font-weight:600">' + escapeHtml(wo.approvedByName) + '</div></div>' : '')
    + '</div>'
    + (wo.note ? '<div><div class="form-label">Poznamka</div><div style="font-size:13px;color:var(--color-text-sec)">' + escapeHtml(wo.note) + '</div></div>' : '')
    + '<div><div class="form-label">Polozky</div>' + itemsHtml + '</div>'
    + '<div style="text-align:right;font-weight:700;font-size:14px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)">'
    + 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">' + fmtEur(wo.totalCost || 0) + '</span>'
    + '</div>'
    + '</div>'
    + actionBtns
    + '<div class="u-modal-btns" style="margin-top:16px">'
    + '<button class="u-btn u-btn-ghost" id="woDetailClose">Zavriet</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  document.getElementById('woDetailClose').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  // Approve/reject from detail modal
  var approveBtn = ov.querySelector('#woDetailApprove');
  var rejectBtn = ov.querySelector('#woDetailReject');

  if (approveBtn) {
    approveBtn.addEventListener('click', async function () {
      btnLoading(approveBtn);
      try {
        await api.post('/inventory/write-offs/' + wo.id + '/approve');
        closeModal();
        showToast('Odpis #' + wo.id + ' schvaleny', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri schvalovani', 'error');
        btnReset(approveBtn);
      }
    });
  }

  if (rejectBtn) {
    rejectBtn.addEventListener('click', async function () {
      btnLoading(rejectBtn);
      try {
        await api.post('/inventory/write-offs/' + wo.id + '/reject');
        closeModal();
        showToast('Odpis #' + wo.id + ' zamietnuty', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri zamietani', 'error');
        btnReset(rejectBtn);
      }
    });
  }
}

// ===== NEW WRITE-OFF MODAL =====
function openNewModal() {
  var existing = document.getElementById('woNewModal');
  if (existing) existing.remove();

  itemCounter = 0;

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'woNewModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:720px">'
    + '<div class="u-modal-title" style="text-align:center">Novy odpis</div>'
    + '<div class="u-modal-body" style="gap:14px">'
    + '<div class="u-modal-field">'
    + '<label for="fWoReason">Dovod<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="fWoReason" data-validate="required">'
    + '<option value="">-- Vyberte dovod --</option>'
    + '<option value="expiration">Expiracia</option>'
    + '<option value="damage">Poskodenie</option>'
    + '<option value="theft">Kradez</option>'
    + '<option value="other">Ine</option>'
    + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fWoNote">Poznamka</label>'
    + '<textarea id="fWoNote" class="form-input" rows="2" placeholder="Doplnujuce informacie..."></textarea>'
    + '</div>'
    + '<div>'
    + '<div class="form-label" style="margin-bottom:8px">Polozky<span class="required-mark" aria-hidden="true"> *</span></div>'
    + '<div id="woItemsWrap"></div>'
    + '<button class="btn-outline-accent" id="woAddItemBtn" type="button" style="margin-top:8px">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14" style="width:12px;height:12px"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + ' Pridat polozku'
    + '</button>'
    + '</div>'
    + '<div id="woGrandTotal" style="text-align:right;font-weight:700;font-size:14px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)">'
    + 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">0,00 \u20AC</span>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="woNewCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="woNewSave">Vytvorit odpis</button>'
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

  document.getElementById('woNewCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  document.getElementById('woAddItemBtn').onclick = function () {
    addItemRow();
  };

  document.getElementById('woNewSave').onclick = async function () {
    if (!validateForm(ov)) return;

    var reason = document.getElementById('fWoReason').value;
    var note = document.getElementById('fWoNote').value.trim();

    if (!reason) {
      showToast('Vyberte dovod odpisu');
      return;
    }

    var itemRows = document.querySelectorAll('#woItemsWrap .wo-item-row');
    var items = [];
    var hasError = false;

    itemRows.forEach(function (row) {
      var ingredientId = Number(row.querySelector('.wo-ingredient-select').value);
      var quantity = parseFloat(row.querySelector('.wo-qty-input').value) || 0;

      if (!ingredientId) { hasError = true; return; }
      if (quantity <= 0) { hasError = true; return; }

      items.push({ ingredientId: ingredientId, quantity: quantity });
    });

    if (items.length === 0 || hasError) {
      showToast('Pridajte aspon jednu polozku s platnym mnozstvom');
      return;
    }

    var saveBtn = document.getElementById('woNewSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      await api.post('/inventory/write-offs', {
        reason: reason,
        note: note || undefined,
        items: items
      });
      showToast('Odpis vytvoreny', true);
      closeModal();
      await loadWriteOffs();
    } catch (err) {
      showToast(err.message || 'Chyba pri vytvarani odpisu', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };
}

function addItemRow() {
  var wrap = document.getElementById('woItemsWrap');
  if (!wrap) return;

  itemCounter++;
  var rowId = 'woItem_' + itemCounter;

  var ingredientOpts = '<option value="">-- Surovina --</option>';
  ingredients.forEach(function (ing) {
    ingredientOpts += '<option value="' + ing.id + '" data-cost="' + (ing.costPerUnit || 0) + '">'
      + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
  });

  var row = document.createElement('div');
  row.className = 'wo-item-row';
  row.id = rowId;
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap';
  row.innerHTML = ''
    + '<select class="wo-ingredient-select" style="flex:2;min-width:140px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--color-border);background:rgba(255,255,255,.04);font-family:var(--font-body);font-size:13px;color:var(--color-text);outline:none">'
    + ingredientOpts
    + '</select>'
    + '<input class="wo-qty-input" type="number" step="0.01" min="0" placeholder="Mnozstvo" style="flex:1;min-width:80px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--color-border);background:rgba(255,255,255,.04);font-family:var(--font-body);font-size:13px;color:var(--color-text);outline:none">'
    + '<span class="wo-line-cost" style="flex:0 0 90px;text-align:right;font-family:var(--font-display);font-weight:600;font-size:13px;color:var(--color-text-sec)">0,00 \u20AC</span>'
    + '<button class="act-btn del wo-remove-btn" type="button" title="Odstranit" style="flex-shrink:0">'
    + '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + '</button>';

  wrap.appendChild(row);

  var ingredientSelect = row.querySelector('.wo-ingredient-select');
  var qtyInput = row.querySelector('.wo-qty-input');
  var lineCost = row.querySelector('.wo-line-cost');

  function getSelectedCostPerUnit() {
    var selected = ingredientSelect.options[ingredientSelect.selectedIndex];
    if (!selected) return 0;
    return parseFloat(selected.dataset.cost) || 0;
  }

  function updateLineCost() {
    var qty = parseFloat(qtyInput.value) || 0;
    var costPerUnit = getSelectedCostPerUnit();
    lineCost.textContent = fmtEur(qty * costPerUnit);
    updateGrandTotal();
  }

  ingredientSelect.addEventListener('change', updateLineCost);
  qtyInput.addEventListener('input', updateLineCost);

  // Remove button
  row.querySelector('.wo-remove-btn').addEventListener('click', function () {
    row.remove();
    updateGrandTotal();
  });
}

function updateGrandTotal() {
  var totalEl = document.getElementById('woGrandTotal');
  if (!totalEl) return;

  var total = 0;
  var rows = document.querySelectorAll('#woItemsWrap .wo-item-row');
  rows.forEach(function (row) {
    var select = row.querySelector('.wo-ingredient-select');
    var selected = select.options[select.selectedIndex];
    var costPerUnit = selected ? (parseFloat(selected.dataset.cost) || 0) : 0;
    var qty = parseFloat(row.querySelector('.wo-qty-input').value) || 0;
    total += qty * costPerUnit;
  });

  totalEl.innerHTML = 'Celkova cena: <span style="color:var(--color-accent);font-family:var(--font-display)">' + fmtEur(total) + '</span>';
}

// ===== VIEW TOGGLE =====
function setView(view) {
  currentView = view;
  $$('.wo-view-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  var listSection = $('#listSection');
  var summarySection = $('#summarySection');

  if (view === 'list') {
    if (listSection) listSection.style.display = '';
    if (summarySection) summarySection.style.display = 'none';
  } else {
    if (listSection) listSection.style.display = 'none';
    if (summarySection) summarySection.style.display = '';
    loadSummary();
  }
}

// ===== TAB SWITCHING =====
function setActiveTab(status) {
  activeStatus = status;
  $$('.wo-tab-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  loadWriteOffs();
}

// ===== INIT / DESTROY =====
export function init(container) {
  _container = container;
  // Reset state
  writeOffs = [];
  ingredients = [];
  summary = null;
  activeStatus = '';
  activeReason = '';
  currentView = 'list';
  itemCounter = 0;

  container.innerHTML = ''
    // View toggle
    + '<div class="tabs" style="margin-bottom:16px">'
    + '<button class="tab-btn wo-view-btn active" data-view="list">Zoznam</button>'
    + '<button class="tab-btn wo-view-btn" data-view="summary">Prehlad</button>'
    + '</div>'

    // LIST VIEW
    + '<div id="listSection">'
    + '<div class="top-bar">'
    + '<button class="btn-add" id="addWriteOffBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Novy odpis'
    + '</button>'
    + '</div>'
    + '<div class="tabs" id="woTabs">'
    + '<button class="tab-btn wo-tab-btn active" data-status="">Vsetky</button>'
    + '<button class="tab-btn wo-tab-btn" data-status="pending">Cakajuce</button>'
    + '<button class="tab-btn wo-tab-btn" data-status="approved">Schvalene</button>'
    + '<button class="tab-btn wo-tab-btn" data-status="rejected">Zamietnute</button>'
    + '</div>'
    + '<div class="panel" id="writeOffsPanel">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    + '</div>'

    // SUMMARY VIEW
    + '<div id="summarySection" style="display:none">'
    + '<div id="summaryWrap">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    + '</div>';

  // View toggle events
  _container.querySelector('.tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.wo-view-btn');
    if (!btn) return;
    setView(btn.dataset.view);
  });

  // New write-off button
  $('#addWriteOffBtn').addEventListener('click', function () {
    openNewModal();
  });

  // Status tab events
  $('#woTabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.wo-tab-btn');
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
    var approveBtn = e.target.closest('[data-approve-id]');
    if (approveBtn) {
      approveWriteOff(Number(approveBtn.dataset.approveId));
      return;
    }
    var rejectBtn = e.target.closest('[data-reject-id]');
    if (rejectBtn) {
      rejectWriteOff(Number(rejectBtn.dataset.rejectId));
      return;
    }
  });

  // Escape key handler
  _escHandler = function (e) {
    if (e.key === 'Escape') {
      var modals = ['woDetailModal', 'woNewModal'];
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

  // Load reference data then write-offs
  loadIngredients().then(function () {
    loadWriteOffs();
  });
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  ['woDetailModal', 'woNewModal'].forEach(function (modalId) {
    var modal = document.getElementById(modalId);
    if (modal) modal.remove();
  });

  writeOffs = [];
  ingredients = [];
  summary = null;
  activeStatus = '';
  activeReason = '';
  currentView = 'list';
  itemCounter = 0;
  _container = null;
}
