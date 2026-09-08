import { softDelete } from '../components/toast-undo.js';
import { mountEmptyState } from '../components/empty-state.js';
import { fmtCost } from '../../components/fmt.js';

// Escapovanie: jediná implementácia je /js/pos-escape.js (načítaná v
// admin/index.html). Táto stránka predtým NEescapovala vôbec nič — názov
// kategórie / produktu / stola / suroviny / zamestnanca ide z DB rovno do
// innerHTML, takže čokoľvek, čo si manažér uloží ako názov, sa v admine
// vykoná ako HTML (CSP má 'unsafe-inline', takže aj ako skript).
function escapeHtml(v) {
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


let MENU_DATA = [];
let activeCatId = null;
let editingProductId = null;
let formAvailable = true;
let formVatRate = 23;
let vatRateTouched = false;
let companionTouched = false;
// Photo upload state for the product modal:
//   pendingImage  — data URL chosen by user, pending POST after Uložiť
//   currentImage  — already-saved image_url shown in preview when editing
//   clearImage    — true when the user clicked Zmazať on an existing photo
let pendingImage = null;
let currentImage = null;
let clearImage = false;
let catDragIdx = null;
let catDragEl = null;
let prodDragIdx = null;
let prodDragEl = null;
let _container = null;

const SUPPORTED_VAT_RATES = [5, 19, 23];
// MUSI ostat zrkadlom server/lib/menu-vat.js (inferVatRateForCategorySlug).
// Ked sa rozidu, klient predvyplni inu sadzbu, nez server ulozi.
const CATEGORY_VAT_DEFAULTS = Object.freeze({
  kava: 19,
  caj: 19,
  nealko: 19,
  koktaily: 23,
  pivo: 23,
  vino: 23,
  sekt: 23,
  destilaty: 23,
  jedlo: 5,
});

// === DOM helpers (scoped to container) ===
function qs(sel) { return _container.querySelector(sel); }
function qsAll(sel) { return _container.querySelectorAll(sel); }
function byId(id) { return _container.querySelector('#' + id) || document.getElementById(id); }

// === Helpers ===
function fmt(n) { return fmtCost(n) + ' \u20AC'; }
function itemsWord(n) { return n === 1 ? 'položka' : (n >= 2 && n <= 4 ? 'položky' : 'položiek'); }
function catsWord(n) { return n === 1 ? 'kategória' : (n >= 2 && n <= 4 ? 'kategórie' : 'kategórií'); }
function updateMenuCount() {
  const el = byId('menuCount');
  if (!el) return;
  const total = MENU_DATA.reduce((a, c) => a + c.items.length, 0);
  const off = MENU_DATA.reduce((a, c) => a + c.items.filter((i) => !(i.available !== undefined ? i.available : i.active)).length, 0);
  el.textContent = total + ' ' + itemsWord(total) + ' · ' + MENU_DATA.length + ' ' + catsWord(MENU_DATA.length)
    + (off ? ' · ' + off + (off === 1 ? ' nedostupná' : ' nedostupných') : '');
}
function getCat(id) { return MENU_DATA.find(c => c.id === id); }
function getActiveCat() { return getCat(activeCatId); }
function normalizeText(value) { return String(value || '').trim().toLowerCase(); }
function isSupportedVatRate(value) { return SUPPORTED_VAT_RATES.includes(Number(value)); }
function findCategory(categoryId) {
  return getCat(Number(categoryId)) || MENU_DATA.find(c => String(c.id) === String(categoryId)) || null;
}
// Predvolena DPH kategorie (menu_categories.default_vat_rate). null = manazer
// ju este nezvolil — vtedy sa padne na hardcoded mapu slugov.
function categoryDefaultVatRate(category) {
  if (!category) return null;
  const n = parseFloat(category.defaultVatRate);
  return Number.isFinite(n) ? n : null;
}
// Vracia navrhovanu sadzbu alebo NULL, ked ju nevieme odvodit. Ziadny tichy
// fallback na 23 % — nove kategorie maju slug `cat_<timestamp>`, ktory ziadna
// mapa nepozna, a jedlo (5 %) by sa tak ticho fiskalizovalo s 23 %.
// Poradie musi sediet so server/lib/menu-vat.js: nealko pivo -> defaultVatRate
// kategorie -> mapa slugov.
function inferVatRateForForm(categoryId, productName) {
  const category = findCategory(categoryId);
  const slug = normalizeText(category && category.slug);
  const name = normalizeText(productName);
  if (slug === 'pivo' && /nealko|nealkohol|0[,.]0|alkohol\s*free/.test(name)) return 19;
  const explicit = categoryDefaultVatRate(category);
  if (explicit !== null) return explicit;
  const mapped = CATEGORY_VAT_DEFAULTS[slug];
  return mapped === undefined ? null : mapped;
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
  const categoryId = byId('fCategory') ? byId('fCategory').value : activeCatId;
  const productName = byId('fName') ? byId('fName').value : '';
  const inferred = inferVatRateForForm(categoryId, productName);
  // Novej polozke sadzbu predvyplnime. Pri UPRAVE existujucej ju nikdy ticho
  // neprepiseme (moze ist o vedomy override, napr. nealko pivo 19 %) — namiesto
  // toho vykreslime varovanie s tlacidlom „Pouzit X %".
  const autofill = force || (editingProductId === null && !vatRateTouched);
  if (autofill) {
    formVatRate = inferred;
    if (byId('fVatRate')) byId('fVatRate').value = inferred === null ? '' : String(inferred);
  }
  renderVatRateHint(inferred);
}

// Inline hlaska pod selectom DPH: bud „kategoria nema sadzbu — vyber rucne",
// alebo nesulad polozky s kategoriou + jednoklikova oprava.
function renderVatRateHint(inferred) {
  const host = byId('fVatRateHint');
  if (!host) return;
  const sel = byId('fVatRate');
  const current = sel ? parseFloat(sel.value) : NaN;

  function hide() { host.style.display = 'none'; host.innerHTML = ''; }

  if (inferred === null) {
    if (Number.isFinite(current)) return hide();
    host.style.display = '';
    host.innerHTML = '<span style="color:var(--color-warning-strong)">Kategória nemá predvolenú DPH — vyber sadzbu ručne.</span>';
    return;
  }
  if (!Number.isFinite(current) || current === inferred) return hide();

  const category = findCategory(byId('fCategory') ? byId('fCategory').value : activeCatId);
  const catLabel = (category && (category.label || category.slug)) || 'Kategória';
  host.style.display = '';
  host.innerHTML = '<span style="color:var(--color-warning-strong)">Kategória ' + escapeHtml(catLabel)
    + ' očakáva ' + formatVatRate(inferred) + ' %, položka má ' + formatVatRate(current) + ' %.</span>'
    + '<button type="button" id="fVatRateApply" class="u-btn u-btn-ghost" data-vat-apply="' + formatVatRate(inferred) + '"'
    + ' style="margin-left:8px;min-height:44px;padding:6px 12px;font-size:12px">Použiť ' + formatVatRate(inferred) + ' %</button>';
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
    '"></div></div><div class="u-modal-btns"><button class="u-btn u-btn-ghost" id="dynCancel">Zrušiť</button><button class="u-btn u-btn-ice" id="dynOk">' +
    (opts.confirmText || 'Potvrdiť') + '</button></div></div>';
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
  if (prodList) showLoading(prodList, 'Načítavam menu…');
  try {
    const menu = await api.get('/menu');
    if (prodList) hideLoading(prodList);
    MENU_DATA = normalizeMenuData(menu);
    if (MENU_DATA.length > 0 && !activeCatId) {
      activeCatId = MENU_DATA[0].id;
    }
    updateMenuCount();
    renderCategories();
    renderProducts();
    if (MENU_DATA.length === 0) {
      // Bez kategórie sa produkt nemá kam pridať — jediná zmysluplná akcia je
      // založiť prvú kategóriu, preto je CTA priamo v prázdnom zozname.
      if (catList) catList.innerHTML = '';
      if (prodList) mountEmptyState(prodList, {
        icon: '\uD83D\uDCC2',
        title: 'Zatiaľ žiadne kategórie',
        text: 'Menu sa skladá z kategórií (káva, pivo, jedlo…) a produktov v nich. Začni prvou kategóriou.',
        ctaLabel: 'Pridať kategóriu',
        onCta: addCategory,
      });
    }
  } catch (err) {
    if (prodList) hideLoading(prodList);
    renderError(prodList, err.message || 'Chyba pri načítaní menu', loadMenu);
  }
}

// === Categories ===
// Kategórie sú rad chipov nad zoznamom (na telefóne roluje vbok), nie bočný
// panel, ktorý sa pod 768 px skrýval a manažér sa ku kategóriám nedostal.
// Úprava a mazanie kategórie sú vo formulári kategórie (tlačidlo „Upraviť
// kategóriu" v hlavičke zoznamu), nie na každom chipe.
function renderCategories() {
  const list = byId('catList');
  if (!list) return;
  list.innerHTML = MENU_DATA.map((cat) => {
    const on = cat.id === activeCatId;
    return '<button type="button" class="doch-chip mn-cat' + (on ? ' is-on' : '') + '"'
      + ' data-cat-select="' + cat.id + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
      + '<span class="mn-cat-icon" aria-hidden="true">' + escapeHtml(cat.icon || '') + '</span>'
      + '<span class="mn-cat-label">' + escapeHtml(cat.label) + '</span>'
      + '<span class="mn-cat-n">' + cat.items.length + '</span>'
      + '</button>';
  }).join('');

  list.querySelectorAll('[data-cat-select]').forEach((el) => {
    el.addEventListener('click', () => {
      const cat = findCategory(el.dataset.catSelect);
      if (cat) selectCategory(cat.id);
    });
  });
}

async function deleteCategory(cat) {
  const hasItems = cat.items && cat.items.length > 0;
  if (hasItems) {
    // Cannot delete non-empty category — show error toast, navigate to it.
    showToast('Kategória „' + cat.label + '" obsahuje ' + cat.items.length + ' ' + itemsWord(cat.items.length) + '. Najprv ich zmaž alebo presuň do inej kategórie.', 'error');
    selectCategory(cat.id);
    return;
  }

  // Optimistic remove from MENU_DATA + UI
  const idx = MENU_DATA.findIndex((c) => c.id === cat.id);
  if (idx < 0) return;
  const snapshot = MENU_DATA[idx];
  const wasActive = activeCatId === cat.id;
  MENU_DATA.splice(idx, 1);
  if (wasActive) activeCatId = MENU_DATA.length ? MENU_DATA[0].id : null;
  renderCategories();
  renderItemsForActiveCategory();

  const result = await softDelete({
    label: 'Kategória „' + cat.label + '" zmazaná',
    deleteFn: () => api.del('/menu/categories/' + cat.id),
  });
  if (result.undone) {
    MENU_DATA.splice(idx, 0, snapshot);
    if (wasActive) activeCatId = cat.id;
    renderCategories();
    renderProducts();
    showToast('Vrátené', true);
  } else if (result.error) {
    // Server rejected (e.g. concurrent items added) — restore + show error
    MENU_DATA.splice(idx, 0, snapshot);
    if (wasActive) activeCatId = cat.id;
    renderCategories();
    renderProducts();
  } else {
    // Committed — refresh from server to catch concurrent edits
    await loadMenu();
  }
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
  // Predvolena DPH kategorie. Prazdna hodnota = manazer ju este nezvolil \u2014
  // ulozenie bez vedomej volby nedovolime (slug `cat_<timestamp>` ziadna
  // inferencia nepokryje a polozky by ticho dostali 23 %).
  const initialVat = categoryDefaultVatRate(current);
  const vatOptions = SUPPORTED_VAT_RATES.map(function (rate) {
    const label = rate === 5 ? '5 % – jedlo' : (rate === 19 ? '19 % – nealko nápoje' : rate + ' % – alkohol a ostatné');
    return '<option value="' + rate + '"' + (initialVat === rate ? ' selected' : '') + '>' + label + '</option>';
  }).join('');

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'catModal';

  const emojiGrid = CATEGORY_EMOJI_SUGGESTIONS.map(function (e) {
    const active = e === initialIcon ? ' active' : '';
    return '<button type="button" class="emoji-pick' + active + '" data-emoji="' + e + '">' + e + '</button>';
  }).join('');

  ov.innerHTML = ''
    + '<div class="u-modal" style="text-align:left;max-width:520px">'
    + '<div class="u-modal-title" style="text-align:center">' + (mode === 'edit' ? 'Upraviť kategóriu' : 'Nová kategória') + '</div>'
    + '<div class="u-modal-body" style="gap:14px">'
    + '<div class="u-modal-field">'
    + '<label for="fCatName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<input id="fCatName" type="text" placeholder="napr. Dezerty" data-validate="required" value="' + String(initialLabel || '').replace(/"/g, '&quot;') + '">'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label>Ikona</label>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
    + '<span id="fCatIconPreview" style="font-size:32px;line-height:1;width:48px;height:48px;display:inline-flex;align-items:center;justify-content:center;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">' + initialIcon + '</span>'
    + '<input id="fCatIcon" type="text" maxlength="4" value="' + initialIcon + '" style="width:120px;text-align:center;font-size:20px" placeholder="\uD83C\uDF7D">'
    + '<div class="text-muted" style="font-size:12px;line-height:1.3">Klepni na ikonu nižšie alebo napíš vlastné emoji.</div>'
    + '</div>'
    + '<div id="fCatEmojiGrid" style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;max-height:220px;overflow-y:auto;padding:8px;background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)">' + emojiGrid + '</div>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fCatDest">Kam sa tlačia položky</label>'
    + '<select id="fCatDest">'
    + '<option value="bar"' + (initialDest === 'bar' ? ' selected' : '') + '>Bar</option>'
    + '<option value="kuchyna"' + (initialDest === 'kuchyna' ? ' selected' : '') + '>Kuchyňa</option>'
    + '<option value="all"' + (initialDest === 'all' ? ' selected' : '') + '>Všetko (bar aj kuchyňa)</option>'
    + '</select>'
    + '</div>'
    + '<div class="u-modal-field">'
    + '<label for="fCatVatRate">Predvolená DPH<span class="required-mark" aria-hidden="true"> *</span></label>'
    + '<select id="fCatVatRate" aria-required="true" data-validate="required">'
    + '<option value="">Vyber sadzbu DPH</option>'
    + vatOptions
    + '</select>'
    + '<div class="text-muted" style="font-size:12px;margin-top:6px;line-height:1.4">Predvyplní sa každej novej položke v tejto kategórii. Jednotlivá položka môže mať vlastnú sadzbu (napr. nealko pivo 19 %).</div>'
    + '</div>'
    + '</div>'
    // Zmazanie patrí do formulára kategórie, nie na každý chip v zozname.
    + (mode === 'edit' ? '<button type="button" class="u-btn mn-btn-danger" id="catDelete">Zmazať kategóriu</button>' : '')
    + '<div class="u-modal-btns">'
    + '<button class="u-btn u-btn-ghost" id="catCancel">Zrušiť</button>'
    + '<button class="u-btn u-btn-ice" id="catSave">' + (mode === 'edit' ? 'Uložiť zmeny' : 'Pridať kategóriu') + '</button>'
    + '</div>'
    + '<style>.emoji-pick{font-size:22px;line-height:1;padding:6px;border:1px solid transparent;background:transparent;border-radius:var(--radius-xs);cursor:pointer;transition:all .1s ease}.emoji-pick:hover{background:var(--color-accent-bg);border-color:var(--color-accent)}.emoji-pick.active{background:var(--color-accent-bg-hover);border-color:var(--color-accent);transform:scale(1.1)}</style>'
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
  const delBtn = ov.querySelector('#catDelete');
  if (delBtn) {
    delBtn.addEventListener('click', function () {
      closeModal();
      const cat = (current.id != null && findCategory(current.id)) || current;
      deleteCategory(cat);
    });
  }

  const saveBtn = ov.querySelector('#catSave');
  saveBtn.addEventListener('click', async function () {
    if (!validateForm(ov)) return;
    const label = ov.querySelector('#fCatName').value.trim();
    const icon = (iconInput.value || '').trim() || '\uD83C\uDF7D';
    const dest = ov.querySelector('#fCatDest').value || 'bar';
    const defaultVatRate = parseFloat(ov.querySelector('#fCatVatRate').value);
    if (!label) {
      showToast('Zadaj názov kategórie', 'error');
      return;
    }
    if (!isSupportedVatRate(defaultVatRate)) {
      showToast('Vyber predvolenú DPH kategórie', 'error');
      return;
    }
    btnLoading(saveBtn);
    try {
      if (mode === 'edit' && current.id) {
        await api.put('/menu/categories/' + current.id, { label: label, icon: icon, dest: dest, defaultVatRate: defaultVatRate });
        showToast('Kategória upravená', true);
      } else {
        const slug = 'cat_' + Date.now();
        const created = await api.post('/menu/categories', {
          slug: slug, label: label, icon: icon, sortKey: String(MENU_DATA.length), dest: dest,
          defaultVatRate: defaultVatRate,
        });
        activeCatId = (created && created.id) || slug;
        showToast('Kategória pridaná', true);
      }
      closeModal();
      await loadMenu();
    } catch (err) {
      btnReset(saveBtn);
      showToast(err.message || 'Chyba uloženia', 'error');
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
    '<button type="button" class="prod-emoji-pick" data-emoji="' + item.e + '" title="' + item.k + '">' +
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
      btn.setAttribute('aria-expanded', 'true');
      if (search) setTimeout(function () { search.focus(); }, 30);
    } else {
      wrap.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  if (close) close.addEventListener('click', function () { wrap.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); });
  if (search) search.addEventListener('input', function () { renderProductEmojiGrid(search.value); });
  grid.addEventListener('click', function (e) {
    const b = e.target.closest('.prod-emoji-pick');
    if (!b) return;
    input.value = b.dataset.emoji;
    wrap.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
    input.focus();
  });
}

// === Products ===
// Jeden riadok na produkt: ikona, názov (+ popis), cena vpravo. Celý riadok
// otvára úpravu; dostupnosť, fotka aj odstránenie sú vo formulári. Výnimky
// (nedostupný, DPH mimo kategórie) sa hlásia len tam, kde nastali.
function renderProducts() {
  const cat = getActiveCat();
  const prodTitle = byId('prodTitle');
  const prodList = byId('prodList');
  const editBtn = byId('editCatBtn');
  if (!prodList || !prodTitle) return;
  if (!cat) {
    prodList.innerHTML = '';
    prodTitle.textContent = '';
    if (editBtn) editBtn.hidden = true;
    return;
  }
  prodTitle.innerHTML = '<span class="mn-group-icon" aria-hidden="true">' + escapeHtml(cat.icon || '') + '</span>'
    + '<span class="mn-group-name">' + escapeHtml(cat.label) + '</span>'
    + '<span class="mn-group-n">' + cat.items.length + ' ' + itemsWord(cat.items.length) + '</span>';
  if (editBtn) editBtn.hidden = false;
  if (!cat.items.length) {
    mountEmptyState(prodList, {
      icon: '📦',
      title: 'Zatiaľ žiadne produkty',
      text: 'V kategórii „' + cat.label + '" nič nie je. Pridaj prvý produkt — objaví sa na kase hneď po uložení.',
      ctaLabel: 'Pridať produkt',
      onCta: openAddProduct,
    });
    return;
  }
  prodList.innerHTML = cat.items.map((item) => {
    const avail = item.available !== undefined ? item.available : item.active;
    const expected = inferVatRateForForm(cat.id, item.name);
    const vatOff = expected !== null && Number(item.vatRate) !== Number(expected);
    const sub = [];
    if (item.desc) sub.push(escapeHtml(item.desc));
    if (expected === null) sub.push('DPH ' + formatVatRate(item.vatRate) + ' %');
    const side = vatOff
      ? '<span class="mn-num-sub mn-warn">DPH ' + formatVatRate(item.vatRate) + ' %, kat. ' + formatVatRate(expected) + ' %</span>'
      : '';
    return '<button type="button" class="mn-row' + (avail ? '' : ' is-off') + '" data-edit-id="' + item.id + '">'
      + '<span class="mn-row-lead" aria-hidden="true">' + escapeHtml(item.emoji || '🍽') + '</span>'
      + '<span class="mn-row-main">'
        + '<span class="mn-row-name">' + escapeHtml(item.name)
          + (avail ? '' : ' <span class="mn-pill is-off">nedostupný</span>')
        + '</span>'
        + (sub.length ? '<span class="mn-row-sub">' + sub.join(' · ') + '</span>' : '')
      + '</span>'
      + '<span class="mn-row-side"><span class="mn-num">' + fmt(item.price) + '</span>' + side + '</span>'
      + '<svg class="mn-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>';
  }).join('');

  prodList.querySelectorAll('[data-edit-id]').forEach(el => {
    el.addEventListener('click', () => openEditProduct(Number(el.dataset.editId)));
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
  sel.innerHTML = MENU_DATA.map(c => `<option value="${c.id}" ${c.id === activeCatId ? 'selected' : ''}>${escapeHtml(c.icon)} ${escapeHtml(c.label)}</option>`).join('');
}

function populateCompanionSelect(selfId, selectedId) {
  const sel = byId('fCompanion');
  if (!sel) return;
  // Exclude self (can't link to yourself) and any item whose own companion points at
  // the item being edited (prevents trivial A→B→A loops).
  const options = ['<option value="">— žiadna —</option>'];
  MENU_DATA.forEach(cat => {
    cat.items.forEach(it => {
      if (it.id === selfId) return;
      if (selfId != null && it.companionMenuItemId === selfId) return;
      const name = escapeHtml((it.emoji ? it.emoji + ' ' : '') + it.name);
      const sel = (selectedId != null && it.id === selectedId) ? ' selected' : '';
      options.push(`<option value="${it.id}"${sel}>${name}</option>`);
    });
  });
  sel.innerHTML = options.join('');
}

// Kategória, ktorej položky sa predávajú vo vratnom obale. Zálohu k nim treba
// pripnúť VŽDY — inak sa pri predaji nenaúčtuje a podnik ju platí zo svojho.
// Presne to sa stalo položkám 128-132: pribudli neskôr a companion im nikto
// nenastavil, takže Rajec, Targa, Dilmah, Vinea ani Thomas Henry zálohu
// neúčtovali vôbec. Preto sa pri NOVEJ položke v tejto kategórii predvyplní.
const DEPOSIT_CATEGORY_SLUG = 'nealko';
const DEPOSIT_NAME_PREFIX = 'záloha';

function findDepositItemId() {
  for (const cat of MENU_DATA) {
    if (String(cat.slug || '').toLocaleLowerCase('sk-SK') !== DEPOSIT_CATEGORY_SLUG) continue;
    for (const it of cat.items) {
      if (String(it.name || '').toLocaleLowerCase('sk-SK').startsWith(DEPOSIT_NAME_PREFIX)) return it.id;
    }
  }
  return null;
}

// Predvyplní zálohu len pri ZAKLADANI novej položky. Pri editácii sa voľby
// manažéra nedotýkame — a keď si ju vedome prepne, `companionTouched` to drží.
function syncCompanionSuggestion(force) {
  const sel = byId('fCompanion');
  if (!sel) return;
  if (!force && (editingProductId !== null || companionTouched)) return;
  const category = findCategory(byId('fCategory') ? byId('fCategory').value : activeCatId);
  const slug = String((category && category.slug) || '').toLocaleLowerCase('sk-SK');
  if (slug !== DEPOSIT_CATEGORY_SLUG) return;
  const depositId = findDepositItemId();
  // Záloha samej sebe companionom byť nemôže.
  if (depositId == null || depositId === editingProductId) return;
  sel.value = String(depositId);
}

function resetImageState() {
  pendingImage = null;
  currentImage = null;
  clearImage = false;
}

function refreshImagePreview() {
  var prev = byId('fImagePreview');
  var clearBtn = byId('fImageClear');
  var input = byId('fImageInput');
  if (!prev) return;
  var src = pendingImage || (clearImage ? null : currentImage);
  if (src) {
    prev.style.backgroundImage = 'url("' + src + '")';
    prev.textContent = '';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    prev.style.backgroundImage = 'none';
    prev.textContent = '—'; // em dash
    if (clearBtn) clearBtn.style.display = currentImage ? '' : 'none';
  }
  if (input) input.value = '';
}

function openAddProduct() {
  editingProductId = null;
  byId('modalTitle').textContent = 'Pridať produkt';
  byId('fEmoji').value = '';
  byId('fName').value = '';
  byId('fDesc').value = '';
  byId('fPrice').value = '';
  formAvailable = true;
  vatRateTouched = false;
  resetImageState();
  refreshImagePreview();
  updateFormToggle();
  populateCategorySelect();
  companionTouched = false;
  populateCompanionSelect(null, null);
  syncCompanionSuggestion(true);
  syncVatRateSuggestion(true);
  if (byId('fDestOverride')) byId('fDestOverride').value = ''; // default (inherit kategória)
  const wrap = byId('fEmojiGridWrap');
  if (wrap) wrap.style.display = 'none';
  if (byId('prodDeleteBtn')) byId('prodDeleteBtn').hidden = true;
  byId('productModal').classList.add('show');
  setTimeout(() => byId('fName').focus(), 100);
}

function openEditProduct(id) {
  let item = null, catId = null;
  MENU_DATA.forEach(cat => { cat.items.forEach(it => { if (it.id === id) { item = it; catId = cat.id; } }); });
  if (!item) return;
  editingProductId = id;
  byId('modalTitle').textContent = 'Upraviť produkt';
  byId('fEmoji').value = item.emoji;
  byId('fName').value = item.name;
  byId('fDesc').value = item.desc;
  byId('fPrice').value = item.price;
  formAvailable = item.available !== undefined ? item.available : item.active;
  formVatRate = normalizeVatRate(item.vatRate);
  // POZOR: `true` tu znamenalo, ze pri zmene kategorie sa sadzba uz nikdy
  // nepreverila (syncVatRateSuggestion hned vypadla). Ostava false — sadzba sa
  // ticho neprepise (sme v edit rezime), ale nesulad s kategoriou sa ukaze.
  vatRateTouched = false;
  resetImageState();
  currentImage = item.imageUrl || null;
  refreshImagePreview();
  updateFormToggle();
  populateCategorySelect();
  populateCompanionSelect(item.id, item.companionMenuItemId);
  byId('fCategory').value = catId;
  byId('fVatRate').value = String(formVatRate);
  syncVatRateSuggestion(false);
  // Pre-fill dest override selector. Empty string = inherit category default.
  if (byId('fDestOverride')) {
    byId('fDestOverride').value = item.destOverride || '';
  }
  if (byId('prodDeleteBtn')) byId('prodDeleteBtn').hidden = false;
  byId('productModal').classList.add('show');
  setTimeout(() => byId('fName').focus(), 100);
}

function closeProductModal() {
  byId('productModal').classList.remove('show');
  editingProductId = null;
  vatRateTouched = false;
  // Varovanie o nesulade DPH patri k prave zatvorenej polozke.
  if (byId('fVatRateHint')) {
    byId('fVatRateHint').style.display = 'none';
    byId('fVatRateHint').innerHTML = '';
  }
  if (byId('fVatRate')) clearFieldError(byId('fVatRate'));
}

function toggleFormAvail() {
  formAvailable = !formAvailable;
  updateFormToggle();
}

function updateFormToggle() {
  const t = byId('fAvailToggle');
  const l = byId('fAvailLabel');
  t.classList.toggle('on', formAvailable);
  l.textContent = formAvailable ? 'Dostupný — na kase sa ponúka' : 'Nedostupný — na kase sa skryje';
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
  const companionRaw = byId('fCompanion') ? byId('fCompanion').value : '';
  const companionMenuItemId = companionRaw ? Number(companionRaw) : null;
  // dest override \u2014 empty string = inherit kateg\u00F3ria (NULL v DB)
  const destOverrideRaw = byId('fDestOverride') ? byId('fDestOverride').value : '';
  const destOverride = (destOverrideRaw === 'bar' || destOverrideRaw === 'kuchyna') ? destOverrideRaw : null;
  if (!name) { showToast('Zadajte názov produktu'); return; }
  if (price <= 0) { showToast('Zadajte platnú cenu'); return; }
  if (!Number.isFinite(vatRate)) {
    // Neznama kategoria (slug `cat_<timestamp>`) — sadzba sa neda odvodit a
    // predvyplnit 23 % by pri jedle znamenalo 18 p.b. preplatenu DPH.
    showToast('Vyber sadzbu DPH — kategória ju nemá nastavenú');
    return;
  }
  if (!isSupportedVatRate(vatRate)) {
    showToast('Portos podporuje iba sadzby DPH 5 %, 19 % a 23 %');
    return;
  }

  const btn = byId('modalSaveBtn');
  if (btn) btnLoading(btn);
  try {
    var savedId = editingProductId;
    if (editingProductId !== null) {
      await api.put('/menu/items/' + editingProductId, { name, emoji, price, desc, available: formAvailable, categoryId: catId, vatRate, companionMenuItemId, destOverride });
    } else {
      const created = await api.post('/menu/items', { categoryId: catId, name, emoji, price, desc, available: formAvailable, vatRate, companionMenuItemId, destOverride });
      savedId = created && created.id;
    }

    // Photo: handle clear / upload AFTER the row exists.
    if (savedId) {
      if (clearImage && !pendingImage) {
        try { await api.del('/menu/items/' + savedId + '/image'); }
        catch (e) { showToast('Fotku sa nepodarilo zmazať: ' + e.message, 'error'); }
      }
      if (pendingImage) {
        try { await api.post('/menu/items/' + savedId + '/image', { image: pendingImage }); }
        catch (e) { showToast('Fotku sa nepodarilo nahrať: ' + e.message, 'error'); }
      }
    }

    showToast(editingProductId !== null ? 'Produkt upravený' : 'Produkt pridaný', true);
    closeProductModal();
    activeCatId = catId;
    await loadMenu();
  } catch (err) {
    showToast(err.message || 'Chyba ukladania produktu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

async function deleteProduct(id) {
  // Find item + its parent category for optimistic restore
  let item = null;
  let parentCat = null;
  let itemIdx = -1;
  for (const cat of MENU_DATA) {
    const i = cat.items.findIndex((it) => it.id === id);
    if (i >= 0) { item = cat.items[i]; parentCat = cat; itemIdx = i; break; }
  }
  if (!item || !parentCat) return;

  // Optimistic remove from local data + re-render
  parentCat.items.splice(itemIdx, 1);
  renderProducts();
  renderCategories();

  const result = await softDelete({
    label: '„' + item.name + '" odstránené',
    deleteFn: () => api.del('/menu/items/' + id),
  });
  if (result.undone) {
    parentCat.items.splice(itemIdx, 0, item);
    renderProducts();
    renderCategories();
    showToast('Vrátené', true);
  } else if (result.error) {
    parentCat.items.splice(itemIdx, 0, item);
    renderProducts();
    renderCategories();
  } else {
    // Committed — reload from server (server-side stock/cost recalc may apply)
    await loadMenu();
  }
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
  container.className = 'content mn-page';

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
    <div class="mn-head">
      <div class="mn-count" id="menuCount" aria-live="polite"></div>
      <button class="btn-add" id="addProdBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridať produkt
      </button>
    </div>
    <div class="mn-cats" role="group" aria-label="Kategórie">
      <div class="mn-cats-list" id="catList"></div>
      <button type="button" class="doch-chip mn-cat mn-cat-add" id="addCatBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Kategória
      </button>
    </div>
    <div class="mn-group">
      <div class="mn-group-head">
        <div class="mn-group-title" id="prodTitle"></div>
        <button type="button" class="btn-secondary mn-group-edit" id="editCatBtn" hidden>Upraviť kategóriu</button>
      </div>
      <div class="mn-list" id="prodList">
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
      </div>
    </div>
    <!-- Product Modal -->
    <div class="u-overlay" id="productModal">
      <div class="u-modal u-modal-left mn-modal">
        <div class="u-modal-title text-center" id="modalTitle">Pridať produkt</div>
        <div class="u-modal-body">
          <div class="u-modal-row mn-row-emoji">
            <div class="u-modal-field field-emoji">
              <label for="fEmoji">Ikona</label>
              <div class="mn-emoji-field">
                <input id="fEmoji" type="text" placeholder="&#9749;" maxlength="4" class="input-emoji mn-emoji-input" aria-label="Emoji ikona produktu">
                <button type="button" id="fEmojiPickBtn" class="btn-secondary mn-emoji-pick" aria-expanded="false" aria-controls="fEmojiGridWrap">Vybrať</button>
              </div>
            </div>
            <div class="u-modal-field field-flex-3">
              <label for="fName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>
              <input id="fName" type="text" placeholder="napr. Cappuccino" aria-required="true" data-validate="required">
            </div>
          </div>
          <div id="fEmojiGridWrap" class="mn-emoji-wrap" style="display:none">
            <div class="mn-emoji-head">
              <input id="fEmojiSearch" type="text" placeholder="Hľadaj: káva, pivo, jedlo…" class="form-input form-input-sm" aria-label="Hľadať emoji">
              <button type="button" class="btn-secondary mn-emoji-close" id="fEmojiClose" aria-label="Zavrieť výber ikony">&#10005;</button>
            </div>
            <div id="fEmojiGrid" class="mn-emoji-grid"></div>
          </div>
          <div class="u-modal-field">
            <label for="fDesc">Popis</label>
            <input id="fDesc" type="text" placeholder="Krátky popis, nepovinné (napr. s mliekovou penou)">
          </div>
          <div class="u-modal-row">
            <div class="u-modal-field">
              <label for="fPrice">Cena (€)<span class="required-mark" aria-hidden="true"> *</span></label>
              <input id="fPrice" type="number" aria-required="true" data-validate="required|number" step="0.10" min="0" placeholder="0,00" inputmode="decimal">
            </div>
            <div class="u-modal-field">
              <label for="fCategory">Kategória</label>
              <select id="fCategory"></select>
            </div>
          </div>
          <div class="u-modal-row">
            <div class="u-modal-field">
              <label for="fVatRate">Sadzba DPH<span class="required-mark" aria-hidden="true"> *</span></label>
              <select id="fVatRate" aria-required="true" data-validate="required">
                <option value="">Vyber sadzbu DPH</option>
                <option value="5">5 % – jedlo</option>
                <option value="19">19 % – nealko nápoje</option>
                <option value="23">23 % – alkohol a ostatné</option>
              </select>
              <div id="fVatRateHint" class="mn-hint" style="display:none"></div>
            </div>
            <div class="u-modal-field">
              <label for="fDestOverride">Tlačiť na stanicu</label>
              <select id="fDestOverride">
                <option value="">Podľa kategórie</option>
                <option value="kuchyna">Kuchyňa</option>
                <option value="bar">Bar</option>
              </select>
              <small class="mn-hint">Jedlo ide do kuchyne, nápoje na bar. Zmeň len vtedy, keď sa má položka tlačiť inde.</small>
            </div>
          </div>
          <div class="u-modal-field">
            <label for="fCompanion">Automaticky priložená položka</label>
            <select id="fCompanion">
              <option value="">— žiadna —</option>
            </select>
            <small class="mn-hint">Napr. „Záloha fľaša" k fľaškovej kole — pridá a zmaže sa spolu s hlavnou položkou.</small>
          </div>
          <div class="u-modal-field">
            <label>Fotka</label>
            <div id="fImageWrap" class="mn-photo">
              <div id="fImagePreview" class="mn-photo-preview" aria-hidden="true">—</div>
              <div class="mn-photo-actions">
                <label class="btn-secondary mn-photo-btn">
                  Vybrať fotku
                  <input id="fImageInput" type="file" accept="image/jpeg,image/png,image/webp" style="display:none">
                </label>
                <button type="button" id="fImageClear" class="btn-secondary mn-photo-btn" style="display:none">Zmazať fotku</button>
                <div id="fImageHint" class="mn-hint">JPEG, PNG alebo WebP do 4 MB. Uloží sa spolu s produktom.</div>
              </div>
            </div>
          </div>
          <div class="u-modal-field">
            <label>Dostupnosť</label>
            <div class="u-toggle" id="fAvailToggleWrap">
              <div class="u-toggle-track on" id="fAvailToggle"><div class="u-toggle-knob"></div></div>
              <span class="u-toggle-label" id="fAvailLabel">Dostupný — na kase sa ponúka</span>
            </div>
          </div>
        </div>
        <button type="button" class="u-btn mn-btn-danger" id="prodDeleteBtn" hidden>Odstrániť produkt</button>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="modalCancelBtn">Zrušiť</button>
          <button class="u-btn u-btn-ice" id="modalSaveBtn">Uložiť</button>
        </div>
      </div>
    </div>
  `;

  // Bind button events
  byId('addCatBtn').addEventListener('click', addCategory);
  byId('addProdBtn').addEventListener('click', openAddProduct);
  byId('editCatBtn').addEventListener('click', function () {
    const cat = getActiveCat();
    if (cat) openCategoryModal('edit', cat);
  });
  byId('modalCancelBtn').addEventListener('click', closeProductModal);
  byId('modalSaveBtn').addEventListener('click', saveProduct);
  // Odstránenie je vo formulári produktu (nie na každom riadku zoznamu).
  byId('prodDeleteBtn').addEventListener('click', function () {
    const id = editingProductId;
    closeProductModal();
    if (id !== null) deleteProduct(id);
  });
  wireProductEmojiPicker();
  // Image picker — read file → data URL → preview; clear button drops both
  // pendingImage and (if currentImage) flags clearImage so the saved photo
  // is removed on save.
  if (byId('fImageInput')) {
    byId('fImageInput').addEventListener('change', function (e) {
      var file = this.files && this.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        showToast('Fotka je príliš veľká (max 4 MB)');
        this.value = '';
        return;
      }
      var fr = new FileReader();
      fr.onload = function () {
        pendingImage = fr.result;
        clearImage = false;
        refreshImagePreview();
      };
      fr.readAsDataURL(file);
    });
  }
  if (byId('fImageClear')) {
    byId('fImageClear').addEventListener('click', function () {
      pendingImage = null;
      clearImage = true;
      refreshImagePreview();
    });
  }
  byId('fAvailToggleWrap').addEventListener('click', toggleFormAvail);
  byId('productModal').addEventListener('click', function (e) { if (e.target === this) closeProductModal(); });
  byId('fCategory').addEventListener('change', function () { syncVatRateSuggestion(false); syncCompanionSuggestion(false); });
  byId('fName').addEventListener('input', function () { syncVatRateSuggestion(false); });
  byId('fCompanion').addEventListener('change', function () { companionTouched = true; });
  byId('fVatRate').addEventListener('change', function () {
    vatRateTouched = true;
    formVatRate = this.value === '' ? null : normalizeVatRate(this.value);
    syncVatRateSuggestion(false);
  });
  // „Pouzit X %" v inline varovani — hint sa prekresluje cez innerHTML,
  // preto delegujeme na jeho kontajner.
  if (byId('fVatRateHint')) {
    byId('fVatRateHint').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-vat-apply]');
      if (!btn) return;
      const sel = byId('fVatRate');
      if (!sel) return;
      sel.value = btn.dataset.vatApply;
      vatRateTouched = true;
      formVatRate = normalizeVatRate(sel.value);
      clearFieldError(sel);
      syncVatRateSuggestion(false);
    });
  }

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

  // Modálne okno ide do <body>: .app má stacking context (z-index:2) a spodný
  // tab bar (z-index:50) by inak prekrýval tlačidlá panelu zdola.
  const pm = byId('productModal');
  if (pm) document.body.appendChild(pm);

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
  const pm = document.getElementById('productModal');
  if (pm) pm.remove();
  const cm = document.getElementById('catModal');
  if (cm) cm.remove();
  _container = null;
  formVatRate = 23;
  vatRateTouched = false;
}
