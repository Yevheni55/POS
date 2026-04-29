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

  return loadTableOrder(selectedTableId, true).then(function () {
    renderOrder();
    if (isMobile()) renderMobOrder();
    updateTableStatuses();
    if (currentView === 'tables') renderFloor();
    if (isMobile()) renderMobTables();
    showToast(message, tone);
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
  var prints = [];

  if (foodItems.length) {
    prints.push(api.post('/print/kitchen', {
      dest: 'KUCHYNA',
      tableName: context.tableName,
      staffName: context.staffName,
      items: foodItems.map(function (i) { return { qty: i.qty, name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }));
  }

  if (drinkItems.length) {
    prints.push(api.post('/print/kitchen', {
      dest: 'BAR',
      tableName: context.tableName,
      staffName: context.staffName,
      items: drinkItems.map(function (i) { return { qty: i.qty, name: i.name, note: i.note || '' }; }),
      orderNum: orderId
    }));
  }

  if (!prints.length) return { printed: 0 };
  await Promise.all(prints);
  return { printed: items.length, foodCount: foodItems.length, drinkCount: drinkItems.length };
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
  if (!currentOrderId && !_orderDirty) { showToast('Nie je co platit', 'warning'); return; }
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

    var btn = document.getElementById('btnSend');
    var mobBtn = document.getElementById('mobBtnSend');
    if (btn) btnLoading(btn);
    if (mobBtn) btnLoading(mobBtn);

    var result = await api.post('/orders/' + currentOrderId + '/send-and-print', {});

    if (!result.printed) {
      showToast('Nie je co odoslat', 'warning');
      return;
    }
    await printKitchenAndBarTickets(result.items, currentOrderId);

    await loadTableOrder(selectedTableId, true);
    renderOrder();
    if (isMobile()) renderMobOrder();

    var foodItems = result.items.filter(function(i) { return getItemDest(i.name) === 'kuchyna'; });
    var drinkItems = result.items.filter(function(i) { return getItemDest(i.name) !== 'kuchyna'; });
    var msg = [];
    if (foodItems.length) msg.push('kuchyna ' + foodItems.length);
    if (drinkItems.length) msg.push('bar ' + drinkItems.length);
    showToast('Bon: ' + msg.join(' + '), true);
  } catch (e) {
    console.error('sendToKitchen error:', e);
    showToast('Chyba: ' + e.message);
  } finally {
    if (btn) btnReset(btn);
    if (mobBtn) btnReset(mobBtn);
  }
}

// printTicket removed - printing now via /api/print/kitchen

function serveItem(name) {
  renderOrder();
  showToast(name + ' vydane');
}

function fmt(n) { return n.toFixed(2).replace('.', ',') + ' \u20AC'; }
