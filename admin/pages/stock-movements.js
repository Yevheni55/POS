// Stock movements page module
let movements = [];
let ingredients = [];
let totalCount = 0;
let currentOffset = 0;
let _container = null;
let _escHandler = null;

var PAGE_SIZE = 50;

var filters = {
  type: '',
  ingredientId: '',
  from: '',
  to: ''
};

function $(sel) {
  return _container.querySelector(sel);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(isoStr) {
  if (!isoStr) return '--';
  var d = new Date(isoStr);
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

function fmtQty(n) {
  if (n == null) return '--';
  var val = Number(n);
  var sign = val > 0 ? '+' : '';
  return sign + val.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getTypeBadge(type) {
  var map = {
    purchase:   { cls: 'badge-success',  label: 'Prijem' },
    sale:       { cls: 'badge-purple',   label: 'Predaj' },
    adjustment: { cls: 'badge-info',     label: 'Uprava' },
    waste:      { cls: 'badge-danger',   label: 'Odpad' },
    inventory:  { cls: 'badge-warning',  label: 'Inventura' }
  };
  var entry = map[type] || { cls: '', label: type || '--' };
  return '<span class="badge ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}

function buildQueryString() {
  var parts = [];
  if (filters.type) parts.push('type=' + encodeURIComponent(filters.type));
  if (filters.ingredientId) parts.push('ingredientId=' + encodeURIComponent(filters.ingredientId));
  if (filters.from) parts.push('from=' + encodeURIComponent(filters.from));
  if (filters.to) parts.push('to=' + encodeURIComponent(filters.to));
  parts.push('limit=' + PAGE_SIZE);
  parts.push('offset=' + currentOffset);
  return parts.join('&');
}

// === Load ingredients for filter dropdown ===
async function loadIngredients() {
  try {
    ingredients = await api.get('/inventory/ingredients?active=true');
    if (!Array.isArray(ingredients)) ingredients = [];
    renderIngredientOptions();
  } catch (err) {
    ingredients = [];
  }
}

function renderIngredientOptions() {
  var select = $('#filterIngredient');
  if (!select) return;
  var val = select.value;
  var html = '<option value="">Vsetky suroviny</option>';
  ingredients.forEach(function (ing) {
    html += '<option value="' + ing.id + '"' + (String(ing.id) === val ? ' selected' : '') + '>'
      + escapeHtml(ing.name) + '</option>';
  });
  select.innerHTML = html;
}

// === Load movements ===
async function loadMovements() {
  var tableWrap = $('#movementsTable');
  if (tableWrap) showLoading(tableWrap, 'Nacitavam pohyby...');
  try {
    var result = await api.get('/inventory/movements?' + buildQueryString());
    if (tableWrap) hideLoading(tableWrap);

    if (result && Array.isArray(result.data)) {
      movements = result.data;
      totalCount = result.total || 0;
    } else if (Array.isArray(result)) {
      movements = result;
      totalCount = result.length;
    } else {
      movements = [];
      totalCount = 0;
    }
    renderTable();
    renderPagination();
  } catch (err) {
    if (tableWrap) hideLoading(tableWrap);
    renderError(tableWrap, err.message || 'Chyba pri nacitani pohybov', loadMovements);
  }
}

// === Render table ===
function renderTable() {
  var tableWrap = $('#movementsTable');
  if (!tableWrap) return;

  if (!movements.length) {
    tableWrap.innerHTML = '<div class="empty-state">'
      + '<div class="empty-state-icon">&#128230;</div>'
      + '<div class="empty-state-title">Ziadne pohyby</div>'
      + '<div class="empty-state-text">Pre zvolene filtre neboli najdene ziadne skladove pohyby.</div>'
      + '</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>'
    + '<th>Dátum</th>'
    + '<th>Typ</th>'
    + '<th>Surovina / Položka</th>'
    + '<th class="text-right">Množstvo</th>'
    + '<th class="text-right">Pred</th>'
    + '<th class="text-right">Po</th>'
    + '<th>Poznámka</th>'
    + '</tr></thead><tbody>';

  movements.forEach(function (m) {
    var diff = Number(m.newQty) - Number(m.previousQty);
    var qtyClass = diff >= 0 ? 'color-success' : 'color-danger';
    var itemName = m.ingredientName || m.menuItemName || ('ID: ' + (m.ingredientId || m.menuItemId || '--'));

    html += '<tr>';
    html += '<td>' + fmtDate(m.createdAt) + '</td>';
    html += '<td>' + getTypeBadge(m.type) + '</td>';
    html += '<td class="td-name">' + escapeHtml(itemName) + '</td>';
    html += '<td class="text-right num ' + qtyClass + '">' + fmtQty(diff) + '</td>';
    html += '<td class="text-right num">' + fmtNum(m.previousQty) + '</td>';
    html += '<td class="text-right num">' + fmtNum(m.newQty) + '</td>';
    html += '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      + escapeHtml(m.note || '') + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  tableWrap.innerHTML = html;
}

// === Pagination ===
function renderPagination() {
  var wrap = $('#paginationWrap');
  if (!wrap) return;

  var totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  var currentPage = Math.floor(currentOffset / PAGE_SIZE) + 1;

  if (totalCount <= PAGE_SIZE) {
    wrap.innerHTML = '<span class="color-sec font-sm">' + totalCount + ' zaznamov</span>';
    return;
  }

  wrap.innerHTML = ''
    + '<button class="btn-outline-accent" id="prevPageBtn"'
    + (currentPage <= 1 ? ' disabled style="opacity:.4;pointer-events:none"' : '')
    + '>Predchadzajuca</button>'
    + '<span class="color-sec font-sm" style="padding:0 12px;line-height:36px">'
    + currentPage + ' z ' + totalPages
    + '</span>'
    + '<button class="btn-outline-accent" id="nextPageBtn"'
    + (currentPage >= totalPages ? ' disabled style="opacity:.4;pointer-events:none"' : '')
    + '>Dalsia strana</button>';

  var prevBtn = $('#prevPageBtn');
  var nextBtn = $('#nextPageBtn');

  if (prevBtn && currentPage > 1) {
    prevBtn.addEventListener('click', function () {
      currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
      loadMovements();
    });
  }
  if (nextBtn && currentPage < totalPages) {
    nextBtn.addEventListener('click', function () {
      currentOffset = currentOffset + PAGE_SIZE;
      loadMovements();
    });
  }
}

// === Adjustment modal ===
function openAdjustModal() {
  var existing = document.getElementById('adjustModal');
  if (existing) existing.remove();

  var ingOptions = '<option value="">-- Vyberte surovinu --</option>';
  ingredients.forEach(function (ing) {
    ingOptions += '<option value="' + ing.id + '">' + escapeHtml(ing.name) + '</option>';
  });

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'adjustModal';
  ov.innerHTML = '<div class="u-modal" style="text-align:left;max-width:480px">'
    + '<div class="u-modal-title" style="text-align:center">Rucna uprava</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="adjIngredient">Surovina<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="adjIngredient" aria-required="true" data-validate="required">' + ingOptions + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="adjQty">Mnozstvo<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="adjQty" type="number" step="0.01" placeholder="napr. 5 alebo -3" aria-required="true" data-validate="required">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="adjType">Typ</label>'
    + '<select id="adjType">'
    + '<option value="adjustment">Uprava</option>'
    + '<option value="waste">Odpad</option>'
    + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="adjNote">Poznamka</label>'
    + '<textarea id="adjNote" rows="2" placeholder="Dovod upravy..."></textarea>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="adjustModalCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="adjustModalSave">Ulozit</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  wireValidation(ov);

  var closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  document.getElementById('adjustModalCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  document.getElementById('adjustModalSave').onclick = async function () {
    if (!validateForm(ov)) return;

    var ingredientId = document.getElementById('adjIngredient').value;
    var quantity = parseFloat(document.getElementById('adjQty').value);
    var type = document.getElementById('adjType').value;
    var note = document.getElementById('adjNote').value.trim();

    if (!ingredientId) {
      showToast('Vyberte surovinu');
      return;
    }
    if (isNaN(quantity) || quantity === 0) {
      showToast('Zadajte nenulove mnozstvo');
      return;
    }

    var saveBtn = document.getElementById('adjustModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      await api.post('/inventory/movements/adjust', {
        ingredientId: Number(ingredientId),
        quantity: quantity,
        type: type,
        note: note || undefined
      });
      showToast('Uprava ulozena', true);
      closeModal();
      currentOffset = 0;
      await loadMovements();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladani upravy', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };
}

// === Apply filters ===
function applyFilters() {
  filters.type = ($('#filterType') || {}).value || '';
  filters.ingredientId = ($('#filterIngredient') || {}).value || '';
  filters.from = ($('#filterFrom') || {}).value || '';
  filters.to = ($('#filterTo') || {}).value || '';
  currentOffset = 0;
  loadMovements();
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  // Reset state
  movements = [];
  ingredients = [];
  totalCount = 0;
  currentOffset = 0;
  filters = { type: '', ingredientId: '', from: '', to: '' };

  container.innerHTML = ''
    + '<div class="top-bar">'
    + '<button class="btn-add" id="adjustBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Rucna uprava'
    + '</button>'
    + '</div>'

    // Filter bar
    + '<div class="panel mb-3" style="padding:14px 16px">'
    + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">'

    + '<div class="u-modal-field" style="flex:0 0 auto;min-width:140px">'
    + '<label for="filterType" style="margin-bottom:4px">Typ</label>'
    + '<select id="filterType" class="form-select" style="padding:8px 30px 8px 10px">'
    + '<option value="">Vsetky</option>'
    + '<option value="purchase">Prijem</option>'
    + '<option value="sale">Predaj</option>'
    + '<option value="adjustment">Uprava</option>'
    + '<option value="waste">Odpad</option>'
    + '<option value="inventory">Inventura</option>'
    + '</select></div>'

    + '<div class="u-modal-field" style="flex:0 0 auto;min-width:160px">'
    + '<label for="filterIngredient" style="margin-bottom:4px">Surovina</label>'
    + '<select id="filterIngredient" class="form-select" style="padding:8px 30px 8px 10px">'
    + '<option value="">Vsetky suroviny</option>'
    + '</select></div>'

    + '<div class="u-modal-field" style="flex:0 0 auto;min-width:140px">'
    + '<label for="filterFrom" style="margin-bottom:4px">Od</label>'
    + '<input id="filterFrom" type="date" class="form-input" style="padding:7px 10px"></div>'

    + '<div class="u-modal-field" style="flex:0 0 auto;min-width:140px">'
    + '<label for="filterTo" style="margin-bottom:4px">Do</label>'
    + '<input id="filterTo" type="date" class="form-input" style="padding:7px 10px"></div>'

    + '<button class="btn-outline-accent" id="applyFilterBtn" style="height:38px">Filtrovat</button>'
    + '</div></div>'

    // Table
    + '<div id="movementsTable">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'

    // Pagination
    + '<div id="paginationWrap" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px"></div>';

  // Bind events
  $('#adjustBtn').addEventListener('click', function () { openAdjustModal(); });
  $('#applyFilterBtn').addEventListener('click', function () { applyFilters(); });

  // Escape key handler
  _escHandler = function (e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('adjustModal');
      if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(function () { modal.remove(); }, 300);
      }
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data
  loadIngredients();
  loadMovements();
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  var modal = document.getElementById('adjustModal');
  if (modal) modal.remove();

  movements = [];
  ingredients = [];
  totalCount = 0;
  currentOffset = 0;
  _container = null;
}
