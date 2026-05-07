// Recipes page module — two-panel recipe editor
let menuItems = [];
let ingredientsList = [];
let selectedItemId = null;
let currentRecipe = [];
let activeFilter = 'all';
let searchQuery = '';
let recipeSummary = {}; // menuItemId -> ingredient count
let salesByMenu = {};   // menuItemId -> soldQty (od začiatku sezóny)
let _container = null;
let _escHandler = null;

// Slovak diacritic-fold for search ('cesnak' matches 'česnak'; 'maso' matches 'mäso').
function _foldDia(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function $(sel) { return _container.querySelector(sel); }
function $$(sel) { return _container.querySelectorAll(sel); }

// === Load data ===
async function loadRecipeSummary() {
  try {
    var rows = await api.get('/inventory/recipes/summary');
    recipeSummary = {};
    // Server posiela {menuItemId, count, cost}. Skladujeme ako objekt,
    // aby sme mali aj food cost (predtým to bola len jednoduchá count
    // mapa). Render číta count cez recipeSummary[id].count, food cost
    // cez recipeSummary[id].cost.
    (rows || []).forEach(function (r) {
      recipeSummary[r.menuItemId] = {
        count: Number(r.count) || 0,
        cost: Number(r.cost) || 0,
      };
    });
  } catch (_) {
    recipeSummary = {};
  }
}

// Adaptive € formatter — sub-cent food costs (drinky / kávy s lacnými
// surovinami) potrebujú 4 desatinné, väčšie burgre stačia 2.
function _fmtCost(n) {
  var x = Number(n);
  if (!isFinite(x) || x === 0) return '0,00';
  var abs = Math.abs(x);
  if (abs >= 1) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 0.01) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return x.toLocaleString('sk-SK', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

// Per-menu predaje od začiatku aktuálnej sezóny (default 25.04). Bez tohto
// dát sa filter "Bez receptu (predáva sa)" zobrazí prázdny — preto loadujeme
// vždy paralelne s recipe summary.
async function loadSalesByMenu() {
  try {
    var rows = await api.get('/inventory/menu-items/sales');
    salesByMenu = {};
    (rows || []).forEach(function (r) { salesByMenu[r.menuItemId] = r.soldQty; });
  } catch (_) {
    salesByMenu = {};
  }
}

async function loadMenuItems() {
  var listEl = $('#itemList');
  if (listEl) showLoading(listEl, 'Nacitavam polozky...');
  try {
    const [items] = await Promise.all([
      api.get('/inventory/menu-items'),
      loadRecipeSummary(),
      loadSalesByMenu(),
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
// Apply mode tab + search query together. Search is diacritic-insensitive
// and matches name OR category label so 'burger' or 'burgre' both find
// the burger SKUs.
//
// Special filter 'sold-no-recipe' = predáva sa od začiatku sezóny ALE
// nemá recept (track_mode != 'recipe' alebo recipe-tracked s 0 riadkami).
// Výstup je zoradený zostupne podľa predaných ks — operátor vidí najprv
// veci, ktoré najviac chýbajú v evidencii.
function getFilteredItems() {
  var q = _foldDia(searchQuery);
  var filtered = menuItems.filter(function(m) {
    if (activeFilter === 'sold-no-recipe') {
      var sold = salesByMenu[m.id] || 0;
      if (sold <= 0) return false;
      var hasRecipe = (m.trackMode === 'recipe') && (recipeSummary[m.id] && recipeSummary[m.id].count > 0);
      if (hasRecipe) return false;
    } else if (activeFilter !== 'all' && m.trackMode !== activeFilter) {
      return false;
    }
    if (!q) return true;
    var hay = _foldDia(m.name) + ' ' + _foldDia(m.categoryLabel || '');
    return hay.indexOf(q) !== -1;
  });
  if (activeFilter === 'sold-no-recipe') {
    filtered.sort(function(a, b) {
      return (salesByMenu[b.id] || 0) - (salesByMenu[a.id] || 0);
    });
  }
  return filtered;
}

// Counts shown in the filter tabs so the user sees at a glance how many
// items are in each mode (helps spot 'X items still without a recipe').
function getModeCounts() {
  var counts = { all: menuItems.length, recipe: 0, simple: 0, none: 0, soldNoRecipe: 0 };
  for (var i = 0; i < menuItems.length; i++) {
    var m = menuItems[i];
    var mode = m.trackMode || 'none';
    if (counts[mode] != null) counts[mode] += 1;
    var sold = salesByMenu[m.id] || 0;
    var hasRecipe = (mode === 'recipe') && (recipeSummary[m.id] > 0);
    if (sold > 0 && !hasRecipe) counts.soldNoRecipe += 1;
  }
  return counts;
}

function _renderFilterTabs() {
  var tabsEl = $('#recipeFilterTabs');
  if (!tabsEl) return;
  var c = getModeCounts();
  var tabs = [
    { f: 'all',    label: 'Všetky',  badge: c.all },
    { f: 'recipe', label: 'Recept',  badge: c.recipe },
    { f: 'simple', label: 'Simple',  badge: c.simple },
    { f: 'none',   label: 'Bez',     badge: c.none },
    // Predáva sa, ale ešte nemá recept — žltá, lebo to je TODO list pre operátora.
    { f: 'sold-no-recipe', label: '⚠ Bez receptu (predáva sa)', badge: c.soldNoRecipe },
  ];
  tabsEl.innerHTML = tabs.map(function(t) {
    var active = t.f === activeFilter ? ' active' : '';
    return '<button class="zone-btn recipe-filter-btn' + active + '" data-filter="' + t.f + '" type="button">'
      + escHtml(t.label)
      + ' <span style="font-size:10px;opacity:.7;margin-left:4px">' + t.badge + '</span>'
      + '</button>';
  }).join('');
  // Re-bind clicks (innerHTML wipes listeners).
  tabsEl.querySelectorAll('.recipe-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setFilter(btn.dataset.filter); });
  });
}

// === Render left panel: menu item list ===
function renderItemList() {
  _renderFilterTabs();
  var listEl = $('#itemList');
  if (!listEl) return;

  var filtered = getFilteredItems();

  // Update the result count line under the search input.
  var countEl = $('#recipeResultCount');
  if (countEl) {
    if (searchQuery) {
      countEl.textContent = filtered.length + ' / ' + menuItems.length + ' (vyh\u013Ead\u00E1vanie)';
    } else {
      countEl.textContent = filtered.length + ' polo\u017Eiek';
    }
  }

  if (!filtered.length) {
    var msg;
    if (searchQuery) msg = '\u017Diadne v\u00FDsledky pre \u201E' + searchQuery + '"';
    else if (activeFilter === 'all') msg = 'Ziadne polozky v menu';
    else msg = 'Ziadne polozky s modom "' + activeFilter + '"';
    listEl.innerHTML = '<div class="empty-state" style="padding:32px 16px">'
      + '<div class="empty-state-icon">\uD83D\uDD0D</div>'
      + '<div class="empty-state-title">Pr\u00E1zdne</div>'
      + '<div class="empty-state-text">' + escHtml(msg) + '</div></div>';
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
      var summary = recipeSummary[item.id] || { count: 0, cost: 0 };
      var count = summary.count;
      var foodCost = summary.cost;
      var sold = salesByMenu[item.id] || 0;
      var price = parseFloat(item.price) || 0;
      var badgeClass = 'badge-info';
      var badgeLabel = 'none';
      if (item.trackMode === 'recipe') { badgeClass = 'badge-purple'; badgeLabel = 'recept'; }
      else if (item.trackMode === 'simple') { badgeClass = 'badge-success'; badgeLabel = 'simple'; }
      var ingredientsLabel = count > 0
        ? '<span class="text-muted" style="margin-left:6px;font-size:11px">' + count + ' surov.</span>'
        : '';
      // Food cost badge — €/porcia + % z predajnej ceny.
      // Industry rule of thumb pre HoReCa: food cost <30 % je dobré,
      // 30-35 % OK, >35 % zle. Farba badge mení sa podľa toho:
      // zelená < 30 %, amber 30-35 %, červená > 35 %.
      var foodCostBadge = '';
      if (count > 0 && foodCost > 0) {
        var pct = (price > 0) ? (foodCost / price) * 100 : 0;
        var fcColor;
        if (pct === 0) fcColor = 'background:rgba(255,255,255,.06);color:var(--color-text-dim)';
        else if (pct < 30) fcColor = 'background:rgba(34,197,94,.15);color:#22c55e';
        else if (pct < 35) fcColor = 'background:rgba(245,158,11,.15);color:#f59e0b';
        else fcColor = 'background:rgba(239,68,68,.18);color:#ef4444';
        var pctLabel = (price > 0) ? ' · ' + pct.toFixed(0) + '%' : '';
        foodCostBadge = '<span title="Food cost na 1 porciu (' + (price>0?(pct.toFixed(1)+'% z ceny ' + price.toFixed(2) + '€'):'cena 0') + ')"'
          + ' style="margin-left:6px;font-size:11px;padding:1px 6px;border-radius:4px;font-weight:700;'
          + fcColor + '">' + _fmtCost(foodCost) + ' €' + pctLabel + '</span>';
      }
      // "Predalo sa Xx" badge \u2014 \u017Elt\u00FD ak nem\u00E1 recept (oper\u00E1tor vid\u00ED \u010Do
      // ch\u00FDba v evidencii); \u0161ed\u00FD ak recept existuje (informa\u010Dn\u00FD).
      var hasRecipe = (item.trackMode === 'recipe') && (count > 0);
      var soldBadge = '';
      if (sold > 0) {
        var soldColor = hasRecipe
          ? 'background:rgba(255,255,255,.06);color:var(--color-text-dim)'
          : 'background:rgba(245,158,11,.15);color:#f59e0b;font-weight:700';
        soldBadge = '<span style="margin-left:6px;font-size:11px;padding:1px 6px;border-radius:4px;'
          + soldColor + '">' + sold + 'x</span>';
      }

      html += '<button class="cat-item' + (item.id === selectedItemId ? ' active' : '') + '" data-item-id="' + item.id + '" type="button">'
        + '<span class="cat-icon">' + (item.emoji || '\uD83C\uDF7D') + '</span>'
        + '<div class="cat-info">'
        + '<div class="cat-name">' + escHtml(item.name) + '</div>'
        + '<div class="cat-count"><span class="badge ' + badgeClass + '">' + badgeLabel + '</span>' + ingredientsLabel + foodCostBadge + soldBadge + '</div>'
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

  // Header: item name + price + food cost summary
  // Food cost počítame zo živého currentRecipe (operátor pridá / zmení
  // qty inline → cost sa hneď prepočíta), alebo z recipeSummary cache
  // ak ešte nie je recept načítaný.
  var price = parseFloat(item.price) || 0;
  var liveFoodCost = 0;
  if (Array.isArray(currentRecipe) && currentRecipe.length) {
    for (var fi = 0; fi < currentRecipe.length; fi++) {
      var line = currentRecipe[fi];
      var ing = ingredientsList.find(function(x){ return x.id === line.ingredientId; });
      var ingCost = ing ? parseFloat(ing.costPerUnit) || 0 : 0;
      liveFoodCost += (parseFloat(line.qtyPerUnit) || 0) * ingCost;
    }
  } else if (recipeSummary[item.id] && recipeSummary[item.id].cost) {
    liveFoodCost = recipeSummary[item.id].cost;
  }
  var fcPct = (price > 0 && liveFoodCost > 0) ? (liveFoodCost / price) * 100 : 0;
  var fcColor = fcPct === 0 ? 'var(--color-text-dim)'
    : fcPct < 30 ? '#22c55e'
    : fcPct < 35 ? '#f59e0b'
    : '#ef4444';

  html += '<div class="prod-header" style="border-bottom:1px solid rgba(255,255,255,.05);display:flex;flex-direction:column;gap:8px">';
  html += '<div class="prod-header-title">' + (item.emoji || '') + ' ' + escHtml(item.name) + '</div>';
  html += '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:13px">';
  html += '<span style="color:var(--color-text-sec)">Cena: <strong style="color:var(--color-text)">' + _fmtCost(price) + ' €</strong></span>';
  if (liveFoodCost > 0) {
    html += '<span style="color:var(--color-text-sec)">Food cost: <strong style="color:' + fcColor + '">' + _fmtCost(liveFoodCost) + ' €</strong></span>';
    if (fcPct > 0) {
      html += '<span style="padding:3px 10px;border-radius:6px;font-weight:700;background:' + fcColor + '22;color:' + fcColor + '">'
        + fcPct.toFixed(1) + ' % z ceny</span>';
    }
    if (price > 0) {
      var marza = price - liveFoodCost;
      html += '<span style="color:var(--color-text-sec)">Marža: <strong style="color:var(--color-text)">+' + _fmtCost(marza) + ' €</strong></span>';
    }
  } else {
    html += '<span style="color:var(--color-text-dim);font-style:italic">Food cost: nie je recept</span>';
  }
  html += '</div>';
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
      // Quantity — editable inline. Was static text before; users were
      // clicking the number expecting to change it, hitting "Ulozit
      // recept", and seeing nothing happen because the value wasn't
      // bound to anything. data-qty-idx → bindEditorEvents wires a
      // change handler that mutates currentRecipe[idx] + auto-saves
      // on blur, so the saved state actually matches what the user typed.
      html += '<input type="number" step="0.001" min="0.001"'
        + ' data-qty-idx="' + idx + '"'
        + ' value="' + Number(line.qtyPerUnit) + '"'
        + ' style="font-family:var(--font-display);font-size:var(--text-xl);font-weight:var(--weight-bold);'
        +        'color:rgba(' + uc + ',1);letter-spacing:var(--tracking-tight);'
        +        'width:90px;text-align:right;'
        +        'background:rgba(' + uc + ',.05);border:1px solid rgba(' + uc + ',.2);'
        +        'border-radius:var(--radius-xs);padding:6px 8px;outline:none">';
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

  // Add ingredient row — search input with diacritic-insensitive
  // autocomplete dropdown. Skladová evidencia má 150+ surovín, dropdown
  // je nepoužiteľný; tu môže operátor písať 'cibu' a hneď vidí biele +
  // červené cibule. Hidden #fNewIngredient drží vybrané ID pre addLineBtn.
  // Suroviny už použité v aktuálnom recepte sú vylúčené.
  var usedIds = currentRecipe.map(function(r) { return r.ingredientId; });
  html += '<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:24px;flex-wrap:wrap;padding:14px;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">';
  html += '<div class="form-group" style="flex:2;min-width:200px;margin-bottom:0;position:relative">';
  html += '<label class="form-label" for="fNewIngredientSearch">Pridat surovinu</label>';
  html += '<input class="form-input" id="fNewIngredientSearch" type="text" autocomplete="off"'
    + ' placeholder="Piš názov suroviny… (napr. cibu, kač, hov)">';
  html += '<input type="hidden" id="fNewIngredient" value="">';
  // Dropdown panel — pozícia absolútna pod input, max-height + scroll;
  // skrytý kým input nie je focused alebo nemá písmená.
  html += '<div id="fNewIngredientDropdown" style="display:none;position:absolute;left:0;right:0;top:100%;'
    + 'z-index:50;max-height:280px;overflow-y:auto;background:var(--color-bg-surface);'
    + 'border:1px solid var(--color-border);border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm);'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.4)"></div>';
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

  // Recipe: remove line (autosave)
  $$('[data-remove-idx]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var idx = Number(btn.dataset.removeIdx);
      var snapshot = currentRecipe.slice();
      currentRecipe = currentRecipe.filter(function(_, i) { return i !== idx; });
      renderEditor();
      try {
        await saveRecipeLines(item.id, { silent: true, skipReload: true });
        showToast('Surovina odstranena', true);
      } catch (_) {
        currentRecipe = snapshot;
        renderEditor();
      }
    });
  });

  // Recipe: edit qty inline. On blur (or Enter) we persist the new value;
  // the autosave is silent because every keystroke would be too chatty.
  $$('[data-qty-idx]').forEach(function(input) {
    input.addEventListener('focus', function() { input.dataset.prevValue = input.value; });
    var commit = async function() {
      var idx = Number(input.dataset.qtyIdx);
      var v = parseFloat(input.value);
      if (!Number.isFinite(v) || v <= 0) {
        showToast('Mnozstvo musi byt > 0', 'error');
        input.value = input.dataset.prevValue || '';
        input.focus();
        return;
      }
      var prev = Number(currentRecipe[idx] && currentRecipe[idx].qtyPerUnit);
      if (v === prev) return; // no-op
      currentRecipe[idx].qtyPerUnit = v;
      try {
        await saveRecipeLines(item.id, { silent: true, skipReload: true });
        // Re-render editor — food cost summary v hlavičke sa prerátá
        // (saveRecipeLines volá renderItemList ale nie renderEditor).
        renderEditor();
        showToast('Mnozstvo upravene a recept ulozeny', true);
      } catch (err) {
        currentRecipe[idx].qtyPerUnit = prev;
        input.value = prev;
      }
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  });

  // Recipe: add line
  var addLine = $('#addLineBtn');
  if (addLine) {
    addLine.addEventListener('click', function() {
      addRecipeLine();
    });
  }

  // Recipe: ingredient search autocomplete (custom dropdown).
  // Filtruje ingredientsList diacritic-insensitive. Vylučuje suroviny už
  // použité v recepte (usedIds). Klávesnica: ↑/↓ zvýrazni, Enter vyberie,
  // Esc zatvorí. Klik mimo zatvorí. Vybraním sa vyplní hidden #fNewIngredient
  // a focus prejde na qty input pre rýchle zadanie čísla.
  var searchInput = $('#fNewIngredientSearch');
  var hiddenInput = $('#fNewIngredient');
  var dropdown = $('#fNewIngredientDropdown');
  if (searchInput && dropdown) {
    var usedIdsSet = {};
    currentRecipe.forEach(function(r) { usedIdsSet[r.ingredientId] = true; });
    var highlighted = -1;
    var visibleList = [];

    function _renderDropdown(query) {
      var q = _foldDia(query);
      visibleList = ingredientsList.filter(function(ing) {
        if (usedIdsSet[ing.id]) return false;
        if (!q) return true;
        return _foldDia(ing.name).indexOf(q) !== -1;
      });
      // Top 25 výsledkov stačí — operátor ak nevidí čo chce, doplní viac písmen.
      visibleList = visibleList.slice(0, 25);
      if (!visibleList.length) {
        dropdown.innerHTML = '<div style="padding:14px;color:var(--color-text-dim);font-size:13px">Žiadna surovina nenájdená</div>';
        dropdown.style.display = 'block';
        highlighted = -1;
        return;
      }
      dropdown.innerHTML = visibleList.map(function(ing, i) {
        var hi = i === highlighted;
        var bg = hi ? 'background:rgba(139,124,246,.18)' : 'background:transparent';
        return '<div class="ing-row" data-ing-id="' + ing.id + '" data-idx="' + i + '" style="'
          + 'padding:10px 14px;cursor:pointer;font-size:14px;border-bottom:1px solid rgba(255,255,255,.04);'
          + bg + '">'
          + '<span style="font-weight:600">' + escHtml(ing.name) + '</span>'
          + ' <span style="color:var(--color-text-dim);font-size:12px">(' + escHtml(ing.unit) + ')</span>'
          + '</div>';
      }).join('');
      dropdown.style.display = 'block';
      // Klik na riadok → pick.
      dropdown.querySelectorAll('.ing-row').forEach(function(row) {
        row.addEventListener('mousedown', function(e) { e.preventDefault(); }); // blur defer
        row.addEventListener('click', function() {
          _pickIngredient(Number(row.dataset.ingId));
        });
      });
    }

    function _pickIngredient(ingId) {
      var ing = ingredientsList.find(function(i) { return i.id === ingId; });
      if (!ing) return;
      hiddenInput.value = String(ingId);
      searchInput.value = ing.name + ' (' + ing.unit + ')';
      dropdown.style.display = 'none';
      var qtyEl = $('#fNewQty');
      if (qtyEl) qtyEl.focus();
    }

    searchInput.addEventListener('focus', function() {
      _renderDropdown(searchInput.value);
    });
    searchInput.addEventListener('input', function() {
      // Kým operátor píše, hidden ID resetuje — inak by sa mohlo pridať
      // surovinu ktorá nezodpovedá zobrazenému textu.
      hiddenInput.value = '';
      highlighted = -1;
      _renderDropdown(searchInput.value);
    });
    searchInput.addEventListener('keydown', function(e) {
      if (dropdown.style.display === 'none' || !visibleList.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlighted = Math.min(highlighted + 1, visibleList.length - 1);
        _renderDropdown(searchInput.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlighted = Math.max(highlighted - 1, 0);
        _renderDropdown(searchInput.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var pick = highlighted >= 0 ? visibleList[highlighted] : visibleList[0];
        if (pick) _pickIngredient(pick.id);
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      }
    });
    // Klik mimo input/dropdown zatvorí.
    document.addEventListener('mousedown', function _outside(e) {
      if (!searchInput.parentElement) {
        document.removeEventListener('mousedown', _outside);
        return;
      }
      if (!searchInput.parentElement.contains(e.target)) {
        dropdown.style.display = 'none';
      }
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

async function addRecipeLine() {
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

  currentRecipe = currentRecipe.concat([{
    ingredientId: ingredientId,
    qtyPerUnit: qty,
    ingredientName: ing.name,
    ingredientUnit: ing.unit
  }]);

  // autosave — odosleme na server hned, aby sa user nemusel spoliehat na kliknutie "Ulozit recept"
  try {
    await saveRecipeLines(selectedItemId, { silent: true, skipReload: true });
    renderEditor();
    showToast('Surovina pridana a recept ulozeny', true);
  } catch (_) {
    // pri chybe vratime zmenu
    currentRecipe = currentRecipe.filter(function (l) { return l.ingredientId !== ingredientId; });
    renderEditor();
  }
}

async function saveRecipeLines(itemId, opts) {
  opts = opts || {};
  var btn = $('#saveRecipeBtn');
  if (btn && !opts.silent) btnLoading(btn);
  try {
    if (!currentRecipe.length) {
      await api.del('/inventory/recipes/' + itemId);
    } else {
      var lines = currentRecipe.map(function(line) {
        return { ingredientId: line.ingredientId, qtyPerUnit: line.qtyPerUnit };
      });
      console.log('[recipes] PUT', itemId, lines);
      await api.put('/inventory/recipes/' + itemId, { lines: lines });
      var local = menuItems.find(function (m) { return m.id === itemId; });
      if (local) local.trackMode = 'recipe';
    }
    await loadRecipeSummary();
    renderItemList();
    if (!opts.skipReload) {
      await loadRecipeForItem(itemId);
    }
    if (!opts.silent) showToast('Recept ulozeny', true);
  } catch (err) {
    console.error('[recipes] save error:', err);
    showToast(err.message || 'Chyba ukladania receptu', 'error');
    throw err;
  } finally {
    if (btn && !opts.silent) btnReset(btn);
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
    + '<div class="cat-panel-header">Polo\u017Eky menu</div>'
    // Search input \u2014 diacritic-insensitive substring match across name + category.
    + '<div style="padding:8px 10px 0;position:relative">'
    + '<input type="search" id="recipeSearch" class="form-input"'
    + ' placeholder="H\u013Eada\u0165 surovinu, jedlo, kateg\u00F3riu\u2026" autocomplete="off"'
    + ' style="padding-left:32px;font-size:13px;height:34px">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true"'
    + ' style="position:absolute;left:18px;top:50%;transform:translateY(-50%);width:14px;height:14px;'
    +        'stroke:var(--color-text-dim);fill:none;stroke-width:2;stroke-linecap:round;pointer-events:none">'
    + '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/></svg>'
    + '<button id="recipeSearchClear" type="button" aria-label="Vy\u010Disti\u0165"'
    + ' style="position:absolute;right:18px;top:50%;transform:translateY(-50%);width:22px;height:22px;'
    +        'border:none;background:rgba(255,255,255,.06);border-radius:50%;color:var(--color-text-sec);'
    +        'cursor:pointer;display:none;align-items:center;justify-content:center;font-size:12px">\u00D7</button>'
    + '</div>'
    // Filter tabs (counts injected by _renderFilterTabs).
    + '<div id="recipeFilterTabs" style="padding:8px 10px 4px;display:flex;gap:4px;flex-wrap:wrap"></div>'
    // Result count line.
    + '<div id="recipeResultCount" style="padding:0 12px 6px;font-size:11px;color:var(--color-text-dim);font-weight:600;letter-spacing:.4px;text-transform:uppercase">\u2026</div>'
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

  // Search input \u2014 debounced re-render so heavy menus (200+ items) stay snappy.
  var searchInput = $('#recipeSearch');
  var clearBtn = $('#recipeSearchClear');
  var _searchT = null;
  function _applySearch() {
    if (clearBtn) clearBtn.style.display = searchQuery ? 'flex' : 'none';
    renderItemList();
  }
  if (searchInput) {
    searchInput.addEventListener('input', function(e) {
      clearTimeout(_searchT);
      _searchT = setTimeout(function() {
        searchQuery = (e.target.value || '').trim();
        _applySearch();
      }, 120);
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && searchQuery) {
        e.preventDefault();
        searchInput.value = '';
        searchQuery = '';
        _applySearch();
      }
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      searchInput.value = '';
      searchQuery = '';
      searchInput.focus();
      _applySearch();
    });
  }
  // Filter-tab clicks are wired inside _renderFilterTabs (called by renderItemList).

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
