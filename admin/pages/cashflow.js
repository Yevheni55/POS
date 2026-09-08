'use strict';

import { softDelete } from '../components/toast-undo.js';
import { fmtCost } from '../../components/fmt.js';

// Admin → Cashflow. Manual income / expense ledger combined with the
// auto-tracked POS + shisha revenue for the same period. Read-only for
// the auto sources; manual entries are CRUD via the modal in Task 7.

const INCOME_CATS = [
  { slug: 'shisha_cash',  label: 'Shisha (hotovosť)' },
  { slug: 'tip',          label: 'Tringelt' },
  { slug: 'deposit',      label: 'Vklad do pokladne' },
  { slug: 'event',        label: 'Akcia / event' },
  { slug: 'sponsorship',  label: 'Sponzorstvo' },
  { slug: 'refund',       label: 'Vrátenie od dodávateľa' },
  { slug: 'other_income', label: 'Iný príjem' },
];
const EXPENSE_CATS = [
  { slug: 'withdrawal_uzavierka', label: 'Výber z pokladne (uzávierka)' },
  { slug: 'rent',          label: 'Nájom' },
  { slug: 'utilities',     label: 'Energie / voda / internet' },
  { slug: 'salary',        label: 'Mzdy / odmeny' },
  { slug: 'supplier',      label: 'Dodávatelia' },
  { slug: 'maintenance',   label: 'Údržba / opravy' },
  { slug: 'marketing',     label: 'Marketing / reklama' },
  { slug: 'taxes',         label: 'Dane a odvody' },
  { slug: 'fees',          label: 'Bankové poplatky' },
  { slug: 'equipment',     label: 'Vybavenie' },
  { slug: 'cleaning',      label: 'Čistenie / hygiena' },
  { slug: 'other_expense', label: 'Iný výdavok' },
];
const CAT_LABEL = (() => {
  const m = {};
  for (const c of [...INCOME_CATS, ...EXPENSE_CATS]) m[c.slug] = c.label;
  return m;
})();

let _container = null;
let _from = todayMinusDaysIso(7);
let _to = todayIso();
let _typeFilter = '';
let _summary = null;
let _entries = [];
// Cached list of saved suppliers — loaded once on init() and reused by
// the modal dropdown so the admin doesn't see a loading flicker every
// time they click "+ Výdavok". Stale-tolerant; suppliers rarely change
// during a single session.
let _suppliers = [];
// Stav UI: rozbalený blok „Iné…" (dátumy). Prežíva re-render po loadAll().
let _moreOpen = false;

// bratislavaDayIso je zdielany global z /api.js (preco nie UTC — viz tam).
function todayIso() { return bratislavaDayIso(new Date()); }
function todayMinusDaysIso(n) {
  // Odpocitavame kalendarne dni od bratislavskeho 'dnes' v UTC priestore,
  // aby posun nepokazil prechod letneho/zimneho casu ani koniec mesiaca.
  const p = todayIso().split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function fmtEur(n) { return fmtCost(n) + ' €'; }
// „1. 9. – 8. 9. 2026" — človek nemá lúštiť ISO dátumy z dvoch políčok.
function fmtRange(fromIso, toIso) {
  const parse = (iso) => { const p = String(iso).split('-').map(Number); return { y: p[0], m: p[1], d: p[2] }; };
  const a = parse(fromIso), b = parse(toIso);
  if (!a.y || !b.y) return fromIso + ' – ' + toIso;
  if (fromIso === toIso) return a.d + '. ' + a.m + '. ' + a.y;
  const left = a.d + '. ' + a.m + '.' + (a.y === b.y ? '' : ' ' + a.y);
  return left + ' – ' + b.d + '. ' + b.m + '. ' + b.y;
}
// Ktorý chip obdobia zodpovedá aktuálnemu rozsahu (0/7/30), inak null.
function presetFor(from, to) {
  if (to !== todayIso()) return null;
  for (const n of [0, 7, 30]) if (todayMinusDaysIso(n) === from) return n;
  return null;
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
function fmtLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadAll() {
  const params = new URLSearchParams({ from: _from, to: _to });
  if (_typeFilter) params.set('type', _typeFilter);
  try {
    const [summary, list] = await Promise.all([
      api.get('/cashflow/summary?' + new URLSearchParams({ from: _from, to: _to })),
      api.get('/cashflow?' + params),
    ]);
    _summary = summary;
    _entries = list.entries || [];
  } catch (err) {
    showToast(err.message || 'Chyba načítania cashflow', 'error');
    _summary = null;
    _entries = [];
  }
  render();
}

function render() {
  if (!_container) return;
  const s = _summary || { manual: { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 }, posRevenue: 0, shishaRevenue: 0, netCashflow: 0, totalIncome: 0, totalExpense: 0, byCategory: { income: [], expense: [] } };

  const preset = presetFor(_from, _to);
  const chip = (n, label) =>
    '<button type="button" class="doch-chip doch-preset' + (preset === n ? ' is-on' : '') + '" data-preset="' + n + '"' +
    ' aria-pressed="' + (preset === n ? 'true' : 'false') + '">' + label + '</button>';
  const seg = (v, label) =>
    '<button type="button"' + (_typeFilter === v ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') +
    ' data-type="' + v + '">' + label + '</button>';
  const net = Number(s.netCashflow) || 0;

  _container.innerHTML =
    // Obdobie ako chipy, dátumy pod „Iné…", typ ako segment — filter sa
    // aplikuje hneď pri zmene.
    '<div class="doch-head rp-head">' +
      '<div class="doch-chips rp-chips" role="group" aria-label="Obdobie">' +
        chip(0, 'Dnes') + chip(7, '7 dní') + chip(30, '30 dní') +
        '<button type="button" class="doch-chip' + ((_moreOpen || preset === null) ? ' is-on' : '') + '" id="cfMore"' +
          ' aria-expanded="' + (_moreOpen ? 'true' : 'false') + '" aria-controls="cfMoreBox">Iné…</button>' +
      '</div>' +
      '<div class="doch-more" id="cfMoreBox"' + (_moreOpen ? '' : ' hidden') + '>' +
        '<label class="doch-toolbar-label">Od<input type="date" id="cfFrom" class="doch-input" value="' + _from + '"></label>' +
        '<label class="doch-toolbar-label">Do<input type="date" id="cfTo" class="doch-input" value="' + _to + '"></label>' +
      '</div>' +
      '<div class="rp-seg" id="cfType" role="group" aria-label="Typ záznamu">' +
        seg('', 'Všetko') + seg('income', 'Príjmy') + seg('expense', 'Výdavky') +
      '</div>' +
      '<div class="doch-range">' + escapeHtml(fmtRange(_from, _to)) + '</div>' +
    '</div>' +

    // Hlavná odpoveď stránky: čistý cashflow (POS + shisha + ručné príjmy −
    // ručné výdavky). Zdroje v jednom riadku súčtu pod ním.
    '<div class="rp-hero">' +
      '<div class="rp-hero-k">Čistý cashflow za obdobie</div>' +
      '<div class="rp-hero-v ' + (net >= 0 ? 'is-pos' : 'is-neg') + '">' + (net >= 0 ? '+' : '') + escapeHtml(fmtEur(net)) + '</div>' +
      '<div class="rp-hero-s">príjmy ' + escapeHtml(fmtEur(s.totalIncome)) + ' − výdavky ' + escapeHtml(fmtEur(s.totalExpense)) + '</div>' +
    '</div>' +
    '<div class="doch-sum rp-sum">' +
      '<span class="rp-sum-i"><strong>' + escapeHtml(fmtEur(s.posRevenue)) + '</strong> tržby POS</span>' +
      (s.shishaRevenue ? '<span class="rp-sum-i"><strong>' + escapeHtml(fmtEur(s.shishaRevenue)) + '</strong> shisha</span>' : '') +
      '<span class="rp-sum-i"><strong>' + escapeHtml(fmtEur(s.manual.income)) + '</strong> ručné príjmy <small>' + (s.manual.incomeCount || 0) + '</small></span>' +
      '<span class="rp-sum-i"><strong>' + escapeHtml(fmtEur(s.manual.expense)) + '</strong> výdavky <small>' + (s.manual.expenseCount || 0) + '</small></span>' +
    '</div>' +

    // Jedna hlavná akcia (výdavok je najčastejší zápis), príjem tónovaný.
    '<div class="rp-actions" style="margin-bottom:12px">' +
      '<button type="button" class="btn-add" id="cfAddExpense">+ Výdavok</button>' +
      '<button type="button" class="btn-secondary" id="cfAddIncome">+ Príjem</button>' +
    '</div>' +

    '<div class="panel rp-panel">' +
      '<div class="panel-title">Záznamy <span class="rp-count-inline">' + _entries.length + '</span></div>' +
      '<div id="cfBody"></div>' +
    '</div>' +

    '<div class="panel rp-panel">' +
      '<div class="panel-title">Rozpis kategórií</div>' +
      '<div id="cfBreakdown" class="rp-2col-grid"></div>' +
    '</div>';

  renderBody();
  renderBreakdown();
  bind();
}

function renderBody() {
  const host = _container.querySelector('#cfBody');
  if (!host) return;
  if (!_entries.length) {
    host.innerHTML = '<div class="empty-hint">Žiadne ručné záznamy v tomto období. Pridaj výdavok alebo príjem tlačidlom hore.</div>';
    return;
  }
  // Riadky so znamienkom: + príjem (zelená), − výdavok (červená). Celý riadok
  // otvorí úpravu; vymazanie je v úprave, nie na každom riadku.
  host.innerHTML = '<div class="rp-list">' + _entries.map((e) => {
    const isInc = e.type === 'income';
    const methodLabel = { cash: 'Hotovosť', card: 'Karta', transfer: 'Prevod', other: 'Iné' }[e.method] || e.method;
    const sub = [
      escapeHtml(fmtLocalDateTime(e.occurredAt)),
      escapeHtml(methodLabel),
      e.supplierName ? escapeHtml(e.supplierName) : '',
      e.note ? escapeHtml(e.note) : '',
    ].filter(Boolean).join(' · ');
    return '<button type="button" class="rp-row has-chev" data-edit="' + e.id + '">' +
      '<span class="rp-row-main">' +
        '<span class="rp-row-t">' + escapeHtml(CAT_LABEL[e.category] || e.category) + '</span>' +
        '<span class="rp-row-s">' + sub + '</span>' +
      '</span>' +
      '<span class="rp-row-side"><span class="rp-row-v ' + (isInc ? 'is-pos' : 'is-neg') + '">' + (isInc ? '+' : '−') + escapeHtml(fmtEur(e.amount)) + '</span></span>' +
      '<svg class="rp-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>';
  }).join('') + '</div>';
}

function renderBreakdown() {
  const host = _container.querySelector('#cfBreakdown');
  if (!host || !_summary) return;
  const block = (title, rows, cls) => {
    if (!rows || !rows.length) return '<div><div class="rp-cat-head">' + title + '</div><div class="empty-hint">Žiadne záznamy.</div></div>';
    const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    return '<div><div class="rp-cat-head">' + title + ' <small>spolu ' + escapeHtml(fmtEur(total)) + '</small></div>' +
      rows.map((r) => {
        const pct = total > 0 ? Math.round((r.total / total) * 100) : 0;
        return '<div class="rp-cat">' +
          '<div class="rp-cat-n">' + escapeHtml(CAT_LABEL[r.category] || r.category) + ' <small>(' + r.count + ')</small></div>' +
          '<div class="rp-cat-v"><strong>' + escapeHtml(fmtEur(r.total)) + '</strong><small>' + pct + ' %</small></div>' +
          '<div class="rp-bar ' + cls + '" aria-hidden="true"><span style="width:' + pct + '%"></span></div>' +
        '</div>';
      }).join('') + '</div>';
  };
  host.innerHTML =
    block('Príjmy',  _summary.byCategory.income,  'is-pos') +
    block('Výdavky', _summary.byCategory.expense, 'is-neg');
}

function nowForDateTimeLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function openEntryModal(mode, presetType, existing) {
  // mode: 'create' | 'edit'. existing only when 'edit'.
  const initialType = (existing && existing.type) || presetType || 'expense';
  const isEdit = mode === 'edit' && existing;
  const occurredLocal = isEdit
    ? new Date(existing.occurredAt).toISOString().slice(0, 16)
    : nowForDateTimeLocal();

  const html =
    '<div class="u-overlay show" id="cfModal">' +
      '<div class="u-modal" role="dialog" aria-modal="true">' +
        '<div class="u-modal-title">' + (isEdit ? 'Upraviť záznam' : (initialType === 'income' ? 'Nový príjem' : 'Nový výdavok')) + '</div>' +
        '<form class="rp-form doch-manual-form" id="cfForm">' +
          '<label class="doch-toolbar-label">Typ' +
            '<select id="cfMType" class="doch-input">' +
              '<option value="income"'  + (initialType === 'income'  ? ' selected' : '') + '>Príjem</option>' +
              '<option value="expense"' + (initialType === 'expense' ? ' selected' : '') + '>Výdavok</option>' +
            '</select>' +
          '</label>' +
          '<label class="doch-toolbar-label">Kategória' +
            '<select id="cfMCat" class="doch-input" required></select>' +
          '</label>' +
          // Supplier picker — shown only for supplier-related categories
          // (expense=supplier, income=refund). Empty option = no link.
          '<label class="doch-toolbar-label" id="cfMSupplierWrap" style="display:none">Dodávateľ' +
            '<select id="cfMSupplier" class="doch-input">' +
              '<option value="">— žiadny —</option>' +
              _suppliers.map((sup) => {
                const sel = isEdit && existing && existing.supplierId === sup.id ? ' selected' : '';
                return '<option value="' + sup.id + '"' + sel + '>' + escapeHtml(sup.name) + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<div class="rp-form-2">' +
            '<label class="doch-toolbar-label">Suma v €' +
              '<input type="number" id="cfMAmount" class="doch-input" min="0.01" step="0.01" inputmode="decimal" required value="' + (isEdit ? Number(existing.amount).toFixed(2) : '') + '">' +
            '</label>' +
            '<label class="doch-toolbar-label">Spôsob' +
              '<select id="cfMMethod" class="doch-input">' +
                ['cash','card','transfer','other'].map((m) => {
                  const lbl = { cash: 'Hotovosť', card: 'Karta', transfer: 'Prevod', other: 'Iné' }[m];
                  const sel = (isEdit ? existing.method : 'cash') === m ? ' selected' : '';
                  return '<option value="' + m + '"' + sel + '>' + lbl + '</option>';
                }).join('') +
              '</select>' +
            '</label>' +
          '</div>' +
          '<label class="doch-toolbar-label">Dátum a čas' +
            '<input type="datetime-local" id="cfMAt" class="doch-input" required value="' + occurredLocal + '">' +
          '</label>' +
          '<label class="doch-toolbar-label">Poznámka' +
            '<input type="text" id="cfMNote" class="doch-input" maxlength="500" placeholder="napr. faktúra č. 123" value="' + escapeHtml(isEdit ? existing.note || '' : '') + '">' +
          '</label>' +
        '</form>' +
        '<div class="u-modal-btns">' +
          (isEdit ? '<button type="button" class="u-btn u-btn-del" id="cfMDelete">Vymazať záznam</button>' : '') +
          '<button type="button" class="u-btn u-btn-ghost" id="cfMCancel">Zrušiť</button>' +
          '<button type="button" class="u-btn u-btn-ice" id="cfMSave">' + (isEdit ? 'Uložiť zmeny' : 'Pridať záznam') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('cfModal');
  const typeSel = modal.querySelector('#cfMType');
  const catSel = modal.querySelector('#cfMCat');

  const supplierWrap = modal.querySelector('#cfMSupplierWrap');
  const supplierSel = modal.querySelector('#cfMSupplier');

  // Show the supplier picker only when it makes sense — paying a supplier
  // (expense=supplier) or recording a refund FROM a supplier (income=refund).
  // Other categories (rent, tip, …) hide it to keep the modal compact.
  function shouldShowSupplier(t, c) {
    return (t === 'expense' && c === 'supplier') || (t === 'income' && c === 'refund');
  }
  function refreshSupplierVisibility() {
    const visible = shouldShowSupplier(typeSel.value, catSel.value) && _suppliers.length > 0;
    supplierWrap.style.display = visible ? '' : 'none';
    if (!visible) supplierSel.value = ''; // clear linked supplier when hidden
  }

  function refillCategories() {
    const list = typeSel.value === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const cur = isEdit && existing.category;
    catSel.innerHTML = list.map((c) => '<option value="' + c.slug + '"' + (c.slug === cur ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>').join('');
    refreshSupplierVisibility();
  }
  refillCategories();
  typeSel.addEventListener('change', refillCategories);
  catSel.addEventListener('change', refreshSupplierVisibility);

  function close() { modal.remove(); }
  modal.querySelector('#cfMCancel').addEventListener('click', close);
  // Vymazanie je v úprave záznamu (nie na každom riadku); má undo cez toast.
  const delBtn = modal.querySelector('#cfMDelete');
  if (delBtn) delBtn.addEventListener('click', () => { close(); deleteEntry(existing.id); });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#cfMSave').addEventListener('click', async () => {
    // supplierId: send the picked id, or null when picker hidden / "— žiadny —"
    // selected (string '' becomes null after the conversion). PATCH treats
    // null as "clear the link"; POST ignores null.
    const rawSup = supplierSel.value;
    const supplierId = rawSup ? parseInt(rawSup, 10) : null;
    const body = {
      type: typeSel.value,
      category: catSel.value,
      amount: Number(modal.querySelector('#cfMAmount').value),
      occurredAt: new Date(modal.querySelector('#cfMAt').value).toISOString(),
      method: modal.querySelector('#cfMMethod').value,
      note: modal.querySelector('#cfMNote').value.trim(),
      supplierId,
    };
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      showToast('Suma musí byť väčšia ako 0', 'error');
      return;
    }
    try {
      if (isEdit) {
        await api.patch('/cashflow/' + existing.id, body);
        showToast('Záznam upravený', true);
      } else {
        await api.post('/cashflow', body);
        showToast('Záznam pridaný', true);
      }
      close();
      await loadAll();
    } catch (err) {
      showToast(err.message || 'Uloženie zlyhalo', 'error');
    }
  });
}

function bind() {
  _container.querySelectorAll('.doch-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.preset, 10);
      _to = todayIso();
      _from = todayMinusDaysIso(n);
      loadAll();
    });
  });
  // „Iné…" — rozbalí dátumy (len stav UI; loadAll() ho prekreslí zo stavu).
  const more = _container.querySelector('#cfMore');
  const box = _container.querySelector('#cfMoreBox');
  if (more && box) {
    more.addEventListener('click', () => {
      _moreOpen = box.hidden;
      box.hidden = !_moreOpen;
      more.setAttribute('aria-expanded', _moreOpen ? 'true' : 'false');
      more.classList.toggle('is-on', _moreOpen || presetFor(_from, _to) === null);
    });
  }
  _container.querySelector('#cfFrom').addEventListener('change', (e) => { _from = e.target.value || _from; loadAll(); });
  _container.querySelector('#cfTo').addEventListener('change',   (e) => { _to   = e.target.value || _to;   loadAll(); });
  // Typ ako segment (predtým <select>): klik = filter hneď.
  _container.querySelectorAll('#cfType [data-type]').forEach((b) => {
    b.addEventListener('click', () => { _typeFilter = b.dataset.type || ''; loadAll(); });
  });
  _container.querySelector('#cfAddIncome').addEventListener('click', () => openEntryModal('create', 'income'));
  _container.querySelector('#cfAddExpense').addEventListener('click', () => openEntryModal('create', 'expense'));
  _container.querySelectorAll('button[data-edit]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-edit'), 10);
      const entry = _entries.find((e) => e.id === id);
      if (entry) openEntryModal('edit', null, entry);
    });
  });
}

// Optimistické zmazanie s undo (toast) — rovnaký tok ako doteraz, len
// volané z modálu úpravy namiesto tlačidla v riadku.
async function deleteEntry(id) {
  const idx = _entries.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const snapshot = _entries[idx];

  // Optimistic remove
  _entries.splice(idx, 1);
  render();

  const result = await softDelete({
    label: (CAT_LABEL[snapshot.category] || snapshot.category) + ' za ' + fmtEur(snapshot.amount) + ' zmazané',
    deleteFn: () => api.del('/cashflow/' + id),
  });
  if (result.undone) {
    _entries.splice(idx, 0, snapshot);
    render();
    showToast('Vrátené', true);
  } else if (result.error) {
    _entries.splice(idx, 0, snapshot);
    render();
  } else {
    // Commited — reload to refresh totals/breakdown
    await loadAll();
  }
}

async function loadSuppliers() {
  try {
    const list = await api.get('/inventory/suppliers');
    _suppliers = (Array.isArray(list) ? list : []).filter((s) => s && s.active !== false);
  } catch {
    _suppliers = [];
  }
}

export async function init(container) {
  _container = container;
  // Suppliers in parallel with the first cashflow load so the admin can
  // open the modal even before the entries table has populated.
  loadSuppliers();
  loadAll();
}

export function destroy() {
  _container = null;
  _summary = null;
  _entries = [];
  _typeFilter = '';
  _suppliers = [];
  _moreOpen = false;
}
