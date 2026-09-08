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

// Typ pohybu: predaj je pravidlo (bez farby), príjem zelený, odpad červený,
// inventúra a ručná úprava sú „niekto zasiahol" — jantár / terakota.
var TYPES = {
  purchase:   { cls: 'is-ok',     label: 'Príjem' },
  sale:       { cls: 'is-dim',    label: 'Predaj' },
  adjustment: { cls: 'is-accent', label: 'Úprava' },
  waste:      { cls: 'is-danger', label: 'Odpad' },
  inventory:  { cls: 'is-warn',   label: 'Inventúra' }
};
function typePill(type) {
  var entry = TYPES[type] || { cls: 'is-dim', label: type || '—' };
  return '<span class="sk-pill ' + entry.cls + '">' + escapeHtml(entry.label) + '</span>';
}
function recordWord(n) {
  if (n === 1) return 'pohyb';
  if (n >= 2 && n <= 4) return 'pohyby';
  return 'pohybov';
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
  var html = '<option value="">Všetky suroviny</option>';
  ingredients.forEach(function (ing) {
    html += '<option value="' + ing.id + '"' + (String(ing.id) === val ? ' selected' : '') + '>'
      + escapeHtml(ing.name) + '</option>';
  });
  select.innerHTML = html;
}

// === Load movements ===
async function loadMovements() {
  var tableWrap = $('#movementsTable');
  if (tableWrap) showLoading(tableWrap, 'Načítavam pohyby…');
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
    renderError(tableWrap, err.message || 'Chyba pri načítaní pohybov', loadMovements);
  }
}

// === Render table ===
function renderTable() {
  var tableWrap = $('#movementsTable');
  if (!tableWrap) return;

  var countEl = $('#smCount');
  if (countEl) countEl.textContent = totalCount + ' ' + recordWord(totalCount);

  if (!movements.length) {
    tableWrap.innerHTML = '<div class="empty-hint">Pre zvolené filtre sa nenašli žiadne pohyby skladu. Skúste iný typ alebo širšie obdobie.</div>';
    return;
  }

  // Triedy sm-c-* sú kotvy pre mobilnú mriežku: názov / rozdiel hore,
  // typ · dátum / pred → po pod tým, poznámka na celú šírku.
  var html = '<div class="sk-table-wrap"><table class="sk-table sm-table"><thead><tr>'
    + '<th class="sm-c-date">Dátum</th>'
    + '<th class="sm-c-type">Typ</th>'
    + '<th class="sm-c-name">Surovina / položka</th>'
    + '<th class="num sm-c-qty">Rozdiel</th>'
    + '<th class="num sm-c-prev">Pred</th>'
    + '<th class="num sm-c-new">Po</th>'
    + '<th class="sm-c-note">Poznámka</th>'
    + '</tr></thead><tbody>';

  movements.forEach(function (m) {
    var diff = Number(m.newQty) - Number(m.previousQty);
    var qtyClass = diff > 0 ? 'is-up' : (diff < 0 ? 'is-down' : '');
    var itemName = m.ingredientName || m.menuItemName || ('ID: ' + (m.ingredientId || m.menuItemId || '—'));

    html += '<tr>';
    html += '<td class="sm-c-date">' + fmtDate(m.createdAt) + '</td>';
    html += '<td class="sm-c-type">' + typePill(m.type) + '</td>';
    html += '<td class="td-name sm-c-name">' + escapeHtml(itemName) + '</td>';
    html += '<td class="num sm-c-qty ' + qtyClass + '">' + fmtQty(diff) + '</td>';
    html += '<td class="num sm-c-prev">' + fmtNum(m.previousQty) + '</td>';
    html += '<td class="num sm-c-new"><span class="sk-prev-inline">' + fmtNum(m.previousQty) + ' → </span>' + fmtNum(m.newQty) + '</td>';
    html += '<td class="td-note sm-c-note">' + escapeHtml(m.note || '') + '</td>';
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
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = ''
    + '<button type="button" class="btn-secondary" id="prevPageBtn"'
    + (currentPage <= 1 ? ' disabled' : '')
    + '>Predchádzajúca</button>'
    + '<span class="sk-pager-n">' + currentPage + ' z ' + totalPages + '</span>'
    + '<button type="button" class="btn-secondary" id="nextPageBtn"'
    + (currentPage >= totalPages ? ' disabled' : '')
    + '>Ďalšia</button>';

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

  var ingOptions = '<option value="">— vyberte surovinu —</option>';
  ingredients.forEach(function (ing) {
    ingOptions += '<option value="' + ing.id + '">' + escapeHtml(ing.name) + ' (' + escapeHtml(ing.unit || '') + ')</option>';
  });

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'adjustModal';
  ov.innerHTML = '<div class="u-modal sk-modal" style="max-width:480px">'
    + '<div class="u-modal-title">Ručná úprava skladu</div>'
    + '<div class="u-modal-body">'
    + '<div class="u-modal-field">'
    + '<label for="adjIngredient">Surovina<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="adjIngredient" aria-required="true" data-validate="required">' + ingOptions + '</select>'
    + '</div>'
    + '<div class="u-modal-row">'
    + '<div class="u-modal-field">'
    + '<label for="adjQty">Množstvo<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="adjQty" type="number" step="0.01" placeholder="napr. 5 alebo −3" aria-required="true" data-validate="required">'
    + '<small>Kladné číslo pridá, záporné odoberie.</small>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="adjType">Typ</label>'
    + '<select id="adjType">'
    + '<option value="adjustment">Úprava</option>'
    + '<option value="waste">Odpad</option>'
    + '</select>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="adjNote">Poznámka</label>'
    + '<textarea id="adjNote" rows="2" placeholder="Dôvod úpravy…"></textarea>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="adjustModalCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="adjustModalSave">Uložiť úpravu</button>'
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
      showToast('Zadajte nenulové množstvo');
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
      showToast('Úprava uložená', true);
      closeModal();
      currentOffset = 0;
      await loadMovements();
    } catch (err) {
      showToast(err.message || 'Chyba pri ukladaní úpravy', 'error');
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

  var typeChips = [['', 'Všetky'], ['purchase', 'Príjem'], ['sale', 'Predaj'], ['adjustment', 'Úprava'], ['waste', 'Odpad'], ['inventory', 'Inventúra']]
    .map(function (t, i) {
      return '<button type="button" class="doch-chip' + (i === 0 ? ' is-on' : '') + '" data-type="' + t[0] + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' + t[1] + '</button>';
    }).join('');

  container.innerHTML = ''
    + '<div class="sk-head">'
    + '<div class="sk-count" id="smCount" aria-live="polite"></div>'
    + '<button class="btn-add" id="adjustBtn">'
    + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    + 'Ručná úprava'
    + '</button>'
    + '</div>'

    // Filtre: typ ako chipy (aplikujú sa hneď), surovina a dátumy pod „Iné…".
    // Predtým 4 polia + tlačidlo „Filtrovať" v paneli — 190 px, kým sa
    // ukázal prvý pohyb.
    + '<div class="sk-filters">'
    + '<div class="sk-filter-row">'
    + '<div class="sk-chips" role="group" aria-label="Typ pohybu">' + typeChips + '</div>'
    + '<button type="button" class="doch-chip is-more" id="smMore" aria-expanded="false" aria-controls="smMoreBox">Iné…</button>'
    + '</div>'
    + '<input type="hidden" id="filterType" value="">'
    + '<div class="sk-more" id="smMoreBox" hidden>'
    + '<label class="doch-toolbar-label">Surovina'
    + '<select id="filterIngredient" class="doch-input"><option value="">Všetky suroviny</option></select>'
    + '</label>'
    + '<div class="sk-dates">'
    + '<label class="doch-toolbar-label">Od<input id="filterFrom" type="date" class="doch-input"></label>'
    + '<label class="doch-toolbar-label">Do<input id="filterTo" type="date" class="doch-input"></label>'
    + '</div>'
    + '</div>'
    + '</div>'

    // Zoznam
    + '<div class="sk-list" id="movementsTable">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'

    // Stránkovanie
    + '<div class="sk-pager" id="paginationWrap"></div>';

  // Bind events
  $('#adjustBtn').addEventListener('click', function () { openAdjustModal(); });

  container.querySelector('.sk-chips').addEventListener('click', function (e) {
    var chip = e.target.closest('[data-type]');
    if (!chip) return;
    container.querySelectorAll('.sk-chips [data-type]').forEach(function (c) {
      var on = c === chip;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('#filterType').value = chip.dataset.type;
    applyFilters();
  });

  $('#smMore').addEventListener('click', function () {
    var box = $('#smMoreBox');
    var open = box.hidden;
    box.hidden = !open;
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.classList.toggle('is-on', open);
  });

  ['#filterIngredient', '#filterFrom', '#filterTo'].forEach(function (sel) {
    $(sel).addEventListener('change', function () { applyFilters(); });
  });

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
