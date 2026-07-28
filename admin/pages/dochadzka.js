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
// "Otv. smeny" KPI je clickable — toggle medzi 'all' a 'only-open' filtrom.
// Pomahá manazerovi pri closeout flow (ked treba dohonit otvorene smeny
// pred koncom dna). Stav sa resetuje pri zmene date range / staff filtra.
let _openOnly = false;
// All-time dlžoba na výplatách (nezávislá od dátumového filtra). Cache-uje
// sa tu, render() ju repaint-uje do #dBalancePanel. Refresh cez loadBalance()
// pri init + po každej mutácii (payout / pridanie eventu / zmazanie).
let _balance = null;

// bratislavaDayIso je zdielany global z /api.js (preco nie UTC — viz tam).
function todayIso() { return bratislavaDayIso(new Date()); }
function todayMinusDays(n) {
  // Kotvene na bratislavske 'dnes', aby _from a _to pocitali s rovnakym
  // dnom. Odpocet dni v UTC priestore neposunie prechod DST.
  const p = todayIso().split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// LOCAL-TIME date helpers — toISOString() na local-time Date by drifta o
// timezone offset (na UTC+2 by '2026-05-01 00:00 local' vratilo '2026-04-30').
// Pre payroll obdobie chceme datumy v lokalnej TZ user-a, takze formatujeme
// manualne.
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function firstOfMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth(), 1));
}
function lastDayOfPrevMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth(), 0));
}
function firstOfPrevMonth(d) {
  const x = d ? new Date(d) : new Date();
  return ymdLocal(new Date(x.getFullYear(), x.getMonth() - 1, 1));
}
function mondayOfWeek(d) {
  const x = d ? new Date(d) : new Date();
  const day = x.getDay() || 7; // Sun=0 → 7
  x.setDate(x.getDate() - (day - 1));
  return ymdLocal(x);
}
function sundayOfWeek(d) {
  const x = d ? new Date(d) : new Date();
  const day = x.getDay() || 7;
  x.setDate(x.getDate() + (7 - day));
  return ymdLocal(x);
}
function lastMondayMinus7() {
  const today = new Date();
  const day = today.getDay() || 7;
  today.setDate(today.getDate() - (day - 1) - 7);
  return ymdLocal(today);
}
function lastSundayMinus1() {
  const today = new Date();
  const day = today.getDay() || 7;
  today.setDate(today.getDate() - day);
  return ymdLocal(today);
}

function fmtMinutes(m) {
  if (!Number.isFinite(m) || m <= 0) return '0h 0m';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm';
}
function fmtEur(n) { return fmtCost(n) + ' €'; }
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

// Malá ceruzka — affordance „tento čas sa dá kliknúť a upraviť". Zobrazí sa
// až na hover/focus (CSS), aby tabuľka ostala čistá.
const EDIT_PENCIL = '<svg class="doch-pencil" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.2l2.3 2.3L6 12.3l-2.6.6.6-2.6z"/></svg>';

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
 * Výplatný modal — bez mätúceho prepínača režimov. Režim sa volí KONTEXTOM,
 * nie radiom:
 *  - lump (default, z riadku zamestnanca): predvyplní dlžobu, suma sa rozhodí
 *    FIFO cez najstaršie nezaplatené smeny. Chip „Celý dlh" = jeden klik.
 *  - shift (z detailu „Označiť ako vyplatené"): pripočíta k jednej smene.
 *
 * @param {object} opts
 * @param {number} opts.staffId
 * @param {string} opts.staffName
 * @param {number} [opts.hourlyRate]   — pre live preview "≈ X hod"
 * @param {number} [opts.outstanding]  — dlžoba (lump pre-fill + chip „Celý dlh")
 * @param {('lump'|'shift')} [opts.defaultMode='lump']
 * @param {number} [opts.shiftWage]    — pre 'shift' mode pre-fill input
 * @param {number} [opts.clockOutEventId] — pre 'shift' mode (povinné)
 * @param {function} opts.onSuccess    — callback po úspešnom POST
 */
function openUnifiedPayoutModal(opts) {
  const staffId = opts.staffId;
  const staffName = opts.staffName || '';
  const hourlyRate = Number(opts.hourlyRate) || 0;
  const mode = opts.defaultMode === 'shift' ? 'shift' : 'lump';
  const shiftWage = Number(opts.shiftWage) || 0;
  const outstanding = Number(opts.outstanding) || 0;
  const clockOutEventId = opts.clockOutEventId || null;

  const existing = document.getElementById('unifiedPayoutModal');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'unifiedPayoutModal';
  ov.className = 'u-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'unifiedPayoutTitle');

  // Pre-fill: shift → celá mzda smeny; lump → dlžoba (ak ju dlhujeme).
  const initVal = mode === 'shift'
    ? shiftWage.toFixed(2)
    : (outstanding > 0 ? outstanding.toFixed(2) : '');
  const title = mode === 'shift'
    ? 'Vyplatiť smenu — ' + escapeHtml(staffName)
    : 'Vyplatiť ' + escapeHtml(staffName);
  const hint = mode === 'shift'
    ? 'Označí túto smenu ako vyplatenú. Predvyplnená je celá mzda smeny.'
    : (outstanding > 0
        ? 'Predvyplnená dlžoba ' + escapeHtml(fmtEur(outstanding)) + '. Suma sa rozhodí cez nezaplatené smeny (FIFO).'
        : 'Suma sa rozhodí cez najstaršie nezaplatené smeny (FIFO).');

  ov.innerHTML =
    '<div class="u-modal" style="max-width:440px">' +
      '<span class="u-modal-icon" aria-hidden="true">💸</span>' +
      '<div class="u-modal-title" id="unifiedPayoutTitle">' + title + '</div>' +
      '<div class="u-modal-text" style="margin-bottom:12px">' + hint + '</div>' +
      '<div class="u-modal-body">' +
        '<div id="payoutChips" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<input type="number" id="payoutAmtInput" class="form-input" step="0.01" min="0.01" max="10000" placeholder="0,00" inputmode="decimal" autocomplete="off" aria-label="Suma na vyplatenie v eurách" value="' + initVal + '" style="flex:1;font-size:24px;font-weight:700;text-align:right;font-family:var(--font-display)">' +
          '<span style="font-family:var(--font-display);font-weight:700;font-size:24px;color:var(--color-text-sec)">€</span>' +
        '</div>' +
        '<div class="u-modal-field">' +
          '<label for="payoutNoteInput">Poznámka (voliteľné)</label>' +
          '<input type="text" id="payoutNoteInput" class="form-input" maxlength="200" placeholder="napr. záloha za máj, bonus...">' +
        '</div>' +
        '<div id="payoutErr" style="color:var(--color-danger);font-size:12px;min-height:14px"></div>' +
        '<div id="payoutPreview" style="font-size:11.5px;color:var(--color-text-dim);min-height:16px"></div>' +
      '</div>' +
      '<div class="u-modal-btns">' +
        '<button type="button" class="u-btn u-btn-ghost" id="payoutCancel">Zrušiť</button>' +
        '<button type="button" class="u-btn u-btn-mint" id="payoutConfirm">Vyplatiť</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  const chipsHost = ov.querySelector('#payoutChips');
  const input = ov.querySelector('#payoutAmtInput');
  const noteInput = ov.querySelector('#payoutNoteInput');
  const err = ov.querySelector('#payoutErr');
  const preview = ov.querySelector('#payoutPreview');
  const confirmBtn = ov.querySelector('#payoutConfirm');
  const cancelBtn = ov.querySelector('#payoutCancel');

  function chip(label, amt) {
    return '<button type="button" class="u-btn u-btn-ghost payout-chip" data-amt="' + amt + '"' +
      ' style="flex:1;min-width:80px;padding:8px 10px;font-size:12px">' + label + '</button>';
  }

  function renderChips() {
    let html = '';
    if (mode === 'shift') {
      html += chip('Celé (' + fmtEur(shiftWage) + ')', shiftWage.toFixed(2));
      html += chip('Polovica', (shiftWage / 2).toFixed(2));
      html += chip('Iné', '');
    } else if (outstanding > 0) {
      html += chip('Celý dlh (' + fmtEur(outstanding) + ')', outstanding.toFixed(2));
      html += chip('Polovica', (outstanding / 2).toFixed(2));
      html += chip('Iné', '');
    } else {
      ['50', '100', '200', '500'].forEach(function (a) { html += chip(a + ' €', a); });
    }
    chipsHost.innerHTML = html;
    chipsHost.querySelectorAll('.payout-chip').forEach(function (c) {
      c.addEventListener('click', function () {
        const a = c.getAttribute('data-amt');
        if (a) { input.value = a; input.focus(); input.select(); }
        else { input.value = ''; input.focus(); }
        updatePreview();
      });
    });
  }

  function updatePreview() {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0 || hourlyRate <= 0) {
      preview.textContent = '';
      return;
    }
    const hours = v / hourlyRate;
    preview.textContent = '≈ ' + hours.toFixed(1) + ' hod pri sadzbe ' + fmtEur(hourlyRate) + '/h';
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 200);
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
      let res;
      if (mode === 'lump') {
        res = await api.post('/attendance/payouts/lump-sum', {
          staffId: staffId,
          amount: Math.round(v * 100) / 100,
          note: noteInput.value || '',
        });
      } else {
        if (!clockOutEventId) {
          throw new Error('Chýba clockOutEventId pre shift mode');
        }
        res = await api.post('/attendance/payouts', {
          clockOutEventId: clockOutEventId,
          amount: Math.round(v * 100) / 100,
          note: noteInput.value || '',
        });
      }
      close();
      if (typeof opts.onSuccess === 'function') opts.onSuccess(res, mode);
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

  input.addEventListener('input', updatePreview);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', tryConfirm);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  renderChips();
  updatePreview();
  setTimeout(function () { input.focus(); if (input.value) input.select(); }, 50);
}

// Rozloží ISO (UTC) timestamp na lokálne polia pre <input type="date"> +
// <input type="time">. Browser na kase beží v Europe/Bratislava, takže
// getHours()/getDate() vrátia bratislavský čas — rovnaká logika ako
// nowForDateTimeLocal() pri vytváraní a formatLocalTime() pri zobrazení,
// takže round-trip je konzistentný.
function dateToLocalFields(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
  };
}

/**
 * Jednoduchá úprava času príchodu/odchodu. Otvára sa klikom priamo na čas
 * v tabuľke Smeny (edit mode → PATCH existujúci event) alebo cez tlačidlo
 * "+ Pridať odchod/príchod" pri neúplnej smene (create mode → POST nový
 * event). Nahrádza neintuitívny flow „zmaž záznam + vyplň manuálny formulár".
 *
 * @param {object} opts
 * @param {('edit'|'create')} opts.mode
 * @param {number} [opts.eventId]   — povinné v edit mode (PATCH cieľ)
 * @param {('clock_in'|'clock_out')} opts.kind — príchod/odchod
 * @param {string} opts.currentIso  — predvyplnený čas (edit: existujúci, create: kotva dňa)
 * @param {string} [opts.siblingIso] — čas partnerského eventu (príchod↔odchod)
 *                                      pre kontrolu poradia; prázdne = bez partnera
 * @param {number} opts.staffId
 * @param {string} opts.staffName
 * @param {function} opts.onSuccess — callback po úspešnom uložení
 */
function openTimeEditModal(opts) {
  const mode = opts.mode === 'create' ? 'create' : 'edit';
  const kind = opts.kind === 'clock_out' ? 'clock_out' : 'clock_in';
  const isArrival = kind === 'clock_in';
  const staffId = opts.staffId;
  const staffName = opts.staffName || '';

  const anchor = opts.currentIso ? new Date(opts.currentIso) : new Date();
  const anchorOk = !Number.isNaN(anchor.getTime());
  // Partnerský event (clock_in pre clock_out a naopak) — strážime poradie,
  // aby odchod nemohol byť pred príchodom (záporná smena = pokazená mzda).
  const sibling = opts.siblingIso ? new Date(opts.siblingIso) : null;
  const siblingOk = sibling && !Number.isNaN(sibling.getTime());
  const init = dateToLocalFields(anchorOk ? anchor : new Date());
  // create = oprava chýbajúceho záznamu (typicky zabudol kliknúť);
  // edit = oprava nesprávneho času. Predvyplníme najčastejší dôvod, takže
  // manažér zvyčajne len potvrdí.
  const defaultReason = mode === 'create' ? 'forgot' : 'wrong_time';

  const word = isArrival ? 'príchod' : 'odchod';
  const titleVerb = mode === 'create' ? 'Pridať' : 'Upraviť';
  const icon = isArrival ? '🟢' : '🔵';

  const existing = document.getElementById('timeEditModal');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'timeEditModal';
  ov.className = 'u-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'timeEditTitle');

  const reasonOpts = [
    ['forgot', 'Zabudol kliknúť'],
    ['wrong_time', 'Nesprávny čas'],
    ['shift_change', 'Zmena zmeny'],
    ['pin_failed', 'PIN zlyhal'],
    ['other', 'Iné'],
  ].map(([v, l]) => '<option value="' + v + '"' + (v === defaultReason ? ' selected' : '') + '>' + l + '</option>').join('');

  ov.innerHTML =
    '<div class="u-modal" style="max-width:420px">' +
      '<span class="u-modal-icon" aria-hidden="true">' + icon + '</span>' +
      '<div class="u-modal-title" id="timeEditTitle">' + titleVerb + ' ' + escapeHtml(word) + '</div>' +
      '<div class="u-modal-text" style="margin-bottom:14px">' + escapeHtml(staffName) + '</div>' +
      '<div class="u-modal-body">' +
        '<div class="u-modal-row">' +
          '<div class="u-modal-field" style="flex:1.3">' +
            '<label for="teTime">Čas</label>' +
            '<input type="time" id="teTime" class="form-input" value="' + init.time + '" step="60" style="font-size:24px;font-weight:700;text-align:center;font-family:var(--font-display)">' +
          '</div>' +
          '<div class="u-modal-field" style="flex:1">' +
            '<label for="teDate">Dátum</label>' +
            '<input type="date" id="teDate" class="form-input" value="' + init.date + '">' +
          '</div>' +
        '</div>' +
        '<div class="doch-nudge-row" role="group" aria-label="Rýchla úprava času">' +
          '<button type="button" class="doch-nudge-btn" data-nudge="-15">−15</button>' +
          '<button type="button" class="doch-nudge-btn" data-nudge="-5">−5</button>' +
          '<button type="button" class="doch-nudge-btn" data-nudge="5">+5</button>' +
          '<button type="button" class="doch-nudge-btn" data-nudge="15">+15</button>' +
        '</div>' +
        '<div id="teRelHint" style="text-align:center;font-size:11.5px;color:var(--color-text-dim);min-height:15px"></div>' +
        '<div class="u-modal-field">' +
          '<label for="teReason">Dôvod úpravy</label>' +
          '<select id="teReason" class="form-select">' + reasonOpts + '</select>' +
        '</div>' +
        '<div class="u-modal-field">' +
          '<label for="teNote">Poznámka (voliteľné)</label>' +
          '<input type="text" id="teNote" class="form-input" maxlength="200" placeholder="napr. zabudol kliknúť">' +
        '</div>' +
        '<div id="teErr" style="color:var(--color-danger);font-size:12px;min-height:14px"></div>' +
      '</div>' +
      '<div class="u-modal-btns">' +
        '<button type="button" class="u-btn u-btn-ghost" id="teCancel">Zrušiť</button>' +
        '<button type="button" class="u-btn u-btn-mint" id="teConfirm">' + (mode === 'create' ? 'Pridať' : 'Uložiť') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  const timeInput = ov.querySelector('#teTime');
  const dateInput = ov.querySelector('#teDate');
  const reasonSel = ov.querySelector('#teReason');
  const noteInput = ov.querySelector('#teNote');
  const err = ov.querySelector('#teErr');
  const relHint = ov.querySelector('#teRelHint');
  const confirmBtn = ov.querySelector('#teConfirm');
  const cancelBtn = ov.querySelector('#teCancel');

  function currentDate() {
    if (!dateInput.value || !timeInput.value) return null;
    const d = new Date(dateInput.value + 'T' + timeInput.value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Kontrola poradia voči partnerskému eventu. Vracia chybový text alebo ''.
  function orderingError(d) {
    if (!d || !siblingOk) return '';
    if (kind === 'clock_out' && d.getTime() < sibling.getTime()) {
      return 'Odchod je pred príchodom (' + formatLocalTime(opts.siblingIso) + ')';
    }
    if (kind === 'clock_in' && d.getTime() > sibling.getTime()) {
      return 'Príchod je po odchode (' + formatLocalTime(opts.siblingIso) + ')';
    }
    return '';
  }

  function updateRelHint() {
    const d = currentDate();
    // Inverzia poradia má prednosť — varujeme jantárovo už počas úprav.
    const ordErr = orderingError(d);
    if (ordErr) {
      relHint.textContent = '⚠ ' + ordErr;
      relHint.style.color = 'var(--color-warning)';
      return;
    }
    relHint.style.color = 'var(--color-text-dim)';
    if (!d || mode !== 'edit' || !anchorOk) { relHint.textContent = ''; return; }
    const diffMin = Math.round((d.getTime() - anchor.getTime()) / 60000);
    if (diffMin === 0) { relHint.textContent = 'bez zmeny oproti pôvodnému času'; return; }
    relHint.textContent = 'o ' + fmtMinutes(Math.abs(diffMin)) + (diffMin < 0 ? ' skôr' : ' neskôr') + ' ako pôvodne';
  }

  function nudge(mins) {
    const d = currentDate() || new Date();
    d.setMinutes(d.getMinutes() + mins);
    const f = dateToLocalFields(d);
    dateInput.value = f.date;
    timeInput.value = f.time;
    updateRelHint();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 200);
  }

  async function tryConfirm() {
    const d = currentDate();
    if (!d) { err.textContent = 'Zadaj platný dátum a čas'; return; }
    const ordErr = orderingError(d);
    if (ordErr) { err.textContent = ordErr; return; }
    const reason = reasonSel.value;
    if (!reason) { err.textContent = 'Vyber dôvod úpravy'; return; }

    // No-op: v edit mode pri nezmenenej minúte neukladáme — inak by sme len
    // odrezali sekundy z presného PIN punchu a zbytočne preklopili záznam na
    // 'manual' s dôvodom (znečistený audit). Minúta = granularita mzdy.
    if (mode === 'edit' && anchorOk &&
        Math.floor(anchor.getTime() / 60000) === Math.floor(d.getTime() / 60000)) {
      close();
      showToast('Čas ostal nezmenený', true);
      return;
    }

    err.textContent = '';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Ukladám…';
    try {
      const iso = d.toISOString();
      const note = noteInput.value.trim();
      if (mode === 'edit') {
        await api.patch('/attendance/events/' + opts.eventId, { at: iso, reason, note });
      } else {
        await api.post('/attendance/events', { staffId, type: kind, at: iso, reason, note });
      }
      close();
      showToast(
        mode === 'create'
          ? (isArrival ? 'Príchod pridaný' : 'Odchod pridaný')
          : 'Čas upravený',
        true,
      );
      if (typeof opts.onSuccess === 'function') opts.onSuccess();
    } catch (e) {
      err.textContent = e.message || 'Uloženie zlyhalo';
      confirmBtn.disabled = false;
      confirmBtn.textContent = mode === 'create' ? 'Pridať' : 'Uložiť';
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' &&
        (document.activeElement === noteInput || document.activeElement === timeInput || document.activeElement === dateInput)) {
      e.preventDefault();
      tryConfirm();
    }
  }

  ov.querySelectorAll('.doch-nudge-btn').forEach(function (b) {
    b.addEventListener('click', function () { nudge(parseInt(b.getAttribute('data-nudge'), 10)); });
  });
  timeInput.addEventListener('input', updateRelHint);
  dateInput.addEventListener('input', updateRelHint);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', tryConfirm);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  updateRelHint();
  setTimeout(function () { timeInput.focus(); }, 50);
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
  // All-time dlžoba sa refreshne po každom loadSummary (init + mutácie ako
  // payout/manual event/delete všetky idú cez loadSummary). Fire-and-forget,
  // nezdržuje render. Dáta sú malé (single-tenant kasa), takže extra all-time
  // query pri filter-change je akceptovateľná cena za garantovanú čerstvosť.
  loadBalance();
}

// All-time dlžoba na výplatách — /api/attendance/balance ignoruje from/to.
async function loadBalance() {
  try {
    _balance = await api.get('/attendance/balance');
  } catch (err) {
    _balance = null; // ticho — panel sa proste nezobrazí, neblokujeme dochádzku
  }
  renderBalancePanel();
}

// Vyrenderuje all-time dlžobu panel do #dBalancePanel. Volané z render()
// (s cache) aj z loadBalance() (po fetchi).
function renderBalancePanel() {
  if (!_container) return;
  const host = _container.querySelector('#dBalancePanel');
  if (!host) return;
  const b = _balance;
  if (!b) { host.innerHTML = ''; return; }

  const owed = Number(b.totalOwed) || 0;
  const prepaid = Number(b.totalPrepaid) || 0;
  // Len ľudia ktorým reálne dlžíš (balance > 0), zoradení podľa dlžoby.
  const debtors = (b.rows || []).filter((r) => Number(r.balance) > 0.01);

  // Per-osoba čipy — meno + suma. Neaktívni dostanú jemný tag.
  const chips = debtors.map((r) => {
    const inactiveTag = r.active ? '' : ' <span style="color:var(--color-text-dim);font-size:var(--text-xs)">(neaktívny)</span>';
    return '<div class="doch-debtor-chip">' +
      '<span style="font-weight:var(--weight-semibold)">' + escapeHtml(r.name || '?') + inactiveTag + '</span>' +
      '<strong>' + fmtEur(r.balance) + '</strong>' +
    '</div>';
  }).join('');

  const prepaidNote = prepaid > 0.01
    ? '<div class="doch-hero-note">ℹ️ Navyše máš predplatené (zálohy) ' + escapeHtml(fmtEur(prepaid)) + ' — tie sa odrátajú z budúcich miezd.</div>'
    : '';

  // "Za obdobie vyplatené" — presunuté sem z pôvodnej KPI karty. Sumár výplat
  // za zvolený dátumový filter (paidAt), nezávislý od all-time dlhu hore.
  const periodPaid = (_summary.rows || []).reduce((s, r) => s + (Number(r.paidTotal) || 0), 0);
  const periodLabel = _from === _to ? escapeHtml(_from) : escapeHtml(_from) + ' → ' + escapeHtml(_to);
  const periodPaidNote = periodPaid > 0.01
    ? '<div class="doch-hero-note bordered">Za zvolené obdobie (' + periodLabel + ') si vyplatil <strong>' + escapeHtml(fmtEur(periodPaid)) + '</strong>.</div>'
    : '';

  const isClear = owed <= 0.01;
  // Hero karta: veľká suma dlhu + breakdown po osobách (zelená keď nič nedlhuješ).
  host.innerHTML =
    '<div class="doch-hero' + (isClear ? ' is-clear' : '') + '">' +
      '<div class="doch-hero-top">' +
        '<div>' +
          '<div class="doch-hero-eyebrow">💰 Komu dlhujem na výplatách</div>' +
          '<div class="doch-hero-sub">za celé obdobie fungovania — odpracované hodiny mínus všetko vyplatené</div>' +
        '</div>' +
        '<div class="doch-hero-num">' + escapeHtml(fmtEur(owed)) + '</div>' +
      '</div>' +
      (debtors.length
        ? '<div class="doch-hero-debtors">' + chips + '</div>'
        : '<div class="doch-hero-allpaid">✓ Všetko vyplatené — nikomu nedlhuješ</div>') +
      prepaidNote +
      periodPaidNote +
    '</div>';
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
  let visibleRows = _staffFilter === 'all'
    ? allRows
    : allRows.filter((r) => String(r.staffId) === String(_staffFilter));
  // Additional filter: ak je _openOnly aktivny (manager klikol na 'Otv. smeny'
  // KPI), zobraz len ludi co maju > 0 otvorenych smien. KPI totals sa pocitaju
  // na ZÚŽENOM zozname aby čísla davali zmysel pre aktualny filter.
  if (_openOnly) {
    visibleRows = visibleRows.filter((r) => Number(r.openShifts) > 0);
  }

  const t = totalsFor(visibleRows);

  const staffOptionsHtml = '<option value="all">Všetci zamestnanci</option>' +
    allRows.map((r) => {
      const sel = String(r.staffId) === String(_staffFilter) ? ' selected' : '';
      return '<option value="' + r.staffId + '"' + sel + '>' + escapeHtml(r.name || '?') + '</option>';
    }).join('');

  const html =
    // Inline style: sticky header pre dochadzka tabulku (scroll dlhych zoznamov
    // ludi by inak skryl Meno/Pozicia hlavicku). z-index>2 aby bol nad badges.
    // Pridana sub-shadow pre vizualnu separaciu od scrollovaneho obsahu.
    '<style>.doch-table thead th{position:sticky;top:0;background:var(--color-bg-elevated);z-index:3;box-shadow:0 1px 0 var(--color-border)}</style>' +
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
          '<button type="button" class="btn-secondary doch-preset" data-preset="week">Tento týždeň</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="last-week">Minulý týždeň</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="month">Tento mesiac</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="last-month">Minulý mesiac</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="7">7 dní</button>' +
          '<button type="button" class="btn-secondary doch-preset" data-preset="30">30 dní</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn-secondary" id="dExportCsv" title="Stiahnuť CSV pre účtovníka">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v10"/><polyline points="4 7 8 11 12 7"/><path d="M2 14h12"/></svg>' +
          'Export CSV' +
        '</button>' +
        '<button class="btn-add" id="dRefresh">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 015 5 5 5 0 01-5 5 5 5 0 01-3.5-1.4L3 13l-1-3 3 1-1.1 1.1A4 4 0 008 12a4 4 0 100-8 4 4 0 00-3.5 2H6V5H2v4h1V7.5A5 5 0 018 3z"/></svg>' +
          'Obnoviť' +
        '</button>' +
      '</div>' +
    '</div>' +

    // Celkový dlh na výplatách (ALL-TIME, nezávislý od dátumového filtra).
    // Naplnené cez loadBalance() → /api/attendance/balance. Prázdny kým
    // sa nenačíta.
    '<div id="dBalancePanel"></div>' +

    // KPI grid — zúžené na 3 karty čo manažéra reálne zaujímajú za obdobie:
    // koľko sa odpracovalo, koľko sa zarobilo, a koľko smien je otvorených
    // (akčné). Celkový dlh + period-vyplatené sú v hero paneli vyššie, takže
    // sme zrušili duplicitné karty „Aktívni", „Vyplatené" a „Zostáva".
    '<div class="stat-grid doch-stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">' +
      '<div class="stat-card">' +
        '<div class="stat-icon ice">' +
          '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Odpracované</div>' +
          '<div class="stat-value">' + escapeHtml(fmtMinutes(t.totalMinutes)) + '</div>' +
          '<div class="stat-change neutral">' + t.totalStaff + ' ' + (t.totalStaff === 1 ? 'zamestnanec' : 'zamestnancov') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-icon mint">' +
          '<svg viewBox="0 0 24 24"><path d="M3 7h18M3 12h18M3 17h18"/><path d="M7 5v14M17 5v14"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Zarobené za obdobie</div>' +
          '<div class="stat-value">' + escapeHtml(fmtEur(t.totalWage)) + '</div>' +
          '<div class="stat-change neutral">' + t.withRate + ' so sadzbou</div>' +
        '</div>' +
      '</div>' +
      // Clickable card: toggle _openOnly filter. Hover/cursor menia signal ze
      // sa s tym da niečo robiť. Border-color zvyrazni keď je filter aktivny.
      '<div class="stat-card doch-kpi-open" id="kpiOpenShifts" ' +
        'style="cursor:' + (t.openShifts > 0 || _openOnly ? 'pointer' : 'default') + ';' +
        (_openOnly ? 'border-color:var(--color-warning);box-shadow:0 0 0 2px var(--color-warning-border)' : '') +
        '" title="' + (_openOnly ? 'Klik = vypnúť filter' : (t.openShifts > 0 ? 'Klik = zobraziť len ľudí s otvorenými smenami' : 'Žiadne otvorené smeny')) + '">' +
        '<div class="stat-icon ' + (t.openShifts > 0 ? 'amber' : 'mint') + '">' +
          '<svg viewBox="0 0 24 24"><path d="M12 8v5l3 2"/><circle cx="12" cy="12" r="9"/></svg>' +
        '</div>' +
        '<div class="stat-info">' +
          '<div class="stat-label">Otvorené smeny' + (_openOnly ? ' <span style="color:var(--color-warning);font-weight:var(--weight-bold)">(filter ON)</span>' : '') + '</div>' +
          '<div class="stat-value">' + t.openShifts + '</div>' +
          '<div class="stat-change ' + (t.openShifts > 0 ? 'neutral' : 'up') + '">' +
            (_openOnly
              ? 'Klik = vypnúť filter'
              : (t.openShifts > 0 ? 'Klik = ukáž len týchto' : 'Všetko v poriadku')) +
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
            '<th class="data-th">Zamestnanec</th>' +
            '<th class="data-th text-right">Hodín</th>' +
            '<th class="data-th text-right">Mzda</th>' +
            '<th class="data-th text-right" title="✓ Vyplatené = nič nedlhuješ  ·  Dlhuje sa = treba vyplatiť  ·  Záloha = preplatil si (bonus/predplate)">Stav výplaty</th>' +
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
    _openOnly = false; // novy rozsah → vypneme filter aby manager nestral data
    loadSummary();
  });

  const exportBtn = _container.querySelector('#dExportCsv');
  if (exportBtn) {
    exportBtn.addEventListener('click', downloadCsv);
  }

  // KPI "Otv. smeny" clickable toggle. Click disabled keď je 0 otv. smien
  // AND filter nie je aktivny (nemalo by zmysel).
  const kpiOpenCard = _container.querySelector('#kpiOpenShifts');
  if (kpiOpenCard) {
    kpiOpenCard.addEventListener('click', () => {
      // Compute totals on the unfiltered (by _openOnly) set — ak su 0
      // otv. smien a filter nie je aktivny, nerob nic.
      const allRows = _summary.rows || [];
      const rowsForCheck = _staffFilter === 'all'
        ? allRows
        : allRows.filter((r) => String(r.staffId) === String(_staffFilter));
      const hasOpen = rowsForCheck.some((r) => Number(r.openShifts) > 0);
      if (!_openOnly && !hasOpen) return; // click bez akcie
      _openOnly = !_openOnly;
      _expanded = null;
      render();
    });
  }

  // Staff filter change: re-render only (no network) and clear any open
  // detail because the previously expanded staff may now be hidden.
  _container.querySelector('#dStaff').addEventListener('change', (e) => {
    _staffFilter = e.target.value || 'all';
    _expanded = null;
    render();
  });

  _container.querySelectorAll('.doch-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      _openOnly = false; // nove obdobie → vypneme filter
      const preset = btn.getAttribute('data-preset');
      if (preset === 'month') {
        _from = firstOfMonth();
        _to = todayIso();
      } else if (preset === 'last-month') {
        _from = firstOfPrevMonth();
        _to = lastDayOfPrevMonth();
      } else if (preset === 'week') {
        _from = mondayOfWeek();
        _to = sundayOfWeek();
      } else if (preset === 'last-week') {
        _from = lastMondayMinus7();
        _to = lastSundayMinus1();
      } else {
        _from = todayMinusDays(parseInt(preset, 10));
        _to = todayIso();
      }
      _expanded = null;
      loadSummary();
    });
  });

  renderBody();
  // Repaint all-time dlžoba z cache (render() prebuild-uje #dBalancePanel
  // ako prázdny div, takže ho treba znova naplniť). loadBalance() ho potom
  // refreshne ak prišli nové dáta.
  renderBalancePanel();
}

function renderBody() {
  const body = _container.querySelector('#dBody');
  const allRows = _summary.rows || [];
  // Mirror the filter applied in render() so the body table, KPI cards and
  // dropdown all stay consistent.
  let rows = _staffFilter === 'all'
    ? allRows
    : allRows.filter((r) => String(r.staffId) === String(_staffFilter));
  // Apply _openOnly filter ak je aktivny (toggle z KPI 'Otv. smeny' karty).
  if (_openOnly) {
    rows = rows.filter((r) => Number(r.openShifts) > 0);
  }
  if (!rows.length) {
    const msg = _openOnly
      ? 'Žiadni ľudia s otvorenými smenami v tomto výbere. Klik na "Otv. smeny" KPI vypneš filter.'
      : (_staffFilter === 'all'
          ? 'Žiadne dáta za toto obdobie. Zamestnanci s nastaveným dochádzka PIN-om sa objavia po prvom Príchode.'
          : 'Vybraný zamestnanec nemá v tomto období žiadne záznamy.');
    body.innerHTML = '<tr><td class="data-td" colspan="5">' +
      '<div class="empty-hint">' + escapeHtml(msg) + '</div>' +
      '</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r) => {
    const isOpen = _expanded === r.staffId;
    // Overlap poznámka — keď má zamestnanec special sadzbu na hodiny spolu
    // s iným (napr. Oleg @ 5€ s Jarikom), ukáž pod mzdou prečo je iná.
    let overlapNote = '';
    if (r.overlapInfo && r.overlapInfo.minutes > 0) {
      const partner = (allRows.find((x) => String(x.staffId) === String(r.overlapInfo.withStaffId)) || {}).name || 'partner';
      overlapNote = '<div class="doch-pay-sub">'
        + 'z toho ' + escapeHtml(fmtMinutes(r.overlapInfo.minutes)) + ' @ ' + fmtEur(r.overlapInfo.rate)
        + ' s ' + escapeHtml(partner) + '</div>';
    }
    const wageCell = r.hourlyRate != null
      ? fmtEur(r.wage) + overlapNote
      : '<span class="text-muted">—</span>';

    // Zamestnanec — meno + (otvorené smeny badge) + pozícia/sadzba ako subtitle.
    // Zlúčili sme pôvodné stĺpce Pozícia, Sadzba a Otv. smeny do jednej bunky.
    const openBadge = r.openShifts > 0
      ? ' <span class="badge badge-warning" title="otvorené smeny — treba uzavrieť">' + r.openShifts + ' otv.</span>'
      : '';
    const subParts = [];
    if (r.position) subParts.push(escapeHtml(r.position));
    if (r.hourlyRate != null) subParts.push(fmtEur(r.hourlyRate) + '/h');
    const nameSub = subParts.length
      ? '<div class="doch-name-pos">' + subParts.join(' · ') + '</div>'
      : '';
    const nameCell = '<div class="doch-name-cell"><strong>' + escapeHtml(r.name) + '</strong>' + openBadge + nameSub + '</div>';

    // Stav výplaty — JEDNA bunka namiesto pôvodných Vyplatené + Zostáva.
    // Outstanding = mzda − vyplatené (period). Zeleno = vyrovnané, oranžovo =
    // dlhuješ, modro = preplatil (záloha/bonus). Bez sadzby = netrackuje sa.
    const paidTotal = Number(r.paidTotal) || 0;
    const outstanding = Number(r.outstanding) || 0;
    let statusCell;
    if (r.hourlyRate == null) {
      statusCell = '<span class="text-muted">—</span>';
    } else if (Math.abs(outstanding) < 0.01) {
      statusCell = '<span class="doch-status-pill is-paid">'
        + '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 4 6 11 3 8"/></svg>'
        + 'Vyplatené</span>';
    } else if (outstanding > 0) {
      statusCell = '<span class="doch-status-pill is-owed">Dlhuje sa ' + fmtEur(outstanding) + '</span>'
        + (paidTotal > 0 ? '<div class="doch-pay-sub">z toho vyplatené ' + fmtEur(paidTotal) + '</div>' : '');
    } else {
      statusCell = '<span class="doch-status-pill is-advance">Záloha ' + fmtEur(Math.abs(outstanding)) + '</span>'
        + '<div class="doch-pay-sub">preplatené (bonus/záloha)</div>';
    }

    // Dlžoba pre payout pre-fill = ALL-TIME (čo reálne dlhuješ a čo lump-sum
    // endpoint FIFO vyrovná), nie period-scoped `outstanding`. Inak by chip
    // „Celý dlh" protirečil all-time panelu hore. Match cez staffId z _balance;
    // fallback na period outstanding kým sa _balance ešte nenačítal.
    const balRow = ((_balance && _balance.rows) || []).find((x) => String(x.staffId) === String(r.staffId));
    const debt = balRow ? (Number(balRow.balance) || 0) : outstanding;
    // "Vyplatiť" má zmysel len keď má človek sadzbu (lump-sum potrebuje sadzbu
    // na výpočet mzdy smien); inak ponúkneme len Detail.
    const payBtn = r.hourlyRate != null
      ? '<button class="btn-edit doch-payout-btn" data-payout-staff="' + r.staffId + '"' +
          ' data-staff-name="' + escapeHtml(r.name) + '"' +
          ' data-staff-rate="' + (r.hourlyRate || 0) + '"' +
          ' data-staff-outstanding="' + (debt > 0 ? debt.toFixed(2) : '') + '"' +
          ' title="Vyplatiť hotovostne — predvyplní dlžobu">Vyplatiť</button>'
      : '';

    return '<tr class="data-row" data-staff="' + r.staffId + '">' +
      '<td class="data-td">' + nameCell + '</td>' +
      '<td class="data-td num text-right"><strong>' + escapeHtml(fmtMinutes(r.minutes)) + '</strong></td>' +
      '<td class="data-td num text-right">' + wageCell + '</td>' +
      '<td class="data-td num text-right">' + statusCell + '</td>' +
      '<td class="data-td" style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' +
        payBtn +
        '<button class="btn-edit doch-detail-btn" data-toggle="' + r.staffId + '">' +
          (isOpen ? 'Skryť' : 'Detail') +
        '</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  body.querySelectorAll('button[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleDetail(parseInt(b.getAttribute('data-toggle'), 10)));
  });

  // Lump-sum payout button — otvorí výplatný modal predvyplnený dlžobou
  body.querySelectorAll('button[data-payout-staff]').forEach((b) => {
    b.addEventListener('click', () => {
      const staffId = parseInt(b.getAttribute('data-payout-staff'), 10);
      const staffName = b.getAttribute('data-staff-name') || '';
      const hourlyRate = Number(b.getAttribute('data-staff-rate')) || 0;
      const outstanding = Number(b.getAttribute('data-staff-outstanding')) || 0;
      openUnifiedPayoutModal({
        staffId, staffName, hourlyRate, outstanding,
        defaultMode: 'lump',
        onSuccess: async function (res) {
          const partsMsg = res.partialShifts > 0 ? ' (' + res.partialShifts + ' čiastočne)' : '';
          const remMsg = res.remainder > 0 ? ' Zostáva ' + fmtEur(res.remainder) + ' (nepoužité)' : '';
          showToast('Vyplatené ' + fmtEur(res.totalPaid) + ' — pokrytých ' + res.shiftsCovered + ' smien' + partsMsg + '.' + remMsg, true);
          await loadSummary();
          if (_expanded === staffId) {
            _expanded = null;
            await toggleDetail(staffId);
          }
        },
      });
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
    ? '<tr><td class="data-td" colspan="8"><div class="empty-hint">Žiadne smeny v tomto období.</div></td></tr>'
    : shifts.slice().reverse().map((s) => {
        const refIso = (s.start && s.start.at) || (s.end && s.end.at) || '';
        const dateCell = escapeHtml(formatLocalDate(refIso));
        // Časy sú priamo klikateľné → otvoria editačný modal (PATCH). Pri
        // neúplnej smene ponúkneme akčné "+ príchod/odchod" tlačidlo (POST),
        // ktoré nahrádza pasívny "otvorená" odznak niečím, čo sa dá rovno
        // vyriešiť. data-ref-iso = kotva dňa pre predvyplnenie create modalu.
        // data-sibling-iso = čas partnerského eventu (príchod↔odchod) pre
        // kontrolu poradia v modáli — bráni posunúť odchod pred príchod.
        const startCell = s.start
          ? '<button type="button" class="doch-time-edit" data-edit-event="' + s.start.id + '"'
              + ' data-kind="clock_in" data-iso="' + escapeHtml(s.start.at) + '"'
              + ' data-sibling-iso="' + (s.end ? escapeHtml(s.end.at) : '') + '"'
              + ' title="Upraviť čas príchodu">'
              + '<span>' + escapeHtml(formatLocalTime(s.start.at)) + '</span>' + EDIT_PENCIL
            + '</button>'
          : '<button type="button" class="doch-time-add" data-add-kind="clock_in"'
              + ' data-ref-iso="' + escapeHtml(refIso) + '"'
              + ' data-sibling-iso="' + (s.end ? escapeHtml(s.end.at) : '') + '"'
              + ' title="Pridať chýbajúci príchod">+ príchod</button>';
        const endCell = s.end
          ? '<button type="button" class="doch-time-edit" data-edit-event="' + s.end.id + '"'
              + ' data-kind="clock_out" data-iso="' + escapeHtml(s.end.at) + '"'
              + ' data-sibling-iso="' + (s.start ? escapeHtml(s.start.at) : '') + '"'
              + ' title="Upraviť čas odchodu">'
              + '<span>' + escapeHtml(formatLocalTime(s.end.at)) + '</span>' + EDIT_PENCIL
            + '</button>'
          : '<button type="button" class="doch-time-add doch-time-add-warn" data-add-kind="clock_out"'
              + ' data-ref-iso="' + escapeHtml((s.start && s.start.at) || refIso) + '"'
              + ' data-sibling-iso="' + (s.start ? escapeHtml(s.start.at) : '') + '"'
              + ' title="Smena je otvorená — pridať odchod">+ odchod</button>';
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
        // Akcia: zmazať celú smenu (par príchod+odchod). IBA pre kompletné
        // smeny viditeľné v perióde (s.start AJ s.end) — vtedy zmažeme presne
        // ten pár, ktorý user vidí. Otvorená smena (chýba odchod) alebo
        // osamotený odchod (príchod je mimo zvolené obdobie) sa tu nemažú —
        // stray event ide cez audit "✕" nižšie. data-del-paid riadi varovanie.
        const delCell = (s.start && s.end && s.end.id)
          ? '<button type="button" class="doch-shift-del" data-del-shift="' + s.end.id + '"'
              + ' data-del-paid="' + (s.end.paid ? '1' : '0') + '"'
              + ' title="Vymazať celú smenu">Vymazať</button>'
          : '<span class="text-muted">—</span>';
        return '<tr class="data-row">' +
          '<td class="data-td">' + dateCell + '</td>' +
          '<td class="data-td num text-right">' + startCell + '</td>' +
          '<td class="data-td num text-right">' + endCell + '</td>' +
          '<td class="data-td num text-right">' + durCell + '</td>' +
          '<td class="data-td num text-right">' + wageCell + '</td>' +
          '<td class="data-td">' + paidCell + '</td>' +
          '<td class="data-td">' + (flags.join(' ') || '<span class="text-muted">—</span>') + '</td>' +
          '<td class="data-td num text-right">' + delCell + '</td>' +
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

      // Smeny — hlavný blok. Časy sú priamo klikateľné (úprava), neúplné
      // smeny majú "+ príchod/odchod". "+ Pridať smenu" naľavo otvorí nový
      // príchod (pre deň úplne bez záznamu) — z neho vznikne otvorená smena,
      // ktorú zavrieš cez "+ odchod".
      '<div class="doch-subhead" style="justify-content:space-between">' +
        '<span>Smeny' + shiftHeadCounts + '</span>' +
        '<button type="button" class="doch-time-add" id="dAddShift" title="Pridať smenu pre deň bez záznamu">+ Pridať smenu</button>' +
      '</div>' +
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
            '<th class="data-th"></th>' +
          '</tr></thead>' +
          '<tbody>' + shiftRowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +

      // História úprav + audit — zbalené (po novom sa časy upravujú inline,
      // takže surový log eventov + ručný formulár treba málokedy). Obsahuje
      // audit záznamov (so zmazaním stray eventu) a escape-hatch formulár.
      '<details class="doch-manual-details" style="margin:6px 0 0">' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:var(--weight-semibold);color:var(--color-text-sec);padding:6px 0;user-select:none">' +
          'História úprav · audit (' + (data.events || []).length + ')' +
        '</summary>' +
        '<div class="table-scroll-wrap" style="margin-top:10px">' +
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
        '<div style="font-size:12px;color:var(--color-text-dim);margin:14px 0 0;line-height:1.5">' +
          'Tip: čas opravíš klikom priamo na <strong>príchod/odchod</strong> v tabuľke Smeny. ' +
          'Formulár nižšie použi len na pridanie samostatného záznamu.' +
        '</div>' +
        '<form class="doch-manual-form" id="dManualForm" style="margin-top:10px">' +
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
      '</details>' +
    '</div>';

  // Inline úprava/pridanie času priamo z tabuľky Smeny: klik na čas (edit)
  // alebo na "+ príchod/odchod" (create). Po uložení obnovíme detail +
  // summary, aby sa prepočítali hodiny/mzda/zostatok.
  const refreshDetail = async () => {
    await loadSummary();
    _expanded = null;
    await toggleDetail(staffId);
  };
  detail.querySelectorAll('button[data-edit-event]').forEach((b) => {
    b.addEventListener('click', () => {
      openTimeEditModal({
        mode: 'edit',
        eventId: parseInt(b.getAttribute('data-edit-event'), 10),
        kind: b.getAttribute('data-kind'),
        currentIso: b.getAttribute('data-iso'),
        siblingIso: b.getAttribute('data-sibling-iso') || '',
        staffId,
        staffName: staffMeta.name || '',
        onSuccess: refreshDetail,
      });
    });
  });
  detail.querySelectorAll('button[data-add-kind]').forEach((b) => {
    b.addEventListener('click', () => {
      openTimeEditModal({
        mode: 'create',
        kind: b.getAttribute('data-add-kind'),
        currentIso: b.getAttribute('data-ref-iso') || new Date().toISOString(),
        siblingIso: b.getAttribute('data-sibling-iso') || '',
        staffId,
        staffName: staffMeta.name || '',
        onSuccess: refreshDetail,
      });
    });
  });

  // "+ Pridať smenu" — nový príchod pre deň úplne bez záznamu. Z neho vznikne
  // otvorená smena (zavrieš cez "+ odchod" v riadku). Predvyplníme na teraz.
  const addShiftBtn = detail.querySelector('#dAddShift');
  if (addShiftBtn) {
    addShiftBtn.addEventListener('click', () => {
      openTimeEditModal({
        mode: 'create',
        kind: 'clock_in',
        currentIso: new Date().toISOString(),
        staffId,
        staffName: staffMeta.name || '',
        onSuccess: refreshDetail,
      });
    });
  }

  const manualForm = detail.querySelector('#dManualForm');
  if (manualForm) manualForm.addEventListener('submit', async (e) => {
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
      // staffId + staffName + hourlyRate sa hladaju z parent summary row
      const parentRow = (_summary.rows || []).find((r) => String(r.staffId) === String(staffId));
      const sName = parentRow ? parentRow.name : '';
      const hRate = parentRow ? Number(parentRow.hourlyRate) || 0 : 0;
      openUnifiedPayoutModal({
        staffId: staffId,
        staffName: sName,
        hourlyRate: hRate,
        defaultMode: 'shift',
        shiftWage: fullAmount,
        clockOutEventId: clockOutEventId,
        onSuccess: async function (res) {
          showToast('Smena označená ako vyplatená (' + fmtEur(Number(res.amount) || fullAmount) + ')', true);
          await loadSummary();
          _expanded = null;
          await toggleDetail(staffId);
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
  // Vymazať celú smenu (príchod + odchod naraz). Ak je vyplatená, varuj že
  // sa zruší aj výplata + cashflow. Server (DELETE /attendance/shifts/:id)
  // to spraví atomicky.
  detail.querySelectorAll('button[data-del-shift]').forEach((b) => {
    b.addEventListener('click', () => {
      const clockOutEventId = parseInt(b.getAttribute('data-del-shift'), 10);
      const paid = b.getAttribute('data-del-paid') === '1';
      const msg = paid
        ? 'Táto smena je VYPLATENÁ — spolu s ňou sa natrvalo zruší aj jej výplata a zodpovedajúci záznam v Cashflow. Mzdový prepočet sa obnoví.'
        : 'Natrvalo odstráni túto smenu (príchod + odchod). Mzdový prepočet sa obnoví.';
      showConfirm(
        'Vymazať celú smenu?',
        msg,
        async () => {
          try {
            await api.del('/attendance/shifts/' + clockOutEventId);
            showToast('Smena vymazaná', true);
            await loadSummary();
            _expanded = null;
            await toggleDetail(staffId);
          } catch (err) {
            showToast(err.message || 'Smenu sa nepodarilo vymazať', 'error');
          }
        },
        { type: 'danger', confirmText: 'Vymazať smenu' },
      );
    });
  });
}

function buildAttendanceCsv(rows, fromDate, toDate) {
  const header = ['Meno', 'Pozicia', 'Sadzba/h', 'Hodin', 'Mzda', 'Vyplatene', 'Zostava'];
  const lines = [header.join(';')];
  for (const r of rows) {
    const hours = Math.floor((Number(r.minutes) || 0) / 60);
    const mins = (Number(r.minutes) || 0) % 60;
    const hrsStr = hours + 'h ' + String(mins).padStart(2, '0') + 'm';
    const cells = [
      String(r.name || ''),
      String(r.position || ''),
      r.hourlyRate != null ? Number(r.hourlyRate).toFixed(2).replace('.', ',') : '',
      hrsStr,
      Number(r.wage || 0).toFixed(2).replace('.', ','),
      Number(r.paidTotal || 0).toFixed(2).replace('.', ','),
      Number(r.outstanding || 0).toFixed(2).replace('.', ','),
    ].map(function (c) {
      const s = String(c == null ? '' : c);
      if (/[;"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    });
    lines.push(cells.join(';'));
  }
  lines.push('');
  lines.unshift('# Dochadzka export ' + fromDate + ' .. ' + toDate);
  return lines.join('\n');
}

function downloadCsv() {
  const rows = (_summary.rows || []).filter((r) => _staffFilter === 'all' || String(r.staffId) === String(_staffFilter));
  if (!rows.length) {
    if (typeof showToast === 'function') showToast('Žiadne dáta na export', 'warning');
    return;
  }
  const csv = buildAttendanceCsv(rows, _from, _to);
  // UTF-8 BOM aby Excel správne otvoril Slovak diacritics
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dochadzka_' + _from + '_' + _to + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
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
  _openOnly = false;
  _balance = null;
}
