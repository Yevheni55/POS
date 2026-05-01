'use strict';

let _container = null;
let _from = todayMinusDays(7);
let _to = today();
let _summary = { rows: [] };
let _expanded = null; // staffId currently expanded

function todayIso() { return new Date().toISOString().slice(0, 10); }
function today() { return todayIso(); }
function todayMinusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(m) {
  if (!Number.isFinite(m)) return '0h 0m';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm';
}
function fmtEur(n) { return Number(n || 0).toFixed(2) + ' €'; }
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadSummary() {
  const res = await api.get(`/attendance/summary?from=${_from}&to=${_to}`);
  _summary = res || { rows: [] };
  render();
}

async function loadHistory(staffId) {
  return api.get(`/attendance/history/${staffId}?from=${_from}&to=${_to}`);
}

function render() {
  if (!_container) return;
  _container.innerHTML =
    '<header class="admin-page-header"><h1>Dochadzka</h1></header>' +
    '<div class="admin-toolbar">' +
      '<label>Od <input type="date" id="dFrom" value="' + _from + '"></label>' +
      '<label>Do <input type="date" id="dTo" value="' + _to + '"></label>' +
      '<button class="admin-btn" id="dRefresh">Obnovit</button>' +
    '</div>' +
    '<table class="admin-table doch-table">' +
      '<thead><tr><th>Meno</th><th>Pozicia</th><th>Sadza</th><th>Hodiny</th><th>Otv. smeny</th><th>Mzda</th><th></th></tr></thead>' +
      '<tbody id="dBody"></tbody>' +
    '</table>' +
    '<div id="dDetail"></div>';

  _container.querySelector('#dRefresh').addEventListener('click', () => {
    _from = _container.querySelector('#dFrom').value;
    _to = _container.querySelector('#dTo').value;
    loadSummary();
  });

  const body = _container.querySelector('#dBody');
  if (!_summary.rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">Ziadne data</td></tr>';
    return;
  }
  body.innerHTML = _summary.rows.map((r) => (
    '<tr data-staff="' + r.staffId + '">' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + escapeHtml(r.position || '') + '</td>' +
      '<td>' + (r.hourlyRate != null ? fmtEur(r.hourlyRate) + '/h' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + fmtMinutes(r.minutes) + '</td>' +
      '<td>' + (r.openShifts > 0 ? '<span class="badge warn">' + r.openShifts + '</span>' : '0') + '</td>' +
      '<td>' + fmtEur(r.wage) + '</td>' +
      '<td><button class="admin-btn-mini" data-toggle="' + r.staffId + '">Detail</button></td>' +
    '</tr>'
  )).join('');

  body.querySelectorAll('button[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleDetail(parseInt(b.getAttribute('data-toggle'), 10)));
  });
}

async function toggleDetail(staffId) {
  if (_expanded === staffId) {
    _expanded = null;
    _container.querySelector('#dDetail').innerHTML = '';
    return;
  }
  _expanded = staffId;
  const detail = _container.querySelector('#dDetail');
  detail.innerHTML = '<div class="muted">Nacitavam…</div>';
  const data = await loadHistory(staffId);
  const evRows = data.events.map((e) => (
    '<tr>' +
      '<td>' + new Date(e.at).toLocaleString('sk-SK') + '</td>' +
      '<td>' + (e.type === 'clock_in' ? 'Prichod' : 'Odchod') + '</td>' +
      '<td>' + escapeHtml(e.source || '') + '</td>' +
      '<td>' + escapeHtml(e.note || '') + '</td>' +
      '<td><button class="admin-btn-mini danger" data-del="' + e.id + '">×</button></td>' +
    '</tr>'
  )).join('');

  detail.innerHTML =
    '<h3>Detail — ' + escapeHtml(data.staff && data.staff.name || '') + '</h3>' +
    '<form id="dManualForm" class="admin-toolbar">' +
      '<label>Typ <select id="mType"><option value="clock_in">Prichod</option><option value="clock_out">Odchod</option></select></label>' +
      '<label>Cas <input type="datetime-local" id="mAt" required></label>' +
      '<label>Poznamka <input type="text" id="mNote" maxlength="200"></label>' +
      '<button class="admin-btn" type="submit">Pridat zaznam</button>' +
    '</form>' +
    '<table class="admin-table"><thead><tr><th>Cas</th><th>Typ</th><th>Zdroj</th><th>Poznamka</th><th></th></tr></thead><tbody>' +
    (evRows || '<tr><td colspan="5" class="muted">Bez zaznamov</td></tr>') +
    '</tbody></table>';

  detail.querySelector('#dManualForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const at = detail.querySelector('#mAt').value;
    const type = detail.querySelector('#mType').value;
    const note = detail.querySelector('#mNote').value;
    await api.post('/attendance/events', { staffId, type, at: new Date(at).toISOString(), note });
    await loadSummary();
    await toggleDetail(staffId); // close
    await toggleDetail(staffId); // re-open with new data
  });
  detail.querySelectorAll('button[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Vymazat zaznam?')) return;
      await api.del('/attendance/events/' + b.getAttribute('data-del'));
      await loadSummary();
      await toggleDetail(staffId); await toggleDetail(staffId);
    });
  });
}

export function init(container) {
  _container = container;
  loadSummary();
}

export function destroy() {
  _container = null;
  _expanded = null;
}
