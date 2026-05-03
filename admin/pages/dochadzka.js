'use strict';

// Admin -> Dochadzka. Reuses the existing design system:
//  - .panel / .panel-title for sections
//  - .data-table for the staff list and the per-staff event log
//  - .stat-grid / .stat-card for the top KPI strip
//  - .badge-warning / .badge-info for inline status pills
//  - showConfirm() for destructive confirms (no native confirm())
//  - showToast() for non-blocking feedback

let _container = null;
let _from = todayMinusDays(7);
let _to = todayIso();
let _summary = { rows: [] };
let _expanded = null; // staffId currently expanded
// Staff filter: 'all' = show every staff member, otherwise the staffId
// (kept as string from the <select>) restricts the table + KPIs to that
// person only. The /summary endpoint returns every staff regardless, so
// filtering is purely client-side and a change re-renders without a
// network round-trip.
let _staffFilter = 'all';

function todayIso() { return new Date().toISOString().slice(0, 10); }
function todayMinusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(m) {
  if (!Number.isFinite(m) || m <= 0) return '0h 0m';
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
function formatLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatLocalDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatLocalTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

// Group raw clock events into shifts. Pairs each clock_in with the next
// clock_out; an unmatched clock_in becomes an "open" shift (operator forgot
// to clock out and the cron hasn't run yet). An orphan clock_out (no prior
// open clock_in inside the window) is shown with a '—' start so the row
// is still visible — most often it means the matching clock_in is just
// before the selected period.
function buildShifts(eventsAsc) {
  const shifts = [];
  let pending = null;
  for (const e of eventsAsc) {
    if (e.type === 'clock_in') {
      if (pending) shifts.push({ start: pending, end: null });
      pending = e;
    } else if (e.type === 'clock_out') {
      if (pending) {
        shifts.push({ start: pending, end: e });
        pending = null;
      } else {
        shifts.push({ start: null, end: e });
      }
    }
  }
  if (pending) shifts.push({ start: pending, end: null });
  for (const s of shifts) {
    if (s.start && s.end) {
      const ms = new Date(s.end.at).getTime() - new Date(s.start.at).getTime();
      s.minutes = ms > 0 ? Math.round(ms / 60000) : 0;
    } else {
      s.minutes = null;
    }
  }
  return shifts;
}
// Build a value compatible with <input type="datetime-local"> (local TZ)
function nowForDateTimeLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

async function loadSummary() {
  try {
    const res = await api.get(`/attendance/summary?from=${_from}&to=${_to}`);
    _summary = res || { rows: [] };
  } catch (err) {
    _summary = { rows: [] };
    showToast(err.message || 'Chyba načítania prehlěadu', 'error');
  }
  // If the previously selected staff is no longer in the result (e.g. user
  // changed the date range), drop the filter back to 'all' so the dropdown's
  // visible state matches our stored filter.
  if (_staffFilter !== 'all') {
    const stillThere = (_summary.rows || []).some(
      (r) => String(r.staffId) === String(_staffFilter),
    );
    if (!stillThere) _staffFilter = 'all';
  }
  render();
}

async function loadHistory(staffId) {
  return api.get(`/attendance/history/${staffId}?from=${_from}&to=${_to}`);
}

function totalsFor(rows) {
  let totalMinutes = 0, totalWage = 0, openShifts = 0, withRate = 0;
  for (const r of rows) {
    totalMinutes += Number(r.minutes) || 0;
    totalWage += Number(r.wage) || 0;
    openShifts += Number(r.openShifts) || 0;
    if (r.hourlyRate != null) withRate += 1;
  }
  return { totalMinutes, totalWage, openShifts, totalStaff: rows.length, withRate };
}

function render() {
  if (!_container) return;

  // Apply the staff filter once so KPI cards, body table, and the auto-open
  // detail all see the same view. _summary still holds every staff (the
  // server returns the full list), so toggling the dropdown is free.
  const allRows = _summary.rows || [];
  const visibleRows = _staffFilter === 'all'
    ? allRows
    : allRows.filter((r) => String(r.staffId) === String(_staffFilter));

  const t = totalsFor(visibleRows);

  const staffOptionsHtml = '<option value="all">Všetci zamestnanci</option>' +
    allRows.map((r) => {
      const sel = String(r.staffId) === String(_staffFilter) ? ' selected' : '';
      return '<option value="' + r.staffId + '"' + sel + '>' + escapeHtml(r.name || '?') + '</option>';
    }).join('');

  const html =
    '<div class="doch-toolbar">' +
      '<div class="doch-toolbar-dates">' +
        '<label class="doch-toolbar-label">Od' +
          '<input type="date" id="dFrom" class="doch-input" value="' + _from + '">' +
        '</label>' +
        '<label class="doch-toolbar-label">Do' +
          '<input type="date" id="dTo" class="doch-input" value="' + _to + '">' +
        '</label>' +
        '<label class="doch-toolbar-label">Zamestnanec' +
          '<select id="dStaff" class="doch-input">' + staffOptionsHtml + '</select>' +
        '</label>' +
        '<div class="doch-toolbar-presets">' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="7">7 dní</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="30">30 dní</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="month">Tento mesiac</button>' +
        '</div>' +
      '</div>' +
      '<button class="btn-add" id="dRefresh">' +
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 015 5 5 5 0 01-5 5 5 5 0 01-3.5-1.4L3 13l-1-3 3 1-1.1 1.1A4 4 0 008 12a4 4 0 100-8 4 4 0 00-3.5 2H6V5H2v4h1V7.5A5 5 0 018 3z"/></svg>' +
        'Obnoviť' +
      '</button>' +
    '</div>' +

    '<div class="stat-grid doch-stats">' +
      '<div class="stat-card">' +
        '<div class="stat-icon ice">' +
          '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Spolu hodín</div>' +
          '<div class="stat-value">' + escapeHtml(fmtMinutes(t.totalMinutes)) + '</div>' +
          '<div class="stat-change neutral">' + t.totalStaff + ' ' + (t.totalStaff === 1 ? 'zamestnanec' : 'zamestnancov') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon mint">' +
          '<svg viewBox="0 0 24 24"><path d="M3 7h18M3 12h18M3 17h18"/><path d="M7 5v14M17 5v14"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Mzda spolu</div>' +
          '<div class="stat-value">' + escapeHtml(fmtEur(t.totalWage)) + '</div>' +
          '<div class="stat-change neutral">' + t.withRate + ' so sadzbou</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon lavender">' +
          '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M3 21a9 9 0 0118 0"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Aktívni</div>' +
          '<div class="stat-value">' + t.totalStaff + '</div>' +
          '<div class="stat-change neutral">' + (_from === _to ? 'dnes' : (_from + ' → ' + _to)) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon ' + (t.openShifts > 0 ? 'amber' : 'mint') + '">' +
          '<svg viewBox="0 0 24 24"><path d="M12 8v5l3 2"/><circle cx="12" cy="12" r="9"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Otvorené smeny</div>' +
          '<div class="stat-value">' + t.openShifts + '</div>' +
          '<div class="stat-change ' + (t.openShifts > 0 ? 'neutral' : 'up') + '">' +
            (t.openShifts > 0 ? 'Treba zatvoriť ručne' : 'Všetko v poriadku') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="panel doch-panel">' +
      '<div class="panel-title">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        ' Prehlěad za obdobie' +
      '</div>' +
      '<div id="dBodyWrap" class="table-scroll-wrap">' +
        '<table class="data-table doch-table">' +
          '<thead><tr>' +
            '<th class="data-th">Meno</th>' +
            '<th class="data-th">Pozícia</th>' +
            '<th class="data-th">Sadzba</th>' +
            '<th class="data-th">Hodín</th>' +
            '<th class="data-th">Otv. smeny</th>' +
            '<th class="data-th">Mzda</th>' +
            '<th class="data-th"></th>' +
          '</tr></thead>' +
          '<tbody id="dBody"></tbody>' +
        '</table>' +
      '</div>' +
    '</div>' +

    '<div id="dDetail" class="doch-detail-host"></div>';

  _container.innerHTML = html;

  _container.querySelector('#dRefresh').addEventListener('click', () => {
    _from = _container.querySelector('#dFrom').value || _from;
    _to = _container.querySelector('#dTo').value || _to;
    _expanded = null;
    loadSummary();
  });

  // Staff filter change: re-render only (no network) and clear any open
  // detail because the previously expanded staff may now be hidden.
  _container.querySelector('#dStaff').addEventListener('change', (e) => {
    _staffFilter = e.target.value || 'all';
    _expanded = null;
    render();
  });

  _container.querySelectorAll('.doch-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      if (preset === 'month') {
        const d = new Date();
        const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        _from = first.toISOString().slice(0, 10);
        _to = todayIso();
      } else {
        _from = todayMinusDays(parseInt(preset, 10));
        _to = todayIso();
      }
      _expanded = null;
      loadSummary();
    });
  });

  renderBody();
}

function renderBody() {
  const body = _container.querySelector('#dBody');
  const allRows = _summary.rows || [];
  // Mirror the filter applied in render() so the body table, KPI cards and
  // dropdown all stay consistent.
  const rows = _staffFilter === 'all'
    ? allRows
    : allRows.filter((r) => String(r.staffId) === String(_staffFilter));
  if (!rows.length) {
    const msg = _staffFilter === 'all'
      ? 'Žiadne dáta za toto obdobie. Zamestnanci s nastaveným dochádzka PIN-om sa objavia po prvom Príchode.'
      : 'Vybraný zamestnanec nemá v tomto období žiadne záznamy.';
    body.innerHTML = '<tr><td class="data-td" colspan="7">' +
      '<div class="empty-hint">' + escapeHtml(msg) + '</div>' +
      '</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r) => {
    const isOpen = _expanded === r.staffId;
    const wageCell = r.hourlyRate != null
      ? fmtEur(r.wage)
      : '<span class="text-muted">—</span>';
    const rateCell = r.hourlyRate != null
      ? fmtEur(r.hourlyRate) + '/h'
      : '<span class="text-muted">nie je</span>';
    const openCell = r.openShifts > 0
      ? '<span class="badge badge-warning">' + r.openShifts + '</span>'
      : '<span class="text-muted">0</span>';
    return '<tr class="data-row" data-staff="' + r.staffId + '">' +
      '<td class="data-td"><strong>' + escapeHtml(r.name) + '</strong></td>' +
      '<td class="data-td">' + (r.position
        ? escapeHtml(r.position)
        : '<span class="text-muted">—</span>') + '</td>' +
      '<td class="data-td">' + rateCell + '</td>' +
      '<td class="data-td"><strong>' + escapeHtml(fmtMinutes(r.minutes)) + '</strong></td>' +
      '<td class="data-td">' + openCell + '</td>' +
      '<td class="data-td num">' + wageCell + '</td>' +
      '<td class="data-td">' +
        '<button class="btn-edit doch-detail-btn" data-toggle="' + r.staffId + '">' +
          (isOpen ? 'Skryť' : 'Detail') +
        '</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  body.querySelectorAll('button[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleDetail(parseInt(b.getAttribute('data-toggle'), 10)));
  });
}

async function toggleDetail(staffId) {
  const detail = _container.querySelector('#dDetail');
  if (_expanded === staffId) {
    _expanded = null;
    detail.innerHTML = '';
    renderBody();
    return;
  }
  _expanded = staffId;
  renderBody();

  detail.innerHTML = '<div class="panel doch-detail-panel">' +
    '<div class="loading-hint">Načítavam históriu…</div></div>';

  let data;
  try {
    data = await loadHistory(staffId);
  } catch (err) {
    detail.innerHTML = '<div class="panel doch-detail-panel"><div class="empty-hint">' +
      escapeHtml(err.message || 'Chyba načítania') + '</div></div>';
    return;
  }

  const events = (data.events || []).slice().reverse(); // newest first
  const reasonLabels = {
    forgot: 'Zabudol kliknúť',
    wrong_time: 'Nesprávny čas',
    shift_change: 'Zmena zmeny',
    pin_failed: 'PIN zlyhal',
    other: 'Iné',
  };
  const evRows = events.map((e) => {
    let sourceCell;
    if (e.source === 'auto_close') sourceCell = '<span class="badge badge-warning">auto-zatvorené</span>';
    else if (e.source === 'manual') sourceCell = '<span class="badge badge-warning">manuálne</span>';
    else sourceCell = '<span class="text-muted">PIN</span>';
    const reasonCell = e.reason
      ? '<span class="text-muted">' + escapeHtml(reasonLabels[e.reason] || e.reason) + '</span>'
      : '<span class="text-muted">—</span>';
    return (
      '<tr class="data-row">' +
        '<td class="data-td">' + escapeHtml(formatLocalDateTime(e.at)) + '</td>' +
        '<td class="data-td">' + (e.type === 'clock_in'
          ? '<span class="badge badge-success">Príchod</span>'
          : '<span class="badge badge-info">Odchod</span>') + '</td>' +
        '<td class="data-td">' + sourceCell + '</td>' +
        '<td class="data-td">' + reasonCell + '</td>' +
        '<td class="data-td">' + (e.note ? escapeHtml(e.note) : '<span class="text-muted">—</span>') + '</td>' +
        '<td class="data-td">' +
          '<button class="btn-toggle-status doch-event-del" data-del="' + e.id + '" title="Vymazať záznam">✕</button>' +
        '</td>' +
      '</tr>'
    );
  }).join('');

  const summary = data.summary || {};
  const staffMeta = data.staff || {};
  const summaryLine = (summary.openShifts > 0)
    ? '<span class="badge badge-warning">' + summary.openShifts + ' otvorená smena</span> '
    : '';
  const autoCount = (data.events || []).filter((e) => e.source === 'auto_close').length;
  const autoLine = autoCount > 0
    ? '<span class="badge badge-warning">' + autoCount + ' auto-zatvorené</span> '
    : '';

  // Build per-shift rows (newest first). Wage per shift uses the staff's
  // current hourlyRate from the parent summary; if no rate is set we just
  // show '—' so the column stays visually consistent.
  const eventsAsc = (data.events || []).slice();
  const shifts = buildShifts(eventsAsc);
  const parentRow = (_summary.rows || []).find((r) => r.staffId === staffId);
  const rate = parentRow && parentRow.hourlyRate != null ? Number(parentRow.hourlyRate) : null;
  const completed = shifts.filter((s) => s.start && s.end).length;
  const open = shifts.filter((s) => s.start && !s.end).length;
  const shiftRowsHtml = shifts.length === 0
    ? '<tr><td class="data-td" colspan="7"><div class="empty-hint">Žiadne smeny v tomto období.</div></td></tr>'
    : shifts.slice().reverse().map((s) => {
        const refIso = (s.start && s.start.at) || (s.end && s.end.at) || '';
        const dateCell = escapeHtml(formatLocalDate(refIso));
        const startCell = s.start
          ? escapeHtml(formatLocalTime(s.start.at))
          : '<span class="text-muted">—</span>';
        const endCell = s.end
          ? escapeHtml(formatLocalTime(s.end.at))
          : '<span class="badge badge-warning">otvorená</span>';
        const durCell = s.minutes != null
          ? '<strong>' + escapeHtml(fmtMinutes(s.minutes)) + '</strong>'
          : '<span class="text-muted">—</span>';
        const wage = (s.minutes != null && rate != null && rate > 0)
          ? (s.minutes / 60) * rate
          : null;
        const wageCell = wage != null
          ? escapeHtml(fmtEur(wage))
          : '<span class="text-muted">—</span>';
        const flags = [];
        if (s.start && s.start.source === 'manual') flags.push('<span class="badge badge-warning">manuál (in)</span>');
        if (s.end && s.end.source === 'auto_close') flags.push('<span class="badge badge-warning">auto-zatv</span>');
        if (s.end && s.end.source === 'manual') flags.push('<span class="badge badge-warning">manuál (out)</span>');
        // Paid pill or "Označiť ako vyplatené" button. Only for closed
        // shifts (need a clock_out event id to link to). For open shifts
        // we just show '—' since the wage isn't final yet anyway.
        let paidCell;
        if (s.end && s.end.id) {
          if (s.end.paid) {
            const paidDate = formatLocalDate(s.end.paid.paidAt);
            paidCell = '<button type="button" class="doch-paid-pill" data-unpay="' + s.end.paid.id + '" title="Klik = zrušiť výplatu">' +
              '<span class="doch-paid-icon">✓</span> Vyplatené ' + escapeHtml(paidDate) +
            '</button>';
          } else if (wage != null) {
            paidCell = '<button type="button" class="doch-pay-btn" data-pay-out="' + s.end.id + '" data-pay-amount="' + wage.toFixed(2) + '">Označiť ako vyplatené</button>';
          } else {
            paidCell = '<span class="text-muted">— (bez sadzby)</span>';
          }
        } else {
          paidCell = '<span class="text-muted">—</span>';
        }
        return '<tr class="data-row">' +
          '<td class="data-td">' + dateCell + '</td>' +
          '<td class="data-td">' + startCell + '</td>' +
          '<td class="data-td">' + endCell + '</td>' +
          '<td class="data-td">' + durCell + '</td>' +
          '<td class="data-td num">' + wageCell + '</td>' +
          '<td class="data-td">' + paidCell + '</td>' +
          '<td class="data-td">' + (flags.join(' ') || '<span class="text-muted">—</span>') + '</td>' +
        '</tr>';
      }).join('');
  const shiftHeadCounts = (completed > 0 || open > 0)
    ? ' <span class="text-muted" style="font-weight:500;font-size:12px">(' +
        completed + ' ' + (completed === 1 ? 'smena' : (completed >= 2 && completed <= 4 ? 'smeny' : 'smien')) +
        (open > 0 ? ', ' + open + ' otvorená' : '') +
      ')</span>'
    : '';

  detail.innerHTML =
    '<div class="panel doch-detail-panel">' +
      '<div class="panel-title">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="8" r="4"/><path d="M3 21a9 9 0 0118 0"/></svg>' +
        ' Detail — ' + escapeHtml(staffMeta.name || '') +
      '</div>' +

      '<div class="doch-detail-summary">' +
        summaryLine +
        autoLine +
        '<span class="text-muted">Hodín:</span> <strong>' + escapeHtml(fmtMinutes(summary.minutes)) + '</strong>' +
        '<span class="dot-sep">·</span>' +
        '<span class="text-muted">Mzda:</span> <strong>' + escapeHtml(fmtEur(summary.wage)) + '</strong>' +
        (staffMeta.position ? ('<span class="dot-sep">·</span>' +
          '<span class="text-muted">Pozícia:</span> <strong>' + escapeHtml(staffMeta.position) + '</strong>') : '') +
      '</div>' +

      '<div class="doch-subhead">Smeny' + shiftHeadCounts + '</div>' +
      '<div class="table-scroll-wrap" style="margin-bottom:14px">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th class="data-th">Dátum</th>' +
            '<th class="data-th">Príchod</th>' +
            '<th class="data-th">Odchod</th>' +
            '<th class="data-th">Trvanie</th>' +
            '<th class="data-th">Mzda</th>' +
            '<th class="data-th">Vyplatené</th>' +
            '<th class="data-th">Pozn.</th>' +
          '</tr></thead>' +
          '<tbody>' + shiftRowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +

      '<div class="doch-subhead">Manuálna úprava</div>' +
      '<form class="doch-manual-form" id="dManualForm">' +
        '<label class="doch-toolbar-label">Typ' +
          '<select id="mType" class="doch-input">' +
            '<option value="clock_in">Príchod</option>' +
            '<option value="clock_out">Odchod</option>' +
          '</select>' +
        '</label>' +
        '<label class="doch-toolbar-label">Dôvod' +
          '<select id="mReason" class="doch-input" required>' +
            '<option value="">— vyber —</option>' +
            '<option value="forgot">Zabudol kliknúť</option>' +
            '<option value="wrong_time">Nesprávny čas</option>' +
            '<option value="shift_change">Zmena zmeny</option>' +
            '<option value="pin_failed">PIN zlyhal</option>' +
            '<option value="other">Iné</option>' +
          '</select>' +
        '</label>' +
        '<label class="doch-toolbar-label">Čas' +
          '<input type="datetime-local" id="mAt" class="doch-input" value="' + nowForDateTimeLocal() + '" required>' +
        '</label>' +
        '<label class="doch-toolbar-label" style="flex:1;min-width:200px">Poznámka' +
          '<input type="text" id="mNote" class="doch-input" maxlength="200" placeholder="napr. zabudol kliknúť">' +
        '</label>' +
        '<button class="btn-save doch-manual-submit" type="submit">Pridať záznam</button>' +
      '</form>' +

      '<div class="doch-subhead">Záznamy (audit)</div>' +
      '<div class="table-scroll-wrap">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th class="data-th">Čas</th>' +
            '<th class="data-th">Typ</th>' +
            '<th class="data-th">Zdroj</th>' +
            '<th class="data-th">Dôvod</th>' +
            '<th class="data-th">Poznámka</th>' +
            '<th class="data-th"></th>' +
          '</tr></thead>' +
          '<tbody>' +
            (evRows || '<tr><td class="data-td" colspan="6"><div class="empty-hint">Bez záznamov za toto obdobie.</div></td></tr>') +
          '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  detail.querySelector('#dManualForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const at = detail.querySelector('#mAt').value;
    const type = detail.querySelector('#mType').value;
    const reason = detail.querySelector('#mReason').value;
    const note = detail.querySelector('#mNote').value.trim();
    if (!at || !reason) {
      showToast('Vyber čas aj dôvod úpravy', 'error');
      return;
    }
    try {
      await api.post('/attendance/events', {
        staffId, type,
        at: new Date(at).toISOString(),
        reason, note,
      });
      showToast('Záznam pridaný', true);
      await loadSummary();
      _expanded = null;
      await toggleDetail(staffId);
    } catch (err) {
      showToast(err.message || 'Záznam sa nepodarilo pridať', 'error');
    }
  });

  detail.querySelectorAll('button[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-del');
      showConfirm(
        'Vymazať záznam?',
        'Toto natrvalo odstráni záznam dochádzky. Mzdový prepočet sa obnoví.',
        async () => {
          try {
            await api.del('/attendance/events/' + id);
            showToast('Záznam vymazaný', true);
            await loadSummary();
            _expanded = null;
            await toggleDetail(staffId);
          } catch (err) {
            showToast(err.message || 'Nepodarilo sa vymazať', 'error');
          }
        },
        { type: 'danger', confirmText: 'Vymazať' },
      );
    });
  });

  // Mark a shift as paid: confirm dialog shows the amount about to be
  // moved into cashflow as a salary expense, then POSTs.
  detail.querySelectorAll('button[data-pay-out]').forEach((b) => {
    b.addEventListener('click', () => {
      const clockOutEventId = parseInt(b.getAttribute('data-pay-out'), 10);
      const amount = Number(b.getAttribute('data-pay-amount'));
      showConfirm(
        'Označiť ako vyplatené?',
        'Vyplata ' + fmtEur(amount) + ' sa zapíše ako výdavok do Cashflow (kategória "Mzdy / odmeny"). Túto akciu vieš vrátiť.',
        async () => {
          try {
            await api.post('/attendance/payouts', { clockOutEventId, amount });
            showToast('Smena označená ako vyplatená', true);
            await loadSummary();
            _expanded = null;
            await toggleDetail(staffId);
          } catch (err) {
            showToast(err.message || 'Označenie zlyhalo', 'error');
          }
        },
        { confirmText: 'Označiť' },
      );
    });
  });
  // Unpay (click on the green pill) — also removes the linked cashflow row.
  detail.querySelectorAll('button[data-unpay]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-unpay'), 10);
      showConfirm(
        'Zrušiť výplatu tejto smeny?',
        'Súčasne sa odstráni aj zodpovedajúci záznam v Cashflow.',
        async () => {
          try {
            await api.del('/attendance/payouts/' + id);
            showToast('Výplata zrušená', true);
            await loadSummary();
            _expanded = null;
            await toggleDetail(staffId);
          } catch (err) {
            showToast(err.message || 'Zrušenie zlyhalo', 'error');
          }
        },
        { type: 'danger', confirmText: 'Zrušiť' },
      );
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
  _summary = { rows: [] };
  _staffFilter = 'all';
}
