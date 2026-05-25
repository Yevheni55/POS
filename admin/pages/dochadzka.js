'use strict';

import { fmtCost } from '../../components/fmt.js';

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
function fmtEur(n) { return fmtCost(n) + ' €'; }
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

/**
 * Modal pre výber sumy pri označení smeny ako vyplatenej. Predtým bol
 * len showConfirm s fixnou full-wage sumou — manager nemohol zaznamenať
 * že vyplatil len časť (napr. 30 € z 65 € teraz cash, zvyšok neskôr).
 *
 * UX:
 *  - Default = full wage (najčastejší prípad)
 *  - 3 quick-amount chipy (Celé / 50% / Iné)
 *  - Editovateľný input s validáciou (must be > 0, max = full wage * 1.5
 *    pre prípady kde manazer pridá bonus)
 *  - Enter potvrdí, Esc zruší
 *
 * @param {object} opts
 * @param {number} opts.fullAmount — pôvodná wage suma (default v inpute)
 * @param {function(number):void} opts.onConfirm — callback s vybraným amount
 */
function openPayoutAmountModal({ fullAmount, onConfirm }) {
  const existing = document.getElementById('payoutAmountModal');
  if (existing) existing.remove();
  const fullStr = Number(fullAmount).toFixed(2);
  const halfStr = (Number(fullAmount) / 2).toFixed(2);
  const ov = document.createElement('div');
  ov.id = 'payoutAmountModal';
  ov.className = 'u-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'payoutAmountTitle');
  ov.innerHTML =
    '<div class="u-modal" style="max-width:380px">' +
      '<span class="u-modal-icon" aria-hidden="true">💶</span>' +
      '<div class="u-modal-title" id="payoutAmountTitle">Vyplatená suma</div>' +
      '<div class="u-modal-text">Plná mzda smeny je <strong>' + fmtEur(Number(fullAmount)) + '</strong>. Zadaj koľko si reálne vyplatil — môže byť aj časť (zvyšok zaznačíš neskôr cez ďalší cashflow zápis).</div>' +
      '<div class="u-modal-body" style="margin-top:8px">' +
        '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">' +
          '<button type="button" class="u-btn u-btn-ghost payout-chip" data-amt="' + fullStr + '" style="flex:1;min-width:80px;padding:6px 10px;font-size:12px">Celé</button>' +
          '<button type="button" class="u-btn u-btn-ghost payout-chip" data-amt="' + halfStr + '" style="flex:1;min-width:80px;padding:6px 10px;font-size:12px">Polovica</button>' +
          '<button type="button" class="u-btn u-btn-ghost payout-chip" data-amt="" style="flex:1;min-width:80px;padding:6px 10px;font-size:12px" title="Editovateľne v poli nižšie">Iné</button>' +
        '</div>' +
        '<label for="payoutAmountInput" class="sr-only">Suma vyplatená (€)</label>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<input type="number" id="payoutAmountInput" class="form-input" step="0.01" min="0.01" max="' + (Number(fullAmount) * 1.5).toFixed(2) + '" value="' + fullStr + '" inputmode="decimal" autocomplete="off" style="flex:1;font-size:18px;font-weight:600;text-align:right;font-family:var(--font-display)">' +
          '<span style="font-family:var(--font-display);font-weight:600;font-size:18px;color:var(--color-text-sec)">€</span>' +
        '</div>' +
        '<div id="payoutAmountErr" style="color:var(--color-danger);font-size:12px;margin-top:6px;min-height:14px"></div>' +
      '</div>' +
      '<div class="u-modal-btns">' +
        '<button type="button" class="u-btn u-btn-ghost" id="payoutCancel">Zrušiť</button>' +
        '<button type="button" class="u-btn u-btn-mint" id="payoutConfirm">Označiť ako vyplatené</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  const input = ov.querySelector('#payoutAmountInput');
  const err = ov.querySelector('#payoutAmountErr');
  const confirmBtn = ov.querySelector('#payoutConfirm');
  const cancelBtn = ov.querySelector('#payoutCancel');
  const chips = ov.querySelectorAll('.payout-chip');

  function close() {
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 200);
  }
  function tryConfirm() {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0) {
      err.textContent = 'Suma musí byť kladná';
      input.focus();
      return;
    }
    err.textContent = '';
    close();
    onConfirm(Math.round(v * 100) / 100);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && document.activeElement === input) {
      e.preventDefault();
      tryConfirm();
    }
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      const a = c.getAttribute('data-amt');
      if (a) {
        input.value = a;
        input.focus();
        input.select();
      } else {
        // "Iné" — vyčisti a daj focus pre custom amount
        input.value = '';
        input.focus();
      }
    });
  });
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', tryConfirm);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  setTimeout(function () { input.focus(); input.select(); }, 50);
}

/**
 * Lump-sum payout modal — manager zadá sumu (napr. 200 €), backend rozloží
 * cez najstarsie nezaplatene smeny FIFO. Posledná smena môže byť čiastočne
 * pokrytá.
 *
 * @param {object} opts
 * @param {number} opts.staffId
 * @param {string} opts.staffName
 * @param {number} opts.hourlyRate
 */
function openLumpSumPayoutModal({ staffId, staffName, hourlyRate }) {
  const existing = document.getElementById('lumpSumPayoutModal');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'lumpSumPayoutModal';
  ov.className = 'u-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'lumpSumTitle');
  ov.innerHTML =
    '<div class="u-modal" style="max-width:440px">' +
      '<span class="u-modal-icon" aria-hidden="true">💸</span>' +
      '<div class="u-modal-title" id="lumpSumTitle">Vyplatiť ' + escapeHtml(staffName) + '</div>' +
      '<div class="u-modal-text">Zadaj koľko si reálne vyplatil (cash). Systém ti automaticky pokryje najstaršie nezaplatené smeny FIFO. Posledná smena môže byť čiastočne pokrytá ak suma nesedí na celé smeny.</div>' +
      '<div class="u-modal-body" style="margin-top:8px">' +
        '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">' +
          '<button type="button" class="u-btn u-btn-ghost lump-chip" data-amt="50" style="flex:1;min-width:60px;padding:6px 10px;font-size:12px">50 €</button>' +
          '<button type="button" class="u-btn u-btn-ghost lump-chip" data-amt="100" style="flex:1;min-width:60px;padding:6px 10px;font-size:12px">100 €</button>' +
          '<button type="button" class="u-btn u-btn-ghost lump-chip" data-amt="200" style="flex:1;min-width:60px;padding:6px 10px;font-size:12px">200 €</button>' +
          '<button type="button" class="u-btn u-btn-ghost lump-chip" data-amt="500" style="flex:1;min-width:60px;padding:6px 10px;font-size:12px">500 €</button>' +
        '</div>' +
        '<label for="lumpSumInput" class="sr-only">Vyplatená suma (€)</label>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<input type="number" id="lumpSumInput" class="form-input" step="0.01" min="0.01" max="10000" placeholder="0,00" inputmode="decimal" autocomplete="off" style="flex:1;font-size:22px;font-weight:700;text-align:right;font-family:var(--font-display)">' +
          '<span style="font-family:var(--font-display);font-weight:700;font-size:22px;color:var(--color-text-sec)">€</span>' +
        '</div>' +
        '<label style="display:block;margin-top:10px">' +
          '<span style="font-size:11px;color:var(--color-text-sec);font-family:var(--font-mono);letter-spacing:.04em;text-transform:uppercase">Poznámka (voliteľné)</span>' +
          '<input type="text" id="lumpSumNote" class="form-input" maxlength="200" placeholder="napr. záloha za máj, bonus...">' +
        '</label>' +
        '<div id="lumpSumErr" style="color:var(--color-danger);font-size:12px;margin-top:6px;min-height:14px"></div>' +
        '<div id="lumpSumPreview" style="margin-top:8px;font-size:11.5px;color:var(--color-text-dim);min-height:16px"></div>' +
      '</div>' +
      '<div class="u-modal-btns">' +
        '<button type="button" class="u-btn u-btn-ghost" id="lumpCancel">Zrušiť</button>' +
        '<button type="button" class="u-btn u-btn-mint" id="lumpConfirm">Vyplatiť</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  const input = ov.querySelector('#lumpSumInput');
  const noteInput = ov.querySelector('#lumpSumNote');
  const err = ov.querySelector('#lumpSumErr');
  const preview = ov.querySelector('#lumpSumPreview');
  const confirmBtn = ov.querySelector('#lumpConfirm');
  const cancelBtn = ov.querySelector('#lumpCancel');
  const chips = ov.querySelectorAll('.lump-chip');

  function close() {
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 200);
  }
  function updatePreview() {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0 || hourlyRate <= 0) {
      preview.textContent = '';
      return;
    }
    // Hrubý odhad — koľko hodín to predstavuje pri tejto sadzbe
    const hours = v / hourlyRate;
    preview.textContent = '≈ ' + hours.toFixed(1) + ' hod práce pri sadzbe ' + fmtEur(hourlyRate) + '/h';
  }
  async function tryConfirm() {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0) {
      err.textContent = 'Suma musí byť kladná';
      input.focus();
      return;
    }
    if (v > 10000) {
      err.textContent = 'Suma > 10 000 €, over zadanie';
      return;
    }
    err.textContent = '';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Spracovávam…';
    try {
      const res = await api.post('/attendance/payouts/lump-sum', {
        staffId,
        amount: Math.round(v * 100) / 100,
        note: noteInput.value || '',
      });
      close();
      const partsMsg = res.partialShifts > 0
        ? ' (' + res.partialShifts + ' čiastočne)'
        : '';
      const remMsg = res.remainder > 0
        ? ' Zostáva ' + fmtEur(res.remainder) + ' (nepoužité — žiadne ďalšie nezaplatené smeny)'
        : '';
      showToast(
        'Vyplatené ' + fmtEur(res.totalPaid) + ' — pokrytých ' + res.shiftsCovered + ' smien' + partsMsg + '.' + remMsg,
        true,
      );
      await loadSummary();
      // Ak je nejaký staff expanded, refresh detail aby ukázalo nové platby
      if (_expanded === staffId) {
        _expanded = null;
        await toggleDetail(staffId);
      }
    } catch (e) {
      err.textContent = e.message || 'Výplata zlyhala';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Vyplatiť';
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (document.activeElement === input || document.activeElement === noteInput)) {
      e.preventDefault();
      tryConfirm();
    }
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      input.value = c.getAttribute('data-amt');
      input.focus();
      input.select();
      updatePreview();
    });
  });
  input.addEventListener('input', updatePreview);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', tryConfirm);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  setTimeout(function () { input.focus(); }, 50);
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
  let totalPaid = 0, totalOutstanding = 0;
  let outstandingPositive = 0;
  for (const r of rows) {
    totalMinutes += Number(r.minutes) || 0;
    totalWage += Number(r.wage) || 0;
    openShifts += Number(r.openShifts) || 0;
    totalPaid += Number(r.paidTotal) || 0;
    totalOutstanding += Number(r.outstanding) || 0;
    if (r.hourlyRate != null) withRate += 1;
    if (Number(r.outstanding) > 0.01) outstandingPositive += 1;
  }
  return {
    totalMinutes, totalWage, openShifts, totalStaff: rows.length, withRate,
    totalPaid, totalOutstanding, outstandingPositive,
  };
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
      '<div class="stat-card">' +
        '<div class="stat-icon ' + (t.totalPaid > 0 ? 'mint' : 'lavender') + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Vyplatené</div>' +
          '<div class="stat-value">' + escapeHtml(fmtEur(t.totalPaid)) + '</div>' +
          '<div class="stat-change ' + (t.totalPaid > 0 ? 'up' : 'neutral') + '">' +
            (t.totalPaid > 0 ? 'V tomto období' : 'Nič nevyplatené') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon ' + (t.totalOutstanding > 0.01 ? 'amber' : 'mint') + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Zostáva vyplatiť</div>' +
          '<div class="stat-value">' + escapeHtml(fmtEur(Math.max(0, t.totalOutstanding))) + '</div>' +
          '<div class="stat-change ' + (t.totalOutstanding > 0.01 ? 'neutral' : 'up') + '">' +
            (t.totalOutstanding > 0.01
              ? t.outstandingPositive + ' ' + (t.outstandingPositive === 1 ? 'osoba' : 'osôb')
              : 'Všetko vyplatené ✓') +
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
            '<th class="data-th text-right">Sadzba</th>' +
            '<th class="data-th text-right">Hodín</th>' +
            '<th class="data-th text-right">Otv. smeny</th>' +
            '<th class="data-th text-right">Mzda</th>' +
            '<th class="data-th text-right" title="Suma vyplatená v zvolenom období">Vyplatené</th>' +
            '<th class="data-th text-right" title="Mzda − Vyplatené. Záporné = preplatil si (bonus/zaloha)">Zostáva</th>' +
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
    body.innerHTML = '<tr><td class="data-td" colspan="9">' +
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
    // Vyplatene v období (z payouts.paidAt) — manager vidi ze kolko jedinec
    // realne dostal. Outstanding = wage − paid. Color-coded: zeleno ked
    // 0/blizko, oranzovo ked dlhujem, modry ked preplaceny (bonus/predplate).
    const paidTotal = Number(r.paidTotal) || 0;
    const outstanding = Number(r.outstanding) || 0;
    const paidCell = paidTotal > 0
      ? '<strong style="color:var(--color-success)">' + fmtEur(paidTotal) + '</strong>'
        + (r.paidCount ? '<div style="font-size:10px;color:var(--color-text-dim);font-family:var(--font-mono)">' + r.paidCount + 'x</div>' : '')
      : '<span class="text-muted">—</span>';
    let outstandingCell;
    if (Math.abs(outstanding) < 0.01) {
      outstandingCell = '<span style="color:var(--color-text-dim)">0,00 €</span>';
    } else if (outstanding > 0) {
      outstandingCell = '<strong style="color:var(--color-warning, #d97706)">' + fmtEur(outstanding) + '</strong>'
        + '<div style="font-size:10px;color:var(--color-text-dim)">dlhujem</div>';
    } else {
      outstandingCell = '<strong style="color:var(--color-accent-secondary, #1f3a5c)">' + fmtEur(Math.abs(outstanding)) + '</strong>'
        + '<div style="font-size:10px;color:var(--color-text-dim)">prep.</div>';
    }

    return '<tr class="data-row" data-staff="' + r.staffId + '">' +
      '<td class="data-td"><strong>' + escapeHtml(r.name) + '</strong></td>' +
      '<td class="data-td">' + (r.position
        ? escapeHtml(r.position)
        : '<span class="text-muted">—</span>') + '</td>' +
      '<td class="data-td num text-right">' + rateCell + '</td>' +
      '<td class="data-td num text-right"><strong>' + escapeHtml(fmtMinutes(r.minutes)) + '</strong></td>' +
      '<td class="data-td text-right">' + openCell + '</td>' +
      '<td class="data-td num text-right">' + wageCell + '</td>' +
      '<td class="data-td num text-right">' + paidCell + '</td>' +
      '<td class="data-td num text-right">' + outstandingCell + '</td>' +
      '<td class="data-td" style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' +
        // "Vyplatiť" — lump-sum payout dialog (manager zadá sumu, backend FIFO
        // pokryje najstarsie nezaplatene smeny).
        '<button class="btn-edit doch-payout-btn" data-payout-staff="' + r.staffId + '"' +
          ' data-staff-name="' + escapeHtml(r.name) + '"' +
          ' data-staff-rate="' + (r.hourlyRate || 0) + '"' +
          ' style="background:rgba(76,175,80,.08);border-color:rgba(76,175,80,.3);color:#2e7d32" title="Vyplatiť hotovostne — backend rozloží sumu cez staré smeny">Vyplatiť</button>' +
        '<button class="btn-edit doch-detail-btn" data-toggle="' + r.staffId + '">' +
          (isOpen ? 'Skryť' : 'Detail') +
        '</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  body.querySelectorAll('button[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleDetail(parseInt(b.getAttribute('data-toggle'), 10)));
  });

  // Lump-sum payout button — modal s amount inputom, POST /payouts/lump-sum
  body.querySelectorAll('button[data-payout-staff]').forEach((b) => {
    b.addEventListener('click', () => {
      const staffId = parseInt(b.getAttribute('data-payout-staff'), 10);
      const staffName = b.getAttribute('data-staff-name') || '';
      const hourlyRate = Number(b.getAttribute('data-staff-rate')) || 0;
      openLumpSumPayoutModal({ staffId, staffName, hourlyRate });
    });
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
          '<td class="data-td num text-right">' + startCell + '</td>' +
          '<td class="data-td num text-right">' + endCell + '</td>' +
          '<td class="data-td num text-right">' + durCell + '</td>' +
          '<td class="data-td num text-right">' + wageCell + '</td>' +
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
            '<th class="data-th text-right">Príchod</th>' +
            '<th class="data-th text-right">Odchod</th>' +
            '<th class="data-th text-right">Trvanie</th>' +
            '<th class="data-th text-right">Mzda</th>' +
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

  // Mark a shift as paid — modal s editovateľnou sumou. Default = full
  // wage z data-pay-amount, ale manazer môže upraviť ak vyplatil partial
  // (napr. časť kešou teraz + zvyšok neskôr). Pri zápise jedna cashflow
  // salary expense + jeden attendance_payout row pre clockOutEvent
  // (schéma má unique index na clockOutEventId, takže iba 1 výplata
  // per smenu).
  detail.querySelectorAll('button[data-pay-out]').forEach((b) => {
    b.addEventListener('click', () => {
      const clockOutEventId = parseInt(b.getAttribute('data-pay-out'), 10);
      const fullAmount = Number(b.getAttribute('data-pay-amount'));
      openPayoutAmountModal({
        fullAmount,
        onConfirm: async (amount) => {
          try {
            await api.post('/attendance/payouts', { clockOutEventId, amount });
            showToast('Smena označená ako vyplatená (' + fmtEur(amount) + ')', true);
            await loadSummary();
            _expanded = null;
            await toggleDetail(staffId);
          } catch (err) {
            showToast(err.message || 'Označenie zlyhalo', 'error');
          }
        },
      });
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
