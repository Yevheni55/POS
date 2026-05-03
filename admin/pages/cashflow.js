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
    '</div>';

  renderBody();
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
  // Add buttons + edit/delete handlers wired in Task 7.
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
