'use strict';

// Admin → História objednávok. Browses the order_events audit log so the
// owner can answer "kto kedy poslal túto objednávku" without psql.
//
// All data is already being written by lib/audit.js — this page is
// read-only. Nothing here mutates state.

let _container = null;
let _from = todayMinusDaysIso(0);
let _to = todayIso();
let _staffFilter = '';
let _typeFilter = '';
let _orderFilter = '';
let _staffList = [];
let _typeList = [];

function todayIso() { return new Date().toISOString().slice(0, 10); }
function todayMinusDaysIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sk-SK', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// Slovak labels for known event types — anything not in the map shows
// the raw type as a fallback so newly-added event types still render
// instead of showing as blank.
const TYPE_LABELS = {
  order_created:    'Objednávka vytvorená',
  item_added:       'Pridaná položka',
  item_qty_changed: 'Zmena množstva',
  item_removed:     'Odstránená položka',
  batch_update:     'Hromadná úprava',
  order_sent:       'Odoslané do kuchyne/baru',
  order_closed:     'Uzatvorená',
  order_cancelled:  'Stornovaná',
  order_split:      'Rozdelená',
  order_paid:       'Zaplatená',
  payment_added:    'Pridaná platba',
  payment_voided:   'Zrušená platba',
  discount_applied: 'Pridaná zľava',
  discount_removed: 'Odstránená zľava',
  storno_requested: 'Storno žiadosť',
  storno_approved:  'Storno schválené',
  storno_rejected:  'Storno zamietnuté',
};

function typeBadgeClass(type) {
  if (type === 'order_cancelled' || type === 'storno_rejected' || type === 'item_removed') return 'badge-danger';
  if (type === 'order_sent' || type === 'order_paid' || type === 'storno_approved') return 'badge-success';
  if (type === 'order_created' || type === 'item_added') return 'badge-info';
  return 'badge-warning';
}

// Render a 1-line description of the payload tailored to each event type.
// The full JSON is also reachable via the hover tooltip so nothing is hidden.
function describePayload(type, payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (type === 'order_created')   return (payload.label ? '"' + payload.label + '" · ' : '') + (payload.itemCount || 0) + ' položiek';
  if (type === 'item_added')      return Array.isArray(payload.items) ? payload.items.length + ' položiek' : '';
  if (type === 'item_qty_changed')return 'menuItemId=' + (payload.menuItemId || '?') + ', qty ' + (payload.from != null ? payload.from + '→' + payload.to : payload.qty);
  if (type === 'item_removed')    return 'itemId=' + (payload.itemId || '?');
  if (type === 'order_sent')      return (payload.itemCount || 0) + ' nových položiek';
  if (type === 'discount_applied')return (payload.discountAmount || 0) + ' € zľava';
  if (type === 'discount_removed')return 'odstránená zľava';
  if (type === 'order_split')     return 'rozdelená na ' + (Array.isArray(payload.newOrderIds) ? payload.newOrderIds.length : '?') + ' obj.';
  if (type === 'order_cancelled') return 'stôl ' + (payload.tableId || '?');
  // Generic fallback: show first 2 keys
  const keys = Object.keys(payload).slice(0, 2);
  return keys.map((k) => k + '=' + JSON.stringify(payload[k])).join(', ');
}

async function loadStaffList() {
  try {
    const list = await api.get('/staff');
    _staffList = Array.isArray(list) ? list : [];
  } catch {
    _staffList = [];
  }
}

async function loadTypeList() {
  try {
    const list = await api.get('/audit/order-events/types');
    _typeList = Array.isArray(list) ? list : [];
  } catch {
    _typeList = [];
  }
}

async function loadEvents() {
  if (!_container) return;
  const tbody = _container.querySelector('#auditBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Načítavam…</td></tr>';
  const params = new URLSearchParams();
  params.set('from', _from);
  params.set('to', _to);
  if (_staffFilter) params.set('staffId', _staffFilter);
  if (_typeFilter)  params.set('type', _typeFilter);
  if (_orderFilter) params.set('orderId', _orderFilter);
  let data;
  try {
    data = await api.get('/audit/order-events?' + params.toString());
  } catch (err) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="td-empty color-danger">Chyba: ' + escapeHtml(err.message || '') + '</td></tr>';
    return;
  }
  renderBody(data);
  renderCount(data);
}

function renderCount(data) {
  const el = _container.querySelector('#auditCount');
  if (!el) return;
  const c = data.count || 0;
  el.textContent = c + ' záznamov' + (data.truncated ? ' (orezané — sprísni filter)' : '');
}

function renderBody(data) {
  const tbody = _container.querySelector('#auditBody');
  if (!tbody) return;
  const events = data.events || [];
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Žiadne záznamy pre toto obdobie.</td></tr>';
    return;
  }
  tbody.innerHTML = events.map((e) => {
    const label = TYPE_LABELS[e.type] || e.type;
    const cls = typeBadgeClass(e.type);
    const tableCell = e.tableName ? escapeHtml(e.tableName)
      : (e.tableId ? '#' + e.tableId : '<span class="text-muted">—</span>');
    const orderCell = e.orderId
      ? '<strong>#' + e.orderId + '</strong>' + (e.orderLabel ? ' <span class="text-muted">' + escapeHtml(e.orderLabel) + '</span>' : '')
      : '<span class="text-muted">—</span>';
    const desc = describePayload(e.type, e.payload);
    const rawJson = e.payload ? JSON.stringify(e.payload) : '';
    return '<tr class="data-row">' +
      '<td class="data-td"><span class="text-muted" style="font-variant-numeric:tabular-nums">' + escapeHtml(formatLocalDateTime(e.createdAt)) + '</span></td>' +
      '<td class="data-td"><strong>' + escapeHtml(e.staffName || '?') + '</strong></td>' +
      '<td class="data-td"><span class="badge ' + cls + '">' + escapeHtml(label) + '</span></td>' +
      '<td class="data-td">' + orderCell + '</td>' +
      '<td class="data-td">' + tableCell + '</td>' +
      '<td class="data-td" title="' + escapeHtml(rawJson) + '">' + escapeHtml(desc) + '</td>' +
    '</tr>';
  }).join('');
}

function render() {
  if (!_container) return;
  const staffOptionsHtml = '<option value="">Všetci čašníci</option>' +
    _staffList.map((s) => '<option value="' + s.id + '"' + (String(s.id) === String(_staffFilter) ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>').join('');
  const typeOptionsHtml = '<option value="">Všetky akcie</option>' +
    _typeList.map((t) => '<option value="' + escapeHtml(t) + '"' + (t === _typeFilter ? ' selected' : '') + '>' + escapeHtml(TYPE_LABELS[t] || t) + '</option>').join('');

  _container.innerHTML =
    '<div class="doch-toolbar">' +
      '<div class="doch-toolbar-dates">' +
        '<label class="doch-toolbar-label">Od' +
          '<input type="date" id="aFrom" class="doch-input" value="' + _from + '">' +
        '</label>' +
        '<label class="doch-toolbar-label">Do' +
          '<input type="date" id="aTo" class="doch-input" value="' + _to + '">' +
        '</label>' +
        '<label class="doch-toolbar-label">Čašník' +
          '<select id="aStaff" class="doch-input">' + staffOptionsHtml + '</select>' +
        '</label>' +
        '<label class="doch-toolbar-label">Typ akcie' +
          '<select id="aType" class="doch-input">' + typeOptionsHtml + '</select>' +
        '</label>' +
        '<label class="doch-toolbar-label">Č. objednávky' +
          '<input type="number" id="aOrder" class="doch-input" value="' + escapeHtml(_orderFilter) + '" placeholder="napr. 123" style="width:120px">' +
        '</label>' +
        '<div class="doch-toolbar-presets">' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="0">Dnes</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="1">Včera</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="7">7 dní</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="30">30 dní</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<span id="auditCount" class="text-muted" style="font-size:13px"></span>' +
        '<button class="btn-add" id="aRefresh">Obnoviť</button>' +
      '</div>' +
    '</div>' +

    '<div class="panel doch-panel">' +
      '<div class="panel-title">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>' +
        ' História operácií nad objednávkami' +
      '</div>' +
      '<div class="table-scroll-wrap">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th class="data-th">Čas</th>' +
            '<th class="data-th">Čašník</th>' +
            '<th class="data-th">Akcia</th>' +
            '<th class="data-th">Objednávka</th>' +
            '<th class="data-th">Stôl</th>' +
            '<th class="data-th">Detail</th>' +
          '</tr></thead>' +
          '<tbody id="auditBody"></tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  bind();
  loadEvents();
}

function bind() {
  _container.querySelector('#aRefresh').addEventListener('click', () => {
    _from = _container.querySelector('#aFrom').value || _from;
    _to = _container.querySelector('#aTo').value || _to;
    _staffFilter = _container.querySelector('#aStaff').value || '';
    _typeFilter = _container.querySelector('#aType').value || '';
    _orderFilter = (_container.querySelector('#aOrder').value || '').trim();
    loadEvents();
  });

  _container.querySelectorAll('.doch-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.preset, 10);
      _to = todayIso();
      _from = todayMinusDaysIso(n);
      _container.querySelector('#aFrom').value = _from;
      _container.querySelector('#aTo').value = _to;
      loadEvents();
    });
  });

  // Live filter on selects/order field — saves a click vs hitting Refresh
  _container.querySelector('#aStaff').addEventListener('change', (e) => {
    _staffFilter = e.target.value || '';
    loadEvents();
  });
  _container.querySelector('#aType').addEventListener('change', (e) => {
    _typeFilter = e.target.value || '';
    loadEvents();
  });
  // Debounce the number input so we don't fire a request on every keystroke
  let _t = null;
  _container.querySelector('#aOrder').addEventListener('input', (e) => {
    clearTimeout(_t);
    _t = setTimeout(() => {
      _orderFilter = (e.target.value || '').trim();
      loadEvents();
    }, 350);
  });
}

export async function init(container) {
  _container = container;
  await Promise.all([loadStaffList(), loadTypeList()]);
  render();
}

export function destroy() {
  _container = null;
  _staffFilter = '';
  _typeFilter = '';
  _orderFilter = '';
}
