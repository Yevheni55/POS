// Purchase orders page module
import { softDelete } from '../components/toast-undo.js';
import { mountEmptyState } from '../components/empty-state.js';
import { fmtCost } from '../../components/fmt.js';

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
  return new Date(isoStr).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Stav ako pilulka. V zozname dostane farbu len výnimka (rozpracovaná =
// treba prijať, zrušená); prijatá je pravidlo a v riadku ju nesie podtitulok.
var STATUS = {
  draft:     { cls: 'is-warn',   label: 'Rozpracovaná' },
  received:  { cls: 'is-ok',     label: 'Prijatá' },
  cancelled: { cls: 'is-dim',    label: 'Zrušená' }
};
function statusPill(status) {
  var entry = STATUS[status] || { cls: 'is-dim', label: status || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}
function statusLabel(status) {
  return (STATUS[status] || {}).label || status || '—';
}
function orderWord(n) {
  if (n === 1) return 'objednávka';
  if (n >= 2 && n <= 4) return 'objednávky';
  return 'objednávok';
}
function itemWord(n) {
  if (n === 1) return 'položka';
  if (n >= 2 && n <= 4) return 'položky';
  return 'položiek';
}

// ===== LOAD =====
async function loadOrders() {
  var panel = $('#ordersPanel');
  if (panel) showLoading(panel, 'Načítavam objednávky…');
  try {
    var url = '/inventory/purchase-orders';
    if (activeStatus) url += '?status=' + activeStatus;
    orders = await api.get(url);
    if (panel) hideLoading(panel);
    renderTable();
  } catch (err) {
    if (panel) hideLoading(panel);
    if (panel) renderError(panel, err.message || 'Chyba pri načítaní objednávok', loadOrders);
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
function rowHtml(po) {
  var supplierName = po.supplier ? escapeHtml(po.supplier.name) : '—';
  var itemCount = po.items ? po.items.length : 0;
  var subParts = ['#' + po.id, fmtDate(po.createdAt), itemCount + ' ' + itemWord(itemCount)];
  if (po.status === 'received') subParts.push('prijatá');
  if (po.hasImage) subParts.push('faktúra');
  // Akcie (prijať, zrušiť, vymazať, faktúra) sú v detaile — riadok má jeden cieľ.
  return '<button type="button" class="sk-row' + (po.status === 'cancelled' ? ' is-off' : '') + '" data-detail-id="' + po.id + '">'
    + '<span class="sk-row-main">'
    + '<span class="sk-row-name">' + supplierName + '</span>'
    + '<span class="sk-row-sub">' + subParts.join(' · ') + '</span>'
    + '</span>'
    + '<span class="sk-row-side">'
    + '<span class="sk-row-num">' + fmtEur(po.totalCost || 0) + '</span>'
    + (po.status === 'received' ? '' : statusPill(po.status))
    + '</span>'
    + '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>';
}

function renderSum() {
  var sum = $('#poSum');
  if (!sum) return;
  var total = orders.reduce(function (s, po) { return s + (Number(po.totalCost) || 0); }, 0);
  var drafts = orders.filter(function (po) { return po.status === 'draft'; }).length;
  sum.innerHTML = '<span><strong>' + orders.length + '</strong> ' + orderWord(orders.length) + '</span>'
    + (orders.length ? '<span><strong>' + fmtEur(total) + '</strong> spolu</span>' : '')
    + (drafts && !activeStatus ? '<span class="sk-pill is-warn">' + drafts + ' na prijatie</span>' : '');
}

function renderTable() {
  var panel = $('#ordersPanel');
  if (!panel) return;

  renderSum();

  if (!orders || orders.length === 0) {
    if (activeStatus) {
      mountEmptyState(panel, {
        icon: '🔍',
        title: 'Žiadne výsledky',
        text: 'V stave „' + statusLabel(activeStatus).toLowerCase() + '" nie je žiadna objednávka.',
        ctaLabel: 'Zobraziť všetky',
        onCta: function () { setActiveTab(''); },
      });
    } else {
      mountEmptyState(panel, {
        icon: '📦',
        title: 'Žiadne objednávky',
        text: 'Objednávka skladu eviduje nákup tovaru a surovín od dodávateľa. Po prijatí sa stav skladu doplní sám.',
        ctaLabel: 'Nová objednávka',
        onCta: function () { openNewOrderModal(); },
      });
    }
    return;
  }

  panel.innerHTML = '<div class="sk-list" id="ordersTable">' + orders.map(rowHtml).join('') + '</div>';
}

// ===== RECEIVE =====
function receiveOrder(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;
  showConfirm(
    'Prijať objednávku',
    'Naozaj chcete prijať objednávku #' + po.id + '? Suroviny sa pripočítajú do skladu.',
    async function () {
      try {
        await api.post('/inventory/purchase-orders/' + id + '/receive');
        showToast('Objednávka #' + id + ' prijatá', true);
        await loadOrders();
      } catch (err) {
        showToast(err.message || 'Chyba pri prijímaní objednávky', 'error');
      }
    },
    { type: 'info', confirmText: 'Prijať' }
  );
}

// ===== CANCEL =====
function cancelOrder(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;
  showConfirm(
    'Zrušiť objednávku',
    'Naozaj chcete zrušiť objednávku #' + po.id + '?',
    async function () {
      try {
        await api.post('/inventory/purchase-orders/' + id + '/cancel');
        showToast('Objednávka #' + id + ' zrušená', true);
        await loadOrders();
      } catch (err) {
        showToast(err.message || 'Chyba pri rušení objednávky', 'error');
      }
    },
    { type: 'danger', confirmText: 'Zrušiť objednávku' }
  );
}

async function deleteOrder(id) {
  const idx = orders.findIndex(function (o) { return o.id === id; });
  if (idx < 0) return;
  const snapshot = orders[idx];

  // Pri PRIJATEJ faktúre sa mazaním odpočítava celá dodávka zo skladu.
  // Predtým to bolo bez akéhokoľvek potvrdenia hneď vedľa tlačidla „Detail",
  // takže jeden omylný tap prepísal stav skladu bez varovania.
  if (snapshot.status === 'received') {
    const ok = await new Promise(function (resolve) {
      let settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      showConfirm(
        'Vymazať prijatú faktúru?',
        'Faktúra #' + id + ' je už prijatá — jej položky sú na sklade. '
          + 'Vymazaním sa zo skladu ODPOČÍTAJÚ a faktúra zmizne aj z histórie. '
          + 'Ak ju chceš len stiahnuť z platnosti, použi „Zrušiť" — tá sklad opraví a faktúru zachová.',
        function () { done(true); },
        {
          type: 'danger',
          confirmText: 'Vymazať a odpísať zo skladu',
          cancelText: 'Späť',
          onDismiss: function () { done(false); },
        }
      );
    });
    if (!ok) return;
  }

  // Optimistic remove
  orders.splice(idx, 1);
  renderTable();

  const result = await softDelete({
    label: 'Objednávka #' + id + ' vymazaná',
    deleteFn: function () { return api.del('/inventory/purchase-orders/' + id); },
  });
  if (result.undone) {
    orders.splice(idx, 0, snapshot);
    renderTable();
    showToast('Vrátené', true);
  } else if (result.error) {
    orders.splice(idx, 0, snapshot);
    renderTable();
  } else {
    // Committed — reload to refresh totals/status counts
    await loadOrders();
  }
}

async function showInvoiceImage(id) {
  try {
    var data = await api.get('/inventory/purchase-orders/' + id + '/image');
    if (!data.imageData) { showToast('Faktúra nemá obrázok'); return; }

    var ov = document.createElement('div');
    ov.className = 'u-overlay';
    ov.id = 'invoiceImageModal';
    ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:90vw">'
      + '<div class="u-modal-title">Faktúra #' + id + '</div>'
      + '<button type="button" class="sk-modal-close" id="closeImgModal" aria-label="Zavrieť">\u2715</button>'
      + '<div class="u-modal-body">'
      + '<img src="' + data.imageData + '" class="sk-img" alt="Faktúra #' + id + '">'
      + '</div>'
      + '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });

    var close = function () { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); };
    ov.querySelector('#closeImgModal').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  } catch (err) {
    showToast('Chyba načítania obrázka: ' + err.message, 'error');
  }
}

// ===== DETAIL MODAL =====
function openDetailModal(id) {
  var po = orders.find(function (o) { return o.id === id; });
  if (!po) return;

  var existing = document.getElementById('poDetailModal');
  if (existing) existing.remove();

  var supplierName = po.supplier ? escapeHtml(po.supplier.name) : '—';

  // Položky ako riadky (názov + prepočet vľavo, suma + „množstvo × cena" vpravo)
  // — tabuľka s 5 stĺpcami v paneli zdola rolovala vbok.
  var itemsHtml = '';
  if (po.items && po.items.length > 0) {
    itemsHtml = '<div class="sk-items">' + po.items.map(function (item) {
      var conv = parseFloat(item.conversionFactor) || 1;
      var stockAdded = Math.round(Number(item.quantity) * conv * 1000) / 1000;
      var qtyStr = Number(item.quantity).toLocaleString('sk-SK', { maximumFractionDigits: 2 })
        + '\u00A0' + escapeHtml((conv !== 1 && item.invoiceUnit) ? item.invoiceUnit : (item.ingredientUnit || ''));
      var convInfo = conv !== 1
        ? '<span class="sk-item-sub is-accent">' + qtyStr + ' × ' + conv + ' = ' + stockAdded.toLocaleString('sk-SK') + '\u00A0' + escapeHtml(item.ingredientUnit || '') + ' na sklad</span>'
        : '';
      return '<div class="sk-item">'
        + '<div class="sk-item-main"><span class="sk-item-name">' + escapeHtml(item.ingredientName || '—') + '</span>' + convInfo + '</div>'
        + '<div class="sk-item-side"><span class="sk-item-num">' + fmtEur(item.totalCost || 0) + '</span>'
        + '<span class="sk-item-meta">' + qtyStr + ' × ' + fmtEur(item.unitCost || 0) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
  } else {
    itemsHtml = '<div class="empty-hint">Objednávka nemá žiadne položky.</div>';
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poDetailModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:640px">'
    + '<div class="u-modal-title">Objednávka #' + po.id + '</div>'
    + '<div class="u-modal-body">'
    + '<div class="sk-kv">'
    + '<div><span class="sk-kv-k">Dodávateľ</span><span class="sk-kv-v">' + supplierName + '</span></div>'
    + '<div><span class="sk-kv-k">Dátum</span><span class="sk-kv-v num">' + fmtDate(po.createdAt) + '</span></div>'
    + '<div><span class="sk-kv-k">Stav</span><span class="sk-kv-v">' + statusPill(po.status) + '</span></div>'
    + '</div>'
    + (po.note ? '<div><span class="sk-kv-k">Poznámka</span><div class="sk-note">' + escapeHtml(po.note) + '</div></div>' : '')
    + '<div class="sk-label">Položky</div>'
    + itemsHtml
    + '<div class="sk-total"><span>Celková cena</span><strong>' + fmtEur(po.totalCost || 0) + '</strong></div>'
    + '<div class="sk-label">Zmeniť stav</div>'
    + '<div class="sk-actions">'
    + (po.status !== 'draft' ? '<button class="u-btn u-btn-ghost" id="poSetDraft">Vrátiť do rozpracovania</button>' : '')
    + (po.status !== 'received' ? '<button class="u-btn u-btn-ice" id="poSetReceived">Prijať na sklad</button>' : '')
    + (po.status !== 'cancelled' ? '<button class="u-btn u-btn-rose" id="poSetCancelled">Zrušiť objednávku</button>' : '')
    + '</div>'
    + '<div class="sk-actions">'
    + (po.hasImage ? '<button class="u-btn u-btn-ghost" id="poDetailImage">Zobraziť faktúru</button>' : '')
    + (po.status !== 'cancelled' ? '<button class="u-btn u-btn-ghost" id="poEdit">Upraviť položky</button>' : '')
    + '<button class="u-btn u-btn-rose" id="poDetailDelete">Vymazať</button>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="poDetailClose">Zavrieť</button>'
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
      showToast('Objednávka #' + po.id + ' prijatá — sklad doplnený', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setReceivedBtn); }
  });

  if (setCancelledBtn) setCancelledBtn.addEventListener('click', async function () {
    btnLoading(setCancelledBtn);
    try {
      await api.post('/inventory/purchase-orders/' + po.id + '/cancel');
      closeModal();
      showToast('Objednávka #' + po.id + ' zrušená', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setCancelledBtn); }
  });

  if (setDraftBtn) setDraftBtn.addEventListener('click', async function () {
    btnLoading(setDraftBtn);
    try {
      await api.post('/inventory/purchase-orders/' + po.id + '/reopen');
      closeModal();
      showToast('Objednávka #' + po.id + ' vrátená do rozpracovania', true);
      await loadOrders();
    } catch (err) { showToast(err.message || 'Chyba', 'error'); btnReset(setDraftBtn); }
  });

  var editBtn = ov.querySelector('#poEdit');
  if (editBtn) editBtn.addEventListener('click', function () {
    closeModal();
    openEditOrderModal(po);
  });

  // Faktúra a vymazanie boli ikony na každom riadku zoznamu — patria sem.
  var imageBtn = ov.querySelector('#poDetailImage');
  if (imageBtn) imageBtn.addEventListener('click', function () { showInvoiceImage(po.id); });

  var deleteBtn = ov.querySelector('#poDetailDelete');
  if (deleteBtn) deleteBtn.addEventListener('click', function () {
    closeModal();
    deleteOrder(po.id);
  });
}

// ===== EDIT EXISTING PURCHASE ORDER (works for draft + received) =====
function openEditOrderModal(po) {
  var existing = document.getElementById('poEditModal');
  if (existing) existing.remove();

  var ingOpts = ingredients
    .filter(function (i) { return (i.type || 'ingredient') === 'ingredient'; })
    .map(function (ing) {
      return '<option value="' + ing.id + '">' + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
    }).join('');

  // Riadok položky: výber suroviny, množstvo, jednotka faktúry, prepočet,
  // cena, suma, odstrániť. Na telefóne sa skladá do troch riadkov (CSS).
  function rowHtml(item, idx) {
    var selectOpts = '<option value="">— vyberte —</option>' + ingOpts;
    var h = '<div data-edit-row="' + idx + '" class="sk-frow sk-frow--edit">';
    h += '<select class="form-select edit-ing sk-f-sel" data-idx="' + idx + '" aria-label="Surovina">' + selectOpts + '</select>';
    h += '<input type="number" class="form-input edit-qty sk-f-qty" step="0.01" min="0" value="' + (item ? item.quantity : '') + '" placeholder="Množ." aria-label="Množstvo">';
    h += '<input type="text" class="form-input edit-unit sk-f-unit" value="' + escapeHtml(item ? (item.invoiceUnit || item.ingredientUnit || '') : '') + '" placeholder="ks" aria-label="Jednotka na faktúre">';
    h += '<input type="number" class="form-input edit-conv sk-f-conv" step="0.01" min="0.01" value="' + (item ? (item.conversionFactor || 1) : 1) + '" title="Prepočet na jednotku skladu (napr. sud 50 l → 50)" aria-label="Prepočet">';
    h += '<input type="number" class="form-input edit-cost sk-f-cost" step="0.01" min="0" value="' + (item ? item.unitCost : '') + '" placeholder="Cena" aria-label="Cena za jednotku">';
    h += '<span class="edit-total sk-frow-tot sk-f-tot">' + (item ? fmtEur(item.totalCost || 0) : fmtEur(0)) + '</span>';
    h += '<button type="button" class="act-btn del edit-remove sk-f-rm" data-idx="' + idx + '" title="Odstrániť" aria-label="Odstrániť položku"><svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    h += '</div>';
    return h;
  }

  var rowsHtml = (po.items || []).map(function (it, i) { return rowHtml(it, i); }).join('');

  var warning = po.status === 'received'
    ? '<div class="sk-warn">Faktúra je už prijatá. Po uložení sa staré množstvá odpočítajú zo skladu a nové pripočítajú — história skladu zaznamená opravu.</div>'
    : '';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poEditModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:880px">'
    + '<div class="u-modal-title">Upraviť objednávku #' + po.id + '</div>'
    + '<div class="u-modal-body">'
    + warning
    + '<div class="u-modal-field">'
    + '<label for="fEditNote">Poznámka</label>'
    + '<textarea id="fEditNote" class="form-input" rows="2">' + escapeHtml(po.note || '') + '</textarea>'
    + '</div>'
    + '<div class="sk-label">Položky</div>'
    + '<div id="editItemsWrap" class="sk-frows">' + rowsHtml + '</div>'
    + '<button type="button" class="btn-secondary sk-frow-add" id="btnEditAddRow"><svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pridať položku</button>'
    + '<div class="sk-total"><span>Celkom</span><strong id="editGrandTotal">' + fmtEur(po.totalCost || 0) + '</strong></div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="poEditCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="poEditSave">Uložiť zmeny</button>'
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
        showToast('Pridajte aspoň jednu položku', 'error');
        btnReset(btn);
        return;
      }
      await api.put('/inventory/purchase-orders/' + po.id, {
        note: ov.querySelector('#fEditNote').value,
        items: items,
      });
      close();
      showToast('Objednávka upravená', true);
      await loadOrders();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladaní', 'error');
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

  var supplierOpts = '<option value="">— vyberte dodávateľa —</option>';
  suppliers.forEach(function (s) {
    supplierOpts += '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>';
  });

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'poNewModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:720px">'
    + '<div class="u-modal-title">Nová objednávka</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="fPoSupplier">Dodávateľ<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="fPoSupplier" data-validate="required">' + supplierOpts + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fPoNote">Poznámka</label>'
    + '<textarea id="fPoNote" class="form-input" rows="2" placeholder="Dodacie podmienky, poznámky…"></textarea>'
    + '</div>'
    + '<div class="sk-label">Položky<span class="required-mark" aria-hidden="true"> *</span></div>'
    + '<div class="sk-help">'
    + 'Množstvo a cena sú vždy v jednotke suroviny (ks / l / kg — vidíte ju pri názve vo výbere). '
    + 'Príklad: 6× fľaša 1,5 l Kinley za 11,24 € → ak je surovina v <code>ks</code>, zadajte <code>6</code> a <code>1,87</code>; ak v <code>l</code>, zadajte <code>9</code> a <code>1,25</code>. '
    + 'Cenu zadávajte bez DPH a bez vratného obalu.'
    + '</div>'
    + '<div id="poItemsWrap" class="sk-frows"></div>'
    + '<button class="btn-secondary sk-frow-add" id="poAddItemBtn" type="button"><svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pridať položku</button>'
    + '<div id="poGrandTotal" class="sk-total"><span>Celková cena</span><strong>' + fmtEur(0) + '</strong></div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="poNewCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="poNewSave">Vytvoriť objednávku</button>'
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
      showToast('Vyberte dodávateľa');
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
      showToast('Pridajte aspoň jednu položku s platným množstvom');
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
      showToast('Objednávka vytvorená', true);
      closeModal();
      await loadOrders();
    } catch (err) {
      showToast(err.message || 'Chyba pri vytváraní objednávky', 'error');
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

  var ingredientOpts = '<option value="">— surovina —</option>';
  ingredients.forEach(function (ing) {
    ingredientOpts += '<option value="' + ing.id + '">' + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
  });

  var row = document.createElement('div');
  row.className = 'po-item-row sk-porow';
  row.id = rowId;
  // Hlavný riadok (surovina / množstvo / cena / suma / odstrániť) a pod ním
  // poznámka „posledná cena". Rozloženie rieši CSS (.sk-frow), JS len prepína
  // viditeľnosť poznámky.
  row.innerHTML = ''
    + '<div class="po-item-main sk-frow">'
    + '<select class="po-ingredient-select form-select sk-f-sel" aria-label="Surovina">'
    + ingredientOpts
    + '</select>'
    + '<input class="po-qty-input form-input sk-f-qty" type="number" step="0.01" min="0" placeholder="Množstvo" title="Počet jednotiek suroviny (ks / l / kg)" aria-label="Množstvo">'
    + '<input class="po-cost-input form-input sk-f-cost" type="number" step="0.0001" min="0" placeholder="Cena za jednotku" title="Cena za 1 jednotku suroviny bez DPH a bez vratného obalu" aria-label="Cena za jednotku">'
    + '<span class="po-unit-hint sk-frow-hint sk-f-hint" aria-hidden="true"></span>'
    + '<span class="po-line-total sk-frow-tot sk-f-tot">' + fmtEur(0) + '</span>'
    + '<button class="act-btn del po-remove-btn sk-f-rm" type="button" title="Odstrániť" aria-label="Odstrániť položku"><svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
    + '</div>'
    + '<div class="po-last-price-hint" style="display:none"></div>';

  wrap.appendChild(row);

  // Wire up line total calculation
  var ingSelect = row.querySelector('.po-ingredient-select');
  var qtyInput = row.querySelector('.po-qty-input');
  var costInput = row.querySelector('.po-cost-input');
  var lineTotal = row.querySelector('.po-line-total');
  var unitHint = row.querySelector('.po-unit-hint');
  var lastPriceHint = row.querySelector('.po-last-price-hint');

  function applyUnitLabels() {
    var id = Number(ingSelect.value);
    var ing = id ? ingredients.find(function (x) { return x.id === id; }) : null;
    var unit = ing && ing.unit ? ing.unit : '';
    if (unit) {
      qtyInput.placeholder = 'Množstvo (' + unit + ')';
      costInput.placeholder = 'Cena (\u20AC/' + unit + ')';
      unitHint.textContent = '\u20AC/' + unit;
      unitHint.title = 'Cena je za 1 ' + unit;
    } else {
      qtyInput.placeholder = 'Množstvo';
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

  // Last purchase price lookup \u2014 po v\u00FDbere surovinky fetchne najnov\u0161\u00ED PO
  // item pre dan\u00FA surovinu a zobraz\u00ED "Posledn\u00E1: X \u20AC/unit od Y (DD.MM)"
  // + tla\u010Didlo "Pou\u017Ei\u0165". Click \u2192 vypln\u00ED cost input.
  async function fetchAndShowLastPrice() {
    var id = Number(ingSelect.value);
    lastPriceHint.style.display = 'none';
    lastPriceHint.innerHTML = '';
    if (!id) return;
    try {
      var res = await api.get('/inventory/ingredients/' + id + '/last-purchase');
      if (!res || !res.found) return;
      var ing = ingredients.find(function (x) { return x.id === id; });
      var unit = ing && ing.unit ? ing.unit : '';
      var dateStr = '';
      if (res.purchasedAt) {
        var d = new Date(res.purchasedAt);
        dateStr = ' (' + d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ')';
      }
      var supplierStr = res.supplierName ? ' od ' + escapeHtml(res.supplierName) : '';
      var priceStr = Number(res.unitCost).toFixed(4).replace(/\.?0+$/, '').replace('.', ',');
      lastPriceHint.style.display = 'flex';
      lastPriceHint.innerHTML = ''
        + '<span>Posledná cena</span>'
        + '<strong>' + priceStr + ' \u20AC/' + escapeHtml(unit) + '</strong>'
        + '<span>' + supplierStr + dateStr + '</span>'
        + '<button type="button" class="po-use-last-price" data-price="' + Number(res.unitCost) + '">Použiť poslednú cenu</button>';
      var btn = lastPriceHint.querySelector('.po-use-last-price');
      btn.addEventListener('click', function () {
        costInput.value = Number(res.unitCost);
        updateLineTotal();
        btn.textContent = 'Použité';
        btn.disabled = true;
      });
    } catch (_) { /* missing endpoint \u2192 silently skip */ }
  }

  ingSelect.addEventListener('change', function () {
    applyUnitLabels();
    fetchAndShowLastPrice();
  });
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

  totalEl.innerHTML = '<span>Celková cena</span><strong>' + fmtEur(total) + '</strong>';
}

// ===== TAB SWITCHING =====
function setActiveTab(status) {
  activeStatus = status;
  $$('.po-tab-btn').forEach(function (btn) {
    var on = btn.dataset.status === status;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    + '<div class="sk-spin" aria-hidden="true"></div>'
    + '<div class="u-modal-title" id="scanStatus">' + (isPdf ? 'Konvertujem PDF…' : 'Skenujem faktúru…') + '</div>'
    + '<div class="u-modal-text">Dokument sa analyzuje a položky sa vyčítajú automaticky. Trvá to 5–20 sekúnd.</div>'
    + '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  try {
    var images;
    if (isPdf) {
      images = await pdfToImages(file);
      var statusEl = ov.querySelector('#scanStatus');
      if (statusEl) statusEl.textContent = 'Skenujem ' + images.length + ' strán…';
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
      if (statusEl && images.length > 1) statusEl.textContent = 'Skenujem stranu ' + (i + 1) + ' z ' + images.length + '…';

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
    showToast('Chyba skenovania: ' + (err.message || 'Neznáma chyba'), 'error');
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
    showToast('Na faktúre sa nenašli žiadne položky', 'error');
    return;
  }

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'scanReviewModal';

  var html = '<div class="u-modal sk-modal" style="max-width:860px">';
  html += '<div class="u-modal-title">Naskenovaná faktúra</div>';
  html += '<div class="u-modal-body">';

  // Invoice info bar
  if (scanResult.supplier || scanResult.invoiceNumber || scanResult.date) {
    html += '<div class="sk-scan-info">';
    if (scanResult.supplier) html += '<div><span class="sk-kv-k">Dodávateľ</span><span class="sk-kv-v">' + escapeHtml(scanResult.supplier) + '</span></div>';
    if (scanResult.invoiceNumber) html += '<div><span class="sk-kv-k">Číslo faktúry</span><span class="sk-kv-v num">' + escapeHtml(scanResult.invoiceNumber) + '</span></div>';
    if (scanResult.date) html += '<div><span class="sk-kv-k">Dátum</span><span class="sk-kv-v num">' + escapeHtml(scanResult.date) + '</span></div>';
    html += '</div>';
  }

  // Items as cards
  html += '<div class="sk-label">Položky z faktúry (' + items.length + ')</div>';
  html += '<div id="scanItemsWrap" class="sk-frows">';

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
  html += '<div id="scanGrandTotal" class="sk-total"><span>Celkom</span><strong id="scanGrandTotalValue">' + fmtCost(grandTotal) + ' \u20AC</strong></div>';
  html += '<div class="sk-total-hint">Suma sa prepočíta po úprave množstiev. Skontrolujte, či zodpovedá sume na faktúre (bez DPH).</div>';
  html += '</div>';

  html += '<div class="u-modal-btns">';
  html += '<button class="u-btn u-btn-ghost" id="scanCancel">Zrušiť</button>';
  html += '<button class="u-btn u-btn-ice" id="scanConfirm">Vytvoriť objednávku</button>';
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
        if (totalEl) totalEl.textContent = fmtCost(qty * cost) + ' \u20AC';
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
    if (el) el.textContent = fmtCost(sum) + ' \u20AC';
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
      resultEl.style.color = 'var(--color-success-strong)';
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
        showToast('Priraďte suroviny k položkám alebo vytvorte nové', 'error');
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
        showToast('Najprv pridajte dodávateľa v sekcii Dodávatelia', 'error');
        btnReset(btn);
        return;
      }

      var poBody = { supplierId: supplierId, note: scanData.note || '', items: poItems };
      if (scanData.imageData) poBody.imageData = scanData.imageData;
      await api.post('/inventory/purchase-orders', poBody);

      ov.classList.remove('show');
      setTimeout(function () { ov.remove(); }, 300);
      showToast('Objednávka vytvorená zo skenu', true);
      loadOrders();
    } catch (err) {
      showToast('Chyba: ' + (err.message || 'Neznáma chyba'), 'error');
      btnReset(btn);
    }
  });
}

function buildScanItemCard(item, idx) {
  var matched = item.matchedIngredientId || '';
  var isUnmatched = !matched;

  var isSupply = item.category === 'supply';
  var ingOpts = '<option value="">— priradiť ' + (isSupply ? 'tovar' : 'surovinu') + ' —</option>';
  ingOpts += '<option value="__new__">+ Vytvoriť ' + (isSupply ? 'nový tovar' : 'novú surovinu') + '</option>';
  ingredients.forEach(function (ing) {
    // Show matching type first, then all
    var ingType = ing.type || 'ingredient';
    var matchesType = (isSupply && ingType === 'supply') || (!isSupply && ingType === 'ingredient');
    var prefix = matchesType ? '' : (ingType === 'supply' ? '[T] ' : '[S] ');
    ingOpts += '<option value="' + ing.id + '"' + (String(ing.id) === String(matched) ? ' selected' : '') + '>' + prefix + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit) + ')</option>';
  });

  var h = '';
  h += '<div data-scan-row="' + idx + '" class="sk-scan' + (isUnmatched ? ' is-unmatched' : '') + '">';

  // Riadok 1: názov z faktúry + pilulky (výnimky) + odstrániť
  h += '<div class="sk-scan-head">';
  h += '<div class="sk-scan-name">' + escapeHtml(item.invoiceName || item.name || '') + '</div>';
  h += (item.category === 'supply')
    ? '<span class="sk-pill is-navy">Tovar</span>'
    : '<span class="sk-pill is-ok">Surovina</span>';
  if (isUnmatched) h += '<span class="sk-pill is-danger">Nepriradená</span>';

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
      ? 'suma napovedá ' + Math.round(expectedFromTotal) + ' ks'
      : 'v názve je väčšie číslo (' + biggestInName + ')';
    h += '<span class="sk-pill is-warn" title="Skontrolujte množstvo — OCR často zamení stĺpec množstvo s číslom v názve">? ' + escapeHtml(hint) + '</span>';
  }

  h += '<button type="button" class="scan-remove" data-idx="' + idx + '" title="Odstrániť" aria-label="Odstrániť položku">\u2715</button>';
  h += '</div>';

  // Riadok 2: surovina + množstvo, jednotka, cena, suma
  h += '<div class="sk-scan-fields">';
  h += '<select class="form-select scan-ing" data-idx="' + idx + '" aria-label="Priradená surovina">' + ingOpts + '</select>';
  h += '<input type="number" class="form-input scan-qty" data-idx="' + idx + '" value="' + (item.quantity || 0) + '" step="0.01" min="0" placeholder="Množ." aria-label="Množstvo">';
  h += '<select class="form-select scan-unit" data-idx="' + idx + '" aria-label="Jednotka">';
  ['ks','kg','g','l','ml'].forEach(function (u) {
    h += '<option value="' + u + '"' + (item.unit === u ? ' selected' : '') + '>' + u + '</option>';
  });
  h += '</select>';
  h += '<input type="number" class="form-input scan-cost" data-idx="' + idx + '" value="' + (item.unitCost || 0) + '" step="0.01" min="0" placeholder="Cena" aria-label="Cena za jednotku">';
  h += '<span class="scan-total-display">' + fmtCost(item.totalCost) + ' \u20AC</span>';
  h += '</div>';

  // Riadok 3: prepočet (napr. 1 ks = 500 g)
  h += '<div class="sk-scan-conv">';
  var aiConv = parseFloat(item.conversionFactor) || 1;
  h += '<span>Prepočet: 1 ' + escapeHtml(item.unit || 'ks') + ' =</span>';
  h += '<input type="number" class="form-input scan-conv" data-idx="' + idx + '" value="' + aiConv + '" step="0.01" min="0.01" aria-label="Prepočet na jednotku skladu">';
  h += '<span class="scan-conv-unit">—</span>';
  h += '<span class="scan-conv-result"></span>';
  h += '</div>';

  // Riadok 4: nová surovina / tovar (skrytý, kým si to človek nevyberie;
  // JS prepína display, preto ostáva inline)
  var newIngUnit = isSupply ? 'ks' : (item.targetUnit || item.unit || 'ks');
  h += '<div class="scan-new-ing" style="display:none">';
  h += '<input class="form-input scan-new-name" placeholder="Názov ' + (isSupply ? 'nového tovaru' : 'novej suroviny') + '" value="' + escapeHtml(item.suggestedName || '') + '" aria-label="Názov">';
  h += '<select class="form-select scan-new-unit" aria-label="Jednotka">';
  ['ks','kg','g','l','ml'].forEach(function (u) {
    h += '<option value="' + u + '"' + (newIngUnit === u ? ' selected' : '') + '>' + u + '</option>';
  });
  h += '</select>';
  h += '<span class="sk-pill is-ok">' + (isSupply ? 'Nový tovar' : 'Nová surovina') + '</span>';
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
    + '<div class="sk-head">'
    + '<div class="sk-sum" id="poSum" aria-live="polite"></div>'
    + '<div class="sk-head-actions">'
    + '<button class="btn-secondary" id="scanInvoiceBtn" type="button">'
    + '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
    + 'Skenovať faktúru'
    + '</button>'
    + '<button class="btn-add" id="addOrderBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Nová objednávka'
    + '</button>'
    + '</div>'
    + '<input type="file" id="invoiceFileInput" accept="image/*,application/pdf" capture="environment" hidden>'
    + '</div>'
    // Stav ako segmentový prepínač — vidno všetky štyri možnosti naraz.
    + '<div class="panel-tabs sk-seg" id="poTabs" role="group" aria-label="Stav objednávky">'
    + '<button type="button" class="panel-tab po-tab-btn active" data-status="" aria-pressed="true">Všetky</button>'
    + '<button type="button" class="panel-tab po-tab-btn" data-status="draft" aria-pressed="false">Rozpracované</button>'
    + '<button type="button" class="panel-tab po-tab-btn" data-status="received" aria-pressed="false">Prijaté</button>'
    + '<button type="button" class="panel-tab po-tab-btn" data-status="cancelled" aria-pressed="false">Zrušené</button>'
    + '</div>'
    + '<div class="panel sk-bare" id="ordersPanel">'
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

  // List event delegation
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

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-po') {
      setTimeout(function () { openNewOrderModal(); }, 120);
    }
  }
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
