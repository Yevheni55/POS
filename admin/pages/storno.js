// admin/pages/storno.js
//
// Storno koš — manager spracúva stornované poslané položky. Presunuté z POS
// table-view (floating pill) sem do admin panelu, lebo rozhodnutie
// "vrátiť na sklad vs odpísať" je manažérska úloha, nie cashier flow.
//
// API (server/routes/storno-basket.js):
//   GET    /api/storno-basket            → { summary, items }
//   POST   /api/storno-basket/:id/resolve  body { override:{ wasPrepared } }
//   DELETE /api/storno-basket/:id

import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
let _socketHandler = null;

function $(sel) { return _container ? _container.querySelector(sel) : null; }
function fmtEur(n) { return fmtCost(n) + ' €'; }
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const REASON_LABELS = {
  order_error: 'Chyba obj.',
  complaint: 'Reklamácia',
  breakage: 'Rozbité',
  staff_meal: 'Zam. spotreba',
  other: 'Iné',
};

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sk-SK', {
    timeZone: 'Europe/Bratislava',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function load() {
  try {
    _data = await api.get('/storno-basket');
  } catch (err) {
    _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
    if (typeof showToast === 'function') showToast(err.message || 'Chyba načítania storno koša', 'error');
  }
  render();
}

function render() {
  if (!_container) return;
  const s = _data.summary || { pendingCount: 0, pendingValue: 0, rowCount: 0 };
  const items = _data.items || [];

  const rowsHtml = items.length
    ? items.map((it) => {
        const pricedQty = (Number(it.unitPrice || 0) * it.qty);
        const suggested = it.wasPrepared
          ? '<span style="font-size:11px;color:#b45309">🔥 Čašník: pripravené</span>'
          : '<span style="font-size:11px;color:#4338ca">🔄 Čašník: nepripravené</span>';
        const reason = REASON_LABELS[it.reason] || it.reason || '';
        return '<tr class="data-row" data-id="' + it.id + '">' +
          '<td class="data-td"><strong>' + esc(it.itemName) + '</strong> &times;' + it.qty +
            '<div style="margin-top:2px">' + suggested + '</div></td>' +
          '<td class="data-td">' + esc(reason) + '</td>' +
          '<td class="data-td">' + esc(it.staffName || '') + '</td>' +
          '<td class="data-td">' + esc(fmtTime(it.createdAt)) + '</td>' +
          '<td class="data-td">' + (it.note ? esc(it.note) : '<span class="text-muted">—</span>') + '</td>' +
          '<td class="data-td num text-right"><strong>' + fmtEur(pricedQty) + '</strong></td>' +
          '<td class="data-td" style="white-space:nowrap">' +
            '<button class="btn-edit storno-return" data-id="' + it.id + '" style="background:rgba(76,175,80,.1);border-color:rgba(76,175,80,.35);color:#2e7d32" title="Suroviny späť na sklad (jedlo nebolo urobené)">🔄 Vrátiť</button> ' +
            '<button class="btn-edit storno-writeoff" data-id="' + it.id + '" style="background:rgba(220,80,80,.1);border-color:rgba(220,80,80,.35);color:#b91c1c" title="Odpísať: jedlo bolo urobené, ide ako strata">🔥 Odpísať</button> ' +
            '<button class="btn-edit storno-delete" data-id="' + it.id + '" title="Zmazať záznam bez akcie skladu (storno bolo omyl)">×</button>' +
          '</td>' +
        '</tr>';
      }).join('')
    : '<tr><td class="data-td" colspan="7"><div class="empty-hint" style="padding:32px;text-align:center">Žiadne čakajúce storná 🎉</div></td></tr>';

  _container.innerHTML =
    '<div class="stat-grid" style="margin-bottom:18px">' +
      '<div class="stat-card">' +
        '<div class="stat-icon ' + (s.pendingCount > 0 ? 'amber' : 'mint') + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Čakajúce storná</div>' +
          '<div class="stat-value">' + (s.pendingCount || 0) + '</div>' +
          '<div class="stat-change ' + (s.pendingCount > 0 ? 'neutral' : 'up') + '">' +
            (s.pendingCount > 0 ? (s.rowCount || 0) + ' záznamov' : 'Všetko spracované') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon lavender">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Hodnota</div>' +
          '<div class="stat-value">' + fmtEur(s.pendingValue || 0) + '</div>' +
          '<div class="stat-change neutral">v cenách menu</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="panel">' +
      '<div class="panel-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<span>Storno — čaká na spracovanie</span>' +
        '<button class="btn-secondary" id="stornoRefresh" style="margin-left:auto;font-size:13px">Obnoviť</button>' +
      '</div>' +
      '<div style="font-size:var(--text-sm);color:var(--color-text-sec);margin:-6px 0 14px">' +
        '<b>🔄 Vrátiť</b> = suroviny späť na sklad (jedlo nebolo urobené). ' +
        '<b>🔥 Odpísať</b> = jedlo už bolo urobené, ide ako strata. ' +
        '<b>×</b> = záznam bol omyl, žiadna akcia skladu.' +
      '</div>' +
      '<div class="table-scroll-wrap">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th class="data-th">Položka</th>' +
            '<th class="data-th">Dôvod</th>' +
            '<th class="data-th">Čašník</th>' +
            '<th class="data-th">Čas</th>' +
            '<th class="data-th">Poznámka</th>' +
            '<th class="data-th text-right">Suma</th>' +
            '<th class="data-th"></th>' +
          '</tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  const refreshBtn = $('#stornoRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', load);

  _container.querySelectorAll('.storno-return').forEach((b) => {
    b.addEventListener('click', () => resolveItem(parseInt(b.getAttribute('data-id'), 10), false));
  });
  _container.querySelectorAll('.storno-writeoff').forEach((b) => {
    b.addEventListener('click', () => resolveItem(parseInt(b.getAttribute('data-id'), 10), true));
  });
  _container.querySelectorAll('.storno-delete').forEach((b) => {
    b.addEventListener('click', () => deleteItem(parseInt(b.getAttribute('data-id'), 10)));
  });
}

async function resolveItem(id, wasPrepared) {
  try {
    await api.post('/storno-basket/' + id + '/resolve', { override: { wasPrepared: !!wasPrepared } });
    if (typeof showToast === 'function') {
      showToast(wasPrepared ? 'Odpísané ako strata' : 'Vrátené na sklad', true);
    }
    await load();
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message || 'Spracovanie zlyhalo', 'error');
  }
}

function deleteItem(id) {
  const doDelete = async () => {
    try {
      await api.del('/storno-basket/' + id);
      if (typeof showToast === 'function') showToast('Záznam zmazaný', true);
      await load();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Zmazanie zlyhalo', 'error');
    }
  };
  if (typeof showConfirm === 'function') {
    showConfirm(
      'Zmazať storno záznam?',
      'Záznam sa odstráni bez akcie skladu (storno bolo omyl). Suroviny sa nevrátia ani neodpíšu.',
      doDelete,
      { type: 'danger', confirmText: 'Zmazať' },
    );
  } else {
    doDelete();
  }
}

export function init(container) {
  _container = container;
  load();
  // Auto-refresh keď cashier zaznamená nové storno (ak admin má socket).
  if (typeof socket !== 'undefined' && socket && typeof socket.on === 'function') {
    _socketHandler = function () { load(); };
    socket.on('storno-basket:updated', _socketHandler);
  }
}

export function destroy() {
  if (_socketHandler && typeof socket !== 'undefined' && socket && typeof socket.off === 'function') {
    try { socket.off('storno-basket:updated', _socketHandler); } catch (_) {}
  }
  _socketHandler = null;
  _container = null;
  _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
}
