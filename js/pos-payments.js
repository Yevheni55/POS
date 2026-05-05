'use strict';
// pos-payments.js - Payment, kitchen send, storno, manager PIN verification, formatting

function getOrderTotal() {
  var order = getOrder();
  var subtotal = order.reduce(function (s, o) { return s + o.price * o.qty; }, 0);
  var currentOrd = tableOrdersList.find(function (o) { return o.id === currentOrderId; });
  var discountAmt = currentOrd && currentOrd.discountAmount ? parseFloat(currentOrd.discountAmount) : 0;
  return Math.max(0, subtotal - discountAmt);
}

function readFiscalPayload(source) {
  if (!source) return null;
  return source.fiscal || source.portos || source.receipt || source.document || source.result || null;
}

/** API chyby maju telo v err.data; uspesna odpoved ma fiscal priamo na koreni. */
function readFiscalFromPaymentResponse(result, err) {
  return readFiscalPayload(result) || readFiscalPayload(err && err.data) || readFiscalPayload(err);
}

function normalizeFiscalOutcome(result, err) {
  // PR-C: fiscal/payment paths refuse to queue offline. Surface as blocked
  // so the operator sees an unambiguous "must be online" message instead of
  // the misleading "queued for later" banner.
  if (err && err.code === 'OFFLINE_NO_QUEUE') {
    return {
      kind: 'blocked',
      tone: 'error',
      message: err.message || 'Pripojenie nie je dostupne — platbu nie je mozne dokoncit offline.',
    };
  }

  if (err && err.status === 409) {
    return { kind: 'blocked', tone: 'error', message: err.message || 'Objednavka sa zmenila, skus to prosim znovu.' };
  }

  if (err && (err.status === 400 || err.status === 403)) {
    var fe = readFiscalFromPaymentResponse(null, err);
    var fd = (fe && (fe.errorDetail || fe.message)) || '';
    return {
      kind: 'blocked',
      tone: 'error',
      message: fd || err.message || 'Portos zablokoval fiskalizaciu.',
    };
  }

  if (err && err.name === 'TypeError' && /fetch/i.test(err.message || '')) {
    return { kind: 'offline_queued', tone: 'warning', message: 'Platba bola ulozena offline a synchronizuje sa neskor.' };
  }

  var fiscal = readFiscalFromPaymentResponse(result, err);
  var status = String((fiscal && (fiscal.status || fiscal.state || fiscal.resultMode || fiscal.mode || fiscal.result)) || '').toLowerCase();
  var httpStatus = fiscal && Number(fiscal.httpStatus || fiscal.statusCode || fiscal.code);
  var message =
    (fiscal && (fiscal.message || fiscal.errorDetail || fiscal.error || '')) ||
    (err && err.message) ||
    '';

  if (fiscal && fiscal.isSuccessful === true) {
    return { kind: 'success', tone: 'success', message: 'Platba uspesna. Fiskalizacia prebehla v Portose.' };
  }

  if (status === 'online_success' || status === 'reconciled_online_success') {
    return {
      kind: 'success',
      tone: 'success',
      message:
        'Platba uspesna. Doklad je v eKase. Papier ma tlacit Portos (CHDU). Ak blok neprisiel, v .env musi byt PORTOS_PRINTER_NAME=pos (nie nazov tlačiarne).',
    };
  }

  if (status === 'success' || status === 'ok' || status === 'registered' || status === 'done' || httpStatus === 200) {
    return { kind: 'success', tone: 'success', message: 'Platba uspesna. Fiskalizacia prebehla v Portose.' };
  }

  if (status === 'offline_accepted' || status === 'accepted_offline' || status === 'queued' || status === 'offline' || httpStatus === 202) {
    return { kind: 'offline_accepted', tone: 'warning', message: 'Platba uspesna. Portos ju prijal offline a dokonci ju neskor.' };
  }

  if (status === 'disabled') {
    return {
      kind: 'no_fiscal',
      tone: 'warning',
      title: 'Platba bez eKasy',
      message:
        'Ucet v POS je zatvoreny, ale fiskalizacia cez Portos na serveri je vypnuta (PORTOS_ENABLED). V Portose sa doklad nevytvoril — zapnite ju v server/.env a restartujte backend.',
    };
  }

  if (status === 'ambiguous' || status === 'unknown' || status === 'needs_reconciliation' || /ambiguous|reconcil|overit|overenie/i.test(message)) {
    return { kind: 'ambiguous', tone: 'warning', message: 'Stav fiskalizacie je nejasny. Neposielaj to hned znovu.' };
  }

  if (status === 'blocked' || status === 'blocked_by_portos' || status === 'rejected' || status === 'denied' || /blocked|rejected|denied|invalid|zablok/i.test(message)) {
    return { kind: 'blocked', tone: 'error', message: message || 'Portos zablokoval fiskalizaciu.' };
  }

  if (err) {
    if (fiscal && (status === 'ambiguous' || status === 'unknown' || status === 'needs_reconciliation')) {
      return { kind: 'ambiguous', tone: 'warning', message: message || 'Stav fiskalizacie je nejasny. Neposielaj to hned znovu.' };
    }
    return { kind: 'blocked', tone: 'error', message: message || 'Platbu sa nepodarilo spracovat.' };
  }

  if (result && (result.payment != null || result.alreadyProcessed) && !fiscal) {
    return {
      kind: 'no_fiscal',
      tone: 'warning',
      title: 'Chyba odpovede',
      message: 'Platba bola prijata, ale server neposlal stav fiskalizacie. Skontroluj admin / logy backendu.',
    };
  }

  return { kind: 'success', tone: 'success', message: 'Platba uspesna.' };
}

function setPaymentFeedback(text, tone, titleOverride) {
  var methodEl = document.getElementById('modalMethod');
  var titleEl = document.getElementById('modalTitle');
  if (methodEl) methodEl.textContent = text;
  if (titleEl) {
    if (titleOverride) titleEl.textContent = titleOverride;
    else if (tone === 'error') titleEl.textContent = 'Platba zablokovana';
    else if (tone === 'warning') titleEl.textContent = 'Platba caka na overenie';
  }
}

function finalizeSuccessfulPayment(message, tone) {
  closeModal();
  if (isMobile()) closeMobPayDrawer();
  currentOrderId = null;
  currentOrderVersion = null;
  // Drop any client-side mutation flags from the just-paid order so they can
  // not leak into a fresh order on the same table (otherwise a stale
  // _pendingStorno / _pendingRemovals would fire on the next sendToKitchen
  // and POST against a closed orderId, surfacing as "Objednavka nenajdena").
  if (typeof _pendingStorno !== 'undefined') _pendingStorno = [];
  if (typeof _pendingRemovals !== 'undefined') _pendingRemovals = [];
  _orderDirty = false;

  return loadTableOrder(selectedTableId, true).then(function () {
    // Bounce the cashier back to the floor: order panel hides, the just-paid
    // table now shows as free, and a fresh tap starts a clean new order
    // instead of typing into a closed-order limbo.
    var navPromise;
    if (isMobile() && typeof switchMobTab === 'function') {
      navPromise = switchMobTab('mobTabTables');
    } else if (typeof switchView === 'function') {
      navPromise = switchView('tables');
    }
    return Promise.resolve(navPromise).then(function () {
      renderOrder();
      if (isMobile() && typeof renderMobOrder === 'function') renderMobOrder();
      updateTableStatuses();
      if (currentView === 'tables' && typeof renderFloor === 'function') renderFloor();
      if (isMobile() && typeof renderMobTables === 'function') renderMobTables();
      showToast(message, tone);
    });
  });
}

function getPendingSendItems(order) {
  return (order || []).filter(function(item) { return !item.sent; });
}

function getPrintContext() {
  var table = TABLES.find(function (t) { return t.id === selectedTableId; });
  var user = api.getUser();
  return {
    tableName: table ? table.name : String(selectedTableId || ''),
    staffName: user ? user.name : '',
  };
}

async function printKitchenAndBarTickets(items, orderId) {
  if (!items || !items.length) return { printed: 0 };

  var context = getPrintContext();
  // Čísla zákazníka (kategória 🔢 Čísla) idú IBA na kuchynský bon —
  // kuchyňa hľadá zákazníka pri vydaní jedla, bar nie. Bar dostane iba
  // skutočné nápoje, číslo si bar nevypisuje.
  var numberItems = items.filter(function (i) { return isTicketNumberItem(i.name); });
  var realItems = items.filter(function (i) { return !isTicketNumberItem(i.name); });
  var foodItems = realItems.filter(function (i) { return getItemDest(i.name) === 'kuchyna'; });
  var drinkItems = realItems.filter(function (i) { return getItemDest(i.name) !== 'kuchyna'; });
  // Číslo pridaj IBA na začiatok kuchynského bonu, a IBA ak kuchyňa má
  // čo robiť. Inak by sa vytlačil prázdny bon iba s "🔢 14" — papier
  // navyše a kuchyňa by sa pýtala čo s ním.
  if (numberItems.length && foodItems.length) {
    foodItems = numberItems.concat(foodItems);
  }
  var tasks = [];

  if (foodItems.length) {
    tasks.push({ dest: 'kuchyna', count: foodItems.length, promise: api.post('/print/kitchen', {
      dest: 'KUCHYNA',
      tableName: context.tableName,
      staffName: context.staffName,
      items: foodItems.map(function (i) { return { qty: i.qty, name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }) });
  }

  if (drinkItems.length) {
    tasks.push({ dest: 'bar', count: drinkItems.length, promise: api.post('/print/kitchen', {
      dest: 'BAR',
      tableName: context.tableName,
      staffName: context.staffName,
      items: drinkItems.map(function (i) { return { qty: i.qty, name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }) });
  }

  if (!tasks.length) return { printed: 0 };

  // Resolve each print job individually so a failed bar doesn't kill the toast
  // for kuchyna (and vice versa). The /api/print/kitchen endpoint returns
  // { ok: true, queued: bool } — queued=true means printer was offline and
  // job went to the local queue.
  var results = await Promise.all(tasks.map(function (t) {
    return t.promise.then(function (resp) {
      var queued = !!(resp && resp.queued);
      return { dest: t.dest, count: t.count, ok: true, queued: queued };
    }, function (err) {
      return { dest: t.dest, count: t.count, ok: false, queued: false, error: err };
    });
  }));

  return {
    printed: items.length,
    foodCount: foodItems.length,
    drinkCount: drinkItems.length,
    results: results,
  };
}

async function printStornoKitchenAndBarTickets(items, orderId) {
  if (!items || !items.length) return { printed: 0 };

  var context = getPrintContext();
  // Storno: rovnaká logika ako pri normálnom odoslaní — číslo iba na
  // kuchynský storno-bon, bar nedostane (nepotrebuje vedieť ku komu).
  // Číslo v storne dáva zmysel iba ak je tam aj reálna jedlá položka.
  var numberItems = items.filter(function (i) { return isTicketNumberItem(i.name); });
  var realItems = items.filter(function (i) { return !isTicketNumberItem(i.name); });
  var foodItems = realItems.filter(function (i) { return getItemDest(i.name) === 'kuchyna'; });
  var drinkItems = realItems.filter(function (i) { return getItemDest(i.name) !== 'kuchyna'; });
  if (numberItems.length && foodItems.length) {
    foodItems = numberItems.concat(foodItems);
  }
  var prints = [];

  if (foodItems.length) {
    prints.push(api.post('/print/kitchen', {
      dest: 'STORNO KUCHYNA',
      tableName: context.tableName,
      staffName: context.staffName,
      items: foodItems.map(function (i) { return { qty: -Math.abs(i.qty), name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }));
  }

  if (drinkItems.length) {
    prints.push(api.post('/print/kitchen', {
      dest: 'STORNO BAR',
      tableName: context.tableName,
      staffName: context.staffName,
      items: drinkItems.map(function (i) { return { qty: -Math.abs(i.qty), name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }));
  }

  if (!prints.length) return { printed: 0 };
  await Promise.all(prints);
  return { printed: items.length, foodCount: foodItems.length, drinkCount: drinkItems.length };
}

async function flushPendingStornoTickets() {
  if (!_pendingStorno.length || !currentOrderId) return { printed: 0, skipped: true };

  var payloadItems = _pendingStorno.map(function (item) {
    return {
      menuItemId: item.menuItemId,
      qty: item.qty,
      note: item.note || '',
    };
  });

  var result = await api.post('/orders/' + currentOrderId + '/send-storno-and-print', {
    items: payloadItems,
  });

  if (!result || !result.items || !result.items.length) {
    _pendingStorno = [];
    return { printed: 0, skipped: true };
  }

  await printStornoKitchenAndBarTickets(result.items, currentOrderId);
  _pendingStorno = [];
  return { printed: result.items.length };
}

async function autoSendPendingItemsBeforePayment() {
  var pendingItems = getPendingSendItems(getOrder());
  if (!pendingItems.length) return { printed: 0, skipped: true };

  var result = await api.post('/orders/' + currentOrderId + '/send-and-print', {});
  if (!result || !result.items || !result.items.length) return { printed: 0, skipped: true };

  await printKitchenAndBarTickets(result.items, currentOrderId);
  await loadTableOrder(selectedTableId, true);
  renderOrder();
  if (isMobile()) renderMobOrder();
  // After every successful send, refresh the sales-rank in the background
  // so the per-category sort reflects today's bestsellers — not yesterday's.
  if (typeof loadTopItems === 'function') loadTopItems(true);

  return { printed: result.items.length };
}

function initiatePayment(method) {
  const order = getOrder();
  const total = getOrderTotal();
  if (!order.length || total <= 0) { showToast('Nie je co platit', 'warning'); return; }
  // Accept local-only items as payable even without currentOrderId/_orderDirty —
  // they may be a stale draft the localStorage persistence preserved across a
  // page reload (where _orderDirty resets to false). syncOrderToServer below
  // will create the server order from them.
  if (!currentOrderId && !_orderDirty) {
    var hasLocalItems = order.some(function (o) {
      return o && !o.sent && typeof o.id === 'number' && o.id > 1000000000;
    });
    if (!hasLocalItems) { showToast('Nie je co platit', 'warning'); return; }
  }
  pendingPaymentMethod = method;
  const labels = { hotovost: 'Hotovost', karta: 'Karta', zaplatit: 'Univerzalna platba' };
  const icons = { hotovost: '\uD83D\uDCB5', karta: '\uD83D\uDCB3', zaplatit: '\uD83D\uDCB0' };
  document.getElementById('modalIcon').textContent = icons[method];
  document.getElementById('modalTitle').textContent = 'Potvrdenie platby';
  document.getElementById('modalAmount').textContent = fmt(total);
  document.getElementById('modalMethod').textContent = 'Sposob: ' + labels[method];
  document.getElementById('paymentModal').classList.add('show');
  _setupCashHelper(method, total);
}

// Cash helper \u2014 vlastn\u00FD numpad pre hotovostn\u00FA platbu. Input je READONLY
// (caret-color:transparent) tak\u017Ee \u017Eiadna nat\u00EDvna kl\u00E1vesnica nevysko\u010D\u00ED na
// touchscreen kase. Oper\u00E1tor pou\u017E\u00EDva quick-pick chipsy (naj\u010Dastej\u0161ie sumy)
// alebo n\u00E1\u0161 numpad (1-9, ., 0, \u232B). V\u00FDmenok sa r\u00E1t\u00E1 v re\u00E1lnom \u010Dase, ostane
// v\u017Edy vidite\u013En\u00FD pod numpadom \u2014 kl\u00E1vesnica u\u017E nezakr\u00FDva ni\u010D.
function _setupCashHelper(method, total) {
  var helper = document.getElementById('cashHelper');
  if (!helper) return;
  if (method !== 'hotovost') {
    helper.classList.add('pos-hidden');
    return;
  }
  helper.classList.remove('pos-hidden');
  var input = document.getElementById('cashGivenInput');
  var qbtns = document.getElementById('cashQuickBtns');
  var numpad = document.getElementById('cashNumpad');
  var changeAmt = document.getElementById('cashChangeAmount');
  if (!input || !qbtns || !numpad || !changeAmt) return;

  // Reset stav (modal sa m\u00F4\u017Ee otv\u00E1ra\u0165 opakovane na rovnakej obrazovke).
  input.value = '';
  changeAmt.textContent = '\u2014';
  changeAmt.style.color = 'var(--color-text-sec)';

  // Quick-pick presety: presn\u00E1 suma + najbli\u017E\u0161ie 5/10/20/50/100 \u20AC. Pokr\u00FDva
  // 95 % platieb \u2014 oper\u00E1tor nemus\u00ED klika\u0165 na numpade.
  var presets = [];
  presets.push({ v: total, label: 'Presne' });
  [5, 10, 20, 50, 100].forEach(function (denom) {
    var v = Math.ceil(total / denom) * denom;
    if (v > total && !presets.some(function (p) { return Math.abs(p.v - v) < 0.005; })) {
      presets.push({ v: v, label: fmt(v) });
    }
  });
  presets = presets.slice(0, 5);

  qbtns.innerHTML = presets.map(function (p) {
    return '<button type="button" class="u-btn u-btn-ghost cash-preset-btn" data-cash="' + p.v.toFixed(2)
      + '" style="flex:0 1 auto;padding:8px 14px;font-size:13px;min-width:70px">' + p.label + '</button>';
  }).join('');
  Array.prototype.forEach.call(qbtns.querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () {
      input.value = b.dataset.cash.replace('.', ',');
      _updateCashChange(total);
    });
  });

  // Vlastn\u00FD numpad 3\u00D74. Posledn\u00FD riadok: \u232B (backspace) | 0 | C (clear all).
  // Backspace zma\u017Ee posledn\u00FA \u010D\u00EDslicu, clear vynuluje na pr\u00E1zdny stav.
  var keys = [
    { k: '1' }, { k: '2' }, { k: '3' },
    { k: '4' }, { k: '5' }, { k: '6' },
    { k: '7' }, { k: '8' }, { k: '9' },
    { k: '\u232B', special: 'back' }, { k: '0' }, { k: 'C', special: 'clear' },
  ];
  numpad.innerHTML = keys.map(function (kk) {
    var bg = kk.special ? 'rgba(245,158,11,.10)' : 'rgba(255,255,255,.06)';
    var color = kk.special ? '#f59e0b' : 'var(--color-text)';
    var border = kk.special ? '1px solid rgba(245,158,11,.30)' : '1px solid var(--color-border)';
    return '<button type="button" class="cash-numpad-btn"'
      + ' data-key="' + kk.k + '"'
      + (kk.special ? ' data-special="' + kk.special + '"' : '')
      + ' style="padding:14px 8px;font-size:20px;font-weight:600;border-radius:6px;'
      +        'background:' + bg + ';border:' + border + ';color:' + color + ';'
      +        'cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent">'
      + kk.k + '</button>';
  }).join('');
  Array.prototype.forEach.call(numpad.querySelectorAll('.cash-numpad-btn'), function (b) {
    b.addEventListener('click', function () {
      _onNumpadKey(b.dataset.key, b.dataset.special, total);
    });
  });
}

// Append digit / handle special keys. Internal value sa dr\u017E\u00ED v Slovak
// form\u00E1te s \u010Diarkou ("12,50"); pri parse v _updateCashChange ju zmen\u00EDme
// na bodku. Limit na 8 znakov (= max 99999,99 \u20AC) aby sa input nepretiekol.
function _onNumpadKey(key, special, total) {
  var input = document.getElementById('cashGivenInput');
  if (!input) return;
  var v = String(input.value || '');

  if (special === 'back') {
    v = v.slice(0, -1);
  } else if (special === 'clear') {
    v = '';
  } else if (key === ',' || key === '.') {
    if (v.indexOf(',') === -1) {
      v = (v.length === 0 ? '0' : v) + ',';
    }
  } else {
    // Zabr\u00E1\u0148 viac ako 2 desatinn\u00FDm miestam (e.g., '12,505' nedovol\u00EDme).
    var commaIdx = v.indexOf(',');
    if (commaIdx !== -1 && v.length - commaIdx > 2) return;
    if (v.length < 8) v = v + key;
  }
  input.value = v;
  _updateCashChange(total);
}

function _updateCashChange(total) {
  var input = document.getElementById('cashGivenInput');
  var changeAmt = document.getElementById('cashChangeAmount');
  if (!input || !changeAmt) return;
  var raw = String(input.value || '').replace(',', '.');
  var given = parseFloat(raw);
  if (!Number.isFinite(given) || given <= 0) {
    changeAmt.textContent = '\u2014';
    changeAmt.style.color = 'var(--color-text-sec)';
    return;
  }
  var change = Math.round((given - total) * 100) / 100;
  if (change < 0) {
    // Z\u00E1kazn\u00EDk dal menej ako je celkov\u00E1 suma \u2014 varovanie, oper\u00E1tor p\u00FDta
    // dorovnanie alebo doklepe \u010Fal\u0161ie bankovky.
    changeAmt.textContent = 'Ch\u00FDba ' + fmt(-change);
    changeAmt.style.color = 'var(--color-danger, #ef4444)';
  } else if (change === 0) {
    changeAmt.textContent = '0,00 \u20AC';
    changeAmt.style.color = 'var(--color-text-sec)';
  } else {
    changeAmt.textContent = fmt(change);
    changeAmt.style.color = 'var(--color-success, #22c55e)';
  }
}

function closeModal() {
  document.getElementById('paymentModal').classList.remove('show');
  pendingPaymentMethod = null;
}

async function confirmPayment() {
  var btn = document.querySelector('#paymentModal .u-btn-mint');
  if (btn) btnLoading(btn);
  try {
    var localOrder = getOrder();
    if (!localOrder.length || getOrderTotal() <= 0) {
      closeModal();
      showToast('Nie je co platit', 'warning');
      return;
    }

    await syncOrderToServer();

    if (!currentOrderId) {
      showToast('Nie je co platit', 'warning');
      return;
    }

    var stornoResult = await flushPendingStornoTickets();
    if (stornoResult && stornoResult.printed) {
      showToast('Storno bolo odoslane na kuchynu/bar', 'success');
    }

    var autoSendResult = await autoSendPendingItemsBeforePayment();
    if (autoSendResult && autoSendResult.printed) {
      showToast('Neodoslane polozky boli automaticky odoslane na kuchynu/bar', 'success');
    }

    var total = getOrderTotal();
    var _orderId = currentOrderId;
    var _method = pendingPaymentMethod;
    var paymentResult = await api.post('/payments', {
      orderId: _orderId,
      method: _method,
      amount: total
    });

    if (paymentResult === null) {
      var queuedOutcome = { kind: 'offline_queued', tone: 'warning', message: 'Platba bola odlozena offline. Dokoncime ju po obnove spojenia.' };
      setPaymentFeedback(queuedOutcome.message, queuedOutcome.tone);
      showToast(queuedOutcome.message, queuedOutcome.tone);
      return;
    }

    var outcome = normalizeFiscalOutcome(paymentResult, null);
    setPaymentFeedback(outcome.message, outcome.tone, outcome.title);

    if (outcome.kind === 'blocked' || outcome.kind === 'ambiguous') {
      showToast(outcome.message, outcome.tone);
      return;
    }

    await finalizeSuccessfulPayment(outcome.message, outcome.tone);
  } catch (e) {
    console.error('confirmPayment error:', e);
    var outcome = normalizeFiscalOutcome(null, e);
    setPaymentFeedback(outcome.message, outcome.tone, outcome.title);
    showToast(outcome.message, outcome.tone);
  } finally {
    if (btn) btnReset(btn);
  }
}

// showToast is now provided by /components/toast.js
// Bridge: old calls used showToast(msg, true) for success - map boolean to type string
var _origShowToast = window.showToast;
window.showToast = function(msg, typeOrBool) {
  var type = 'info';
  if (typeOrBool === true) type = 'success';
  else if (typeOrBool === false || typeOrBool === undefined) type = 'info';
  else if (typeof typeOrBool === 'string') type = typeOrBool;
  if (type === 'info' && typeof msg === 'string' && /^(chyba|error)/i.test(msg)) type = 'error';
  _origShowToast(msg, type);
};

// === Manager PIN for storno ===
var pendingStornoAction = null;

function requireManagerPin(action) {
  pendingStornoAction = action;
  document.getElementById('managerPinInput').value = '';
  document.getElementById('managerPinError').classList.add('pos-hidden');
  document.getElementById('managerPinModal').classList.add('show');
  setTimeout(function() { document.getElementById('managerPinInput').focus(); }, 100);
}

async function verifyManagerPin() {
  var pin = document.getElementById('managerPinInput').value;
  var btn = document.querySelector('#managerPinModal .u-btn-ice');
  if (btn) btnLoading(btn);
  try {
    await api.post('/auth/verify-manager', { pin: pin });
    document.getElementById('managerPinModal').classList.remove('show');
    if (pendingStornoAction) { pendingStornoAction(); pendingStornoAction = null; }
  } catch(e) {
    document.getElementById('managerPinError').textContent = 'Nespravny PIN';
    document.getElementById('managerPinError').classList.remove('pos-hidden');
    document.getElementById('managerPinInput').value = '';
  } finally {
    if (btn) btnReset(btn);
  }
}

function closeManagerPinModal() {
  document.getElementById('managerPinModal').classList.remove('show');
  pendingStornoAction = null;
}

async function sendToKitchen() {
  await syncOrderToServer();

  var btn = null;
  var mobBtn = null;
  var btnOriginalHTML = null;
  var mobBtnOriginalHTML = null;

  try {
    var stornoResult = await flushPendingStornoTickets();
    if (stornoResult && stornoResult.printed) {
      showToast('Storno bolo odoslane na kuchynu/bar', 'success');
    }

    var order = getOrder();
    if (!order.length || !currentOrderId) {
      if (selectedTableId) await loadTableOrder(selectedTableId, true);
      renderOrder(); updateTableStatuses(); renderFloor();
      return;
    }

    btn = document.getElementById('btnSend');
    mobBtn = document.getElementById('mobBtnSend');
    if (btn) {
      btnOriginalHTML = btn.innerHTML;
      btn.disabled = true;
      btn.style.pointerEvents = 'none';
      btn.innerHTML = '<span class="btn-spinner"></span>Posielam…';
    }
    if (mobBtn) {
      mobBtnOriginalHTML = mobBtn.innerHTML;
      mobBtn.disabled = true;
      mobBtn.style.pointerEvents = 'none';
      mobBtn.innerHTML = '<span class="btn-spinner"></span>Posielam…';
    }

    var result = await api.post('/orders/' + currentOrderId + '/send-and-print', {});

    if (!result.printed) {
      showToast('Nie je co odoslat', 'warning');
      return;
    }
    var printOutcome = await printKitchenAndBarTickets(result.items, currentOrderId);

    await loadTableOrder(selectedTableId, true);
    renderOrder();
    if (isMobile()) renderMobOrder();
    // Refresh sales-rank in the background so the next render of the
    // category grid bubbles today's hot sellers to the top.
    if (typeof loadTopItems === 'function') loadTopItems(true);

    // Build a toast that reflects the REAL print outcome per destination:
    //   - printed online   => "✔ Bon vytlačený: kuchyňa 2 + bar 1"   (success)
    //   - went to queue    => "⏳ Bon do queue: kuchyňa 2 + bar 1 — tlačiareň offline"  (warning)
    //   - mixed            => "Bon: kuchyňa 2 vytlačený + bar 1 do queue (offline)"   (warning)
    //   - all failed hard  => fall through to catch and show error
    var perDest = (printOutcome && printOutcome.results) || [];
    function fmt(d) {
      var label = d.dest === 'kuchyna' ? 'kuchyňa' : 'bar';
      return label + ' ' + d.count;
    }

    if (perDest.length === 0) {
      // Defensive: nothing was actually dispatched (shouldn't happen given printed>0)
      showToast('Bon odoslany', 'success');
    } else {
      var failed = perDest.filter(function (d) { return !d.ok; });
      var queued = perDest.filter(function (d) { return d.ok && d.queued; });
      var printed = perDest.filter(function (d) { return d.ok && !d.queued; });

      if (failed.length && !printed.length && !queued.length) {
        // Every job threw — surface as an error so cashier knows nothing reached printer or queue
        var errMsg = (failed[0].error && failed[0].error.message) || 'tlač zlyhala';
        showToast('Chyba tlače: ' + perDest.map(fmt).join(' + ') + ' — ' + errMsg, 'error');
      } else if (queued.length === perDest.length) {
        // All went to offline queue
        showToast('⏳ Bon do queue: ' + perDest.map(fmt).join(' + ') + ' — tlačiareň offline', 'warning');
      } else if (printed.length === perDest.length) {
        // Everything actually printed
        showToast('✔ Bon vytlačený: ' + perDest.map(fmt).join(' + '), 'success');
      } else {
        // Mixed: show per-destination state
        var parts = perDest.map(function (d) {
          if (!d.ok) return fmt(d) + ' chyba';
          return fmt(d) + (d.queued ? ' do queue' : ' vytlačený');
        });
        showToast('Bon: ' + parts.join(' + ') + (queued.length ? ' (offline)' : ''), 'warning');
      }
    }
  } catch (e) {
    console.error('sendToKitchen error:', e);
    showToast('Chyba: ' + e.message, 'error');
  } finally {
    if (btn) {
      if (btnOriginalHTML !== null) btn.innerHTML = btnOriginalHTML;
      btn.disabled = false;
      btn.style.pointerEvents = '';
    }
    if (mobBtn) {
      if (mobBtnOriginalHTML !== null) mobBtn.innerHTML = mobBtnOriginalHTML;
      mobBtn.disabled = false;
      mobBtn.style.pointerEvents = '';
    }
  }
}

// One-time spinner style for the "Posielam..." button state in sendToKitchen.
// Lives here (not in css/pos.css) because js/pos-payments.js owns this UX bit.
if (typeof document !== 'undefined' && !document.getElementById('btn-spinner-style')) {
  var _btnSpinnerStyle = document.createElement('style');
  _btnSpinnerStyle.id = 'btn-spinner-style';
  _btnSpinnerStyle.textContent = '@keyframes btn-spin{to{transform:rotate(360deg)}}.btn-spinner{display:inline-block;width:14px;height:14px;margin-right:6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:btn-spin .8s linear infinite;vertical-align:-2px}';
  document.head.appendChild(_btnSpinnerStyle);
}

// printTicket removed - printing now via /api/print/kitchen

function serveItem(name) {
  renderOrder();
  showToast(name + ' vydane');
}

function fmt(n) { return n.toFixed(2).replace('.', ',') + ' \u20AC'; }
