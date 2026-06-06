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

// Send helper — pouzivame fetch (nie api.post) aby sme mali statusCode +
// JSON detail pre 422 limit-prekroceny error. Pri 422 vyvolame manager PIN
// gate a retry s overrideLimit=true.
async function _doSendAndPrintPost(overrideLimit) {
  var token = (typeof api !== 'undefined' && api.getToken) ? api.getToken() : '';
  var resp = await fetch('/api/orders/' + currentOrderId + '/send-and-print', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ overrideLimit: !!overrideLimit }),
  });
  var body = null;
  try { body = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    var err = new Error((body && body.error) || ('HTTP ' + resp.status));
    err.statusCode = resp.status;
    err.detail = body && body.detail;
    throw err;
  }
  return body;
}

async function _sendWithLimitOverride() {
  try {
    return await _doSendAndPrintPost(false);
  } catch (limitErr) {
    if (limitErr && limitErr.statusCode === 422 && limitErr.detail) {
      var d = limitErr.detail;
      var ctxLine;
      if (d.limitType === 'drink') {
        ctxLine = 'Limit nápojov 5 €/deň prekročený pre ' + d.personName + ': '
          + 'dnes už ' + (d.priorUsage || 0).toFixed(2) + ' €, táto objednávka '
          + (d.attempted || 0).toFixed(2) + ' € (spolu ' + (d.wouldBeTotal || 0).toFixed(2) + ' €).';
      } else {
        ctxLine = 'Limit 1 jedlo/deň prekročený pre ' + d.personName + ': '
          + 'dnes už ' + (d.priorUsage || 0) + ' jedál.';
      }
      if (typeof showManagerPin !== 'function') {
        showToast(ctxLine, 'error');
        return null;
      }
      return await new Promise(function (resolve) {
        showManagerPin(ctxLine + ' Pokračovať s odoslaním?', async function () {
          try {
            var r = await _doSendAndPrintPost(true);
            resolve(r);
          } catch (e2) {
            showToast(e2.message || 'Aj override zlyhal', 'error');
            resolve(null);
          }
        });
      });
    }
    throw limitErr;
  }
}

async function autoSendPendingItemsBeforePayment() {
  var pendingItems = getPendingSendItems(getOrder());
  if (!pendingItems.length) return { printed: 0, skipped: true };

  var result = await _sendWithLimitOverride();
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
  // Monochrome SVG markers \u2014 banknote / card / wallet. Stroke uses currentColor
  // so the icon inherits the modal's text tone instead of color-emoji noise.
  const banknoteSvg = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg>';
  const cardSvg = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
  const universalSvg = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>';
  const icons = { hotovost: banknoteSvg, karta: cardSvg, zaplatit: universalSvg };
  document.getElementById('modalIcon').innerHTML = icons[method];
  document.getElementById('modalTitle').textContent = 'Potvrdenie platby';
  document.getElementById('modalAmount').textContent = fmt(total);
  document.getElementById('modalMethod').textContent = 'Sposob: ' + labels[method];
  _renderReceiptPreview(order, total, method);
  document.getElementById('paymentModal').classList.add('show');
  _setupCashHelper(method, total);
}

// Receipt preview — zobrazi zoznam poloziek pred fiskalnou tlacou.
// Casnik vidi presne co pojde na bon: meno + qty x cena + spolu. Chyti
// chybu (zlu polozku, zly qty) PRED Portos roundtripom. Render je
// thermal-printer-styled (mono font, kompaktny riadok, dashed perforation
// hore aj dole).
function _renderReceiptPreview(order, total, method) {
  var host = document.getElementById('receiptPreview');
  if (!host) return;

  // Aggregate companion + sauce annotation rows visually — do not show
  // 0 EUR "Omáčka (combo)" rows separately. Note inline under primary
  // item instead.
  var primaries = [];
  var annotations = {};
  for (var i = 0; i < order.length; i++) {
    var it = order[i];
    if (it.name === 'Omáčka (combo)' && it._companionOf) {
      annotations[it._companionOf] = it.note || '';
      continue;
    }
    primaries.push(it);
  }

  var table = TABLES.find(function(t){ return t.id === selectedTableId; });
  var tableName = table ? table.name : ('Stol ' + selectedTableId);
  var user = api.getUser();
  var staffName = user ? user.name : '';
  var now = new Date();
  var timeStr = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
    ? new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' }).format(now)
    : (String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0'));
  var dateStr = now.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Discount detection — getOrderTotal already applied; show line if discount > 0.
  var subtotal = primaries.reduce(function(s, o){ return s + o.price * o.qty; }, 0);
  var discount = subtotal - total;
  var hasDiscount = discount > 0.005;

  var rowsHtml = primaries.map(function(it){
    var safeName = (typeof escHtml === 'function') ? escHtml(it.name) : it.name;
    var lineTotal = it.price * it.qty;
    var unitLabel = it.qty > 1 ? (it.qty + '× ' + fmt(it.price)) : fmt(it.price);
    var ann = annotations[it.id];
    var annHtml = ann ? '<div class="rp-note">+ ' + (typeof escHtml === 'function' ? escHtml(ann) : ann) + '</div>' : '';
    return ''
      + '<div class="rp-row">'
      +   '<div class="rp-row-main">'
      +     '<div class="rp-name">' + safeName + '</div>'
      +     '<div class="rp-meta">' + unitLabel + '</div>'
      +     annHtml
      +   '</div>'
      +   '<div class="rp-amt">' + fmt(lineTotal) + '</div>'
      + '</div>';
  }).join('');

  var methodLabel = method === 'hotovost' ? 'Hotovosť' : (method === 'karta' ? 'Karta' : 'Platba');

  host.innerHTML = ''
    + '<div class="rp-header">'
    +   '<div class="rp-meta-row"><span>' + (typeof escHtml === 'function' ? escHtml(tableName) : tableName) + '</span><span class="rp-mono">' + dateStr + ' · ' + timeStr + '</span></div>'
    +   (staffName ? '<div class="rp-meta-row rp-meta-row--dim"><span>Obsluha</span><span>' + (typeof escHtml === 'function' ? escHtml(staffName) : staffName) + '</span></div>' : '')
    + '</div>'
    + '<div class="rp-perforation"></div>'
    + '<div class="rp-rows">' + rowsHtml + '</div>'
    + (hasDiscount
        ? '<div class="rp-perforation"></div>'
          + '<div class="rp-rows">'
          +   '<div class="rp-row"><div class="rp-row-main"><div class="rp-name">Medzisúčet</div></div><div class="rp-amt rp-amt--dim">' + fmt(subtotal) + '</div></div>'
          +   '<div class="rp-row"><div class="rp-row-main"><div class="rp-name">Zľava</div></div><div class="rp-amt rp-amt--discount">−' + fmt(discount) + '</div></div>'
          + '</div>'
        : '')
    + '<div class="rp-perforation"></div>'
    + '<div class="rp-total-row">'
    +   '<span class="rp-total-label">SPOLU</span>'
    +   '<span class="rp-total-amt">' + fmt(total) + '</span>'
    + '</div>'
    + '<div class="rp-method-line">' + methodLabel + ' · ' + primaries.length + ' ' + (primaries.length === 1 ? 'položka' : (primaries.length < 5 ? 'položky' : 'položiek')) + '</div>';
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
  var changeBox = document.getElementById('cashChangeBox');
  var changeLabel = document.getElementById('cashChangeLabel');
  if (changeBox) changeBox.classList.remove('is-change', 'is-short');
  if (changeLabel) changeLabel.textContent = 'Vyda\u0165:';

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
  // Styling teraz cez .cash-numpad-btn v css/pos.css aby @media
  // (pointer:coarse) mohol bumpovat hodnoty pre tablet. Special keys
  // (backspace, clear) dostavaju .is-special variantu s amber tintom.
  numpad.innerHTML = keys.map(function (kk) {
    return '<button type="button" class="cash-numpad-btn'
      + (kk.special ? ' is-special' : '') + '"'
      + ' data-key="' + kk.k + '"'
      + (kk.special ? ' data-special="' + kk.special + '"' : '')
      + '>' + kk.k + '</button>';
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
  var changeBox = document.getElementById('cashChangeBox');
  var changeLabel = document.getElementById('cashChangeLabel');
  if (!input || !changeAmt) return;
  // State carried by .is-change / .is-short classes on #cashChangeBox (CSS).
  if (changeBox) changeBox.classList.remove('is-change', 'is-short');
  var raw = String(input.value || '').replace(',', '.');
  var given = parseFloat(raw);
  if (!Number.isFinite(given) || given <= 0) {
    if (changeLabel) changeLabel.textContent = 'Vyda\u0165:';
    changeAmt.textContent = '\u2014';
    return;
  }
  var change = Math.round((given - total) * 100) / 100;
  if (change < 0) {
    // Z\u00E1kazn\u00EDk dal menej ako je celkov\u00E1 suma \u2014 \u010Derven\u00FD CH\u00DDBA stav, nech to
    // \u010D\u00EDta ako chyba, nie ako drobn\u00E1 zmena farby. Oper\u00E1tor p\u00FDta dorovnanie.
    if (changeLabel) changeLabel.textContent = 'CH\u00DDBA';
    changeAmt.textContent = fmt(-change);
    if (changeBox) changeBox.classList.add('is-short');
  } else if (change === 0) {
    if (changeLabel) changeLabel.textContent = 'Vyda\u0165:';
    changeAmt.textContent = '0,00 \u20AC';
  } else {
    if (changeLabel) changeLabel.textContent = 'Vyda\u0165:';
    changeAmt.textContent = fmt(change);
    if (changeBox) changeBox.classList.add('is-change');
  }
}

function closeModal() {
  document.getElementById('paymentModal').classList.remove('show');
  pendingPaymentMethod = null;
}

// === ZAMESTNANECKA SPOTREBA ===
// Skryva/zobrazuje tlacidlo "Zamestnanecka spotreba" podla toho, ci je
// aktualne vybrany stol v zone 'zamestanci'. Volane z loadTableOrder.
function updateStaffMealButtonVisibility() {
  var btn = document.getElementById('btnStaffMeal');
  if (!btn) return;
  var t = (typeof TABLES !== 'undefined' && selectedTableId)
    ? TABLES.find(function(x){ return x.id === selectedTableId; })
    : null;
  var show = !!(t && t.zone === 'zamestanci');
  if (show) btn.removeAttribute('hidden');
  else btn.setAttribute('hidden', '');
}

// Uzavrie objednavku ako zamestnanecku spotrebu — ziadna platba, ziadny
// fiskal, write-off so sumou COGS sa zapise pre P&L. Pred tym auto-send
// vsetkych nepostatych poloziek aby kuchyna dostala bon a sklad sa odpisal.
// Helper — POST close-as-staff-meal + extract HTTP status + JSON detail
// pre limit error (422). api.post zvyčajne hádže Error s len .message,
// preto manuálne čítame response cez fetch keď chceme statusCode + detail.
async function _doCloseStaffMealPost(overrideLimit) {
  var token = (typeof api !== 'undefined' && api.getToken) ? api.getToken() : '';
  var resp = await fetch('/api/orders/' + currentOrderId + '/close-as-staff-meal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ version: currentOrderVersion, overrideLimit: !!overrideLimit }),
  });
  var body = null;
  try { body = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    var err = new Error((body && body.error) || ('HTTP ' + resp.status));
    err.statusCode = resp.status;
    err.detail = body && body.detail;
    throw err;
  }
  return body;
}

async function closeAsStaffMeal() {
  var order = getOrder();
  if (!order.length) { showToast('Nie je co uzatvorit', 'warning'); return; }

  // Sanity: musi to byt zona 'zamestanci' (back-end to overi tiez)
  var t = (typeof TABLES !== 'undefined' && selectedTableId)
    ? TABLES.find(function(x){ return x.id === selectedTableId; })
    : null;
  if (!t || t.zone !== 'zamestanci') {
    showToast('Tato akcia je len pre stoly v zone Zamestanci', 'warning');
    return;
  }

  // Confirm — táto akcia neprebieha cez fiškál, takže staff musí potvrdiť.
  var totalEur = (typeof getOrderTotal === 'function') ? getOrderTotal() : 0;
  var confirmed = window.confirm(
    'Uzavriet objednavku ako zamestnanecku spotrebu?\n\n'
    + 'Hodnota menu: ' + (typeof fmt === 'function' ? fmt(totalEur) : totalEur.toFixed(2) + ' €')
    + '\n\nZIADNA platba a ZIADNY fiskal sa nevytvori.\n'
    + 'Sklad sa odpise normalne (cez recepty).'
  );
  if (!confirmed) return;

  var btn = document.getElementById('btnStaffMeal');
  if (btn) btnLoading(btn);

  try {
    // Najprv sync local-only items na server
    await syncOrderToServer();
    if (!currentOrderId) { showToast('Nie je co uzatvorit', 'warning'); return; }

    // Auto-send nepostatych poloziek tak ako pri normalnej platbe — kuchyna
    // musi dostat bon, inak by recept ingrediencie boli nikdy odpisane.
    var stornoResult = await flushPendingStornoTickets();
    if (stornoResult && stornoResult.printed) {
      showToast('Storno bolo odoslane na kuchynu/bar', 'success');
    }
    var autoSendResult = await autoSendPendingItemsBeforePayment();
    if (autoSendResult && autoSendResult.printed) {
      showToast('Polozky boli odoslane na kuchynu/bar', 'success');
    }

    // Backend: uzavri ako staff_meal (s optional overrideLimit ak manazer
    // potvrdí prekročenie denného limitu cez PIN)
    var result;
    try {
      result = await _doCloseStaffMealPost(false);
    } catch (limitErr) {
      // Backend vrátil 422 s detail (drink/meal limit prekročený). Spýtaj
      // manager PIN, ak schváli → retry s overrideLimit=true.
      if (limitErr && limitErr.statusCode === 422 && limitErr.detail) {
        var d = limitErr.detail;
        var ctxLine;
        if (d.limitType === 'drink') {
          ctxLine = 'Limit nápojov 5 €/deň prekročený pre ' + d.personName + ': '
            + 'dnes už ' + (d.priorUsage || 0).toFixed(2) + ' €, táto objednávka '
            + (d.attempted || 0).toFixed(2) + ' € (spolu ' + (d.wouldBeTotal || 0).toFixed(2) + ' €).';
        } else {
          ctxLine = 'Limit 1 jedlo/deň prekročený pre ' + d.personName + ': '
            + 'dnes už ' + (d.priorUsage || 0) + ' jedál.';
        }
        if (typeof showManagerPin === 'function') {
          await new Promise(function (resolve) {
            showManagerPin(ctxLine + ' Pokračovať?', async function () {
              try {
                result = await _doCloseStaffMealPost(true);
                resolve();
              } catch (e2) {
                showToast(e2.message || 'Aj override zlyhal', 'error');
                resolve();
              }
            });
          });
          if (!result) return; // user cancelled or override failed
        } else {
          showToast(ctxLine, 'error');
          return;
        }
      } else {
        throw limitErr;
      }
    }

    if (!result || !result.order) {
      showToast('Uzavretie zlyhalo', 'error');
      return;
    }

    showToast('Zamestnanecka spotreba zaznamenana — naklad: ' + (typeof fmt === 'function' ? fmt(Number(result.totalCogs) || 0) : result.totalCogs + ' €'), 'success');
    // Phase 5 — staff meal close-out also gets a confirmation haptic.
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15); } catch (_) {}
    // Free table + clear order rovnako ako pri normalnej platbe
    await finalizeSuccessfulPayment('Zamestnanecka spotreba zaznamenana', 'success');
  } catch (e) {
    console.error('closeAsStaffMeal error:', e);
    var msg = (e && e.message) ? e.message : 'Uzavretie zlyhalo';
    showToast(msg, 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

// Paragón offline fallback — § 10 z. 289/2008.
// Volane keď platba zlyhá lebo Portos/eKasa je nedostupné. Zobrazí confirm
// modal "eKasa nedostupná — vystaviť paragón?". Na potvrdenie:
//   1. Vystaví paragón cez POST /api/paragons (lokálne, monotonic číslo)
//   2. Vytlačí ESC/POS doklad cez POST /api/print/paragon (so slovom „PARAGÓN")
//   3. Background worker neskôr (po obnove Portos) registruje cez eKasa
//
// Returns true ak paragón vystavený (caller pokračuje ako pri success),
// false ak user odmietol alebo error (caller pokračuje s pôvodným error
// toastom).
async function offerParagonFallback(reason) {
  return new Promise(function (resolve) {
    if (typeof showConfirm !== 'function') {
      console.warn('offerParagonFallback: showConfirm helper not available');
      return resolve(false);
    }
    showConfirm(
      'eKasa nedostupná',
      'Portos / eKasa nereaguje. Môžete vystaviť PARAGÓN (náhradný doklad). Po obnove sa automaticky zaregistruje v eKasa systéme.',
      async function () {
        // User confirmed → issue paragón
        try {
          var order = getOrder();
          var items = order
            .filter(function (o) { return o && o.name && o.name !== 'Omáčka (combo)'; })
            .map(function (it) {
              return { id: it.id, name: it.name, qty: it.qty, price: it.price, vatRate: it.vatRate || 0, note: it.note || '' };
            });
          var total = getOrderTotal();
          var method = pendingPaymentMethod || 'hotovost';

          var issueRes = await api.post('/paragons', {
            orderId: currentOrderId,
            items: items,
            paymentMethod: method,
            totalAmount: total,
            reason: reason || 'portos_unavailable',
          });

          if (!issueRes || !issueRes.paragonNumber) {
            showToast('Paragón sa nepodarilo vystaviť', 'error');
            return resolve(false);
          }

          // Print paragón ESC/POS ticket (best-effort — keď tlačiareň offline,
          // printQueue ho dohne)
          try {
            var user = (typeof api !== 'undefined' && api.getUser) ? api.getUser() : null;
            var table = (typeof TABLES !== 'undefined') ? TABLES.find(function (t) { return t.id === selectedTableId; }) : null;
            await api.post('/print/paragon', {
              paragonNumber: issueRes.paragonNumber,
              tableName: table ? table.name : null,
              staffName: user ? user.name : '',
              items: items,
              total: total,
              method: method,
              vatRate: null, // non-payer DPH (forceZeroVat) → no VAT row
              companyName: null,
            });
          } catch (printErr) {
            console.warn('paragon print failed:', printErr);
            showToast('Paragón #' + issueRes.paragonNumber + ' vystavený, ale tlač zlyhala. Vytlačte cez admin → História.', 'warning');
          }

          showToast('Paragón ' + issueRes.paragonNumber + ' vystavený. Po obnove eKasa sa automaticky zaregistruje.', 'success');
          resolve(true);
        } catch (err) {
          console.error('offerParagonFallback error:', err);
          showToast('Vystavenie paragónu zlyhalo: ' + (err.message || 'neznáma chyba'), 'error');
          resolve(false);
        }
      },
      {
        type: 'danger',
        confirmText: 'Vystaviť paragón',
        cancelText: 'Zrušiť'
      }
    );
  });
}

async function confirmPayment(opts) {
  opts = opts || {};
  // Underpayment guard (cash only): the typed cash is a change-calculator that
  // is never validated at confirm — amount:total is posted regardless. So a
  // cashier can see a small red "Chýba 3,00", press Potvrdiť, and the bill
  // closes as fully paid. If an explicit amount was typed and it's below the
  // total, ask once. Empty input (no amount typed) pays normally as before.
  if (!opts._underpaymentConfirmed && pendingPaymentMethod === 'hotovost') {
    var _cashEl = document.getElementById('cashGivenInput');
    if (_cashEl) {
      var _given = parseFloat(String(_cashEl.value || '').replace(',', '.'));
      var _due = getOrderTotal();
      if (Number.isFinite(_given) && _given > 0 && _given < _due - 0.005) {
        showConfirm(
          'Zákazník dal menej',
          'Zadaná hotovosť ' + fmt(_given) + ' je menšia ako suma účtu ' + fmt(_due) + '. Naozaj uzavrieť účet?',
          function () { confirmPayment({ _underpaymentConfirmed: true }); },
          { type: 'danger', confirmText: 'Uzavrieť účet', cancelText: 'Späť' }
        );
        return;
      }
    }
  }

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
      // Portos blokuje → ponúkni paragón fallback (§ 10 ERP zákon).
      var issued = await offerParagonFallback('portos_blocked');
      if (issued) {
        await finalizeSuccessfulPayment('Paragón vystavený. eKasa sa dohne neskôr.', 'warning');
        return;
      }
      showToast(outcome.message, outcome.tone);
      return;
    }

    // Phase 5 — success haptic. 20ms is a slightly stronger bzik than
    // the add/qty 10ms — operator feels "transaction done".
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(20); } catch (_) {}

    // Bump in-memory today revenue counter so shift strip updates immediately.
    // Authoritative source is server; this is just optimistic UI.
    if (typeof window._todayRevenue !== 'number') window._todayRevenue = 0;
    window._todayRevenue += Number(total) || 0;
    if (typeof updateShiftStrip === 'function') updateShiftStrip();

    await finalizeSuccessfulPayment(outcome.message, outcome.tone);
  } catch (e) {
    console.error('confirmPayment error:', e);
    var outcome = normalizeFiscalOutcome(null, e);
    setPaymentFeedback(outcome.message, outcome.tone, outcome.title);

    // Portos transport error / network down → ponúkni paragón fallback.
    var isOfflineCase = (e && e.code === 'OFFLINE_NO_QUEUE')
      || (e && e.name === 'TypeError' && /fetch/i.test(e.message || ''))
      || outcome.kind === 'blocked'
      || outcome.kind === 'offline_queued';
    if (isOfflineCase) {
      var issued = await offerParagonFallback(e && e.code === 'OFFLINE_NO_QUEUE' ? 'no_connection' : 'portos_error');
      if (issued) {
        await finalizeSuccessfulPayment('Paragón vystavený. eKasa sa dohne neskôr.', 'warning');
        return;
      }
    }
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
  var errEl = document.getElementById('managerPinError');
  var inputEl = document.getElementById('managerPinInput');
  if (btn) btnLoading(btn);
  try {
    // _noAuthRedirect: a wrong PIN returns 401 — without this api.request would
    // log the cashier out and redirect the terminal to /login.
    var vr = await api.request('/auth/verify-manager', {
      method: 'POST',
      body: JSON.stringify({ pin: pin }),
      _noAuthRedirect: true,
    });
    // Offline → api.request queues the POST and returns null. We must NOT treat
    // that as a pass (would run the gated storno without ever checking the PIN).
    if (vr === null) {
      errEl.textContent = 'Bez pripojenia sa PIN nedá overiť';
      errEl.classList.remove('pos-hidden');
      return;
    }
    document.getElementById('managerPinModal').classList.remove('show');
    if (pendingStornoAction) { pendingStornoAction(); pendingStornoAction = null; }
  } catch(e) {
    var msg;
    if (e && e.status === 429) {
      msg = (e.data && e.data.error) || 'Zablokované — priveľa pokusov, skús o chvíľu';
    } else if (e && (e.status >= 500 || (e.name === 'TypeError' && /fetch/i.test(e.message || '')))) {
      // Server/transport error — keep the typed PIN so the manager needn't retype.
      msg = 'Server nedostupný — skús znova';
    } else {
      // 401/403/etc. → genuinely the wrong PIN.
      msg = 'Nesprávny PIN';
      inputEl.value = '';
    }
    errEl.textContent = msg;
    errEl.classList.remove('pos-hidden');
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

    var result = await _sendWithLimitOverride();
    if (!result) return; // limit prekrocene + user zrusil PIN prompt

    if (!result.printed) {
      // No-op — pouzivatel nechcel "Nie je co odoslat" notifikaciu.
      // Tlacidlo Poslat je teraz disabled cez btnSend.disabled = !pending,
      // takze tap fire-uje iba ked je naozaj co odoslat. Pri race condition
      // (medzi disable check a sendAndPrint) ticho return.
      return;
    }
    // Phase 5 — confirmation haptic when send actually fires (not on
    // the empty-order early-return above).
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15); } catch (_) {}
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
        // All went to offline queue. Queue worker retry-uje automaticky kazdych
        // 15s, takze bon sa dotlaci hned ako tlaciaren odpovie — preto
        // upokojujuca formulacia (nie "offline" co znie ako zlyhanie).
        showToast('⏳ Bon vo fronte: ' + perDest.map(fmt).join(' + ') + ' — vytlačí sa hneď ako tlačiareň odpovie', 'warning');
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

// Predúčet (pre-bill) — informatívny doklad PRED fiškálnou platbou.
// Klasický restauračný flow: zákazník chce vidieť účet → čašník stlačí
// Predúčet → tlačiareň vypľuje non-fiskal blocek s velkym disclaimerom
// "NIE JE DANOVY DOKLAD" → zákazník skontroluje, vyberie spôsob platby
// → čašník stlačí Hotovosť/Karta → vtedy ide fiškálny blocek cez Portos.
//
// Žiadny side-effect: stav objednávky sa nemení, môžeš tlačiť viackrát.
async function printPreBill() {
  // Najprv sync — ak operátor pridal položky offline, potrebujeme aktuálny stav
  // na serveri aby orderNum + items boli konzistentné.
  await syncOrderToServer();

  var order = getOrder();
  if (!order.length) {
    showToast('Prazdna objednavka — nie je co tlacit', 'warning');
    return;
  }

  var btn = document.getElementById('btnPreBill');
  var mobBtn = document.getElementById('mobBtnPreBill');
  var btnOriginalHTML = null;
  var mobBtnOriginalHTML = null;

  if (btn) {
    btnOriginalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    btn.innerHTML = '<span class="btn-spinner"></span>Tlacim…';
  }
  if (mobBtn) {
    mobBtnOriginalHTML = mobBtn.innerHTML;
    mobBtn.disabled = true;
    mobBtn.style.pointerEvents = 'none';
    mobBtn.innerHTML = '<span class="btn-spinner"></span>Tlacim…';
  }

  try {
    // Subtotal pred zľavou + discount — server vie obe vytlačiť, klient ich rátame tu
    var subtotal = order.reduce(function (s, o) { return s + o.price * o.qty; }, 0);
    var total = getOrderTotal();
    var discount = Math.max(0, subtotal - total);

    var table = (typeof TABLES !== 'undefined') ? TABLES.find(function (t) { return t.id === selectedTableId; }) : null;
    var tableName = table ? table.name : ('Stol ' + selectedTableId);
    var user = (typeof api !== 'undefined' && api.getUser) ? api.getUser() : null;
    var staffName = user ? (user.name || '') : '';

    // Filter položky — sauce companion riadky riešime server-side, ale pre istotu
    // pošleme všetko a server ich preskočí. Kazdy item potrebuje name, qty, price.
    var items = order.map(function (it) {
      return {
        name: it.name,
        qty: it.qty,
        price: it.price,
        note: it.note || '',
      };
    });

    var result = await api.post('/print/pre-bill', {
      tableName: tableName,
      staffName: staffName,
      items: items,
      total: total,
      subtotal: subtotal,
      discount: discount,
      orderNum: currentOrderId || null,
    });

    if (result && result.queued) {
      showToast('Predúčet v queue — tlačiareň offline', 'warning');
    } else {
      showToast('✔ Predúčet vytlačený', 'success');
    }
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10); } catch (_) {}
  } catch (e) {
    console.error('printPreBill error:', e);
    showToast('Chyba tlače predúčtu: ' + (e.message || 'neznáma chyba'), 'error');
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
