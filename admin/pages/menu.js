let MENU_DATA = [];
let activeCatId = null;
let editingProductId = null;
let formAvailable = true;
let formVatRate = 23;
let vatRateTouched = false;
let catDragIdx = null;
let catDragEl = null;
let prodDragIdx = null;
let prodDragEl = null;
let _container = null;

const SUPPORTED_VAT_RATES = [5, 19, 23];
const CATEGORY_VAT_DEFAULTS = Object.freeze({
  kava: 19,
  caj: 19,
  koktaily: 23,
  pivo: 23,
  vino: 23,
  jedlo: 5,
});

// === DOM helpers (scoped to container) ===
function qs(sel) { return _container.querySelector(sel); }
function qsAll(sel) { return _container.querySelectorAll(sel); }
function byId(id) { return _container.querySelector('#' + id); }

// === Helpers ===
function fmt(n) { return n.toFixed(2).replace('.', ',') + ' \u20AC'; }
function getCat(id) { return MENU_DATA.find(c => c.id === id); }
function getActiveCat() { return getCat(activeCatId); }
function normalizeText(value) { return String(value || '').trim().toLowerCase(); }
function isSupportedVatRate(value) { return SUPPORTED_VAT_RATES.includes(Number(value)); }
function inferVatRateForForm(categoryId, productName) {
  const category = getCat(Number(categoryId)) || MENU_DATA.find(c => String(c.id) === String(categoryId));
  const slug = normalizeText(category && category.slug);
  const name = normalizeText(productName);
  if (slug === 'pivo' && /nealko|nealkohol|0[,.]0|alkohol\s*free/.test(name)) return 19;
  return CATEGORY_VAT_DEFAULTS[slug] || 23;
}
function normalizeVatRate(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 23;
}
function formatVatRate(v) {
  const n = normalizeVatRate(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
function normalizeMenuData(menu) {
  return menu.map(function(cat) {
    return {
      ...cat,
      items: (cat.items || []).map(function(item) {
        const active = item.available !== undefined ? item.available : (item.active !== undefined ? item.active : true);
        return {
          ...item,
          active: active,
          available: active,
          vatRate: normalizeVatRate(item.vatRate),
        };
      }),
    };
  });
}
function syncVatRateSuggestion(force) {
  if (!force && vatRateTouched) return;
  const categoryId = byId('fCategory') ? byId('fCategory').value : activeCatId;
  const productName = byId('fName') ? byId('fName').value : '';
  formVatRate = inferVatRateForForm(categoryId, productName);
  if (byId('fVatRate')) byId('fVatRate').value = String(formVatRate);
}

// === Prompt modal (not available globally in admin SPA) ===
function showPrompt(title, placeholder, onSubmit, opts) {
  opts = opts || {};
  const existing = document.getElementById('dynModal');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.className = 'u-overlay'; ov.id = 'dynModal';
  ov.innerHTML = '<div class="u-modal"><span class="u-modal-icon">' + (opts.icon || '\u270F\uFE0F') +
    '</span><div class="u-modal-title">' + title +
    '</div><div class="u-modal-body"><div class="u-modal-field"><input type="text" id="dynInput" placeholder="' +
    (placeholder || '') + '" value="' + (opts.defaultValue || '') +
    '"></div></div><div class="u-modal-btns"><button class="u-btn u-btn-ghost" id="dynCancel">Zrusit</button><button class="u-btn u-btn-ice" id="dynOk">' +
    (opts.confirmText || 'Potvrdit') + '</button></div></div>';
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
  setTimeout(() => document.getElementById('dynInput').focus(), 100);
  function close() { ov.classList.remove('show'); setTimeout(() => ov.remove(), 300); }
  document.getElementById('dynCancel').onclick = close;
  document.getElementById('dynOk').onclick = function () {
    const v = document.getElementById('dynInput').value; close(); if (onSubmit) onSubmit(v);
  };
  document.getElementById('dynInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('dynOk').click(); }
  });
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
}

// === Load menu data ===
async function loadMenu() {
  const catList = byId('catList');
  const prodList = byId('prodList');
  if (catList) showLoading(catList, 'Nacitavam menu...');
  try {
    const menu = await api.get('/menu');
    if (catList) hideLoading(catList);
    MENU_DATA = normalizeMenuData(menu);
    if (MENU_DATA.length > 0 && !activeCatId) {
      activeCatId = MENU_DATA[0].id;
    }
    renderCategories();
    renderProducts();
    if (MENU_DATA.length === 0) {
      if (catList) catList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83D\uDCC2</div><div class="empty-state-title">Ziadne kategorie</div><div class="empty-state-text">Vytvorte prvu kategoriu pre vase menu</div><button class="btn-outline-accent" onclick="document.getElementById(\'addCatBtn\').click()">Pridat kategoriu</button></div>';
      if (prodList) prodList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83D\uDCE6</div><div class="empty-state-title">Ziadne produkty</div><div class="empty-state-text">Najprv pridajte kategoriu</div></div>';
    }
  } catch (err) {
    if (catList) hideLoading(catList);
    renderError(catList, err.message || 'Chyba pri nacitani menu', loadMenu);
  }
}

// === Categories ===
function renderCategories() {
  const list = byId('catList');
  list.innerHTML = MENU_DATA.map((cat, i) => `
    <button class="cat-item ${cat.id === activeCatId ? 'active' : ''}" data-cat-idx="${i}" type="button">
      <span class="cat-drag-handle">\u22EE\u22EE</span>
      <span class="cat-icon">${cat.icon}</span>
      <div class="cat-info">
        <div class="cat-name">${cat.label}</div>
        <div class="cat-count">${cat.items.length} poloziek</div>
      </div>
    </button>
  `).join('');

  list.querySelectorAll('.cat-item').forEach((el, i) => {
    el.addEventListener('click', () => selectCategory(MENU_DATA[i].id));
    el.addEventListener('mousedown', (e) => startCatDrag(e, i));
  });
}

function selectCategory(id) {
  activeCatId = id;
  renderCategories();
  renderProducts();
}

// === Category drag & drop ===
function startCatDrag(e, idx) {
  if (e.button !== 0) return;
  const handle = e.target.closest('.cat-drag-handle');
  if (!handle) return;
  e.preventDefault();
  catDragIdx = idx;
  catDragEl = e.currentTarget;
  catDragEl.classList.add('dragging');
  document.addEventListener('mousemove', onCatDrag);
  document.addEventListener('mouseup', endCatDrag);
}

function onCatDrag(e) {
  if (catDragIdx === null) return;
  const list = byId('catList');
  const items = list.querySelectorAll('.cat-item');
  items.forEach((item, i) => {
    if (i === catDragIdx) return;
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    item.classList.toggle('drag-over', e.clientY < mid && e.clientY > rect.top - 10);
  });
}

function endCatDrag() {
  document.removeEventListener('mousemove', onCatDrag);
  document.removeEventListener('mouseup', endCatDrag);
  if (catDragIdx === null) return;
  const list = byId('catList');
  const items = list.querySelectorAll('.cat-item');
  let targetIdx = catDragIdx;
  items.forEach((item, i) => {
    if (item.classList.contains('drag-over')) { targetIdx = i; }
    item.classList.remove('drag-over');
  });
  if (targetIdx !== catDragIdx) {
    const moved = MENU_DATA.splice(catDragIdx, 1)[0];
    MENU_DATA.splice(targetIdx, 0, moved);
  }
  if (catDragEl) catDragEl.classList.remove('dragging');
  catDragIdx = null; catDragEl = null;
  renderCategories();
}

const CATEGORY_EMOJI_SUGGESTIONS = [
  '\u2615', '\uD83C\uDF75', '\uD83C\uDF79', '\uD83C\uDF7A', '\uD83C\uDF77', '\uD83E\uDD42', '\uD83C\uDF7E',
  '\uD83E\uDD43', '\uD83E\uDD5B', '\uD83E\uDDC3', '\uD83C\uDF7C', '\uD83C\uDF76', '\uD83E\uDD64', '\uD83E\uDD5A',
  '\uD83C\uDF54', '\uD83C\uDF55', '\uD83C\uDF2E', '\uD83C\uDF2F', '\uD83E\uDD6A', '\uD83C\uDF2D', '\uD83C\uDF57',
  '\uD83C\uDF5F', '\uD83E\uDD57', '\uD83E\uDDC0', '\uD83E\uDD69', '\uD83C\uDF73', '\uD83E\uDD58', '\uD83C\uDF72',
  '\uD83C\uDF5B', '\uD83C\uDF59', '\uD83C\uDF71', '\uD83C\uDF5C', '\uD83C\uDF5D', '\uD83C\uDF5A', '\uD83C\uDF61',
  '\uD83C\uDF70', '\uD83C\uDF6E', '\uD83C\uDF6D', '\uD83C\uDF6A', '\uD83C\uDF6B', '\uD83C\uDF66', '\uD83C\uDF68', '\uD83C\uDF67',
  '\uD83C\uDF4E', '\uD83C\uDF4A', '\uD83C\uDF4B', '\uD83C\uDF49', '\uD83C\uDF47', '\uD83C\uDF53', '\uD83C\uDF52',
  '\uD83E\uDD6B', '\uD83C\uDF7D', '\uD83E\uDDC1', '\uD83E\uDDC2', '\uD83E\uDD64', '\uD83C\uDF78',
];

function openCategoryModal(mode, initial) {
  const existing = document.getElementById('catModal');
  if (existing) existing.remove();

  const current = initial || {};
  const initialIcon = current.icon || '\uD83C\uDF7D';
  const initialLabel = current.label || '';
  const initialDest = current.dest || 'bar';

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'catModal';

  const emojiGrid = CATEGORY_EMOJI_SUGGESTIONS.map(function (e) {
    const active = e === initialIcon ? ' active' : '';
    return '<button type="button" class="emoji-pick' + active + '" data-emoji="' + e + '">' + e + '</button>';
  }).join('');

  ov.innerHTML = ''
    + '<div class="u-modal" style="text-align:left;max-width:520px">'
    + '<div class="u-modal-title" style="text-align:center">' + (mode === 'edit' ? 'Upravit kategoriu' : 'Nova kategoria') + '</div>'
    + '<div class="u-modal-body" style="gap:14px">'
    + '<div class="u-modal-field">'
    + '<label for="fCatName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fCatName" type="text" placeholder="napr. Dezerty" data-validate="required" value="' + String(initialLabel || '').replace(/"/g, '&quot;') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label>Emoji ikona</label>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
    + '<span id="fCatIconPreview" style="font-size:32px;line-height:1;width:48px;height:48px;display:inline-flex;align-items:center;justify-content:center;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">' + initialIcon + '</span>'
    + '<input id="fCatIcon" type="text" maxlength="4" value="' + initialIcon + '" style="width:120px;text-align:center;font-size:20px" placeholder="\uD83C\uDF7D">'
    + '<div class="text-muted" style="font-size:12px;line-height:1.3">Klikni na ikonu nizsie alebo zadaj vlastne emoji.</div>'
    + '</div>'
    + '<div id="fCatEmojiGrid" style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;max-height:220px;overflow-y:auto;padding:8px;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">' + emojiGrid + '</div>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fCatDest">Kam sa tlacia polozky</label>'
    + '<select id="fCatDest">'
    + '<option value="bar"' + (initialDest === 'bar' ? ' selected' : '') + '>Bar</option>'
    + '<option value="kuchyna"' + (initialDest === 'kuchyna' ? ' selected' : '') + '>Kuchyna</option>'
    + '<option value="all"' + (initialDest === 'all' ? ' selected' : '') + '>Vsetko (bar aj kuchyna)</option>'
    + '</select>'
    + '</div>'
    + '</div>'
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="catCancel">Zrusit</button>'
    + '<button class="u-btn u-btn-ice" id="catSave">' + (mode === 'edit' ? 'Ulozit' : 'Pridat') + '</button>'
    + '</div>'
    + '<style>.emoji-pick{font-size:22px;line-height:1;padding:6px;border:1px solid transparent;background:transparent;border-radius:var(--radius-xs);cursor:pointer;transition:all .1s ease}.emoji-pick:hover{background:rgba(139,124,246,.1);border-color:var(--color-accent)}.emoji-pick.active{background:rgba(139,124,246,.2);border-color:var(--color-accent);transform:scale(1.1)}</style>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  const closeModal = function () {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 300);
  };

  const iconInput = ov.querySelector('#fCatIcon');
  const iconPreview = ov.querySelector('#fCatIconPreview');
  const grid = ov.querySelector('#fCatEmojiGrid');

  function setIcon(emoji) {
    iconInput.value = emoji;
    iconPreview.textContent = emoji || '\uD83C\uDF7D';
    grid.querySelectorAll('.emoji-pick').forEach(function (b) {
      b.classList.toggle('active', b.dataset.emoji === emoji);
    });
  }

  grid.addEventListener('click', function (e) {
    const btn = e.target.closest('.emoji-pick');
    if (!btn) return;
    setIcon(btn.dataset.emoji);
  });

  iconInput.addEventListener('input', function () {
    const value = iconInput.value.trim();
    iconPreview.textContent = value || '\uD83C\uDF7D';
    grid.querySelectorAll('.emoji-pick').forEach(function (b) {
      b.classList.toggle('active', b.dataset.emoji === value);
    });
  });

  ov.querySelector('#catCancel').onclick = closeModal;
  ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });

  const saveBtn = ov.querySelector('#catSave');
  saveBtn.addEventListener('click', async function () {
    if (!validateForm(ov)) return;
    const label = ov.querySelector('#fCatName').value.trim();
    const icon = (iconInput.value || '').trim() || '\uD83C\uDF7D';
    const dest = ov.querySelector('#fCatDest').value || 'bar';
    if (!label) {
      showToast('Zadaj nazov kategorie', 'error');
      return;
    }
    btnLoading(saveBtn);
    try {
      if (mode === 'edit' && current.id) {
        await api.put('/menu/categories/' + current.id, { label: label, icon: icon, dest: dest });
        showToast('Kategoria upravena', true);
      } else {
        const slug = 'cat_' + Date.now();
        const created = await api.post('/menu/categories', {
          slug: slug, label: label, icon: icon, sortKey: String(MENU_DATA.length), dest: dest,
        });
        activeCatId = (created && created.id) || slug;
        showToast('Kategoria pridana', true);
      }
      closeModal();
      await loadMenu();
    } catch (err) {
      btnReset(saveBtn);
      showToast(err.message || 'Chyba ulozenia', 'error');
    }
  });

  setTimeout(function () {
    const el = ov.querySelector('#fCatName');
    if (el) el.focus();
  }, 80);
}

function addCategory() {
  openCategoryModal('add', null);
}

// ==== Product emoji picker ====
// Pozn.: kľúčové slová sú po slovensky aj anglicky, aby hľadanie fungovalo prirodzene.
const PRODUCT_EMOJI_PALETTE = [
  { e: '\u2615', k: 'kava espresso coffee hot' },
  { e: '\uD83C\uDF75', k: 'caj tea' },
  { e: '\uD83E\uDDC9', k: 'mate yerba' },
  { e: '\uD83E\uDD64', k: 'kokktail smoothie' },
  { e: '\uD83C\uDF79', k: 'koktail koktejl cocktail tropical' },
  { e: '\uD83C\uDF78', k: 'koktail martini cocktail' },
  { e: '\uD83E\uDD43', k: 'whisky tumbler rum bourbon alkohol' },
  { e: '\uD83C\uDF7E', k: 'sekt champagne prosecco sampan' },
  { e: '\uD83C\uDF77', k: 'vino cervene vino wine' },
  { e: '\uD83E\uDD42', k: 'vino biele sparkling wine' },
  { e: '\uD83C\uDF7A', k: 'pivo beer' },
  { e: '\uD83C\uDF7B', k: 'pivo cheers tost' },
  { e: '\uD83E\uDD6B', k: 'radler pivo mix' },
  { e: '\uD83E\uDD5B', k: 'mlieko milk' },
  { e: '\uD83E\uDDC3', k: 'dzus juice pomaranc orange' },
  { e: '\uD83E\uDD64', k: 'limonada lemon soda kokteil' },
  { e: '\uD83C\uDF76', k: 'sake liquor' },
  { e: '\uD83C\uDF54', k: 'burger hamburger' },
  { e: '\uD83C\uDF55', k: 'pizza' },
  { e: '\uD83C\uDF2D', k: 'hotdog parky' },
  { e: '\uD83C\uDF2E', k: 'taco' },
  { e: '\uD83C\uDF2F', k: 'burrito quesadilla tortilla' },
  { e: '\uD83E\uDD6A', k: 'sendvic sandwich bageta' },
  { e: '\uD83E\uDDC7', k: 'waffle' },
  { e: '\uD83C\uDF57', k: 'kurca chicken' },
  { e: '\uD83C\uDF56', k: 'maso meat' },
  { e: '\uD83C\uDF5F', k: 'hranolky fries potato' },
  { e: '\uD83E\uDD57', k: 'salat salad zdrave' },
  { e: '\uD83E\uDDC0', k: 'syr cheese' },
  { e: '\uD83E\uDD69', k: 'steak' },
  { e: '\uD83E\uDD58', k: 'polievka soup' },
  { e: '\uD83C\uDF72', k: 'polievka pot hot' },
  { e: '\uD83C\uDF73', k: 'vajce egg fried' },
  { e: '\uD83E\uDD5A', k: 'vajce egg chocolate' },
  { e: '\uD83C\uDF5B', k: 'ryza rice bowl' },
  { e: '\uD83C\uDF5C', k: 'polievka ramen noodles' },
  { e: '\uD83C\uDF5D', k: 'spaghetti cestoviny pasta' },
  { e: '\uD83C\uDF5A', k: 'ryza rice' },
  { e: '\uD83C\uDF59', k: 'sushi rice' },
  { e: '\uD83C\uDF71', k: 'bento' },
  { e: '\uD83C\uDF61', k: 'onigiri rice ball' },
  { e: '\uD83C\uDF70', k: 'dort tortu cake strawberry' },
  { e: '\uD83C\uDF82', k: 'torta narodeniny birthday' },
  { e: '\uD83C\uDF6E', k: 'flan pudding creme brulee' },
  { e: '\uD83C\uDF6D', k: 'cukor candy lollipop' },
  { e: '\uD83C\uDF6A', k: 'cookie susienka' },
  { e: '\uD83C\uDF69', k: 'donut' },
  { e: '\uD83C\uDF6B', k: 'cokolada chocolate' },
  { e: '\uD83C\uDF66', k: 'zmrzlina ice cream vanilla' },
  { e: '\uD83C\uDF68', k: 'zmrzlina ice cream cup' },
  { e: '\uD83C\uDF67', k: 'shaved ice' },
  { e: '\uD83E\uDD67', k: 'pie kolac' },
  { e: '\uD83C\uDF4E', k: 'jablko apple ovocie fruit' },
  { e: '\uD83C\uDF4A', k: 'pomaranc orange citrus' },
  { e: '\uD83C\uDF4B', k: 'citron lemon citrus' },
  { e: '\uD83C\uDF49', k: 'melon watermelon' },
  { e: '\uD83C\uDF47', k: 'hrozno grapes' },
  { e: '\uD83C\uDF53', k: 'jahoda strawberry' },
  { e: '\uD83C\uDF52', k: 'cheresne cherry' },
  { e: '\uD83C\uDF4C', k: 'banan banana' },
  { e: '\uD83E\uDD6D', k: 'mango' },
  { e: '\uD83C\uDF4D', k: 'ananas pineapple' },
  { e: '\uD83E\uDD5D', k: 'kivi kiwi' },
  { e: '\uD83E\uDD65', k: 'kokos coconut' },
  { e: '\uD83E\uDD50', k: 'chlieb croissant' },
  { e: '\uD83C\uDF5E', k: 'chlieb bread baguette' },
  { e: '\uD83E\uDD56', k: 'bageta baguette' },
  { e: '\uD83E\uDD68', k: 'precle pretzel' },
  { e: '\uD83E\uDDC8', k: 'maslo butter' },
  { e: '\uD83E\uDDC2', k: 'sol salt pepper korenie' },
  { e: '\uD83C\uDF36', k: 'paprika chili korenie spicy' },
  { e: '\uD83E\uDDC4', k: 'cesnak garlic' },
  { e: '\uD83E\uDDC5', k: 'cibula onion' },
  { e: '\uD83C\uDF45', k: 'paradajky tomato bruschetta' },
  { e: '\uD83C\uDF46', k: 'baklazan eggplant' },
  { e: '\uD83E\uDD6C', k: 'salat lettuce' },
  { e: '\uD83E\uDD50', k: 'ovocie fruit croissant' },
  { e: '\uD83C\uDF7C', k: 'pitie baby milk' },
  { e: '\uD83E\uDDCB', k: 'bubble tea' },
  { e: '\uD83C\uDF7D', k: 'tanier plate' },
  { e: '\uD83E\uDDC1', k: 'cupcake muffin' },
  { e: '\uD83C\uDF2B', k: 'dym para' },
  { e: '\uD83D\uDCE6', k: 'balik box supply tovar' },
  { e: '\uD83E\uDDFB', k: 'papier toilet paper tovar' },
  { e: '\uD83E\uDDFC', k: 'mydlo soap tovar' },
  { e: '\uD83E\uDDFA', k: 'taska bag bag tovar' },
];

function renderProductEmojiGrid(filter) {
  const grid = byId('fEmojiGrid');
  if (!grid) return;
  const query = String(filter || '').trim().toLowerCase();
  const list = query
    ? PRODUCT_EMOJI_PALETTE.filter(item => item.k.indexOf(query) !== -1)
    : PRODUCT_EMOJI_PALETTE;
  grid.innerHTML = list.map(item => (
    '<button type="button" class="prod-emoji-pick" data-emoji="' + item.e + '" title="' + item.k + '" ' +
    'style="font-size:22px;line-height:1;padding:6px;border:1px solid transparent;background:transparent;border-radius:var(--radius-xs);cursor:pointer">' +
    item.e + '</button>'
  )).join('');
}

function wireProductEmojiPicker() {
  const btn = byId('fEmojiPickBtn');
  const wrap = byId('fEmojiGridWrap');
  const grid = byId('fEmojiGrid');
  const search = byId('fEmojiSearch');
  const close = byId('fEmojiClose');
  const input = byId('fEmoji');
  if (!btn || !wrap || !grid || !input) return;

  btn.addEventListener('click', function () {
    if (wrap.style.display === 'none' || !wrap.style.display) {
      renderProductEmojiGrid(search ? search.value : '');
      wrap.style.display = 'block';
      if (search) setTimeout(function () { search.focus(); }, 30);
    } else {
      wrap.style.display = 'none';
    }
  });
  if (close) close.addEventListener('click', function () { wrap.style.display = 'none'; });
  if (search) search.addEventListener('input', function () { renderProductEmojiGrid(search.value); });
  grid.addEventListener('click', function (e) {
    const b = e.target.closest('.prod-emoji-pick');
    if (!b) return;
    input.value = b.dataset.emoji;
    wrap.style.display = 'none';
    input.focus();
  });
}

// === Products ===
function renderProducts() {
  const cat = getActiveCat();
  const prodTitle = byId('prodTitle');
  const prodList = byId('prodList');
  if (!cat) { prodList.innerHTML = ''; prodTitle.textContent = ''; return; }
  prodTitle.textContent = cat.icon + ' ' + cat.label;
  if (!cat.items.length) {
    prodList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83D\uDCE6</div><div class="empty-state-title">Ziadne produkty</div><div class="empty-state-text">Pridajte prvy produkt do tejto kategorie</div><button class="btn-outline-accent" onclick="document.getElementById(\'addProdBtn\').click()">Pridat produkt</button></div>';
    return;
  }
  prodList.innerHTML = cat.items.map((item, i) => `
    <div class="prod-row" data-prod-idx="${i}">
      <span class="prod-drag">\u22EE\u22EE</span>
      <span class="prod-emoji">${item.emoji}</span>
      <div class="prod-info">
        <div class="prod-name">${item.name}</div>
        <div class="prod-desc">${item.desc}</div>
        <div style="font-size:12px;color:var(--color-text-sec);margin-top:4px">DPH ${formatVatRate(item.vatRate)}%</div>
      </div>
      <div class="prod-price">${fmt(item.price)}</div>
      <div class="toggle-wrap">
        <div class="toggle ${(item.available !== undefined ? item.available : item.active) ? 'on' : ''}" data-item-id="${item.id}"><div class="toggle-knob"></div></div>
      </div>
      <div class="prod-actions">
        <button class="act-btn" data-edit-id="${item.id}" title="Upravit">
          <svg viewBox="0 0 16 16"><path d="M12.1 1.3a1.5 1.5 0 012.1 2.1L5.8 11.8l-3.3.8.8-3.3z"/></svg>
        </button>
        <button class="act-btn del" data-del-id="${item.id}" title="Odstranit">
          <svg viewBox="0 0 16 16"><path d="M5 2V1h6v1h4v2H1V2h4zm0 4v7h6V6H5zm-3 9h12V5H2v10z"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  // Bind events
  prodList.querySelectorAll('.prod-row').forEach((el, i) => {
    el.addEventListener('mousedown', (e) => startProdDrag(e, i));
  });
  prodList.querySelectorAll('.toggle').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleAvail(Number(el.dataset.itemId)); });
  });
  prodList.querySelectorAll('[data-edit-id]').forEach(el => {
    el.addEventListener('click', () => openEditProduct(Number(el.dataset.editId)));
  });
  prodList.querySelectorAll('[data-del-id]').forEach(el => {
    el.addEventListener('click', () => deleteProduct(Number(el.dataset.delId)));
  });
}

// === Product drag & drop ===
function startProdDrag(e, idx) {
  if (e.button !== 0) return;
  const handle = e.target.closest('.prod-drag');
  if (!handle) return;
  e.preventDefault();
  prodDragIdx = idx;
  prodDragEl = e.currentTarget;
  prodDragEl.classList.add('dragging');
  document.addEventListener('mousemove', onProdDrag);
  document.addEventListener('mouseup', endProdDrag);
}

function onProdDrag(e) {
  if (prodDragIdx === null) return;
  const list = byId('prodList');
  const items = list.querySelectorAll('.prod-row');
  items.forEach((item, i) => {
    if (i === prodDragIdx) return;
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    item.classList.toggle('drag-over', e.clientY < mid && e.clientY > rect.top - 10);
  });
}

function endProdDrag() {
  document.removeEventListener('mousemove', onProdDrag);
  document.removeEventListener('mouseup', endProdDrag);
  if (prodDragIdx === null) return;
  const cat = getActiveCat();
  const list = byId('prodList');
  const items = list.querySelectorAll('.prod-row');
  let targetIdx = prodDragIdx;
  items.forEach((item, i) => {
    if (item.classList.contains('drag-over')) { targetIdx = i; }
    item.classList.remove('drag-over');
  });
  if (targetIdx !== prodDragIdx && cat) {
    const moved = cat.items.splice(prodDragIdx, 1)[0];
    cat.items.splice(targetIdx, 0, moved);
  }
  if (prodDragEl) prodDragEl.classList.remove('dragging');
  prodDragIdx = null; prodDragEl = null;
  renderProducts();
}

async function toggleAvail(id) {
  let targetItem = null;
  MENU_DATA.forEach(cat => {
    cat.items.forEach(item => { if (item.id === id) targetItem = item; });
  });
  if (!targetItem) return;
  try {
    const nextAvailable = !(targetItem.available !== undefined ? targetItem.available : targetItem.active);
    await api.put('/menu/items/' + id, { available: nextAvailable });
    targetItem.available = nextAvailable;
    targetItem.active = nextAvailable;
    renderProducts();
  } catch (err) {
    showToast('Chyba: ' + err.message);
  }
}

// === Product modal ===
function populateCategorySelect() {
  const sel = byId('fCategory');
  sel.innerHTML = MENU_DATA.map(c => `<option value="${c.id}" ${c.id === activeCatId ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('');
}

function openAddProduct() {
  editingProductId = null;
  byId('modalTitle').textContent = 'Pridat produkt';
  byId('fEmoji').value = '';
  byId('fName').value = '';
  byId('fDesc').value = '';
  byId('fPrice').value = '';
  formAvailable = true;
  vatRateTouched = false;
  updateFormToggle();
  populateCategorySelect();
  syncVatRateSuggestion(true);
  const wrap = byId('fEmojiGridWrap');
  if (wrap) wrap.style.display = 'none';
  byId('productModal').classList.add('show');
  setTimeout(() => byId('fName').focus(), 100);
}

function openEditProduct(id) {
  let item = null, catId = null;
  MENU_DATA.forEach(cat => { cat.items.forEach(it => { if (it.id === id) { item = it; catId = cat.id; } }); });
  if (!item) return;
  editingProductId = id;
  byId('modalTitle').textContent = 'Upravit produkt';
  byId('fEmoji').value = item.emoji;
  byId('fName').value = item.name;
  byId('fDesc').value = item.desc;
  byId('fPrice').value = item.price;
  formAvailable = item.available !== undefined ? item.available : item.active;
  formVatRate = normalizeVatRate(item.vatRate);
  vatRateTouched = true;
  updateFormToggle();
  populateCategorySelect();
  byId('fCategory').value = catId;
  byId('fVatRate').value = String(formVatRate);
  byId('productModal').classList.add('show');
  setTimeout(() => byId('fName').focus(), 100);
}

function closeProductModal() {
  byId('productModal').classList.remove('show');
  editingProductId = null;
  vatRateTouched = false;
}

function toggleFormAvail() {
  formAvailable = !formAvailable;
  updateFormToggle();
}

function updateFormToggle() {
  const t = byId('fAvailToggle');
  const l = byId('fAvailLabel');
  t.classList.toggle('on', formAvailable);
  l.textContent = formAvailable ? 'Dostupny' : 'Nedostupny';
}

async function saveProduct() {
  var modalEl = byId('productModal');
  if (modalEl && !validateForm(modalEl)) return;

  const emoji = byId('fEmoji').value.trim() || '\uD83C\uDF7D';
  const name = byId('fName').value.trim();
  const desc = byId('fDesc').value.trim();
  const price = parseFloat(byId('fPrice').value) || 0;
  const vatRate = parseFloat(byId('fVatRate').value);
  const catId = byId('fCategory').value;
  if (!name) { showToast('Zadajte nazov produktu'); return; }
  if (price <= 0) { showToast('Zadajte platnu cenu'); return; }
  if (!isSupportedVatRate(vatRate)) {
    showToast('Portos podporuje iba sadzby DPH 5 %, 19 % a 23 %');
    return;
  }

  const btn = byId('modalSaveBtn');
  if (btn) btnLoading(btn);
  try {
    if (editingProductId !== null) {
      await api.put('/menu/items/' + editingProductId, { name, emoji, price, desc, available: formAvailable, categoryId: catId, vatRate });
      showToast('Produkt upraveny', true);
    } else {
      await api.post('/menu/items', { categoryId: catId, name, emoji, price, desc, available: formAvailable, vatRate });
      showToast('Produkt pridany', true);
    }
    closeProductModal();
    activeCatId = catId;
    await loadMenu();
  } catch (err) {
    showToast(err.message || 'Chyba ukladania produktu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

function deleteProduct(id) {
  let item = null;
  MENU_DATA.forEach(cat => { cat.items.forEach(it => { if (it.id === id) item = it; }); });
  if (!item) return;
  showConfirm('Zmazat', 'Tato akcia sa neda vratit.', async function () {
    try {
      await api.del('/menu/items/' + id);
      await loadMenu();
      showToast('Produkt odstraneny', true);
    } catch (err) {
      showToast('Chyba: ' + err.message);
    }
  }, { type: 'danger' });
}

// === Keyboard handler ===
function onKeydown(e) {
  const dyn = document.getElementById('dynModal');
  if (dyn && dyn.classList.contains('show')) {
    if (e.key === 'Escape') { const cb = document.getElementById('dynCancel'); if (cb) cb.click(); }
    return;
  }
  const modal = byId('productModal');
  if (modal && modal.classList.contains('show')) {
    if (e.key === 'Escape') closeProductModal();
    return;
  }
}

// === EXPORTS ===
export function init(container) {
  _container = container;
  container.className = 'content admin-page-fill';

  // Reset state
  MENU_DATA = [];
  activeCatId = null;
  editingProductId = null;
  formAvailable = true;
  formVatRate = 23;
  vatRateTouched = false;
  catDragIdx = null;
  catDragEl = null;
  prodDragIdx = null;
  prodDragEl = null;

  container.innerHTML = `
    <div class="cat-panel">
      <div class="cat-panel-header">Kategorie <span id="catCount"></span></div>
      <div class="cat-list" id="catList">
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
      </div>
      <button class="cat-add-btn" id="addCatBtn">+ Pridat kategoriu</button>
    </div>
    <div class="prod-panel">
      <div class="prod-header">
        <div class="prod-header-title" id="prodTitle">Polozky</div>
        <button class="prod-add-btn" id="addProdBtn">
          <svg aria-hidden="true" viewBox="0 0 24 24" class="icon-plus"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Pridat
        </button>
      </div>
      <div class="prod-list" id="prodList">
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
      </div>
    </div>
    <!-- Product Modal -->
    <div class="u-overlay" id="productModal">
      <div class="u-modal u-modal-left">
        <div class="u-modal-title text-center" id="modalTitle">Pridat produkt</div>
        <div class="u-modal-body">
          <div class="u-modal-row">
            <div class="u-modal-field field-emoji">
              <label for="fEmoji">Emoji</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input id="fEmoji" type="text" placeholder="napr. &#9749;" maxlength="4" class="input-emoji" style="flex:1;text-align:center;font-size:20px">
                <button type="button" id="fEmojiPickBtn" class="u-btn u-btn-ghost" style="padding:6px 10px;font-size:18px" title="Vybrat emoji">\u{1F642}</button>
              </div>
            </div>
            <div class="u-modal-field field-flex-3">
              <label for="fName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>
              <input id="fName" type="text" placeholder="Nazov produktu" aria-required="true" data-validate="required">
            </div>
          </div>
          <div id="fEmojiGridWrap" style="display:none;margin:-8px 0 6px;padding:8px;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <input id="fEmojiSearch" type="text" placeholder="Hladaj (kava, pivo, jedlo...)" class="form-input form-input-sm" style="flex:1">
              <button type="button" class="act-btn" id="fEmojiClose" title="Zavriet" style="margin-left:6px">\u2715</button>
            </div>
            <div id="fEmojiGrid" style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;max-height:200px;overflow-y:auto"></div>
          </div>
          <div class="u-modal-field">
            <label for="fDesc">Popis</label>
            <input id="fDesc" type="text" placeholder="Kratky popis">
          </div>
          <div class="u-modal-row">
            <div class="u-modal-field">
              <label for="fPrice">Cena (EUR)<span class="required-mark" aria-hidden="true"> *</span></label>
              <input id="fPrice" type="number" aria-required="true" data-validate="required|number" step="0.10" min="0" placeholder="0.00">
            </div>
            <div class="u-modal-field">
              <label for="fCategory">Kategoria</label>
              <select id="fCategory"></select>
            </div>
          </div>
          <div class="u-modal-field">
            <label for="fVatRate">DPH sadzba (%)</label>
            <select id="fVatRate">
              <option value="5">5 % - jedlo</option>
              <option value="19">19 % - nealko napoje</option>
              <option value="23">23 % - alkohol</option>
            </select>
          </div>
          <div class="u-modal-field">
            <label>Dostupnost</label>
            <div class="u-toggle" id="fAvailToggleWrap">
              <div class="u-toggle-track on" id="fAvailToggle"><div class="u-toggle-knob"></div></div>
              <span class="u-toggle-label" id="fAvailLabel">Dostupny</span>
            </div>
          </div>
        </div>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="modalCancelBtn">Zrusit</button>
          <button class="u-btn u-btn-ice" id="modalSaveBtn">Ulozit</button>
        </div>
      </div>
    </div>
  `;

  // Bind button events
  byId('addCatBtn').addEventListener('click', addCategory);
  byId('addProdBtn').addEventListener('click', openAddProduct);
  byId('modalCancelBtn').addEventListener('click', closeProductModal);
  byId('modalSaveBtn').addEventListener('click', saveProduct);
  wireProductEmojiPicker();
  byId('fAvailToggleWrap').addEventListener('click', toggleFormAvail);
  byId('productModal').addEventListener('click', function (e) { if (e.target === this) closeProductModal(); });
  byId('fCategory').addEventListener('change', function () { syncVatRateSuggestion(false); });
  byId('fName').addEventListener('input', function () { syncVatRateSuggestion(false); });
  byId('fVatRate').addEventListener('change', function () {
    vatRateTouched = true;
    formVatRate = normalizeVatRate(this.value);
  });

  // Inline validation listeners
  container.querySelectorAll('[data-validate]').forEach(function(input) {
    input.addEventListener('blur', function() {
      var rules = this.getAttribute('data-validate').split('|');
      var self = this;
      rules.forEach(function(rule) { validateField(self, rule); });
    });
    input.addEventListener('input', function() { clearFieldError(this); });
  });

  // Global keyboard handler
  document.addEventListener('keydown', onKeydown);

  // Load data
  loadMenu();
}

export function destroy() {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mousemove', onCatDrag);
  document.removeEventListener('mouseup', endCatDrag);
  document.removeEventListener('mousemove', onProdDrag);
  document.removeEventListener('mouseup', endProdDrag);
  // Remove any lingering dynamic modals created by this module
  const dyn = document.getElementById('dynModal');
  if (dyn) dyn.remove();
  _container = null;
  formVatRate = 23;
  vatRateTouched = false;
}
