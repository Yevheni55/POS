'use strict';

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

function todayIso() { return new Date().toISOString().slice(0, 10); }
function todayMinusDaysIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function fmtEur(n) { return Number(n || 0).toFixed(2) + ' €'; }
function escapeHtml(v) {
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

  _container.innerHTML =
    '<div class="doch-toolbar">' +
      '<div class="doch-toolbar-dates">' +
        '<label class="doch-toolbar-label">Od<input type="date" id="cfFrom" class="doch-input" value="' + _from + '"></label>' +
        '<label class="doch-toolbar-label">Do<input type="date" id="cfTo"   class="doch-input" value="' + _to + '"></label>' +
        '<label class="doch-toolbar-label">Typ' +
          '<select id="cfType" class="doch-input">' +
            '<option value=""'        + (_typeFilter === ''        ? ' selected' : '') + '>Všetko</option>' +
            '<option value="income"'  + (_typeFilter === 'income'  ? ' selected' : '') + '>Len príjmy</option>' +
            '<option value="expense"' + (_typeFilter === 'expense' ? ' selected' : '') + '>Len výdavky</option>' +
          '</select>' +
        '</label>' +
        '<div class="doch-toolbar-presets">' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="0">Dnes</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="7">7 dní</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="30">30 dní</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn-add" id="cfAddIncome" style="background:rgba(95,200,130,.16);color:var(--color-success);border-color:rgba(95,200,130,.4)">+ Príjem</button>' +
        '<button class="btn-add" id="cfAddExpense" style="background:rgba(224,112,112,.16);color:var(--color-danger);border-color:rgba(224,112,112,.4)">+ Výdavok</button>' +
      '</div>' +
    '</div>' +

    '<div class="stat-grid" style="margin-bottom:18px">' +
      '<div class="stat-card"><div class="stat-icon mint"><svg viewBox="0 0 24 24"><path d="M12 1v22M5 8h14a3 3 0 0 1 0 6H5a3 3 0 0 0 0 6h14"/></svg></div>' +
        '<div class="stat-info"><div class="stat-label">Príjmy spolu</div><div class="stat-value">' + escapeHtml(fmtEur(s.totalIncome)) + '</div>' +
        '<div class="stat-change neutral">POS ' + fmtEur(s.posRevenue) + ' + manuál ' + fmtEur(s.manual.income) + (s.shishaRevenue ? ' + shisha ' + fmtEur(s.shishaRevenue) : '') + '</div></div></div>' +
      '<div class="stat-card"><div class="stat-icon amber"><svg viewBox="0 0 24 24"><path d="M3 6h18l-2 14H5z"/></svg></div>' +
        '<div class="stat-info"><div class="stat-label">Výdavky spolu</div><div class="stat-value">' + escapeHtml(fmtEur(s.totalExpense)) + '</div>' +
        '<div class="stat-change neutral">' + (s.manual.expenseCount || 0) + ' záznamov</div></div></div>' +
      '<div class="stat-card"><div class="stat-icon ' + (s.netCashflow >= 0 ? 'mint' : 'amber') + '"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 12h6M12 9v6"/></svg></div>' +
        '<div class="stat-info"><div class="stat-label">Čistý zisk</div><div class="stat-value" style="color:' + (s.netCashflow >= 0 ? 'var(--color-success)' : 'var(--color-danger)') + '">' + escapeHtml(fmtEur(s.netCashflow)) + '</div>' +
        '<div class="stat-change neutral">' + escapeHtml(_from) + ' → ' + escapeHtml(_to) + '</div></div></div>' +
    '</div>' +

    '<div class="panel doch-panel">' +
      '<div class="panel-title">Manuálne záznamy (' + _entries.length + ')</div>' +
      '<div class="table-scroll-wrap"><table class="data-table">' +
        '<thead><tr><th class="data-th">Dátum</th><th class="data-th">Typ</th><th class="data-th">Kategória</th><th class="data-th">Suma</th><th class="data-th">Spôsob</th><th class="data-th">Poznámka</th><th class="data-th"></th></tr></thead>' +
        '<tbody id="cfBody"></tbody>' +
      '</table></div>' +
    '</div>' +

    '<div class="panel doch-panel">' +
      '<div class="panel-title">Rozpis kategórií</div>' +
      '<div id="cfBreakdown" style="display:grid;grid-template-columns:1fr 1fr;gap:18px"></div>' +
    '</div>';

  renderBody();
  renderBreakdown();
  bind();
}

function renderBody() {
  const tbody = _container.querySelector('#cfBody');
  if (!_entries.length) {
    tbody.innerHTML = '<tr><td class="data-td" colspan="7"><div class="empty-hint">Žiadne manuálne záznamy v tomto období.</div></td></tr>';
    return;
  }
  tbody.innerHTML = _entries.map((e) => {
    const typeBadge = e.type === 'income'
      ? '<span class="badge badge-success">Príjem</span>'
      : '<span class="badge badge-danger">Výdavok</span>';
    const methodLabel = { cash: 'Hotovosť', card: 'Karta', transfer: 'Prevod', other: 'Iné' }[e.method] || e.method;
    return '<tr class="data-row">' +
      '<td class="data-td">' + escapeHtml(fmtLocalDateTime(e.occurredAt)) + '</td>' +
      '<td class="data-td">' + typeBadge + '</td>' +
      '<td class="data-td">' + escapeHtml(CAT_LABEL[e.category] || e.category) + '</td>' +
      '<td class="data-td num"><strong>' + escapeHtml(fmtEur(e.amount)) + '</strong></td>' +
      '<td class="data-td">' + escapeHtml(methodLabel) + '</td>' +
      '<td class="data-td">' + (e.note ? escapeHtml(e.note) : '<span class="text-muted">—</span>') + '</td>' +
      '<td class="data-td"><button class="btn-toggle-status" data-edit="' + e.id + '" title="Upraviť">✎</button> ' +
        '<button class="btn-toggle-status doch-event-del" data-del="' + e.id + '" title="Vymazať">✕</button></td>' +
    '</tr>';
  }).join('');
}

function renderBreakdown() {
  const host = _container.querySelector('#cfBreakdown');
  if (!host || !_summary) return;
  const block = (title, rows, color) => {
    if (!rows || !rows.length) return '<div><div class="doch-subhead">' + title + '</div><div class="empty-hint">Žiadne záznamy.</div></div>';
    const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    return '<div><div class="doch-subhead">' + title + ' — spolu ' + fmtEur(total) + '</div>' +
      rows.map((r) => {
        const pct = total > 0 ? Math.round((r.total / total) * 100) : 0;
        return '<div style="display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;margin-bottom:6px;font-size:13px">' +
          '<div>' + escapeHtml(CAT_LABEL[r.category] || r.category) + ' <span class="text-muted">(' + r.count + ')</span></div>' +
          '<div style="text-align:right;font-variant-numeric:tabular-nums"><strong>' + escapeHtml(fmtEur(r.total)) + '</strong> <span class="text-muted">' + pct + '%</span></div>' +
          '<div style="grid-column:1 / span 2;height:6px;border-radius:3px;background:rgba(255,255,255,.04);overflow:hidden">' +
            '<div style="width:' + pct + '%;height:100%;background:' + color + '"></div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  };
  host.innerHTML =
    block('Príjmy',  _summary.byCategory.income,  'var(--color-success)') +
    block('Výdavky', _summary.byCategory.expense, 'var(--color-danger)');
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
        '<form class="doch-manual-form" id="cfForm" style="border:none;padding:0;background:none">' +
          '<label class="doch-toolbar-label">Typ' +
            '<select id="cfMType" class="doch-input">' +
              '<option value="income"'  + (initialType === 'income'  ? ' selected' : '') + '>Príjem</option>' +
              '<option value="expense"' + (initialType === 'expense' ? ' selected' : '') + '>Výdavok</option>' +
            '</select>' +
          '</label>' +
          '<label class="doch-toolbar-label">Kategória' +
            '<select id="cfMCat" class="doch-input" required></select>' +
          '</label>' +
          '<label class="doch-toolbar-label">Suma €' +
            '<input type="number" id="cfMAmount" class="doch-input" min="0.01" step="0.01" required value="' + (isEdit ? Number(existing.amount).toFixed(2) : '') + '">' +
          '</label>' +
          '<label class="doch-toolbar-label">Dátum' +
            '<input type="datetime-local" id="cfMAt" class="doch-input" required value="' + occurredLocal + '">' +
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
          '<label class="doch-toolbar-label" style="flex:1 1 100%">Poznámka' +
            '<input type="text" id="cfMNote" class="doch-input" maxlength="500" value="' + escapeHtml(isEdit ? existing.note || '' : '') + '">' +
          '</label>' +
        '</form>' +
        '<div class="u-modal-btns">' +
          '<button class="u-btn u-btn-ghost" id="cfMCancel">Zrušiť</button>' +
          '<button class="u-btn u-btn-ice" id="cfMSave">' + (isEdit ? 'Uložiť' : 'Pridať') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('cfModal');
  const typeSel = modal.querySelector('#cfMType');
  const catSel = modal.querySelector('#cfMCat');

  function refillCategories() {
    const list = typeSel.value === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const cur = isEdit && existing.category;
    catSel.innerHTML = list.map((c) => '<option value="' + c.slug + '"' + (c.slug === cur ? ' selected' : '') + '>' + c.label + '</option>').join('');
  }
  refillCategories();
  typeSel.addEventListener('change', refillCategories);

  function close() { modal.remove(); }
  modal.querySelector('#cfMCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#cfMSave').addEventListener('click', async () => {
    const body = {
      type: typeSel.value,
      category: catSel.value,
      amount: Number(modal.querySelector('#cfMAmount').value),
      occurredAt: new Date(modal.querySelector('#cfMAt').value).toISOString(),
      method: modal.querySelector('#cfMMethod').value,
      note: modal.querySelector('#cfMNote').value.trim(),
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
  _container.querySelector('#cfFrom').addEventListener('change', (e) => { _from = e.target.value || _from; loadAll(); });
  _container.querySelector('#cfTo').addEventListener('change',   (e) => { _to   = e.target.value || _to;   loadAll(); });
  _container.querySelector('#cfType').addEventListener('change', (e) => { _typeFilter = e.target.value || ''; loadAll(); });
  _container.querySelector('#cfAddIncome').addEventListener('click', () => openEntryModal('create', 'income'));
  _container.querySelector('#cfAddExpense').addEventListener('click', () => openEntryModal('create', 'expense'));
  _container.querySelectorAll('button[data-edit]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-edit'), 10);
      const entry = _entries.find((e) => e.id === id);
      if (entry) openEntryModal('edit', null, entry);
    });
  });

  _container.querySelectorAll('button[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-del'), 10);
      const entry = _entries.find((e) => e.id === id);
      if (!entry) return;
      showConfirm(
        'Vymazať záznam?',
        'Toto natrvalo zmaže záznam ' + (CAT_LABEL[entry.category] || entry.category) + ' za ' + fmtEur(entry.amount) + '. Súčty sa prepočítajú.',
        async () => {
          try {
            await api.del('/cashflow/' + id);
            showToast('Záznam vymazaný', true);
            await loadAll();
          } catch (err) {
            showToast(err.message || 'Mazanie zlyhalo', 'error');
          }
        },
        { type: 'danger', confirmText: 'Vymazať' },
      );
    });
  });
}

export function init(container) {
  _container = container;
  loadAll();
}

export function destroy() {
  _container = null;
  _summary = null;
  _entries = [];
  _typeFilter = '';
}
