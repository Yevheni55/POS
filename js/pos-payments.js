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
  var foodItems = items.filter(function (i) { return getItemDest(i.name) === 'kuchyna'; });
  var drinkItems = items.filter(function (i) { return getItemDest(i.name) !== 'kuchyna'; });
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
  var foodItems = items.filter(function (i) { return getItemDest(i.name) === 'kuchyna'; });
  var drinkItems = items.filter(function (i) { return getItemDest(i.name) !== 'kuchyna'; });
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
