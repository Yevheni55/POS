// Write-offs (odpisy) page module
import { mountEmptyState } from '../components/empty-state.js';

let writeOffs = [];
let ingredients = [];
let summary = null;
let activeStatus = '';
let activeReason = '';
let currentView = 'list'; // 'list' | 'summary'
let _container = null;
let _escHandler = null;
var itemCounter = 0;
// Počty podľa stavu pre chipy — spočítané z posledného nefiltrovaného zoznamu.
var _counts = {};

function $(sel) {
  return _container.querySelector(sel);
}

function $$(sel) {
  return _container.querySelectorAll(sel);
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

// Dôvod odpisu — farba nesie druh straty (expirácia jantár, poškodenie
// červená, krádež navy), zamestnanecká spotreba a „iné" sú neutrálne.
var REASONS = {
  expiration: { cls: 'is-warn',   label: 'Expirácia' },
  damage:     { cls: 'is-danger', label: 'Poškodenie' },
  theft:      { cls: 'is-navy',   label: 'Krádež' },
  staff_meal: { cls: 'is-accent', label: 'Zamestnanecká spotreba' },
  other:      { cls: 'is-dim',    label: 'Iné' }
};
function reasonLabel(reason) {
  return (REASONS[reason] || {}).label || reason || '—';
}
function reasonPill(reason) {
  var entry = REASONS[reason] || { cls: 'is-dim', label: reason || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}

// Stav: čakajúci na schválenie je výnimka (jantár), zamietnutý sivý,
// schválený zelený — v zozname ho nezobrazujeme, je to pravidlo.
var STATUS = {
  pending:  { cls: 'is-warn', label: 'Čaká na schválenie' },
  approved: { cls: 'is-ok',   label: 'Schválený' },
  rejected: { cls: 'is-dim',  label: 'Zamietnutý' }
};
function statusPill(status) {
  var entry = STATUS[status] || { cls: 'is-dim', label: status || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}
function woWord(n) {
  if (n === 1) return 'odpis';
  if (n >= 2 && n <= 4) return 'odpisy';
  return 'odpisov';
}
function itemWord(n) {
  if (n === 1) return 'položka';
  if (n >= 2 && n <= 4) return 'položky';
  return 'položiek';
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
  if (panel) showLoading(panel, 'Načítavam odpisy…');
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
    if (panel) renderError(panel, err.message || 'Chyba pri načítaní odpisov', loadWriteOffs);
  }
}

async function loadSummary() {
  var wrap = $('#summaryWrap');
  if (wrap) showLoading(wrap, 'Načítavam prehľad…');
  try {
    // Bratislavsky den (zdielany global z /api.js), nie UTC — 'from' je
    // prvy den toho isteho bratislavskeho mesiaca ako 'to'.
    var to = bratislavaDayIso(new Date());
    var from = to.slice(0, 8) + '01';
    summary = await api.get('/inventory/write-offs-summary?from=' + from + '&to=' + to);
    if (wrap) hideLoading(wrap);
    renderSummary();
  } catch (err) {
    if (wrap) hideLoading(wrap);
    if (wrap) renderError(wrap, err.message || 'Chyba pri načítaní prehľadu', loadSummary);
  }
}

// ===== RENDER TABLE =====
function rowHtml(wo) {
  var itemCount = Array.isArray(wo.items) ? wo.items.length : 0;
  var sub = ['#' + wo.id, fmtDate(wo.createdAt), itemCount + ' ' + itemWord(itemCount), escapeHtml(wo.createdByName || '—')];
  // Schváliť / zamietnuť je v detaile — riadok má jeden cieľ.
  return '<button type="button" class="sk-row' + (wo.status === 'rejected' ? ' is-off' : '') + '" data-detail-id="' + wo.id + '">'
    + '<span class="sk-row-main">'
    + '<span class="sk-row-name">' + escapeHtml(reasonLabel(wo.reason)) + '</span>'
    + '<span class="sk-row-sub">' + sub.join(' · ') + '</span>'
    + '</span>'
    + '<span class="sk-row-side">'
    + '<span class="sk-row-num">' + fmtEur(wo.totalCost || 0) + '</span>'
    + (wo.status === 'approved' ? '' : statusPill(wo.status))
    + '</span>'
    + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>';
}

function renderSum() {
  var sum = $('#woSum');
  if (!sum) return;
  var total = writeOffs.reduce(function (s, w) { return s + (Number(w.totalCost) || 0); }, 0);
  sum.innerHTML = '<span><strong>' + writeOffs.length + '</strong> ' + woWord(writeOffs.length) + '</span>'
    + (writeOffs.length ? '<span><strong>' + fmtEur(total) + '</strong></span>' : '');

  // Počet v chipe („Čakajúce 1") namiesto ďalšej pilulky v súčte — hovorí
  // to isté a nezaberá riadok navyše.
  if (!activeStatus) {
    _counts = {};
    writeOffs.forEach(function (w) { _counts[w.status] = (_counts[w.status] || 0) + 1; });
  }
  $$('.wo-tab-btn').forEach(function (btn) {
    var st = btn.dataset.status;
    var n = st ? (_counts[st] || 0) : 0;
    btn.innerHTML = escapeHtml(btn.dataset.label || btn.textContent) + (n ? ' <span class="sk-n">' + n + '</span>' : '');
  });
}

function renderTable() {
  var panel = $('#writeOffsPanel');
  if (!panel) return;

  renderSum();

  if (!writeOffs || writeOffs.length === 0) {
    var filtered = activeStatus || activeReason;
    if (filtered) {
      mountEmptyState(panel, {
        icon: '🔍',
        title: 'Žiadne výsledky',
        text: 'Pre zvolený filter sa nenašli žiadne odpisy.',
        ctaLabel: 'Zobraziť všetky',
        onCta: function () {
          activeReason = '';
          setActiveTab('');
        },
      });
    } else {
      mountEmptyState(panel, {
        icon: '📋',
        title: 'Žiadne odpisy',
        text: 'Odpis zaznamenáva straty (rozliatie, exspirovaný tovar, krádež) a znižuje stav skladu. Vytvorte prvý.',
        ctaLabel: 'Nový odpis',
        onCta: function () { openNewModal(); },
      });
    }
    return;
  }

  panel.innerHTML = '<div class="sk-list">' + writeOffs.map(rowHtml).join('') + '</div>';
}

// ===== RENDER SUMMARY =====
function renderSummary() {
  var wrap = $('#summaryWrap');
  if (!wrap || !summary) return;

  var byReason = summary.byReason || {};
  var reasons = ['expiration', 'damage', 'theft', 'staff_meal', 'other'];

  // Jeden riadok súčtu namiesto piatich rovnocenných kariet; rozpad podľa
  // dôvodu je zoznam — nula sa nezobrazuje, nie je čo riešiť.
  var html = '<div class="sk-sum">'
    + '<span>Tento mesiac odpísané <strong>' + fmtEur(summary.total || 0) + '</strong></span>'
    + '<span><strong>' + (summary.count || 0) + '</strong> ' + woWord(summary.count || 0) + '</span>'
    + '</div>';

  var rows = reasons.filter(function (r) { return Number(byReason[r]) > 0; }).map(function (r) {
    return '<div class="sk-row is-static">'
      + '<span class="sk-row-main"><span class="sk-row-name">' + escapeHtml(reasonLabel(r)) + '</span></span>'
      + '<span class="sk-row-side"><span class="sk-row-num">' + fmtEur(byReason[r]) + '</span></span>'
      + '</div>';
  });
  html += '<div class="sk-list-title">Podľa dôvodu</div>'
    + '<div class="sk-list">' + (rows.length ? rows.join('') : '<div class="empty-hint">Tento mesiac zatiaľ bez schválených odpisov.</div>') + '</div>';

  // Top write-offs by cost
  var sorted = writeOffs.slice().sort(function (a, b) {
    return (b.totalCost || 0) - (a.totalCost || 0);
  });
  var topItems = sorted.slice(0, 10);

  if (topItems.length) {
    html += '<div class="sk-list-title">Najvyššie odpisy</div>'
      + '<div class="sk-list">' + topItems.map(rowHtml).join('') + '</div>';
  }

  wrap.innerHTML = html;
}

// ===== APPROVE / REJECT =====
function approveWriteOff(id) {
  showConfirm(
    'Schváliť odpis',
    'Naozaj chcete schváliť odpis #' + id + '? Množstvá sa odpíšu zo skladu.',
    async function () {
      try {
        await api.post('/inventory/write-offs/' + id + '/approve');
        showToast('Odpis #' + id + ' schválený', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri schvaľovaní odpisu', 'error');
      }
    },
    { type: 'info', confirmText: 'Schváliť' }
  );
}

function rejectWriteOff(id) {
  showConfirm(
    'Zamietnuť odpis',
    'Naozaj chcete zamietnuť odpis #' + id + '?',
    async function () {
      try {
        await api.post('/inventory/write-offs/' + id + '/reject');
        showToast('Odpis #' + id + ' zamietnutý', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri zamietaní odpisu', 'error');
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

  // Položky ako riadky: názov vľavo, suma a „množstvo × cena" vpravo.
  var itemsHtml = '';
  if (items.length > 0) {
    itemsHtml = '<div class="sk-items">' + items.map(function (item) {
      return '<div class="sk-item">'
        + '<div class="sk-item-main"><span class="sk-item-name">' + escapeHtml(item.ingredientName || '—') + '</span></div>'
        + '<div class="sk-item-side"><span class="sk-item-num">' + fmtEur(item.totalCost || 0) + '</span>'
        + '<span class="sk-item-meta">' + fmtNum(item.quantity) + '\u00A0' + escapeHtml(item.ingredientUnit || '') + ' × ' + fmtEur(item.unitCost || 0) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
  } else {
    itemsHtml = '<div class="empty-hint">Odpis nemá žiadne položky.</div>';
  }

  var actionBtns = '';
  if (wo.status === 'pending') {
    actionBtns = '<div class="sk-actions">'
      + '<button class="u-btn u-btn-rose" id="woDetailReject">Zamietnuť</button>'
      + '<button class="u-btn u-btn-ice" id="woDetailApprove">Schváliť odpis</button>'
      + '</div>';
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'woDetailModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:640px">'
    + '<div class="u-modal-title">Odpis #' + wo.id + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="sk-kv">'
    + '<div><span class="sk-kv-k">Dôvod</span><span class="sk-kv-v">' + reasonPill(wo.reason) + '</span></div>'
    + '<div><span class="sk-kv-k">Stav</span><span class="sk-kv-v">' + statusPill(wo.status) + '</span></div>'
    + '<div><span class="sk-kv-k">Dátum</span><span class="sk-kv-v num">' + fmtDate(wo.createdAt) + '</span></div>'
    + '<div><span class="sk-kv-k">Vytvoril</span><span class="sk-kv-v">' + escapeHtml(wo.createdByName || '—') + '</span></div>'
    + (wo.approvedByName ? '<div><span class="sk-kv-k">Schválil</span><span class="sk-kv-v">' + escapeHtml(wo.approvedByName) + '</span></div>' : '')
    + '</div>'
    + (wo.note ? '<div><span class="sk-kv-k">Poznámka</span><div class="sk-note">' + escapeHtml(wo.note) + '</div></div>' : '')
    + '<div class="sk-label">Položky</div>'
    + itemsHtml
    + '<div class="sk-total"><span>Celková cena</span><strong>' + fmtEur(wo.totalCost || 0) + '</strong></div>'
    + actionBtns
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="woDetailClose">Zavrieť</button>'
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
        showToast('Odpis #' + wo.id + ' schválený', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri schvaľovaní', 'error');
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
        showToast('Odpis #' + wo.id + ' zamietnutý', true);
        await loadWriteOffs();
      } catch (err) {
        showToast(err.message || 'Chyba pri zamietaní', 'error');
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
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:720px">'
    + '<div class="u-modal-title">Nový odpis</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fWoReason">Dôvod<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="fWoReason" data-validate="required">'
    + '<option value="">— vyberte dôvod —</option>'
    + '<option value="expiration">Expirácia</option>'
    + '<option value="damage">Poškodenie</option>'
    + '<option value="theft">Krádež</option>'
    + '<option value="other">Iné</option>'
    + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fWoNote">Poznámka</label>'
    + '<textarea id="fWoNote" class="form-input" rows="2" placeholder="Doplňujúce informácie…"></textarea>'
    + '</div>'
    + '<div class="sk-label">Položky<span class="required-mark" aria-hidden="true"> *</span></div>'
    + '<div id="woItemsWrap" class="sk-frows"></div>'
    + '<button class="btn-secondary sk-frow-add" id="woAddItemBtn" type="button"><svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pridať položku</button>'
    + '<div id="woGrandTotal" class="sk-total"><span>Celková cena</span><strong>' + fmtEur(0) + '</strong></div>'
    + '<div class="sk-total-hint">Cena sa počíta z aktuálnej nákupnej ceny suroviny. Odpis nad 50 € čaká na schválenie manažérom.</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="woNewCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="woNewSave">Vytvoriť odpis</button>'
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
      showToast('Vyberte dôvod odpisu');
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
      showToast('Pridajte aspoň jednu položku s platným množstvom');
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
      showToast('Odpis vytvorený', true);
      closeModal();
      await loadWriteOffs();
    } catch (err) {
      showToast(err.message || 'Chyba pri vytváraní odpisu', 'error');
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

  var ingredientOpts = '<option value="">— surovina —</option>';
  ingredients.forEach(function (ing) {
    ingredientOpts += '<option value="' + ing.id + '" data-cost="' + (ing.costPerUnit || 0) + '">'
      + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
  });

  // Riadok položky: surovina / množstvo / suma / odstrániť. Rozloženie
  // rieši CSS (.sk-frow--wo), na telefóne sa skladá do dvoch riadkov.
  var row = document.createElement('div');
  row.className = 'wo-item-row sk-frow sk-frow--wo';
  row.id = rowId;
  row.innerHTML = ''
    + '<select class="wo-ingredient-select form-select sk-f-sel" aria-label="Surovina">'
    + ingredientOpts
    + '</select>'
    + '<input class="wo-qty-input form-input sk-f-qty" type="number" step="0.01" min="0" placeholder="Množstvo" aria-label="Množstvo">'
    + '<span class="wo-line-cost sk-frow-tot sk-f-tot">' + fmtEur(0) + '</span>'
    + '<button class="act-btn del wo-remove-btn sk-f-rm" type="button" title="Odstrániť" aria-label="Odstrániť položku"><svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';

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

  totalEl.innerHTML = '<span>Celková cena</span><strong>' + fmtEur(total) + '</strong>';
}

// ===== VIEW TOGGLE =====
function setView(view) {
  currentView = view;
  var listSection = $('#listSection');
  var summarySection = $('#summarySection');

  if (view === 'list') {
    if (listSection) listSection.hidden = false;
    if (summarySection) summarySection.hidden = true;
  } else {
    if (listSection) listSection.hidden = true;
    if (summarySection) summarySection.hidden = false;
    loadSummary();
  }
}

// ===== TAB SWITCHING =====
function setActiveTab(status) {
  activeStatus = status;
  $$('.wo-tab-btn').forEach(function (btn) {
    var on = btn.dataset.status === status;
    btn.classList.toggle('active', on);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
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

  var statusChips = [['', 'Všetky'], ['pending', 'Čakajúce'], ['approved', 'Schválené'], ['rejected', 'Zamietnuté']]
    .map(function (t, i) {
      return '<button type="button" class="doch-chip wo-tab-btn' + (i === 0 ? ' is-on active' : '') + '" data-status="' + t[0] + '" data-label="' + t[1] + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' + t[1] + '</button>';
    }).join('');

  container.innerHTML = ''
    // LIST VIEW
    + '<div id="listSection">'
    + '<div class="sk-head">'
    + '<div class="sk-sum" id="woSum" aria-live="polite"></div>'
    + '<button class="btn-add" id="addWriteOffBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Nový odpis'
    + '</button>'
    + '</div>'
    + '<div class="sk-filters"><div class="sk-chips" id="woTabs" role="group" aria-label="Stav odpisu">' + statusChips + '</div></div>'
    + '<div class="panel sk-bare" id="writeOffsPanel">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    // Prehľad mesiaca je report — odkaz pod zoznamom, nie segment nad ním
    // (ušetrí 62 px nad prvým odpisom).
    + '<div class="sk-foot"><button type="button" class="sk-link wo-view-btn" data-view="summary">Prehľad mesiaca</button></div>'
    + '</div>'

    // SUMMARY VIEW
    + '<div id="summarySection" hidden>'
    + '<div class="sk-detail-head"><button type="button" class="sk-back wo-view-btn" data-view="list"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>Späť na zoznam</button></div>'
    + '<div id="summaryWrap">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    + '</div>';

  // View toggle events (odkaz pod zoznamom / späť zo súhrnu)
  container.addEventListener('click', function (e) {
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

  // List event delegation
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

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-writeoff') {
      setTimeout(function () { openNewModal(); }, 120);
    }
  }
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
