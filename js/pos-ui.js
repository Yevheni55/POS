'use strict';
// pos-ui.js — UI helpers: modals, drag, swipe, long-press, qty hold, keyboard navigation

// === Focus capture/restore for modals ===
var _modalTrigger=null;
function captureModalTrigger(){_modalTrigger=document.activeElement}
function restoreModalTrigger(){if(_modalTrigger&&_modalTrigger.focus&&document.body.contains(_modalTrigger)){_modalTrigger.focus()}_modalTrigger=null}

// === Unified dialog helpers ===
function showConfirm(title, text, onConfirm, opts) {
  opts = opts || {};
  captureModalTrigger();
  var type = opts.type || 'info';
  // Monochrome SVG markers \u2014 alert-triangle / help-circle / info-circle.
  // Stroke inherits modal text tone via currentColor.
  var _confirmIcons = {
    danger:  '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    warning: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info:    '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  var icon = opts.icon || _confirmIcons[type] || _confirmIcons.info;
  var confirmText = opts.confirmText || 'Potvrdit';
  var cancelText = opts.cancelText || 'Zrusit';
  var btnClass = type==='danger'?'u-btn-rose':type==='warning'?'u-btn-lavender':'u-btn-mint';

  var existing = document.getElementById('confirmModal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.className = 'u-overlay';
  overlay.id = 'confirmModal';
  var bodyHtml = opts.customBody ? opts.customBody : '';
  var btnsHtml = opts.hideButtons ? '<div class="u-modal-btns"><button class="u-btn u-btn-ghost" id="confirmCancel">Zavriet</button></div>' :
    '<div class="u-modal-btns">' +
    (cancelText ? '<button class="u-btn u-btn-ghost" id="confirmCancel">' + cancelText + '</button>' : '') +
    '<button class="u-btn ' + btnClass + '" id="confirmOk">' + confirmText + '</button>' +
    '</div>';
  overlay.innerHTML = '<div class="u-modal" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle">' +
    '<span class="u-modal-icon">' + icon + '</span>' +
    '<div class="u-modal-title" id="confirmModalTitle">' + title + '</div>' +
    (text ? '<div class="u-modal-text">' + text + '</div>' : '') +
    (bodyHtml ? '<div class="u-modal-body">' + bodyHtml + '</div>' : '') +
    btnsHtml + '</div>';
  document.body.appendChild(overlay);

  requestAnimationFrame(function(){ overlay.classList.add('show'); });

  function close() { overlay.classList.remove('show'); setTimeout(function(){ overlay.remove(); restoreModalTrigger(); }, 300); }

  // opts.onCancel bezi LEN pri kliku na cancel tlacidlo (explicitna volba,
  // napr. 'Odhlasit bez uzavierky'). Escape a klik na pozadie modal iba
  // zatvoria — preto keyboard handler vola overlay._dismiss, nie .click().
  overlay._dismiss = close;
  var cancelBtn = document.getElementById('confirmCancel');
  if (cancelBtn) cancelBtn.onclick = function() { if (opts.onCancel) opts.onCancel(); close(); };
  document.getElementById('confirmOk').onclick = function() { close(); if (onConfirm) onConfirm(); };
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
}

function showPrompt(title, placeholder, onSubmit, opts) {
  opts = opts || {};
  captureModalTrigger();
  var existing = document.getElementById('promptModal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.className = 'u-overlay';
  overlay.id = 'promptModal';
  // Prompt default icon \u2014 pencil SVG (monochrome). Override via opts.icon if needed.
  var _promptDefaultIcon = '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
  overlay.innerHTML = '<div class="u-modal" role="dialog" aria-modal="true" aria-labelledby="promptModalTitle">' +
    '<span class="u-modal-icon">' + (opts.icon || _promptDefaultIcon) + '</span>' +
    '<div class="u-modal-title" id="promptModalTitle">' + title + '</div>' +
    '<div class="u-modal-body"><div class="u-modal-field"><label for="promptInput" class="sr-only">' + title + '</label><input type="' + (opts.inputType || 'text') + '" id="promptInput" placeholder="' + (placeholder || '') + '" value="' + (opts.defaultValue || '') + '"></div></div>' +
    '<div class="u-modal-btns">' +
    '<button class="u-btn u-btn-ghost" id="promptCancel">Zrusit</button>' +
    '<button class="u-btn u-btn-ice" id="promptOk">' + (opts.confirmText || 'Potvrdit') + '</button>' +
    '</div></div>';
  document.body.appendChild(overlay);

  requestAnimationFrame(function(){ overlay.classList.add('show'); });
  setTimeout(function(){ document.getElementById('promptInput').focus(); }, 100);

  function close() { overlay.classList.remove('show'); setTimeout(function(){ overlay.remove(); restoreModalTrigger(); }, 300); }

  document.getElementById('promptCancel').onclick = close;
  document.getElementById('promptOk').onclick = function() {
    var val = document.getElementById('promptInput').value;
    close();
    if (onSubmit) onSubmit(val);
  };
  document.getElementById('promptInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('promptOk').click(); }
  });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
}

function showAlert(title, text, opts) {
  showConfirm(title, text, null, Object.assign({confirmText:'OK', cancelText:null}, opts || {}));
}

// === Storno reason modal ===
// Cashier picks TWO things explicitly (no auto-defaults that always
// suggest "vratit na sklad"):
//   1. Was the food prepared?  Ano / Nie
//   2. Reason (5 options)
// Plus optional free-text note. "Potvrdit" stays disabled until both are
// chosen. The whole entry goes to /api/storno-basket; the actual stock
// action runs later from the admin Storno page (not here).
function showStornoReason(itemName, qty, callback) {
  var existing = document.getElementById('stornoReasonModal');
  if (existing) existing.remove();

  captureModalTrigger();

  var reasons = [
    { value: 'order_error', label: 'Chyba objednavky' },
    { value: 'complaint',   label: 'Reklamacia' },
    { value: 'breakage',    label: 'Rozbite / rozliate' },
    { value: 'staff_meal',  label: 'Zamestnanecka spotreba' },
    { value: 'other',       label: 'Ine' },
  ];

  var state = { wasPrepared: null, reason: null };

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'stornoReasonModal';

  var reasonBtns = reasons.map(function(r) {
    return '<button type="button" class="storno-reason-btn" data-reason="' + r.value + '">' + r.label + '</button>';
  }).join('');

  // Hierarchia: PRIMARNA info = co sa stornuje (qty × name), bold 24px.
  // SEKUNDARNA = ze ide o storno akciu (eyebrow). Predtym bolo opacne —
  // "Storno" velkym titulkom a item drobny, takze casnik si v rychly tahu
  // mohol pomylit POLOZKU ktoru rusi.
  ov.innerHTML = ''
    + '<div class="u-modal" role="dialog" aria-modal="true" aria-labelledby="stornoModalTitle" style="max-width:460px;text-align:left">'
    +   '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">'
    +     '<div style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;line-height:1;color:var(--color-danger,#ef4444)"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>'
    +     '<div>'
    +       '<div id="stornoModalTitle" style="font-size:24px;font-weight:700;color:var(--color-text);margin:0;line-height:1.15">' + qty + '× ' + itemName + '</div>'
    +       '<div style="font-size:13px;color:var(--color-danger,#ef4444);margin:2px 0 0;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Storno</div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="storno-section-label">Bolo uz pripravene?</div>'
    +   '<div class="storno-prep-row">'
    +     '<button type="button" class="storno-prep-btn" data-prep="yes">'
    +       '<span class="storno-prep-emoji">🔥</span>'
    +       '<span class="storno-prep-label">Ano, pripravene</span>'
    +       '<span class="storno-prep-hint">jedlo / napoj islo von &rarr; odpis</span>'
    +     '</button>'
    +     '<button type="button" class="storno-prep-btn" data-prep="no">'
    +       '<span class="storno-prep-emoji">🔄</span>'
    +       '<span class="storno-prep-label">Nie, nestihli sme</span>'
    +       '<span class="storno-prep-hint">vratit suroviny na sklad</span>'
    +     '</button>'
    +   '</div>'
    +   '<div class="storno-section-label" style="margin-top:14px">Dovod</div>'
    +   '<div class="storno-reasons-row">' + reasonBtns + '</div>'
    +   '<div class="u-modal-field" style="margin-top:14px">'
    +     '<label for="stornoNote" class="sr-only">Poznamka</label>'
    +     '<input id="stornoNote" class="form-input" maxlength="200" placeholder="Poznamka (volitelna)">'
    +   '</div>'
    +   '<div class="u-modal-btns" style="margin-top:16px">'
    +     '<button type="button" class="u-btn u-btn-ghost" id="stornoCancel">Zrusit</button>'
    +     '<button type="button" class="u-btn u-btn-mint" id="stornoSubmit" disabled>Potvrdit</button>'
    +   '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function() { ov.classList.add('show'); });

  var submitBtn = ov.querySelector('#stornoSubmit');
  var noteInput = ov.querySelector('#stornoNote');

  function refreshSubmit() {
    submitBtn.disabled = !(state.wasPrepared !== null && state.reason);
  }

  function finishClose(result) {
    document.removeEventListener('keydown', keyHandler, true);
    ov.classList.remove('show');
    setTimeout(function() { if (ov.parentNode) ov.remove(); restoreModalTrigger(); }, 250);
    if (callback) callback(result);
  }

  function keyHandler(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); finishClose(null); }
    else if (ev.key === 'Enter' && !submitBtn.disabled) { ev.preventDefault(); submit(); }
  }
  document.addEventListener('keydown', keyHandler, true);

  function submit() {
    if (state.wasPrepared === null || !state.reason) return;
    finishClose({
      reason: state.reason,
      returnToStock: state.wasPrepared === false, // back-compat alias
      wasPrepared: state.wasPrepared,
      note: (noteInput.value || '').trim(),
    });
  }

  ov.addEventListener('click', function(e) {
    if (e.target === ov) { finishClose(null); return; }

    var prep = e.target.closest('.storno-prep-btn');
    if (prep) {
      state.wasPrepared = prep.dataset.prep === 'yes';
      ov.querySelectorAll('.storno-prep-btn').forEach(function(b) {
        b.classList.toggle('selected', b === prep);
      });
      refreshSubmit();
      return;
    }

    var reasonBtn = e.target.closest('.storno-reason-btn');
    if (reasonBtn) {
      state.reason = reasonBtn.dataset.reason;
      ov.querySelectorAll('.storno-reason-btn').forEach(function(b) {
        b.classList.toggle('selected', b === reasonBtn);
      });
      refreshSubmit();
      return;
    }
  });

  ov.querySelector('#stornoCancel').addEventListener('click', function() { finishClose(null); });
  submitBtn.addEventListener('click', submit);
}

// Helper — vrati array predtym pouzitych omacok pre rovnaku polozku v
// aktualnej objednavke. Pouzite v showSauceSelector aby tap "+" na sent
// combo neotvorilo prazdny modal ale zachytilo poslednu volbu.
// Returns: null ak ziadny predchadzajuci, [] pre "bez omacky", inak array.
function _findLastSauceForItem(comboName) {
  if (typeof getOrder !== 'function') return null;
  var order = getOrder() || [];
  var primaries = order
    .filter(function (it) { return it.name === comboName && !it._companionOf; })
    .sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
  for (var i = 0; i < primaries.length; i++) {
    var ann = order.find(function (it) {
      return it.name === 'Omáčka (combo)' && it._companionOf === primaries[i].id;
    });
    if (ann && typeof ann.note === 'string') {
      if (/bezs*omáčky/i.test(ann.note)) return [];
      return ann.note.split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    }
  }
  return null;
}

// Sauce selector for combos. Callback receives an array of selected sauce names
// (possibly empty — means "bez omáčky") or null if the user cancelled.
//
// Ak v aktualnej objednavke uz existuje rovnaka polozka s omackou, modal
// zobrazi prominent "Opakovat" CTA hore (jeden klik = potvrdenie s
// rovnakou volbou) + checkboxy budu pre-checknute. Casnik s rusnikom v
// ruke uz nemusi prerolovat zoznam vsetkych chuti.
function showSauceSelector(comboName, callback) {
  var existing = document.getElementById('sauceSelectorModal');
  if (existing) existing.remove();
  captureModalTrigger();

  var sauces = [
    'Big Mac domáca',
    'Chilli-mayo',
    'Tatárka domáca',
    'Kečup',
    'BBQ',
  ];

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'sauceSelectorModal';

  // Predchadzajuca volba — pouzita ako default + ako "Opakovat" CTA.
  var previous = _findLastSauceForItem(comboName);
  var hasPrevious = Array.isArray(previous);
  var previousLabel = '';
  if (hasPrevious) {
    previousLabel = previous.length ? previous.join(' + ') : 'bez omáčky';
  }

  var sauceBoxes = sauces.map(function (s, i) {
    var id = 'sauce-' + i;
    var preChecked = hasPrevious && previous.indexOf(s) >= 0;
    return '<label for="' + id + '" class="sauce-row' + (preChecked ? ' is-prechecked' : '') + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:' + (preChecked ? 'rgba(139,124,246,.10)' : 'rgba(255,255,255,.04)') + ';border:1px solid ' + (preChecked ? 'rgba(139,124,246,.40)' : 'var(--color-border)') + ';border-radius:var(--radius-sm);cursor:pointer;font-size:var(--text-base)">'
      + '<input type="checkbox" id="' + id + '" data-sauce="' + s + '"' + (preChecked ? ' checked' : '') + ' style="width:18px;height:18px;cursor:pointer">'
      + '<span>' + s + '</span></label>';
  }).join('');

  // Repeat CTA — viditeľný len ak našla sa predchádzajúca volba. Plne
  // accent-tinted, big tap target, ikona ↻ aby bolo zrejmé že je to repeat.
  var repeatCta = '';
  if (hasPrevious) {
    repeatCta = '<button type="button" class="sauce-repeat-btn" id="sauceRepeat">'
      + '<span class="sauce-repeat-icon" aria-hidden="true">'
      +   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon">'
      +     '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'
      +   '</svg>'
      + '</span>'
      + '<span class="sauce-repeat-text">'
      +   '<span class="sauce-repeat-eyebrow">Opakovať omáčku</span>'
      +   '<span class="sauce-repeat-value">' + (previousLabel || '—') + '</span>'
      + '</span>'
      + '</button>';
  }

  ov.innerHTML = '<div class="u-modal" role="dialog" aria-modal="true" aria-labelledby="sauceModalTitle" style="max-width:380px">'
    + '<div class="u-modal-icon">\uD83E\uDD62</div>'
    + '<div class="u-modal-title" id="sauceModalTitle">Vyber omáčok</div>'
    + '<div class="u-modal-text">' + comboName + '</div>'
    + repeatCta
    + '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">' + sauceBoxes + '</div>'
    + '<div class="u-modal-btns" style="gap:8px">'
    + '<button class="u-btn u-btn-ice" id="sauceNone">Bez omáčky</button>'
    + '<button class="u-btn u-btn-mint" id="sauceConfirm">Potvrdiť</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(ov);
  requestAnimationFrame(function () { ov.classList.add('show'); });

  function finishClose() {
    document.removeEventListener('keydown', keyHandler, true);
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); restoreModalTrigger(); }, 300);
  }

  function keyHandler(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finishClose();
      if (callback) callback(null);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      var picked = [];
      ov.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        picked.push(cb.dataset.sauce);
      });
      finishClose();
      if (callback) callback(picked);
    }
  }
  document.addEventListener('keydown', keyHandler, true);

  // Backdrop click = cancel
  ov.addEventListener('click', function (e) {
    if (e.target === ov) {
      finishClose();
      if (callback) callback(null);
    }
  });

  // Repeat CTA — instant confirm s presne tou istou omackou ako naposledy.
  if (hasPrevious) {
    var repeatBtn = document.getElementById('sauceRepeat');
    if (repeatBtn) {
      repeatBtn.addEventListener('click', function () {
        finishClose();
        if (callback) callback(previous.slice());
      });
    }
  }

  document.getElementById('sauceNone').addEventListener('click', function () {
    finishClose();
    if (callback) callback([]); // empty array = "bez omáčky"
  });

  document.getElementById('sauceConfirm').addEventListener('click', function () {
    var picked = [];
    ov.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      picked.push(cb.dataset.sauce);
    });
    finishClose();
    if (callback) callback(picked);
  });
}

// Manager-PIN wrapper that surfaces WHAT the cashier is about to authorise
// (e.g. "Storno: 3× Cola (4.50 €)") above the PIN input. Without this header
// the manager sees the same generic prompt for every storno and has to take
// the cashier's word for the impact.
//
// Delegates to requireManagerPin() in pos-payments.js for the actual modal
// open + verify flow; we just inject/refresh a context line into the static
// modal body each time it opens.
//
// Signature is (contextLabel, callback) but we keep back-compat with the
// older (callback) shape so any existing single-arg caller still works.
function showManagerPin(contextLabel, callback) {
  // Back-compat: if the first arg is the callback, shift.
  if (typeof contextLabel === 'function' && callback === undefined) {
    callback = contextLabel;
    contextLabel = '';
  }
  var modal = document.getElementById('managerPinModal');
  if (modal) {
    var body = modal.querySelector('.u-modal-body');
    var ctxEl = modal.querySelector('.manager-pin-context');
    if (contextLabel) {
      if (!ctxEl && body) {
        ctxEl = document.createElement('div');
        ctxEl.className = 'manager-pin-context';
        ctxEl.style.cssText = 'font-size:14px;color:var(--color-text-muted, rgba(255,255,255,.7));margin-bottom:12px;text-align:center';
        body.insertBefore(ctxEl, body.firstChild);
      }
      if (ctxEl) ctxEl.textContent = contextLabel;
    } else if (ctxEl) {
      // No context this time — clear the previous one rather than leak it.
      ctxEl.textContent = '';
    }
  }
  requireManagerPin(callback);
}

// Drag logic
let dragId=null, dragOffX=0, dragOffY=0;
function startDrag(e,id){
  if(!editMode)return;
  e.preventDefault();
  dragId=+id;
  const el=e.currentTarget && e.currentTarget.querySelector
    ? e.currentTarget.querySelector('[data-id="'+id+'"]')
    : document.querySelector('[data-id="'+id+'"]');
  const rect=(el||e.currentTarget).getBoundingClientRect();
  dragOffX=e.clientX-rect.left;
  dragOffY=e.clientY-rect.top;
  if (el) el.classList.add('dragging');
  document.addEventListener('mousemove',onDrag);
  document.addEventListener('mouseup',endDrag);
}

// ─── Table resize (edit mode) ─────────────────────────────────────────────
// Drag za pravy dolny roh chipu meni width/height. Snap 20px grid.
// Min: 80x80 (tap target + text fit). Max: 240x200 (chip-friendly cap).
let _resizeId = null;
let _resizeStartW = 0;
let _resizeStartH = 0;
let _resizeStartClientX = 0;
let _resizeStartClientY = 0;
const TABLE_W_MIN = 80;
const TABLE_W_MAX = 240;
const TABLE_H_MIN = 80;
const TABLE_H_MAX = 200;

function _snapSize(v, min, max) {
  var s = Math.round(v / 20) * 20;
  if (s < min) s = min;
  if (s > max) s = max;
  return s;
}

function startTableResize(e, id) {
  if (!editMode) return;
  _resizeId = +id;
  var chip = document.querySelector('[data-id="' + id + '"]');
  if (!chip) { _resizeId = null; return; }
  var rect = chip.getBoundingClientRect();
  _resizeStartW = rect.width;
  _resizeStartH = rect.height;
  var isTouch = e.touches && e.touches[0];
  _resizeStartClientX = isTouch ? e.touches[0].clientX : e.clientX;
  _resizeStartClientY = isTouch ? e.touches[0].clientY : e.clientY;
  chip.classList.add('resizing');
  if (isTouch) {
    document.addEventListener('touchmove', _onResizeTouch, { passive: false });
    document.addEventListener('touchend', _endTableResize);
    document.addEventListener('touchcancel', _endTableResize);
  } else {
    document.addEventListener('mousemove', _onResizeMouse);
    document.addEventListener('mouseup', _endTableResize);
  }
}

function _applyResize(clientX, clientY) {
  if (!_resizeId) return;
  var chip = document.querySelector('[data-id="' + _resizeId + '"]');
  if (!chip) return;
  var dx = clientX - _resizeStartClientX;
  var dy = clientY - _resizeStartClientY;
  var w = _snapSize(_resizeStartW + dx, TABLE_W_MIN, TABLE_W_MAX);
  var h = _snapSize(_resizeStartH + dy, TABLE_H_MIN, TABLE_H_MAX);
  chip.style.width = w + 'px';
  chip.style.height = h + 'px';
  var t = TABLES.find(function (x) { return x.id === _resizeId; });
  if (t) { t.width = w; t.height = h; }
}

function _onResizeMouse(e) { _applyResize(e.clientX, e.clientY); }
function _onResizeTouch(e) {
  if (!e.touches[0]) return;
  e.preventDefault();
  _applyResize(e.touches[0].clientX, e.touches[0].clientY);
}

function _endTableResize() {
  if (_resizeId) {
    var chip = document.querySelector('[data-id="' + _resizeId + '"]');
    if (chip) chip.classList.remove('resizing');
    _resizeId = null;
  }
  document.removeEventListener('mousemove', _onResizeMouse);
  document.removeEventListener('mouseup', _endTableResize);
  document.removeEventListener('touchmove', _onResizeTouch);
  document.removeEventListener('touchend', _endTableResize);
  document.removeEventListener('touchcancel', _endTableResize);
}

if (typeof window !== 'undefined') {
  window.startTableResize = startTableResize;
}
function onDrag(e){
  if(!dragId)return;
  const canvas=document.getElementById('floorCanvas');
  const cr=canvas.getBoundingClientRect();
  let nx=e.clientX-cr.left-dragOffX+canvas.scrollLeft;
  let ny=e.clientY-cr.top-dragOffY+canvas.scrollTop;
  // Snap to 20px grid
  nx=Math.round(nx/20)*20;ny=Math.round(ny/20)*20;
  nx=Math.max(0,nx);ny=Math.max(0,ny);
  const t=TABLES.find(x=>x.id===dragId);
  if(t){t.x=nx;t.y=ny}
  const el=document.querySelector(`[data-id="${dragId}"]`);
  if(el){el.style.left=nx+'px';el.style.top=ny+'px'}
}
function endDrag(){
  if(dragId){
    const el=document.querySelector(`[data-id="${dragId}"]`);
    if(el)el.classList.remove('dragging');
    dragId=null;
  }
  document.removeEventListener('mousemove',onDrag);
  document.removeEventListener('mouseup',endDrag);
}

// Touch drag support
document.addEventListener('touchstart',function(e){
  if(!editMode)return;
  // Resize handle má precedens — ak je touch na corner grip, nech ho rieši
  // startTableResize (cez canvas touchstart listener), neštartuj position drag.
  if (e.target.closest('[data-resize-id]')) return;
  const chip=e.target.closest('.table-chip');
  if(!chip)return;
  e.preventDefault();
  const id=chip.dataset.id;
  dragId=+id;
  const rect=chip.getBoundingClientRect();
  const touch=e.touches[0];
  dragOffX=touch.clientX-rect.left;
  dragOffY=touch.clientY-rect.top;
  chip.classList.add('dragging');
},{passive:false});
document.addEventListener('touchmove',function(e){
  if(!dragId)return;
  e.preventDefault();
  const touch=e.touches[0];
  const canvas=document.getElementById('floorCanvas');
  const cr=canvas.getBoundingClientRect();
  let nx=touch.clientX-cr.left-dragOffX+canvas.scrollLeft;
  let ny=touch.clientY-cr.top-dragOffY+canvas.scrollTop;
  nx=Math.round(nx/20)*20;ny=Math.round(ny/20)*20;
  nx=Math.max(0,nx);ny=Math.max(0,ny);
  const t=TABLES.find(x=>x.id===dragId);
  if(t){t.x=nx;t.y=ny}
  const el=document.querySelector(`[data-id="${dragId}"]`);
  if(el){el.style.left=nx+'px';el.style.top=ny+'px'}
},{passive:false});
document.addEventListener('touchend',function(){
  if(dragId){
    const el=document.querySelector(`[data-id="${dragId}"]`);
    if(el)el.classList.remove('dragging');
    dragId=null;
  }
});

// Keyboard
document.addEventListener('keydown',function(e){
  // Dynamic confirm/prompt modals get top priority for Escape.
  // Escape iba zatvori modal (_dismiss) — NESMIE klikat confirmCancel,
  // lebo cancel tlacidlo moze niest onCancel akciu (showConfirm opts).
  var cModal=document.getElementById('confirmModal');
  if(cModal&&cModal.classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();if(cModal._dismiss){cModal._dismiss()}else{cModal.classList.remove('show');setTimeout(function(){cModal.remove()},300)}}
    if(e.key==='Enter'){e.preventDefault();document.getElementById('confirmOk').click()}return}
  var pModal=document.getElementById('promptModal');
  if(pModal&&pModal.classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();document.getElementById('promptCancel').click()}return}
  // Table picker overlay
  var tpEl=document.getElementById('tablePicker');
  if(tpEl&&tpEl.classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeTablePicker()}return}
  // Inline move mode
  if(moveMode){
    if(e.key==='Escape'){e.preventDefault();exitMoveMode()}return}
  // Manager PIN modal
  if(document.getElementById('managerPinModal').classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeManagerPinModal()}if(e.key==='Enter'){e.preventDefault();verifyManagerPin()}return}
  // Logout modal
  if(document.getElementById('logoutModal').classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeLogoutModal()}return}
  if(document.getElementById('noteModal').classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeNoteModal()}if(e.key==='Enter'){e.preventDefault();saveNote()}return}
  if(document.getElementById('paymentModal').classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();closeModal()}if(e.key==='Enter'){e.preventDefault();confirmPayment()}return}
  // Qty popup: Escape closes and restores focus; block other global shortcuts while open
  var qp=document.getElementById('qtyPopup');
  if(qp&&qp.classList.contains('show')){
    if(e.key==='Escape'){e.preventDefault();hideQtyPopup();return}
    return
  }
  // Generic overlay escape (close topmost)
  if(e.key==='Escape'){
    var overlays=document.querySelectorAll('.u-overlay.show');
    if(overlays.length){e.preventDefault();overlays[overlays.length-1].classList.remove('show');return}
  }
  // Don't handle view/global shortcuts while typing in a field
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return
  // F2 toggle tables/products
  if(e.key==='F2'){e.preventDefault();switchView(currentView==='tables'?'products':'tables');return}
  if(e.key==='?'){e.preventDefault();document.getElementById('helpModal').classList.add('show');return}
  if(currentView==='products'){
    if(e.key==='/'&&document.activeElement!==document.getElementById('searchInput')){e.preventDefault();document.getElementById('searchInput').focus();return}
    if(document.activeElement.tagName!=='INPUT'){const cats=Object.keys(MENU);const k=parseInt(e.key);if(k>=1&&k<=cats.length){e.preventDefault();setCategory(cats[k-1])}}
  }
});

// === KEYBOARD NAVIGATION ENHANCEMENTS ===

// Activate focusable elements with Enter/Space
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' ')return;
  var t=e.target;
  if(t.getAttribute('role')==='button'||t.hasAttribute('tabindex')){
    if(t.tagName!=='BUTTON'&&t.tagName!=='A'&&t.tagName!=='INPUT'){
      e.preventDefault();
      t.click();
    }
  }
});

// Arrow key navigation in product grid
document.addEventListener('keydown',function(e){
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;
  var focused=document.activeElement;
  if(!focused||!focused.classList.contains('product-card'))return;

  e.preventDefault();
  var cards=Array.from(document.querySelectorAll('.product-card'));
  var idx=cards.indexOf(focused);
  if(idx===-1)return;

  var grid=focused.parentElement;
  var cols=Math.floor(grid.offsetWidth/focused.offsetWidth)||1;

  var next=-1;
  switch(e.key){
    case 'ArrowRight':next=idx+1;break;
    case 'ArrowLeft':next=idx-1;break;
    case 'ArrowDown':next=idx+cols;break;
    case 'ArrowUp':next=idx-cols;break;
  }
  if(next>=0&&next<cards.length)cards[next].focus();
});

// Focus trap for modals and qty popup
document.addEventListener('keydown',function(e){
  if(e.key!=='Tab')return;
  var qtyPop=document.getElementById('qtyPopup');
  var modal=null;
  if(qtyPop&&qtyPop.classList.contains('show'))modal=qtyPop;
  else modal=document.querySelector('.u-overlay.show .u-modal');
  if(!modal)return;

  var focusable=modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  if(!focusable.length)return;

  var first=focusable[0];
  var last=focusable[focusable.length-1];

  if(e.shiftKey){
    if(document.activeElement===first){e.preventDefault();last.focus()}
  }else{
    if(document.activeElement===last){e.preventDefault();first.focus()}
  }
});

// Long press quantity popup
let longPressTimer=null;
let longPressItem=null;

function setupLongPress(){
  const grid=document.getElementById('productsGrid');
  if(!grid) return;

  grid.addEventListener('pointerdown',function(e){
    const card=e.target.closest('.product-card');
    if(!card) return;
    const name=card.getAttribute('data-name');
    if(!name) return;

    longPressTimer=setTimeout(function(){
      let item=null;
      Object.values(MENU).forEach(cat=>{
        const found=cat.items.find(i=>i.name===name);
        if(found) item=found;
      });
      if(!item) return;

      longPressItem=item;
      showQtyPopup(e.clientX,e.clientY,item);
    },500);
  });

  grid.addEventListener('pointerup',function(){clearTimeout(longPressTimer)});
  grid.addEventListener('pointerleave',function(){clearTimeout(longPressTimer)});
  grid.addEventListener('pointermove',function(e){
    if(longPressTimer && (Math.abs(e.movementX)>5||Math.abs(e.movementY)>5)){
      clearTimeout(longPressTimer);
    }
  });
}

function showQtyPopup(x,y,item){
  captureModalTrigger();
  const popup=document.getElementById('qtyPopup');
  const grid=document.getElementById('qtyPopupGrid');
  const title=document.getElementById('qtyPopupTitle');

  title.textContent=item.name;
  grid.innerHTML='';
  for(let i=1;i<=10;i++){
    const btn=document.createElement('button');
    btn.className='qty-popup-btn';
    btn.textContent=i;
    btn.onclick=async function(){
      try {
        var menuItemId = MENU_ID_MAP.get(item.name);
        if (!menuItemId) return;

        const order = getOrder();
        const existing = order.find(o => o.name === item.name);

        if (!currentOrderId) {
          const newOrder = await api.post('/orders', {
            tableId: selectedTableId,
            items: [{ menuItemId, qty: i, note: '' }]
          });
          currentOrderId = newOrder.id;
          currentOrderVersion = newOrder.version || 1;
        } else if (existing) {
          var qtyPut = await api.put('/orders/' + currentOrderId + '/items/' + existing.id, { qty: existing.qty + i, version: currentOrderVersion });
          if (qtyPut && qtyPut.orderVersion != null) currentOrderVersion = qtyPut.orderVersion;
        } else {
          await api.post('/orders/' + currentOrderId + '/items', {
            items: [{ menuItemId, qty: i, note: '' }], version: currentOrderVersion
          });
        }

        const t = TABLES.find(x => x.id === selectedTableId);
        if (t && t.status === 'free') t.status = 'occupied';
        await loadTableOrder(selectedTableId, true);
        renderOrder();updateQtyBadges();
        hideQtyPopup();
        showToast(item.emoji+' '+i+'x '+item.name+' pridane');
      } catch(e) {
        console.error('qtyPopup error:', e);
        showToast('Chyba: ' + e.message);
      }
    };
    grid.appendChild(btn);
  }

  const pw=270,ph=160;
  let px=x-pw/2;
  let py=y-ph-20;
  if(px<10)px=10;
  if(px+pw>window.innerWidth-10)px=window.innerWidth-pw-10;
  if(py<10)py=y+20;

  popup.style.left=px+'px';
  popup.style.top=py+'px';
  popup.classList.add('show');
  requestAnimationFrame(function(){
    var firstBtn=grid.querySelector('button');
    if(firstBtn)firstBtn.focus();
  });
}

function hideQtyPopup(){
  var qp=document.getElementById('qtyPopup');
  if(qp)qp.classList.remove('show');
  longPressItem=null;
  restoreModalTrigger();
}

document.addEventListener('pointerdown',function(e){
  const popup=document.getElementById('qtyPopup');
  if(popup.classList.contains('show')&&!popup.contains(e.target)){
    hideQtyPopup();
  }
});

// Hold to auto-increment qty
let qtyHoldTimer=null;
let qtyHoldInterval=null;

function startQtyHold(name,delta,itemId){
  clearQtyHold();
  qtyHoldTimer=setTimeout(function(){
    // Accumulate qty changes and batch render via rAF
    var _holdAccum=0;
    var _holdRAF=null;
    qtyHoldInterval=setInterval(function(){
      _holdAccum+=delta;
      if(!_holdRAF){
        _holdRAF=requestAnimationFrame(function(){
          _holdRAF=null;
          var flush=_holdAccum;
          _holdAccum=0;
          if(flush!==0) changeQty(name,flush,itemId);
        });
      }
    },150);
  },400);
}

function clearQtyHold(){
  clearTimeout(qtyHoldTimer);
  clearInterval(qtyHoldInterval);
  qtyHoldTimer=null;
  qtyHoldInterval=null;
}

document.addEventListener('pointerup',clearQtyHold);
document.addEventListener('pointerleave',clearQtyHold);

// Swipe actions for order items
let _swipeX0=0,_swipeCurrent=null,_swipeDragging=false;
function _getSwipeX(e){ return e.touches ? e.touches[0].clientX : e.clientX; }
function _getSwipeEndX(e){ return e.changedTouches ? e.changedTouches[0].clientX : e.clientX; }
function swipeStart(e,el){
  _swipeX0=_getSwipeX(e);
  _swipeDragging=true;
  if(_swipeCurrent&&_swipeCurrent!==el)_swipeCurrent.classList.remove('swiped');
  _swipeCurrent=el;
}
function swipeMove(e,el){
  if(!_swipeDragging)return;
  const dx=_getSwipeX(e)-_swipeX0;
  const inner=el.querySelector('.order-item-inner');
  if(dx<-20){inner.style.transform='translateX('+Math.max(dx,-160)+'px)';if(e.cancelable)e.preventDefault()}
  else if(dx>20&&el.classList.contains('swiped')){inner.style.transform='translateX('+Math.min(dx-160,0)+'px)';if(e.cancelable)e.preventDefault()}
}
function swipeEnd(e,el){
  _swipeDragging=false;
  const inner=el.querySelector('.order-item-inner');
  inner.style.transform='';
  const dx=_getSwipeEndX(e)-_swipeX0;
  if(dx<-60)el.classList.add('swiped');
  else el.classList.remove('swiped');
}
// Close swipe on tap/click outside
document.addEventListener('click',function(e){
  if(_swipeCurrent&&!_swipeCurrent.contains(e.target)){_swipeCurrent.classList.remove('swiped');_swipeCurrent=null}
});

// Safety net: persist local orders on tab close (setOrder already persists on each change)
window.addEventListener('beforeunload',_persistTableOrdersNow);
