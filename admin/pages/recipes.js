// Recipes page module — two-panel recipe editor
import { fmtCost } from '../../components/fmt.js';
import { mountEmptyState } from '../components/empty-state.js';

let menuItems = [];
let ingredientsList = [];
let selectedItemId = null;
let currentRecipe = [];
let activeFilter = 'all';
let searchQuery = '';
let recipeSummary = {}; // menuItemId -> ingredient count
let salesByMenu = {};   // menuItemId -> soldQty (od začiatku sezóny)
let vatPayer = false;   // odvodené z company_profiles.ic_dph
let _container = null;
let _escHandler = null;

// Food cost % a marža sa musia rátať proti cene BEZ DPH: cost_per_unit
// surovín sa zadáva netto (admin/pages/purchase-orders.js to výslovne
// prikazuje), takže brutto menu cena posúva prahy (zelená <30 %, amber
// 30–35 %, červená >35 %) až o faktor 1,23.
// U NEPLATITEĽA vraciame cenu nezmenenú — správanie ostáva bit-identické.
function netBase(item, price) {
  var p = Number(price) || 0;
  if (!vatPayer) return p;
  var rate = parseFloat(item && item.vatRate);
  if (!Number.isFinite(rate) || rate <= 0) return p;
  return p / (1 + rate / 100);
}

function vatNote() {
  return vatPayer ? ' bez DPH' : '';
}

async function loadVatMode() {
  try {
    var profile = await api.getCompanyProfile();
    vatPayer = String((profile && profile.icDph) || '').trim().length > 0;
  } catch (_) {
    // Fail-safe: bez profilu sa správame ako neplatiteľ, teda ako doteraz.
    vatPayer = false;
  }
}

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
  if (listEl) showLoading(listEl, 'Načítavam položky…');
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
    renderError(listEl, err.message || 'Chyba pri načítaní položiek', loadMenuItems);
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
    showLoading(editorEl, 'Načítavam recept…');
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
    { f: 'all',    label: 'Všetky',         badge: c.all },
    { f: 'recipe', label: 'Recept',         badge: c.recipe },
    { f: 'simple', label: 'Jednoduché',     badge: c.simple },
    { f: 'none',   label: 'Bez sledovania', badge: c.none },
    // Predáva sa, ale ešte nemá recept — TODO list pre operátora.
    { f: 'sold-no-recipe', label: 'Predáva sa bez receptu', badge: c.soldNoRecipe },
  ];
  tabsEl.innerHTML = tabs.map(function(t) {
    var on = t.f === activeFilter;
    return '<button class="doch-chip mn-cat recipe-filter-btn' + (on ? ' is-on' : '') + '" data-filter="' + t.f + '" type="button"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
      + '<span class="mn-cat-label">' + escHtml(t.label) + '</span>'
      + '<span class="mn-cat-n">' + t.badge + '</span>'
      + '</button>';
  }).join('');
  // Re-bind clicks (innerHTML wipes listeners).
  tabsEl.querySelectorAll('.recipe-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setFilter(btn.dataset.filter); });
  });
}

function itemsWord(n) { return n === 1 ? 'položka' : (n >= 2 && n <= 4 ? 'položky' : 'položiek'); }
function ingWord(n) { return n === 1 ? 'surovina' : (n >= 2 && n <= 4 ? 'suroviny' : 'surovín'); }

// Food cost ako pilulka: zelená < 30 %, jantárová 30–35 %, červená > 35 %
// (bežné prahy v HoReCa). Bez ceny (0 €) percento nedáva zmysel — len suma.
function foodCostPill(foodCost, netPrice, big) {
  var pct = (netPrice > 0) ? (foodCost / netPrice) * 100 : 0;
  var cls = pct === 0 ? 'is-muted' : pct < 30 ? 'is-ok' : pct < 35 ? 'is-warn' : 'is-danger';
  var title = netPrice > 0
    ? 'Food cost na 1 porciu: ' + pct.toFixed(1).replace('.', ',') + ' % z ceny' + vatNote() + ' ' + fmtCost(netPrice) + ' €'
    : 'Food cost na 1 porciu; cena položky je 0 €';
  return '<span class="mn-pill ' + cls + (big ? ' is-lg' : '') + '" title="' + escHtml(title) + '">'
    + fmtCost(foodCost) + ' €' + (netPrice > 0 ? ' · ' + pct.toFixed(0) + ' %' : '') + '</span>';
}

// === Render left panel: menu item list ===
// Jeden riadok na položku: ikona, názov, pod ním režim sledovania (+ počet
// surovín, predaj), vpravo food cost ako pilulka. Kategórie sú nadpisy
// skupín. Riadok otvára editor (na telefóne ako ďalšiu obrazovku).
function renderItemList() {
  _renderFilterTabs();
  var listEl = $('#itemList');
  if (!listEl) return;

  var filtered = getFilteredItems();

  // Update the result count line under the search input.
  var countEl = $('#recipeResultCount');
  if (countEl) {
    if (searchQuery) {
      countEl.textContent = filtered.length + ' z ' + menuItems.length + ' ' + itemsWord(menuItems.length) + ' pre „' + searchQuery + '"';
    } else if (activeFilter !== 'all') {
      countEl.textContent = filtered.length + ' z ' + menuItems.length + ' ' + itemsWord(menuItems.length);
    } else {
      countEl.textContent = filtered.length + ' ' + itemsWord(filtered.length);
    }
  }

  if (!filtered.length) {
    var opts;
    if (searchQuery) {
      opts = { icon: '🔍', title: 'Nič sa nenašlo', text: 'Pre „' + searchQuery + '" nie je žiadna položka ani kategória. Skús kratšie slovo alebo hľadanie vymaž.',
        ctaLabel: 'Vymazať hľadanie', onCta: function () { var i = $('#recipeSearch'); if (i) { i.value = ''; searchQuery = ''; renderItemList(); } var cb = $('#recipeSearchClear'); if (cb) cb.style.display = 'none'; } };
    } else if (activeFilter === 'sold-no-recipe') {
      opts = { icon: '✅', title: 'Všetko predávané má recept', text: 'Každá položka, ktorá sa od začiatku sezóny predala, má nastavený recept alebo sledovanie.' };
    } else if (activeFilter === 'all') {
      opts = { icon: '🍽', title: 'Žiadne položky v menu', text: 'Receptúry sa viažu na produkty. Najprv pridaj produkty v sekcii Menu.' };
    } else {
      opts = { icon: '🔍', title: 'Nič v tomto režime', text: 'Žiadna položka nemá tento režim sledovania. Skús filter „Všetky".' };
    }
    mountEmptyState(listEl, opts);
    return;
  }

  // Group items by category
  var categories = [];
  var catMap = {};
  filtered.forEach(function(item) {
    var catKey = item.categorySlug || item.categoryId || 'other';
    if (!catMap[catKey]) {
      catMap[catKey] = { label: item.categoryLabel || 'Ostatné', items: [] };
      categories.push(catMap[catKey]);
    }
    catMap[catKey].items.push(item);
  });

  var html = '';
  categories.forEach(function(cat) {
    html += '<div class="mn-group-label">' + escHtml(cat.label) + '</div>';
    cat.items.forEach(function(item) {
      var summary = recipeSummary[item.id] || { count: 0, cost: 0 };
      var count = summary.count;
      var foodCost = summary.cost;
      var sold = salesByMenu[item.id] || 0;
      var price = parseFloat(item.price) || 0;
      var hasRecipe = (item.trackMode === 'recipe') && (count > 0);

      var sub = [];
      if (item.trackMode === 'recipe') sub.push(count > 0 ? count + ' ' + ingWord(count) : 'recept bez surovín');
      else if (item.trackMode === 'simple') sub.push('jednoduché sledovanie · na sklade ' + fmtCost(item.stockQty || 0));
      else sub.push('bez sledovania');
      if (sold > 0) {
        sub.push(hasRecipe
          ? 'predané ' + sold + '×'
          : '<span class="mn-warn">predané ' + sold + '× bez receptu</span>');
      }

      var side = '';
      if (count > 0 && foodCost > 0) side = foodCostPill(foodCost, netBase(item, price), false);

      html += '<button class="mn-row rc-item' + (item.id === selectedItemId ? ' is-selected' : '') + '" data-item-id="' + item.id + '" type="button"'
        + (item.id === selectedItemId ? ' aria-current="true"' : '') + '>'
        + '<span class="mn-row-lead" aria-hidden="true">' + (item.emoji || '🍽') + '</span>'
        + '<span class="mn-row-main">'
        + '<span class="mn-row-name">' + escHtml(item.name) + '</span>'
        + '<span class="mn-row-sub">' + sub.join(' · ') + '</span>'
        + '</span>'
        + '<span class="mn-row-side">' + side + '</span>'
        + '<svg class="mn-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</button>';
    });
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.rc-item').forEach(function(el) {
    el.addEventListener('click', function() {
      selectItem(Number(el.dataset.itemId));
      openEditor();
    });
  });
}

// Na telefóne je editor ďalšia obrazovka (zoznam → detail a späť), nie
// bočný panel, ktorý sa pod 768 px skrýval. Na širokých obrazovkách ostáva
// vedľa zoznamu — trieda tam nič nemení.
function openEditor() {
  if (!_container) return;
  _container.classList.add('is-detail');
  _container.scrollTop = 0;
}
function closeEditor() {
  if (!_container) return;
  _container.classList.remove('is-detail');
}

// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function escHtml(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    editorEl.innerHTML = '<div class="empty-hint rc-empty">Vyber položku zo zoznamu — tu sa ukáže jej recept a sledovanie skladu.</div>';
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
  var netPrice = netBase(item, price);

  html += '<div class="rc-ed-head">';
  html += '<span class="mn-row-lead" aria-hidden="true">' + (item.emoji || '🍽') + '</span>';
  html += '<div class="rc-ed-main">';
  html += '<div class="rc-ed-name">' + escHtml(item.name) + '</div>';
  html += '<div class="rc-ed-price">' + escHtml(item.categoryLabel || '') + (item.categoryLabel ? ' · ' : '') + 'cena <strong>' + fmtCost(price) + ' €</strong>'
    + (vatPayer && netPrice > 0 && netPrice !== price ? ' <span class="rc-ed-net">(bez DPH ' + fmtCost(netPrice) + ' €)</span>' : '')
    + '</div>';
  html += '</div>';
  html += '</div>';

  // Súčet: jeden riadok — food cost ako pilulka, marža ako číslo.
  html += '<div class="rc-sum">';
  if (liveFoodCost > 0) {
    html += '<span class="rc-sum-i">Food cost ' + foodCostPill(liveFoodCost, netPrice, true) + '</span>';
    if (netPrice > 0) {
      var marza = netPrice - liveFoodCost;
      html += '<span class="rc-sum-i">marža' + vatNote() + ' <strong>' + (marza < 0 ? '−' : '+') + fmtCost(Math.abs(marza)) + ' €</strong></span>';
    }
  } else {
    html += '<span class="rc-sum-i">Food cost sa počíta až z receptu.</span>';
  }
  html += '</div>';

  // Track mode selector
  html += '<div class="rc-mode">';
  html += '<div class="mn-label">Sledovanie skladu</div>';
  html += '<div class="panel-tabs" role="group" aria-label="Režim sledovania skladu">';
  html += modeBtn('none', 'Žiadne', item.trackMode);
  html += modeBtn('simple', 'Jednoduché', item.trackMode);
  html += modeBtn('recipe', 'Recept', item.trackMode);
  html += '</div>';
  html += '</div>';

  // Content based on track mode
  html += '<div class="rc-body">';

  if (item.trackMode === 'none') {
    html += '<div class="empty-hint">Sklad sa pri predaji tejto položky nemení. Zvoľ „Jednoduché" (počíta kusy) alebo „Recept" (odpisuje suroviny).</div>';
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
  var cls = isActive ? 'panel-tab active' : 'panel-tab';
  return '<button class="' + cls + '" data-mode="' + mode + '" type="button" aria-pressed="' + (isActive ? 'true' : 'false') + '">' + label + '</button>';
}

// === Simple mode form ===
function renderSimpleForm(item) {
  var html = '';
  html += '<div class="rc-fields">';
  html += '<div class="form-group">';
  html += '<label class="mn-label" for="fStockQty">Aktuálne množstvo na sklade (ks)</label>';
  html += '<input class="form-input" id="fStockQty" type="number" step="0.01" min="0" inputmode="decimal" value="' + (item.stockQty || 0) + '">';
  html += '</div>';
  html += '<div class="form-group">';
  html += '<label class="mn-label" for="fMinStockQty">Upozorniť, keď klesne pod (ks)</label>';
  html += '<input class="form-input" id="fMinStockQty" type="number" step="0.01" min="0" inputmode="decimal" value="' + (item.minStockQty || 0) + '">';
  html += '</div>';
  html += '</div>';
  html += '<button class="btn-save rc-save" id="saveSimpleBtn" type="button">Uložiť množstvá</button>';
  return html;
}

// === Recipe mode form ===
function renderRecipeForm(item) {
  var html = '';

  // Riadky receptu: surovina vľavo, množstvo (upraviteľné) + jednotka vpravo.
  if (currentRecipe.length) {
    html += '<div class="rc-lines" role="list" aria-label="Suroviny receptu">';
    currentRecipe.forEach(function(line, idx) {
      html += '<div class="rc-line" role="listitem">';
      html += '<div class="rc-line-name">' + escHtml(line.ingredientName || '') + '</div>';
      // Quantity — editable inline. data-qty-idx → bindEditorEvents wires a
      // change handler that mutates currentRecipe[idx] + auto-saves on blur.
      html += '<input class="rc-qty" type="number" step="0.001" min="0.001" inputmode="decimal"'
        + ' data-qty-idx="' + idx + '"'
        + ' aria-label="Množstvo: ' + escHtml(line.ingredientName || '') + '"'
        + ' value="' + Number(line.qtyPerUnit) + '">';
      html += '<span class="rc-unit">' + escHtml(line.ingredientUnit || '') + '</span>';
      html += '<button type="button" class="rc-remove" data-remove-idx="' + idx + '" aria-label="Odstrániť ' + escHtml(line.ingredientName || 'surovinu') + '" title="Odstrániť z receptu">✕</button>';
      html += '</div>';
    });
    html += '</div>';
  } else {
    html += '<div class="empty-hint rc-lines-empty">Recept je zatiaľ prázdny. Pridaj prvú surovinu nižšie — uloží sa hneď.</div>';
  }

  // Add ingredient row — search input with diacritic-insensitive
  // autocomplete dropdown (150+ surovín, select je nepoužiteľný). Hidden
  // #fNewIngredient drží vybrané ID pre addLineBtn.
  html += '<div class="rc-add">';
  html += '<div class="rc-add-search">';
  html += '<label class="mn-label" for="fNewIngredientSearch">Pridať surovinu</label>';
  html += '<input class="form-input" id="fNewIngredientSearch" type="text" autocomplete="off"'
    + ' placeholder="Začni písať názov, napr. cibu…">';
  html += '<input type="hidden" id="fNewIngredient" value="">';
  html += '<div id="fNewIngredientDropdown" class="rc-dd" style="display:none" role="listbox"></div>';
  html += '</div>';
  html += '<div class="rc-add-qty">';
  html += '<label class="mn-label" for="fNewQty">Množstvo na 1 ks</label>';
  html += '<input class="form-input" id="fNewQty" type="number" step="0.001" min="0.001" inputmode="decimal" placeholder="0,000">';
  html += '</div>';
  html += '<button class="btn-secondary rc-add-btn" id="addLineBtn" type="button">Pridať</button>';
  html += '</div>';

  // Save button
  html += '<button class="btn-save rc-save" id="saveRecipeBtn" type="button">Uložiť recept</button>';

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
        showToast('Surovina odstránená', true);
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
        showToast('Množstvo musí byť väčšie ako 0', 'error');
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
        showToast('Množstvo upravené, recept uložený', true);
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
        dropdown.innerHTML = '<div class="rc-dd-empty">Žiadna surovina sa nenašla. Skús kratšie slovo.</div>';
        dropdown.style.display = 'block';
        highlighted = -1;
        return;
      }
      dropdown.innerHTML = visibleList.map(function(ing, i) {
        var hi = i === highlighted;
        return '<div class="ing-row rc-dd-row' + (hi ? ' is-hi' : '') + '" data-ing-id="' + ing.id + '" data-idx="' + i + '" role="option"'
          + (hi ? ' aria-selected="true"' : '') + '>'
          + '<span class="rc-dd-name">' + escHtml(ing.name) + '</span>'
          + ' <span class="rc-dd-unit">' + escHtml(ing.unit) + '</span>'
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
    showToast('Režim sledovania zmenený', true);
  } catch (err) {
    showToast(err.message || 'Chyba zmeny režimu', 'error');
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
    showToast('Množstvá uložené', true);
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
    showToast('Vyber surovinu zo zoznamu');
    return;
  }
  if (!qty || qty <= 0) {
    showToast('Zadaj množstvo väčšie ako 0');
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
    showToast('Surovina pridaná, recept uložený', true);
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
    if (!opts.silent) showToast('Recept uložený', true);
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
    var on = btn.dataset.filter === filter;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
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
  container.className = 'content rc-page';

  // Reset state
  menuItems = [];
  ingredientsList = [];
  selectedItemId = null;
  currentRecipe = [];
  activeFilter = 'all';

  container.innerHTML = ''
    + '<div class="rc-master">'
    // Hľadanie — bez diakritiky, v názve aj kategórii.
    + '<div class="search-wrap rc-search">'
    + '<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    + '<input type="search" id="recipeSearch" class="search-input"'
    + ' placeholder="Hľadať položku alebo kategóriu…" aria-label="Hľadať položku alebo kategóriu" autocomplete="off">'
    + '<button id="recipeSearchClear" type="button" class="rc-search-clear" aria-label="Vyčistiť hľadanie" style="display:none">×</button>'
    + '</div>'
    // Filter režimu ako chipy (počty dopĺňa _renderFilterTabs).
    + '<div id="recipeFilterTabs" class="mn-cats rc-filters" role="group" aria-label="Filter režimu sledovania"></div>'
    + '<div id="recipeResultCount" class="mn-count rc-count" aria-live="polite">…</div>'
    + '<div class="mn-group mn-list rc-list" id="itemList">'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '<div class="skeleton-row"></div>'
    + '</div>'
    + '</div>'
    + '<div class="rc-detail">'
    + '<button type="button" class="rc-back" id="recipeBack">'
    + '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + 'Položky</button>'
    + '<div class="mn-group rc-editor" id="editorContent">'
    + '<div class="empty-hint rc-empty">Načítavam…</div>'
    + '</div>'
    + '</div>';

  var backBtn = $('#recipeBack');
  if (backBtn) backBtn.addEventListener('click', closeEditor);

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

  // Load data in parallel. Režim DPH beží samostatne — keď dorazí neskôr než
  // položky, prekreslíme, aby food cost % sedelo na správnom základe.
  loadVatMode().then(function () {
    // _container === null => stránka sa medzitým opustila (destroy).
    if (_container && menuItems.length) {
      renderItemList();
      renderEditor();
    }
  });
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
