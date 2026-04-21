// Recipes page module — two-panel recipe editor
let menuItems = [];
let ingredientsList = [];
let selectedItemId = null;
let currentRecipe = [];
let activeFilter = 'all';
let recipeSummary = {}; // menuItemId -> ingredient count
let _container = null;
let _escHandler = null;

function $(sel) { return _container.querySelector(sel); }
function $$(sel) { return _container.querySelectorAll(sel); }

// === Load data ===
async function loadRecipeSummary() {
  try {
    var rows = await api.get('/inventory/recipes/summary');
    recipeSummary = {};
    (rows || []).forEach(function (r) { recipeSummary[r.menuItemId] = r.count; });
  } catch (_) {
    recipeSummary = {};
  }
}

async function loadMenuItems() {
  var listEl = $('#itemList');
  if (listEl) showLoading(listEl, 'Nacitavam polozky...');
  try {
    const [items] = await Promise.all([
      api.get('/inventory/menu-items'),
      loadRecipeSummary(),
    ]);
    menuItems = items;
    if (listEl) hideLoading(listEl);
    renderItemList();
    // If we had a selection, re-select it; otherwise select first matching
    if (selectedItemId) {
      var still = menuItems.find(function(m) { return m.id === selectedItemId; });
      if (!still) selectedItemId = null;
    }
    if (!selectedItemId) {
      var visible = getFilteredItems();
      if (visible.length) selectItem(visible[0].id);
      else renderEditor();
    } else {
      await loadRecipeForItem(selectedItemId);
    }
  } catch (err) {
    if (listEl) hideLoading(listEl);
    renderError(listEl, err.message || 'Chyba pri nacitani poloziek', loadMenuItems);
  }
}

async function loadIngredients() {
  try {
    ingredientsList = await api.get('/inventory/ingredients');
  } catch (_) {
    ingredientsList = [];
  }
}

async function loadRecipeForItem(itemId) {
  var editorEl = $('#editorContent');
  if (!editorEl) return;
  var item = menuItems.find(function(m) { return m.id === itemId; });
  if (!item) return;

  if (item.trackMode === 'recipe') {
    showLoading(editorEl, 'Nacitavam recept...');
    try {
      currentRecipe = await api.get('/inventory/recipes/' + itemId);
    } catch (_) {
      currentRecipe = [];
    }
    hideLoading(editorEl);
  } else {
    currentRecipe = [];
  }
  renderEditor();
}

// === Filtering ===
function getFilteredItems() {
  if (activeFilter === 'all') return menuItems;
  return menuItems.filter(function(m) { return m.trackMode === activeFilter; });
}

// === Render left panel: menu item list ===
function renderItemList() {
  var listEl = $('#itemList');
  if (!listEl) return;

  var filtered = getFilteredItems();

  if (!filtered.length) {
    var msg = activeFilter === 'all'
      ? 'Ziadne polozky v menu'
      : 'Ziadne polozky s modom "' + activeFilter + '"';
    listEl.innerHTML = '<div class="empty-state" style="padding:32px 16px">'
      + '<div class="empty-state-icon">\uD83D\uDCE6</div>'
      + '<div class="empty-state-title">Prazdne</div>'
      + '<div class="empty-state-text">' + msg + '</div></div>';
    return;
  }

  // Group items by category
  var categories = [];
  var catMap = {};
  filtered.forEach(function(item) {
    var catKey = item.categorySlug || item.categoryId || 'other';
    if (!catMap[catKey]) {
      catMap[catKey] = { label: item.categoryLabel || 'Ostatne', items: [] };
      categories.push(catMap[catKey]);
    }
    catMap[catKey].items.push(item);
  });

  var html = '';
  categories.forEach(function(cat) {
    html += '<div style="padding:8px 12px 2px;font-size:10px;font-weight:700;color:var(--color-text-dim);text-transform:uppercase;letter-spacing:1px">'
      + escHtml(cat.label) + '</div>';
    cat.items.forEach(function(item) {
      var count = recipeSummary[item.id] || 0;
      var badgeClass = 'badge-info';
      var badgeLabel = 'none';
      if (item.trackMode === 'recipe') { badgeClass = 'badge-purple'; badgeLabel = 'recept'; }
      else if (item.trackMode === 'simple') { badgeClass = 'badge-success'; badgeLabel = 'simple'; }
      var ingredientsLabel = count > 0
        ? '<span class="text-muted" style="margin-left:6px;font-size:11px">' + count + ' surov.</span>'
        : '';

      html += '<button class="cat-item' + (item.id === selectedItemId ? ' active' : '') + '" data-item-id="' + item.id + '" type="button">'
        + '<span class="cat-icon">' + (item.emoji || '\uD83C\uDF7D') + '</span>'
        + '<div class="cat-info">'
        + '<div class="cat-name">' + escHtml(item.name) + '</div>'
        + '<div class="cat-count"><span class="badge ' + badgeClass + '">' + badgeLabel + '</span>' + ingredientsLabel + '</div>'
        + '</div>'
        + '</button>';
    });
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.cat-item').forEach(function(el) {
    el.addEventListener('click', function() {
      selectItem(Number(el.dataset.itemId));
    });
  });
}

function escHtml(s) {
  var div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function selectItem(id) {
  selectedItemId = id;
  renderItemList();
  await loadRecipeForItem(id);
}

// === Render right panel: editor ===
function renderEditor() {
  var editorEl = $('#editorContent');
  if (!editorEl) return;

  var item = menuItems.find(function(m) { return m.id === selectedItemId; });
  if (!item) {
    editorEl.innerHTML = '<div class="empty-state" style="padding:60px 20px">'
      + '<div class="empty-state-icon">\uD83D\uDC48</div>'
      + '<div class="empty-state-title">Vyberte polozku</div>'
      + '<div class="empty-state-text">Vyberte polozku z laveho panelu pre upravu receptury</div></div>';
    return;
  }

  var html = '';

  // Header: item name + mode selector
  html += '<div class="prod-header" style="border-bottom:1px solid rgba(255,255,255,.05)">';
  html += '<div class="prod-header-title">' + (item.emoji || '') + ' ' + escHtml(item.name) + '</div>';
  html += '</div>';

  // Track mode selector
  html += '<div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.05)">';
  html += '<div class="form-label">Rezim sledovania skladu</div>';
  html += '<div style="display:flex;gap:6px;margin-top:8px">';
  html += modeBtn('none', 'Ziadne', item.trackMode);
  html += modeBtn('simple', 'Jednoduche', item.trackMode);
  html += modeBtn('recipe', 'Recept', item.trackMode);
  html += '</div>';
  html += '</div>';

  // Content based on track mode
  html += '<div style="padding:16px 20px;flex:1;overflow-y:auto">';

  if (item.trackMode === 'none') {
    html += '<div class="empty-state" style="padding:40px 20px">'
      + '<div class="empty-state-icon">\uD83D\uDEAB</div>'
      + '<div class="empty-state-title">Sledovanie skladu vypnute</div>'
      + '<div class="empty-state-text">Zvolte rezim "Jednoduche" alebo "Recept" pre sledovanie tejto polozky</div></div>';
  } else if (item.trackMode === 'simple') {
    html += renderSimpleForm(item);
  } else if (item.trackMode === 'recipe') {
    html += renderRecipeForm(item);
  }

  html += '</div>';

  editorEl.innerHTML = html;
  bindEditorEvents(item);
}

function modeBtn(mode, label, current) {
  var isActive = current === mode;
  var cls = isActive ? 'zone-btn active' : 'zone-btn';
  return '<button class="' + cls + '" data-mode="' + mode + '" type="button">' + label + '</button>';
}

// === Simple mode form ===
function renderSimpleForm(item) {
  var html = '';
  html += '<div class="form-group">';
  html += '<label class="form-label" for="fStockQty">Aktualne mnozstvo na sklade</label>';
  html += '<input class="form-input" id="fStockQty" type="number" step="0.01" min="0" value="' + (item.stockQty || 0) + '">';
  html += '</div>';
  html += '<div class="form-group">';
  html += '<label class="form-label" for="fMinStockQty">Minimalne mnozstvo (upozornenie)</label>';
  html += '<input class="form-input" id="fMinStockQty" type="number" step="0.01" min="0" value="' + (item.minStockQty || 0) + '">';
  html += '</div>';
  html += '<div style="margin-top:16px">';
  html += '<button class="btn-save" id="saveSimpleBtn">Ulozit</button>';
  html += '</div>';
  return html;
}

// === Recipe mode form ===
function renderRecipeForm(item) {
  var html = '';

  // Recipe ingredient cards
  if (currentRecipe.length) {
    html += '<div class="recipe-cards" style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px">';
    currentRecipe.forEach(function(line, idx) {
      var unitColors = { ks:'139,124,246', kg:'92,196,158', g:'92,196,158', l:'125,211,252', ml:'125,211,252' };
      var uc = unitColors[line.ingredientUnit] || '139,124,246';
      html += '<div class="recipe-card" style="'
        + 'display:flex;align-items:center;gap:12px;padding:12px 14px;'
        + 'background:rgba(' + uc + ',.04);border:1px solid rgba(' + uc + ',.12);'
        + 'border-radius:var(--radius-sm);transition:all .15s;position:relative;overflow:hidden'
        + '">';
      // Left accent bar
      html += '<div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:rgba(' + uc + ',.4);border-radius:3px 0 0 3px"></div>';
      // Name
      html += '<div style="flex:1;min-width:0;padding-left:4px">';
      html += '<div style="font-size:var(--text-md);font-weight:var(--weight-bold);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(line.ingredientName || '') + '</div>';
      html += '</div>';
      // Quantity — big and prominent
      html += '<div style="font-family:var(--font-display);font-size:var(--text-2xl);font-weight:var(--weight-bold);color:rgba(' + uc + ',1);letter-spacing:var(--tracking-tight);min-width:60px;text-align:right">'
        + Number(line.qtyPerUnit).toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 3 })
        + '</div>';
      // Unit badge
      html += '<div style="'
        + 'font-size:var(--text-xs);font-weight:var(--weight-bold);text-transform:uppercase;letter-spacing:.5px;'
        + 'padding:4px 8px;border-radius:var(--radius-xs);min-width:32px;text-align:center;'
        + 'background:rgba(' + uc + ',.12);color:rgba(' + uc + ',1)'
        + '">' + escHtml(line.ingredientUnit || '') + '</div>';
      // Remove button
      html += '<button data-remove-idx="' + idx + '" title="Odstranit" style="'
        + 'width:28px;height:28px;border-radius:var(--radius-xs);border:1px solid transparent;'
        + 'background:transparent;color:var(--color-text-dim);font-size:14px;cursor:pointer;'
        + 'display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0'
        + '" onmouseover="this.style.background=\'rgba(224,112,112,.15)\';this.style.color=\'var(--color-danger)\';this.style.borderColor=\'rgba(224,112,112,.2)\'"'
        + ' onmouseout="this.style.background=\'transparent\';this.style.color=\'var(--color-text-dim)\';this.style.borderColor=\'transparent\'"'
        + '>\u2715</button>';
      html += '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="padding:32px 16px;text-align:center;border:1.5px dashed rgba(139,124,246,.12);border-radius:var(--radius-md);margin-bottom:20px">'
      + '<div style="font-size:20px;margin-bottom:6px;opacity:.4">\uD83E\uDDEA</div>'
      + '<div style="font-size:var(--text-md);font-weight:var(--weight-semibold);color:var(--color-text-sec);margin-bottom:2px">Prazdny recept</div>'
      + '<div style="font-size:var(--text-sm);color:var(--color-text-dim)">Pridajte suroviny nizsie</div>'
      + '</div>';
  }

  // Add ingredient row
  html += '<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:24px;flex-wrap:wrap;padding:14px;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">';
  html += '<div class="form-group" style="flex:2;min-width:160px;margin-bottom:0">';
  html += '<label class="form-label" for="fNewIngredient">Pridat surovinu</label>';
  html += '<select class="form-select" id="fNewIngredient">';
  html += '<option value="">-- Vyberte --</option>';

  // Filter out ingredients already in recipe
  var usedIds = currentRecipe.map(function(r) { return r.ingredientId; });
  ingredientsList.forEach(function(ing) {
    if (usedIds.indexOf(ing.id) === -1) {
      html += '<option value="' + ing.id + '">' + escHtml(ing.name) + ' (' + ing.unit + ')</option>';
    }
  });

  html += '</select>';
  html += '</div>';
  html += '<div class="form-group" style="flex:1;min-width:100px;margin-bottom:0">';
  html += '<label class="form-label" for="fNewQty">Mnozstvo na 1ks</label>';
  html += '<input class="form-input" id="fNewQty" type="number" step="0.001" min="0.001" placeholder="0.00">';
  html += '</div>';
  html += '<button class="btn-add" id="addLineBtn" type="button" style="margin-bottom:0">';
  html += '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  html += 'Pridat surovinu';
  html += '</button>';
  html += '</div>';

  // Save button
  html += '<button class="btn-save" id="saveRecipeBtn">Ulozit recept</button>';

  return html;
}

// === Bind editor events ===
function bindEditorEvents(item) {
  // Mode selector buttons
  $$('[data-mode]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var newMode = btn.dataset.mode;
      if (newMode === item.trackMode) return;
      changeTrackMode(item.id, newMode);
    });
  });

  // Simple mode save
  var saveSimple = $('#saveSimpleBtn');
  if (saveSimple) {
    saveSimple.addEventListener('click', function() {
      saveSimpleConfig(item.id);
    });
  }

  // Recipe: remove line
  $$('[data-remove-idx]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = Number(btn.dataset.removeIdx);
      currentRecipe = currentRecipe.filter(function(_, i) { return i !== idx; });
      renderEditor();
    });
  });

  // Recipe: add line
  var addLine = $('#addLineBtn');
  if (addLine) {
    addLine.addEventListener('click', function() {
      addRecipeLine();
    });
  }

  // Recipe: save
  var saveRecipe = $('#saveRecipeBtn');
  if (saveRecipe) {
    saveRecipe.addEventListener('click', function() {
      saveRecipeLines(item.id);
    });
  }
}

// === Actions ===
async function changeTrackMode(itemId, newMode) {
  var body = { trackMode: newMode };
  // When switching to simple, include defaults
  if (newMode === 'simple') {
    var item = menuItems.find(function(m) { return m.id === itemId; });
    body.stockQty = item ? (item.stockQty || 0) : 0;
    body.minStockQty = item ? (item.minStockQty || 0) : 0;
  }
  try {
    await api.put('/inventory/menu-items/' + itemId + '/stock-config', body);
    // Update local state
    var item = menuItems.find(function(m) { return m.id === itemId; });
    if (item) item.trackMode = newMode;
    renderItemList();
    await loadRecipeForItem(itemId);
    showToast('Rezim sledovania zmeneny', true);
  } catch (err) {
    showToast(err.message || 'Chyba zmeny rezimu', 'error');
  }
}

async function saveSimpleConfig(itemId) {
  var stockQtyEl = $('#fStockQty');
  var minStockQtyEl = $('#fMinStockQty');
  if (!stockQtyEl || !minStockQtyEl) return;

  var stockQty = parseFloat(stockQtyEl.value) || 0;
  var minStockQty = parseFloat(minStockQtyEl.value) || 0;

  var btn = $('#saveSimpleBtn');
  if (btn) btnLoading(btn);
  try {
    await api.put('/inventory/menu-items/' + itemId + '/stock-config', {
      trackMode: 'simple',
      stockQty: stockQty,
      minStockQty: minStockQty
    });
    // Update local state
    var item = menuItems.find(function(m) { return m.id === itemId; });
    if (item) {
      item.stockQty = stockQty;
      item.minStockQty = minStockQty;
    }
    showToast('Konfiguracia ulozena', true);
  } catch (err) {
    showToast(err.message || 'Chyba ukladania', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

function addRecipeLine() {
  var selectEl = $('#fNewIngredient');
  var qtyEl = $('#fNewQty');
  if (!selectEl || !qtyEl) return;

  var ingredientId = Number(selectEl.value);
  var qty = parseFloat(qtyEl.value);

  if (!ingredientId) {
    showToast('Vyberte surovinu');
    return;
  }
  if (!qty || qty <= 0) {
    showToast('Zadajte platne mnozstvo');
    return;
  }

  var ing = ingredientsList.find(function(i) { return i.id === ingredientId; });
  if (!ing) return;

  // Add to local recipe (immutable — new array)
  currentRecipe = currentRecipe.concat([{
    ingredientId: ingredientId,
    qtyPerUnit: qty,
    ingredientName: ing.name,
    ingredientUnit: ing.unit
  }]);

  renderEditor();
}

async function saveRecipeLines(itemId) {
  var btn = $('#saveRecipeBtn');
  if (btn) btnLoading(btn);
  try {
    if (!currentRecipe.length) {
      // Empty recipe — delete all lines
      await api.del('/inventory/recipes/' + itemId);
    } else {
      var lines = currentRecipe.map(function(line) {
        return { ingredientId: line.ingredientId, qtyPerUnit: line.qtyPerUnit };
      });
      await api.put('/inventory/recipes/' + itemId, { lines: lines });
      // server automaticky prepne item na trackMode='recipe' — synchronizujeme lokálny cache
      var local = menuItems.find(function (m) { return m.id === itemId; });
      if (local) local.trackMode = 'recipe';
    }
    await loadRecipeSummary();
    renderItemList();
    await loadRecipeForItem(itemId);
    showToast('Recept ulozeny', true);
  } catch (err) {
    showToast(err.message || 'Chyba ukladania receptu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

// === Filter tabs ===
function setFilter(filter) {
  activeFilter = filter;
  $$('.recipe-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  selectedItemId = null;
  currentRecipe = [];
  renderItemList();
  var visible = getFilteredItems();
  if (visible.length) {
    selectItem(visible[0].id);
  } else {
    renderEditor();
  }
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  container.className = 'content admin-page-fill';

  // Reset state
  menuItems = [];
  ingredientsList = [];
  selectedItemId = null;
  currentRecipe = [];
  activeFilter = 'all';

  container.innerHTML = ''
    + '<div class="cat-panel">'
    + '<div class="cat-panel-header">Polozky menu</div>'
    + '<div style="padding:8px 8px 0;display:flex;gap:4px;flex-wrap:wrap">'
    + '<button class="zone-btn active recipe-filter-btn" data-filter="all" type="button">Vsetky</button>'
    + '<button class="zone-btn recipe-filter-btn" data-filter="recipe" type="button">Recept</button>'
    + '<button class="zone-btn recipe-filter-btn" data-filter="simple" type="button">Simple</button>'
    + '<button class="zone-btn recipe-filter-btn" data-filter="none" type="button">None</button>'
    + '</div>'
    + '<div class="cat-list" id="itemList">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    + '</div>'
    + '<div class="prod-panel">'
    + '<div id="editorContent" style="display:flex;flex-direction:column;flex:1;overflow:hidden">'
    + '<div class="empty-state" style="padding:60px 20px">'
    + '<div class="empty-state-icon">\u23F3</div>'
    + '<div class="empty-state-title">Nacitavam...</div>'
    + '</div>'
    + '</div>'
    + '</div>';

  // Bind filter tab events
  $$('.recipe-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setFilter(btn.dataset.filter);
    });
  });

  // Escape key handler
  _escHandler = function(e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('dynModal');
      if (modal) modal.remove();
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data in parallel
  Promise.all([loadIngredients(), loadMenuItems()]);
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
  menuItems = [];
  ingredientsList = [];
  selectedItemId = null;
  currentRecipe = [];
  activeFilter = 'all';
  _container = null;
}
