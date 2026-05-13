'use strict';
// pos-orders.js — Order management: add/remove items, sync, accounts, notes, split, move, merge

// Order — local-first: no API calls until send/payment/table-switch
var _orderDirty = false; // true when local state differs from server
var _pendingStorno = []; // tracks qty reductions on sent items for storno print
var _pendingRemovals = []; // server item IDs removed locally via changeQty (qty→0)
var _nextLocalOrderItemId = Date.now();
var _addToastTimer = null;
var _addToastCount = 0;
var _addToastEmoji = '';
var _addToastName = '';
var _addToastMixed = false;
var _savingNote = false;

// ---- Companion items (e.g. bottle deposit "Záloha") ----
// A menu item can declare companionMenuItemId pointing at another menu item.
// When the primary is added to an order, we auto-add the companion tied to it
// via `_companionOf = primary.id`. When the primary's qty changes, the
// companion mirrors it. When the primary is removed, the companion goes too.
function _findCompanionLine(order, primaryId) {
  for (var i = 0; i < order.length; i++) {
    if (order[i]._companionOf === primaryId) return { item: order[i], index: i };
  }
  return null;
}

function _upsertCompanionForPrimary(primary) {
  if (!primary || primary._companionOf) return; // never companion-of-companion
  var order = getOrder();

  // Always mirror qty on any existing companion line tied to this primary.
  // This covers sauce annotations on combos (added imperatively by
  // _addSauceAnnotationForCombo) — they don't have a companionMenuItemId on
  // the menu_items table but they DO point at the combo via _companionOf,
  // so we must keep their qty in sync when the cashier presses + on the
  // combo. Without this, "+ Combo" left the sauce stuck at qty=1 while the
  // combo went to qty=2, which printed wrong on the kitchen ticket.
  var mutated = false;
  for (var i = 0; i < order.length; i++) {
    var row = order[i];
    if (row._companionOf === primary.id && row.qty !== primary.qty) {
      row.qty = primary.qty;
      row._localQtyChanged = true;
      mutated = true;
    }
  }

  // Then handle the declarative case: a menu_item with companionMenuItemId
  // (e.g. Cola → Záloha fľaša) auto-adds its companion if none exists yet.
  var primaryMenu = (typeof MENU_ITEM_BY_ID !== 'undefined') ? MENU_ITEM_BY_ID.get(primary.menuItemId) : null;
  if (!primaryMenu || !primaryMenu.companionMenuItemId) {
    if (mutated) setOrder(order);
    return;
  }
  var companionMenu = MENU_ITEM_BY_ID.get(primaryMenu.companionMenuItemId);
  if (!companionMenu) {
    if (mutated) setOrder(order);
    return;
  }
  var found = _findCompanionLine(order, primary.id);
  if (found) {
    if (found.item.qty !== primary.qty) {
      found.item.qty = primary.qty;
      found.item._localQtyChanged = true;
    }
  } else {
    order.push({
      name: companionMenu.name,
      emoji: companionMenu.emoji,
      price: parseFloat(companionMenu.price) || 0,
      qty: primary.qty,
      note: '',
      menuItemId: companionMenu.id,
      id: _getNextLocalOrderItemId(),
      _companionOf: primary.id,
    });
  }
  setOrder(order);
}

// Remove the companion linked to a just-removed primary. Fire-and-forget DELETE
// if the companion had already been synced to the server.
function _removeCompanionOfPrimary(primaryIdSnapshot) {
  var order = getOrder();
  var found = _findCompanionLine(order, primaryIdSnapshot);
  if (!found) return;
  var companion = found.item;
  order.splice(found.index, 1);
  setOrder(order);
  if (_isServerOrderItem(companion) && currentOrderId) {
    var oid = currentOrderId;
    var ver = currentOrderVersion;
    api.del('/orders/' + oid + '/items/' + companion.id, { version: ver })
      .then(function (r) {
        if (r && r.orderVersion != null && currentOrderId === oid) currentOrderVersion = r.orderVersion;
      })
      .catch(function (e) {
        console.warn('companion delete failed, queued for sync:', e && e.message);
        _pendingRemovals.push(companion.id);
      });
  }
}

// Auto-delete a server order once its local state becomes empty (no items left)
async function _autoDeleteEmptyOrderIfApplicable(orderIdSnapshot) {
  if (!currentOrderId) return;
  if (orderIdSnapshot != null && currentOrderId !== orderIdSnapshot) return;
  if (getOrder().length > 0) return;
  var oid = currentOrderId;
  var ver = currentOrderVersion;
  // Flush kitchen/bar STORNO tickets BEFORE the order is destroyed on the server.
  // flushPendingStornoTickets posts to /orders/:id/send-storno-and-print and then
  // prints the physical tickets; it requires currentOrderId to still be set.
  // Only changeQty queues _pendingStorno (doRemoveItem/doClearOrder already print inline).
  if (_pendingStorno.length && typeof flushPendingStornoTickets === 'function') {
    try { await flushPendingStornoTickets(); }
    catch (e) { console.warn('Storno ticket flush before auto-delete failed:', e && e.message); }
  }
  try {
    await api.del('/orders/' + oid, { version: ver });
  } catch (e) {
    console.warn('Auto-delete empty order failed:', e && e.message);
    // 403 here = order has a payment and the cashier is a cisnik. Without a
    // toast they see an empty order panel + an "occupied" table for the rest
    // of the session and have no idea why. Tell them to fetch a manager.
    if (e && e.status === 403) {
      showToast('Objednávku s platbou môže zrušiť len manažér', 'error');
    }
    return;
  }
  if (currentOrderId !== oid) return; // user switched away mid-flight
  // If a product was tapped during the DELETE round-trip, preserve the new local row
  // as a seed for the next syncOrderToServer instead of wiping it with loadTableOrder.
  // The old server order is gone, so null its id/version but keep _orderDirty so the
  // next flush creates a fresh order.
  if (getOrder().length > 0) {
    currentOrderId = null;
    currentOrderVersion = null;
    _pendingRemovals = [];
    // Any lingering _pendingStorno entries belonged to the just-destroyed order; drop
    // them so they don't accidentally print under the next (fresh) order id.
    _pendingStorno = [];
    _orderDirty = true;
    return;
  }
  currentOrderId = null;
  currentOrderVersion = null;
  _pendingRemovals = [];
  _pendingStorno = [];
  _orderDirty = false;
  if (selectedTableId) {
    try { await loadTableOrder(selectedTableId, true); } catch (e) {}
  }
  renderOrder();
  if (typeof isMobile === 'function' && isMobile() && typeof renderMobOrder === 'function') renderMobOrder();
  if (typeof updateTableStatuses === 'function') updateTableStatuses();
  if (typeof currentView !== 'undefined' && currentView === 'tables' && typeof renderFloor === 'function') renderFloor();
  if (typeof isMobile === 'function' && isMobile() && typeof renderMobTables === 'function') renderMobTables();
}

// Debounced render — batches multiple rapid adds into one full render
var _renderTimer = null;
function _scheduleRender() {
  if (_renderTimer) clearTimeout(_renderTimer);
  _renderTimer = setTimeout(function() {
    _renderTimer = null;
    renderOrder();
    updateQtyBadges();
  }, 120);
}

function _getNextLocalOrderItemId() {
  _nextLocalOrderItemId += 1;
  return _nextLocalOrderItemId;
}

function _getMergeKey(item) {
  // _noMerge rows (e.g. each combo tap with its own sauce annotation) get a
  // per-row key so _normalizeLocalOrder never collapses them together.
  if (item._noMerge) return '_uniq::' + item.id;
  // Include _companionOf so companion lines tied to different primaries don't merge
  // into one row (e.g. záloha for Cola and záloha for Fanta must stay separate).
  return String(item.menuItemId) + '::' + (item.note || '') + '::' + (item._companionOf || '');
}

function _isServerOrderItem(item) {
  return typeof item.id === 'number' && item.id <= 1000000000;
}

function _normalizeLocalOrder(order) {
  var normalized = [];
  var unsentSeen = Object.create(null);

  for (var i = 0; i < order.length; i++) {
    var item = order[i];
    if (item.sent) {
      normalized.push(item);
      continue;
    }

    var key = _getMergeKey(item);
    if (unsentSeen[key] === undefined) {
      unsentSeen[key] = normalized.length;
      normalized.push(item);
      continue;
    }

    var target = normalized[unsentSeen[key]];
    if (_isServerOrderItem(target) && _isServerOrderItem(item)) {
      normalized.push(item);
      continue;
    }

    target.qty += item.qty;
    target._localQtyChanged = true;
    if (!_isServerOrderItem(target) && _isServerOrderItem(item)) {
      target.id = item.id;
      if (item.orderId !== undefined) target.orderId = item.orderId;
    }
  }

  return normalized;
}

function _queueAddToast(emoji, name, qtyAdded) {
  qtyAdded = qtyAdded || 1;
  if (!_addToastCount) {
    _addToastEmoji = emoji;
    _addToastName = name;
    _addToastMixed = false;
  } else if (_addToastEmoji !== emoji || _addToastName !== name) {
    _addToastMixed = true;
  }

  _addToastCount += qtyAdded;
  if (_addToastTimer) clearTimeout(_addToastTimer);
  _addToastTimer = setTimeout(function() {
    var message;
    if (_addToastMixed) message = _addToastCount + ' pol. pridanych';
    else if (_addToastCount > 1) message = _addToastEmoji + ' ' + _addToastName + ' x' + _addToastCount + ' pridane';
    else message = _addToastEmoji + ' ' + _addToastName + ' pridane';

    _addToastTimer = null;
    _addToastCount = 0;
    _addToastEmoji = '';
    _addToastName = '';
    _addToastMixed = false;
    showToast(message);
  }, 180);
}

// Bulk add — used by the long-press qty popup so 5x Pivo is one user gesture.
// Plain loop over addToOrder is correct (merge-into-existing-row + companion
// mirroring keep working); the per-call DOM append is cheap for n <= 10.
function addToOrderN(name, emoji, price, n) {
  var count = parseInt(n, 10) || 1;
  if (count < 1) count = 1;
  for (var i = 0; i < count; i++) addToOrder(name, emoji, price);
}

// Items that include a side-sauce in their price → otvor sauce-picker.
// Combo-* (burger combos) majú omáčku v recepte; Kuracie hranolky tiež —
// takže obe musia ponúknuť výber Tatárka/Kečup/BBQ atď. pre kuchyňa-tiket.
function _needsSaucePicker(name) {
  if (/^combo\s/i.test(name)) return true;
  if (/kuracie\s+hranolky/i.test(name)) return true;
  return false;
}

function addToOrder(name, emoji, price) {
  var menuItemId = MENU_ID_MAP.get(name);
  if (!menuItemId) return;

  // Combos + Kuracie hranolky majú omáčku v cene → najprv sauce-picker,
  // až potom pridáme položku + 0 EUR annotation row "Omáčka (combo)" s
  // vybranou omáčkou v note (kuchyňa to vidí na bone).
  if (_needsSaucePicker(name) && typeof showSauceSelector === 'function') {
    showSauceSelector(name, function (sauces) {
      if (sauces == null) return; // user cancelled
      // Combos must NOT merge into an existing combo row of the same name —
      // each tap can have a different sauce selection, and the kitchen needs
      // one sauce annotation line per concrete combo. Force a brand-new row,
      // and mark it _noMerge so _normalizeLocalOrder doesn't re-collapse it
      // at sync time.
      var combo = _addToOrderCore(name, emoji, price, true);
      if (!combo) return;
      combo._noMerge = true;
      var sauceNote = sauces.length ? sauces.join(' + ') : 'bez omáčky';
      // Combo má vlastný recept (= burger + male hranolky + boková omáčka
      // skonsolidované) → odpis surovín ide cez recept comba pri sale.
      // JS companion-logika (burger / fries / sauce s konkrétnym
      // menu_item_id) je preto vypnutá — inak by sa tie isté suroviny
      // odpísali dvakrát. Sauce annotation ostáva ako "Omáčka (combo)"
      // placeholder s notou kvôli kuchyňa-tiketu (placeholder nemá
      // recept → žiadna deduplikácia).
      _addSauceAnnotationForCombo(combo, sauceNote);
    });
    return;
  }

  _addToOrderCore(name, emoji, price);
}

// For combos: push 0-price annotation row using the generic 'Omáčka
// (combo)' placeholder so the kitchen sees which sauce(s) the waiter
// picked. The placeholder has no recipe — combo's own recipe already
// deducts the side sauce ingredients (per Combo X recipe in DB), so
// using the placeholder avoids double-deduction.
//
// Note: tracking the EXACT sauce the customer picked vs. the combo's
// "default" side sauce is a known approximation. If a customer asks for
// Tatárka instead of Big Mac sauce on a Big Mac combo, the kitchen sees
// it correctly but inventory still draws Big Mac sauce ingredients.
// Acceptable for now; if it matters later, switch combo recipes back to
// "burger + fries only" and re-enable per-sauce companion lines.
function _addSauceAnnotationForCombo(primaryCombo, sauceNote) {
  if (!primaryCombo) return;
  if (typeof MENU_ID_MAP === 'undefined' || typeof MENU_ITEM_BY_ID === 'undefined') return;

  var annotationMenuId = MENU_ID_MAP.get('Omáčka (combo)');
  if (!annotationMenuId) return;
  var annotationMenu = MENU_ITEM_BY_ID.get(annotationMenuId);
  if (!annotationMenu) return;

  var order = getOrder();
  order.push({
    name: annotationMenu.name,
    emoji: annotationMenu.emoji,
    price: 0,
    qty: primaryCombo.qty,
    note: sauceNote || 'bez omáčky',
    menuItemId: annotationMenuId,
    id: _getNextLocalOrderItemId(),
    _companionOf: primaryCombo.id,
  });

  setOrder(order);
  _scheduleRender();
}

function _addToOrderCore(name, emoji, price, forceNewRow) {
  var menuItemId = MENU_ID_MAP.get(name);
  if (!menuItemId) return;

  var order = _normalizeLocalOrder(getOrder());
  var existing = forceNewRow ? null : order.find(function(item) {
    return !item.sent && item.menuItemId === menuItemId && !item.note && !item._companionOf;
  });
  var changedItem;
  if (existing) {
    existing.qty += 1;
    existing._localQtyChanged = true;
    changedItem = existing;
  } else {
    changedItem = {
      name: name,
      emoji: emoji,
      price: price,
      qty: 1,
      note: '',
      menuItemId: menuItemId,
      id: _getNextLocalOrderItemId()
    };
    order.push(changedItem);
  }
  setOrder(order);
  _orderDirty = true;
  // Mirror qty / auto-add a companion item if the menu item has one configured.
  _upsertCompanionForPrimary(changedItem);
  var t = TABLES.find(function(x) { return x.id === selectedTableId; });
  if (t && t.status === 'free') t.status = 'occupied';

  // Fast-path: append single item to DOM immediately (no full rebuild)
  var c = document.getElementById('orderItems');
  var emptyEl = c.querySelector('.order-empty');
  if (emptyEl) emptyEl.remove();
  var esc = escAttr(name.replace(/'/g, "\\'"));
  if (existing) {
    var existingEl = c.querySelector('.order-item-wrap[data-item-id="' + existing.id + '"]');
    if (existingEl) {
      var qtyEl = existingEl.querySelector('.qty-val');
      if (qtyEl) qtyEl.textContent = existing.qty;
      var totalEl = existingEl.querySelector('.order-item-total');
      if (totalEl) totalEl.textContent = fmt(existing.price * existing.qty);
    }
  } else {
    var html = '<div class="order-item-wrap" data-item-id="' + changedItem.id + '" ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this)">' +
      '<div class="order-item-inner"><span class="order-item-emoji">' + escHtml(emoji) + '</span>' +
      '<div class="order-item-info"><div class="order-item-name">' + escHtml(name) + '</div></div>' +
      '<div class="order-item-qty"><button class="qty-btn" onclick="changeQty(\'' + esc + '\', -1, ' + changedItem.id + ')" onpointerdown="startQtyHold(\'' + esc + '\', -1, ' + changedItem.id + ')">&minus;</button><span class="qty-val">1</span><button class="qty-btn" onclick="changeQty(\'' + esc + '\', 1, ' + changedItem.id + ')" onpointerdown="startQtyHold(\'' + esc + '\', 1, ' + changedItem.id + ')">&plus;</button></div>' +
      '<div class="order-item-total">' + fmt(price) + '</div></div>' +
      '<div class="order-item-swipe-left"><button class="swipe-btn swipe-btn-move" onclick="enterMoveMode(' + changedItem.id + ')" aria-label="Presunut polozku">&#8599;</button><button class="swipe-btn swipe-btn-note" onclick="openNoteModal(\'' + esc + '\',' + changedItem.id + ')" aria-label="Poznamka">&#9998;</button><button class="swipe-btn swipe-btn-del" onclick="removeItem(\'' + esc + '\')" aria-label="Odstranit polozku">&#10005;</button></div></div>';
    c.insertAdjacentHTML('afterbegin', html);
  }

  // Skrolneme order panel na vrch po pridani / inkremente — bez tohoto
  // casnik tapnuty na sent polozku v dolnej casti listu nevidi novu
  // unsent polozku ktoru jeho tap vytvoril (lebo unsent items su na
  // vrchu cez sort by id desc). Funguje pre desktop aj mobile panel.
  scrollOrderToTop();

  // Lightweight counter + total update (no full rebuild)
  var countEl = document.getElementById('orderCount');
  var newCount = order.reduce(function(s, o) { return s + o.qty; }, 0);
  countEl.textContent = newCount;
  countEl.classList.toggle('zero', newCount === 0);
  countEl.classList.add('bump'); setTimeout(function() { countEl.classList.remove('bump'); }, 250);
  updateTotals();

  // Update only this item's product card badge
  updateQtyBadges(menuItemId);
  // Flash the product card to confirm addition
  var addedCard=document.querySelector('.product-card[data-name="'+name.replace(/"/g,'\\"')+'"]');
  if(addedCard){addedCard.classList.remove('just-added');void addedCard.offsetWidth;addedCard.classList.add('just-added');setTimeout(function(){addedCard.classList.remove('just-added')},400)}
  var btnSend = document.getElementById('btnSend');
  if (btnSend) btnSend.disabled = false;

  // Schedule a full render to fix sort order and send-button state after rapid adds settle
  _scheduleRender();

  _queueAddToast(emoji, name, 1);
  // Phase 5 — barely-perceptible haptic ack on every successful add.
  // Feature-detect + try/catch because Android embedded WebView can throw.
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10); } catch (_) {}
  return changedItem;
}

// Sync local order state to server — called before send, payment, or table switch
async function syncOrderToServer() {
  if (!selectedTableId) return;
  var order = getOrder();
  // Stale local-only items can survive a page reload via the localStorage
  // persistence in pos-state.js (and survive the polling-merge fix), but
  // _orderDirty was reset to false on load. Without this, syncOrderToServer
  // would early-return and confirmPayment then trips on the missing
  // currentOrderId with "Nie je co platit". Mark dirty so we POST a fresh
  // order for them.
  if (!_orderDirty) {
    var hasLocalUnsent = order.some(function (o) {
      return o && !o.sent && typeof o.id === 'number' && o.id > 1000000000;
    });
    var hasPendingWork = (_pendingRemovals && _pendingRemovals.length) || (_pendingStorno && _pendingStorno.length);
    if (!hasLocalUnsent && !hasPendingWork) return;
    _orderDirty = true;
  }
  if (!order.length && !currentOrderId) { _orderDirty = false; return; }

  try {
    // Delete items that were removed locally via changeQty (qty→0)
    if (_pendingRemovals.length && currentOrderId) {
      for (var ri = 0; ri < _pendingRemovals.length; ri++) {
        try { await api.del('/orders/' + currentOrderId + '/items/' + _pendingRemovals[ri], { version: currentOrderVersion }); } catch(e) {}
      }
      _pendingRemovals = [];
    }

    // All items removed locally — reload from server to sync state
    if (!order.length && currentOrderId) {
      await loadTableOrder(selectedTableId, true);
      _orderDirty = false;
      return;
    }

    // Keep sent items separate, but collapse identical unsent rows before sync.
    order = _normalizeLocalOrder(order);
    setOrder(order);

    // Separate unsent (local-only) items from server-synced items
    var unsentItems = order.filter(function(o) { return !o.sent && typeof o.id === 'number' && o.id > 1000000000; });
    var existingChanged = order.filter(function(o) { return o.sent || (typeof o.id === 'number' && o.id <= 1000000000); });

    // Capture exactly which local IDs we are about to POST. After the round-trip
    // we filter those out of tableOrders so the loadTableOrder merge below does
    // not re-add them as duplicates alongside their freshly-created server rows.
    // Items added BETWEEN the POST and the filter (race window of a few ms) keep
    // their IDs and so survive the filter — no data loss.
    var syncedLocalIds = new Set(unsentItems.map(function (o) { return o.id; }));

    if (!currentOrderId) {
      // No order on server yet — create with all items (already merged)
      var items = order.map(function(o) { return { menuItemId: o.menuItemId, qty: o.qty, note: o.note || '' }; });
      // For a brand-new order EVERY local-only row is being sent.
      order.forEach(function (o) {
        if (typeof o.id === 'number' && o.id > 1000000000 && !o.sent) syncedLocalIds.add(o.id);
      });
      var newOrder = await api.post('/orders', { tableId: selectedTableId, items: items });
      currentOrderId = newOrder.id;
      currentOrderVersion = newOrder.version || 1;
    } else {
      // Order exists — add unsent items, update changed quantities
      if (unsentItems.length) {
        var items = unsentItems.map(function(o) { return { menuItemId: o.menuItemId, qty: o.qty, note: o.note || '' }; });
        await api.post('/orders/' + currentOrderId + '/items', { items: items, version: currentOrderVersion });
      }
      // Update qty for existing items that may have changed (including merged)
      for (var i = 0; i < existingChanged.length; i++) {
        var o = existingChanged[i];
        if (o._localQtyChanged) {
          var putRes = await api.put('/orders/' + currentOrderId + '/items/' + o.id, { qty: o.qty, version: currentOrderVersion });
          if (putRes && putRes.orderVersion != null) currentOrderVersion = putRes.orderVersion;
          o._localQtyChanged = false;
        }
      }
    }

    // Drop the local-only rows we just successfully synced so loadTableOrder's
    // merge sees only items added DURING the round-trip (which still need to
    // survive the refresh). Without this, the merge re-adds the just-POSTed
    // rows alongside the server's freshly-created copies → visible duplicates.
    if (syncedLocalIds.size && tableOrders[selectedTableId]) {
      tableOrders[selectedTableId] = tableOrders[selectedTableId].filter(function (o) {
        return !syncedLocalIds.has(o.id);
      });
    }

    // Reload from server to get real IDs
    await loadTableOrder(selectedTableId, true);
    renderOrder();
    updateQtyBadges();
    _orderDirty = false;
  } catch (e) {
    console.error('syncOrderToServer error:', e);
    showToast('Chyba sync: ' + e.message);
    throw e;
  }
}

function _findOrderItemForQtyChange(order, name, itemId) {
  if (itemId != null) {
    var byId = order.find(function(o) { return o.id === itemId; });
    if (byId) return byId;
  }
  return order.find(function(o) { return o.name === name; });
}

function _increaseSentItemAsUnsentDelta(order, item, delta) {
  var unsentTwin = order.find(function(candidate) {
    return !candidate.sent &&
      candidate.menuItemId === item.menuItemId &&
      (candidate.note || '') === (item.note || '');
  });

  if (unsentTwin) {
    unsentTwin.qty += delta;
    unsentTwin._localQtyChanged = true;
    // Casnik klikol + na sent polozke a uz existuje unsent twin →
    // skrolneme order panel hore aby twin (s novym qty) bol viditelny.
    // Bez toho twin zostane mimo viewportu na tablete a casnik si mysli
    // ze ho stratil.
    if (typeof scrollOrderToTop === 'function') scrollOrderToTop();
    return unsentTwin;
  }

  var newItem = {
    name: item.name,
    emoji: item.emoji,
    price: item.price,
    qty: delta,
    note: item.note || '',
    menuItemId: item.menuItemId,
    id: _getNextLocalOrderItemId(),
    sent: false,
  };
  order.push(newItem);
  // Novy unsent delta riadok ide hore (sort by id desc) — skrolneme,
  // aby ho casnik hned videl.
  if (typeof scrollOrderToTop === 'function') scrollOrderToTop();
  return newItem;
}

// Scroll order panel na vrch — pouzite po pridani polozky (manualne cez
// menu, cez + na unsent, alebo cez + na sent ktore vytvori unsent delta).
// Bez toho panel ostane na povodnom scrolle a casnik nevidi novu polozku
// v hornej casti — musel by manualne skrolovat.
//
// Hosts:
//   #orderItems     — desktop / tablet (> 768px)
//   #mobOrderItems  — phone (≤ 768px)
//
// Implementacia: instant snap (scrollTop=0) DVAKRAT — raz okamzite,
// druhy raz po 140ms. Dovod: changeQty volá _scheduleRender s 120ms
// debounce ktory potom rebuilduje innerHTML cez renderOrder(). Smooth
// scroll animacia by sa nestihla dokoncit pred rebuildom a poloha by
// sa restorovala. Instant snap je `сразу` (okamzite) tak ako pyta
// pouzivatel, a re-snap po debounce je idempotentny safety-net.
function scrollOrderToTop() {
  function snap() {
    ['orderItems', 'mobOrderItems'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.scrollTop = 0;
    });
  }
  // Okamzity snap — vacsina pripadov to vyriesi.
  snap();
  // Re-snap po 140ms — po 120ms debounced renderOrder() rebuilde, ktory
  // by inak mohol obnovit povodny scroll po tom co sme my snapli na 0.
  setTimeout(snap, 140);
}

// Show the storno reason popup and POST the write-off when the cashier
// confirms. Extracted so changeQty can either invoke it inline (qty
// decrement, no DELETE) or defer it into the .then of the row-DELETE
// (so we don't record a write-off for an item the server still has).
function _promptStornoReasonAndWriteOff(s) {
  if (!s || !s.miId) return;
  showStornoReason(s.sName, s.sQty, function(result) {
    if (!result) return;
    // Cashier's input goes to the basket — admin will resolve it from the
    // Storno page, which is when the actual stock revert / write-off runs.
    api.post('/storno-basket', {
      menuItemId: s.miId,
      qty: s.sQty,
      name: s.sName,
      unitPrice: typeof s.unitPrice === 'number' ? s.unitPrice : 0,
      reason: result.reason,
      note: result.note || '',
      wasPrepared: !result.returnToStock,
      orderId: s.oid || null,
    }).then(function () {
      showToast('✔ Storno zapísané', true);
    }).catch(function (e) {
      console.error('storno-basket POST error:', e);
      showToast('Storno zapis zlyhal: ' + (e && e.message), 'error');
    });
  });
}

// Coalesce rapid storno clicks on the same item into one popup that shows the
// CUMULATIVE qty (sum of all unprompted clicks) instead of per-click 1.
// Prevents the "modalka shows wrong sum" bug when a cashier hammers `−` to
// remove qty=3 — they used to see "1x Cola" three times in quick succession
// instead of one "3x Cola" prompt + one matching write-off.
//
// Tracked separately from _pendingStorno (which feeds the kitchen STORNO ticket
// at next sendToKitchen) so flushing the popup doesn't drain the print queue.
var _stornoUnpromptedQty = Object.create(null); // {itemName: qty awaiting popup}
var _stornoReasonPromptTimer = null;
var _stornoReasonPendingPrompt = null; // {sName, miId, oid}

function _accumulateStornoForPrompt(args) {
  if (!args || !args.sName || !(args.sQty > 0)) return;
  _stornoUnpromptedQty[args.sName] = (_stornoUnpromptedQty[args.sName] || 0) + args.sQty;
  // Switching to a different item — fire the previous one synchronously so its
  // reason/write-off isn't lost.
  if (_stornoReasonPendingPrompt && _stornoReasonPendingPrompt.sName !== args.sName) {
    _firePendingStornoReasonPrompt();
  }
  _stornoReasonPendingPrompt = { sName: args.sName, miId: args.miId, oid: args.oid };
  if (_stornoReasonPromptTimer) clearTimeout(_stornoReasonPromptTimer);
  _stornoReasonPromptTimer = setTimeout(_firePendingStornoReasonPrompt, 600);
}

function _firePendingStornoReasonPrompt() {
  if (_stornoReasonPromptTimer) {
    clearTimeout(_stornoReasonPromptTimer);
    _stornoReasonPromptTimer = null;
  }
  var pending = _stornoReasonPendingPrompt;
  _stornoReasonPendingPrompt = null;
  if (!pending) return;
  var sQty = _stornoUnpromptedQty[pending.sName] || 0;
  if (sQty <= 0) return;
  _stornoUnpromptedQty[pending.sName] = 0;
  _promptStornoReasonAndWriteOff({ sName: pending.sName, miId: pending.miId, oid: pending.oid, sQty: sQty });
}

function changeQty(name,d,itemId){
  const order = getOrder();
  const item = _findOrderItemForQtyChange(order, name, itemId);
  if (!item) return;

  // Phase 5 — haptic ack on confirmed qty change. Past the guard above,
  // every remaining branch mutates state (increment, decrement, storno).
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10); } catch (_) {}

  // Combos + Kuracie hranolky: kazdy + (sent ALEBO unsent) otvori sauce-picker
  // pre tu novu porciu. Predtym to bolo len pri sent — unsent silently
  // inkrementoval qty a annotation row sa mirror-oval, takze vsetky porcie
  // zdielali rovnaku omacku ("1× s BBQ + 1× s Tatarkou" nebolo mozne).
  // Teraz konzistentne: + = picker. Repeat CTA v pickeri = 1 tap pre
  // "to iste znova" pripad, takze friction je minimalna.
  if (d > 0 && typeof _needsSaucePicker === 'function' && _needsSaucePicker(item.name) && typeof addToOrder === 'function') {
    addToOrder(item.name, item.emoji, item.price);
    return;
  }

  if (d > 0 && item.sent) {
    _increaseSentItemAsUnsentDelta(order, item, d);
    setOrder(order);
    _orderDirty = true;
    updateTotals();
    updateQtyBadges(item.menuItemId);
    _scheduleRender();
    return;
  }

  // Track storno for sent items being reduced. The reason popup + write-off
  // POST are deferred for the row-delete case below until DELETE actually
  // confirms — otherwise a 409 leaves a write-off recorded for an item the
  // server never removed.
  var sentQty = item._sentQty || 0;
  var stornoArgs = null;
  if (d < 0 && sentQty > 0) {
    var stornoQty = Math.min(-d, Math.min(item.qty, sentQty));
    if (stornoQty > 0) {
      var existing = _pendingStorno.find(function(s) { return s.name === name; });
      if (existing) { existing.qty += stornoQty; }
      else { _pendingStorno.push({ qty: stornoQty, name: item.name, note: item.note || '', menuItemId: item.menuItemId }); }
      stornoArgs = {
        miId: item.menuItemId,
        sQty: stornoQty,
        sName: item.name,
        unitPrice: typeof item.price === 'number' ? item.price : 0,
        oid: currentOrderId,
      };
    }
  }

  const newQty = item.qty + d;
  var primaryIdSnapshot = item.id;
  if (newQty <= 0) {
    const idx = order.indexOf(item);
    if (idx !== -1) order.splice(idx, 1);
    setOrder(order);
    // Primary is gone — drop its companion (e.g. Záloha fľaša) too.
    _removeCompanionOfPrimary(primaryIdSnapshot);
    // Flush server-side deletion immediately so the 30s poll / socket refresh
    // does not rehydrate the item back from the server. Fall back to the
    // pending-removal queue if this call fails (e.g. version conflict).
    if (_isServerOrderItem(item) && currentOrderId) {
      var _removeOrderId = currentOrderId;
      var _removeItemId = item.id;
      var _removeVersion = currentOrderVersion;
      api.del('/orders/' + _removeOrderId + '/items/' + _removeItemId, { version: _removeVersion })
        .then(function(r) {
          if (r && r.orderVersion != null && currentOrderId === _removeOrderId) {
            currentOrderVersion = r.orderVersion;
          }
          // DELETE confirmed — now safe to ask the cashier for the storno reason
          // and record the write-off. Doing this BEFORE confirmation risks
          // recording a write-off for an item the server still has.
          if (stornoArgs) _accumulateStornoForPrompt(stornoArgs);
          // If this removal emptied the order, drop the whole account.
          return _autoDeleteEmptyOrderIfApplicable(_removeOrderId);
        })
        .catch(function(e) {
          console.warn('changeQty immediate delete failed, queued for sync:', e && e.message);
          _pendingRemovals.push(_removeItemId);
          // Item is still on the server — drop the queued kitchen storno entry
          // so we don't print a phantom STORNO ticket on the next send.
          if (stornoArgs) {
            var idxQ = _pendingStorno.findIndex(function(s) {
              return s.menuItemId === stornoArgs.miId && s.name === stornoArgs.sName;
            });
            if (idxQ !== -1) {
              if (_pendingStorno[idxQ].qty <= stornoArgs.sQty) _pendingStorno.splice(idxQ, 1);
              else _pendingStorno[idxQ].qty -= stornoArgs.sQty;
            }
          }
        });
    } else if (currentOrderId && !getOrder().length) {
      // Local-only removal that emptied an existing server order — delete it too.
      _autoDeleteEmptyOrderIfApplicable();
    }
  } else {
    item.qty = newQty;
    item._localQtyChanged = true;
    // Mirror the new qty on any linked companion line so receipt totals stay consistent.
    _upsertCompanionForPrimary(item);
    // Qty-decrement-not-to-zero on a sent item: no DELETE happens, just a
    // PUT in the next sync. Show the reason popup immediately as before.
    if (stornoArgs) _promptStornoReasonAndWriteOff(stornoArgs);
  }
  _orderDirty = true;
  // Fast-path: update the qty display and total inline
  var wrap = document.querySelector('.order-item-wrap .order-item-name');
  var wraps = document.querySelectorAll('.order-item-wrap');
  for (var wi = 0; wi < wraps.length; wi++) {
    var nameEl = wraps[wi].querySelector('.order-item-name');
    if (nameEl && nameEl.textContent === name) {
      if (newQty <= 0) {
        wraps[wi].remove();
      } else {
        var qtyVal = wraps[wi].querySelector('.qty-val');
        if (qtyVal) qtyVal.textContent = newQty;
        var totalEl = wraps[wi].querySelector('.order-item-total');
        if (totalEl) totalEl.textContent = fmt(item.price * newQty);
      }
      break;
    }
  }
  updateTotals();
  updateQtyBadges(item.menuItemId);
  _scheduleRender();
}
async function removeItem(name){
  const order = getOrder();
  const item = order.find(o => o.name === name);
  if (!item) return;

  // If sent and user is cisnik (not manazer/admin), require manager PIN
  var user = api.getUser();
  if (item.sent && user && user.role === 'cisnik') {
    var _stQty = item._sentQty || item.qty || 1;
    var _stPrice = typeof item.price === 'number' ? item.price : 0;
    var _ctx = 'Storno: ' + _stQty + '× ' + name + ' (' + (_stPrice * _stQty).toFixed(2) + ' €)';
    showManagerPin(_ctx, function() { doRemoveItem(name); });
    return;
  }

  doRemoveItem(name);
}
async function doRemoveItem(name){
  const order = getOrder();
  const item = order.find(o => o.name === name);
  if (!item) return;

  var sentQty = item._sentQty || 0;
  const itemId = item.id;
  const removedQty = item.qty;
  const removedName = item.name;
  const removedNote = item.note || '';
  const idx = order.indexOf(item);
  if (idx !== -1) order.splice(idx, 1);
  setOrder(order);
  _orderDirty = true;
  // Drop any companion tied to this primary (e.g. Záloha fľaša) in the same gesture.
  _removeCompanionOfPrimary(itemId);
  renderOrder();
  updateQtyBadges();
  if (isMobile()) renderMobOrder();

  // Only call API for sent items (storno needs server + print)
  if (sentQty > 0 && currentOrderId) {
    try {
      var _delOrderId = currentOrderId;
      var _delRes = await api.del('/orders/' + _delOrderId + '/items/' + itemId, { version: currentOrderVersion });
      // Keep currentOrderVersion in sync with the server's bumped version, otherwise
      // the follow-up _autoDeleteEmptyOrderIfApplicable() would hit 409 and leave the
      // order (and table) stuck in the "occupied" state.
      if (_delRes && _delRes.orderVersion != null && currentOrderId === _delOrderId) {
        currentOrderVersion = _delRes.orderVersion;
      }
      var table = TABLES.find(function(t) { return t.id === selectedTableId; });
      var tableName = table ? table.name : String(selectedTableId);
      var user = api.getUser();
      var staffName = user ? user.name : '';
      var dest = getItemDest(removedName) === 'kuchyna' ? 'KUCHYNA' : 'BAR';
      await api.post('/print/kitchen', {
        dest: 'STORNO ' + dest,
        tableName: tableName,
        staffName: staffName,
        items: [{ qty: -sentQty, name: removedName, note: removedNote }],
        orderNum: currentOrderId
      });
      showToast('Storno vytlacene: ' + removedName);

      // Cashier picks reason → row goes to /storno-basket. Stock change
      // happens later in admin Storno page (resolve), not here.
      _promptStornoReasonAndWriteOff({
        miId: item.menuItemId,
        sQty: sentQty,
        sName: removedName,
        unitPrice: typeof item.price === 'number' ? item.price : 0,
        oid: currentOrderId,
      });
    } catch(e) {
      console.error('removeItem storno error:', e);
      showToast('Chyba storno: ' + e.message);
    }
  }
  // If that removal emptied the account, delete the whole order so the table frees up
  if (!getOrder().length) {
    await _autoDeleteEmptyOrderIfApplicable();
  }
}
async function clearOrder(){
  try {
    if(!getOrder().length)return;

    // Check if any items were sent and user is cisnik — require manager PIN
    var hasSentItems = getOrder().some(function(item) {
      return item.sent;
    });
    var user = api.getUser();
    if (hasSentItems && user && user.role === 'cisnik') {
      var _orderTotal = getOrder().reduce(function(sum, it) {
        var p = typeof it.price === 'number' ? it.price : 0;
        var q = typeof it.qty === 'number' ? it.qty : 0;
        return sum + p * q;
      }, 0);
      var _ctx = 'Storno celej objednávky (' + _orderTotal.toFixed(2) + ' €)';
      showManagerPin(_ctx, function() { doClearOrder(); });
      return;
    }
    await doClearOrder();
  } catch(e) {
    console.error('clearOrder error:', e);
    showToast('Chyba: ' + e.message);
  }
}
async function doClearOrder(){
  try {
    if(!getOrder().length)return;
    _pendingStorno = []; // clearOrder handles its own storno prints
    _pendingRemovals = [];

    // Print storno for all sent items
    var stornoItems = [];
    getOrder().forEach(function(item) {
      var sentQty = item._sentQty || 0;
      if (sentQty > 0) {
        stornoItems.push({ qty: -sentQty, name: item.name, note: '' });
      }
    });
    if (stornoItems.length) {
      var table = TABLES.find(function(t) { return t.id === selectedTableId; });
      var tableName = table ? table.name : String(selectedTableId);
      var user = api.getUser();
      var staffName = user ? user.name : '';
      // Split storno by dest
      var foodStorno = stornoItems.filter(function(i) { return getItemDest(i.name) === 'kuchyna'; });
      var drinkStorno = stornoItems.filter(function(i) { return getItemDest(i.name) !== 'kuchyna'; });
      var prints = [];
      if (foodStorno.length) prints.push(api.post('/print/kitchen', { dest:'STORNO KUCHYNA', tableName:tableName, staffName:staffName, items:foodStorno, orderNum:currentOrderId }));
      if (drinkStorno.length) prints.push(api.post('/print/kitchen', { dest:'STORNO BAR', tableName:tableName, staffName:staffName, items:drinkStorno, orderNum:currentOrderId }));
      try {
        await Promise.all(prints);
      } catch (printErr) {
        console.error('Storno print failed (order still cancelled):', printErr);
        if (typeof showToast === 'function') {
          showToast('Storno sa nepodarilo vytlacit — objednavka sa aj tak zrusi.', true);
        }
      }
    }

    if (currentOrderId) {
      await api.del('/orders/' + currentOrderId, { version: currentOrderVersion });
      currentOrderId = null;
      currentOrderVersion = null;
    }
    await loadTableOrder(selectedTableId, true);
    renderOrder();
    if (isMobile()) renderMobOrder();
    updateTableStatuses();
    if(currentView==='tables')renderFloor();
    if(isMobile())renderMobTables();
    showToast('Objednavka zrusena');
  } catch(e) {
    console.error('clearOrder error:', e);
    showToast('Chyba: ' + e.message);
  }
}

function _activateLoadedOrder(orderId) {
  var order = tableOrdersList.find(function(o) { return o.id === orderId; });
  if (!order) return false;
  currentOrderId = orderId;
  currentOrderVersion = order.version || null;
  tableOrders[selectedTableId] = order.items.map(function(i) {
    return {
      id: i.id, name: i.name, emoji: i.emoji, price: i.price,
      qty: i.qty, note: i.note, menuItemId: i.menuItemId,
      orderId: order.id, desc: i.desc || '', sent: !!i.sent,
      _sentQty: i.sent ? i.qty : 0
    };
  });
  return true;
}

async function switchAccount(orderId){
  if(!_activateLoadedOrder(orderId)) return;
  renderOrder();if(isMobile())renderMobOrder();
}
async function newAccount(){
  if(!selectedTableId)return;
  try {
    const label='Ucet '+(tableOrdersList.length+1);
    const newOrder=await api.post('/orders',{tableId:selectedTableId,items:[],label:label});
    currentOrderId=newOrder.id;
    currentOrderVersion=newOrder.version||1;
    await loadTableOrder(selectedTableId, true);
    renderOrder();if(isMobile())renderMobOrder();
    showToast('Novy ucet vytvoreny');
  } catch(e) {
    showToast(e.message || 'Chyba pri vytvarani uctu', 'error');
  }
}

function openNoteModal(name, itemId){
  var order = getOrder();
  var item = itemId != null ? order.find(function(o) { return o.id === itemId; }) : order.find(function(o) { return o.name === name; });
  if (!item) return;
  noteItemName = item.name;
  noteItemId = item.id;
  document.getElementById('noteInput').value = item.note || '';
  var hint = document.getElementById('noteModalSentHint');
  if (hint) hint.classList.toggle('pos-hidden', !item.sent);
  _refreshNotePresetActiveState();
  _buildNoteKeyboard();
  document.getElementById('noteModal').classList.add('show');
}

// === Vlastna klavesnica pre note input ===
// 3 vrstvy: 'abc' (zakladne pismena), 'dia' (slovenske diakritiky), '123'
// (cisla + symboly). Toggle cez klavesy 'áž' a '123'. Vsetky tapy 48px
// min — wet-finger safe. Pisanie ide cez input.value mutaciu + refresh
// preset active state.
var _noteKbLayer = 'abc';

function _buildNoteKeyboard(){
  _noteKbLayer = 'abc';
  _renderNoteKeyboard();
}

function _renderNoteKeyboard(){
  var host = document.getElementById('noteKeyboard');
  if (!host) return;
  var rows;
  if (_noteKbLayer === 'abc'){
    rows = [
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l'],
      ['z','x','c','v','b','n','m'],
    ];
  } else if (_noteKbLayer === 'dia'){
    rows = [
      ['á','č','ď','é','í','ľ','ĺ','ň'],
      ['ó','ô','ŕ','š','ť','ú','ý','ž'],
    ];
  } else { // '123'
    rows = [
      ['1','2','3','4','5','6','7','8','9','0'],
      ['.',',','-','_','!','?','(',')','%','/'],
    ];
  }
  var html = '';
  for (var r = 0; r < rows.length; r++){
    html += '<div class="note-kb-row">';
    for (var c = 0; c < rows[r].length; c++){
      var k = rows[r][c];
      html += '<button type="button" class="note-kb-key" data-kb-key="' + k + '">' + k + '</button>';
    }
    html += '</div>';
  }
  // Action row — toggle layers + space + backspace + comma + return
  html += '<div class="note-kb-row note-kb-actions">';
  html += '<button type="button" class="note-kb-key is-mod" data-kb-action="toggle-dia">'
    + (_noteKbLayer === 'dia' ? 'abc' : 'áž') + '</button>';
  html += '<button type="button" class="note-kb-key is-mod" data-kb-action="toggle-123">'
    + (_noteKbLayer === '123' ? 'abc' : '123') + '</button>';
  html += '<button type="button" class="note-kb-key is-space" data-kb-key=" ">medzera</button>';
  html += '<button type="button" class="note-kb-key is-mod" data-kb-action="backspace">⌫</button>';
  html += '</div>';
  host.innerHTML = html;
}

document.addEventListener('click', function(e){
  var keyBtn = e.target && e.target.closest && e.target.closest('.note-kb-key');
  if (!keyBtn) return;
  var input = document.getElementById('noteInput');
  if (!input) return;
  var action = keyBtn.dataset.kbAction;
  if (action === 'backspace'){
    input.value = (input.value || '').slice(0, -1);
    _refreshNotePresetActiveState();
    return;
  }
  if (action === 'toggle-dia'){
    _noteKbLayer = _noteKbLayer === 'dia' ? 'abc' : 'dia';
    _renderNoteKeyboard();
    return;
  }
  if (action === 'toggle-123'){
    _noteKbLayer = _noteKbLayer === '123' ? 'abc' : '123';
    _renderNoteKeyboard();
    return;
  }
  var key = keyBtn.dataset.kbKey;
  if (key == null) return;
  if ((input.value || '').length >= 200) return; // maxlength guard
  input.value = (input.value || '') + key;
  _refreshNotePresetActiveState();
});

// Preset note chips — quick-insert common phrases (bez cibule, extra ostre...)
// so cashier doesn't have to type on tablet. Toggling: tap an inactive chip
// appends it (comma-separated); tap an active one removes the phrase.
function appendNotePreset(text) {
  var input = document.getElementById('noteInput');
  if (!input) return;
  var parts = (input.value || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  var idx = parts.indexOf(text);
  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(text);
  input.value = parts.join(', ');
  _refreshNotePresetActiveState();
}

function _refreshNotePresetActiveState() {
  var input = document.getElementById('noteInput');
  if (!input) return;
  var current = (input.value || '').toLowerCase();
  var chips = document.querySelectorAll('#notePresets .note-preset-chip');
  for (var i = 0; i < chips.length; i++) {
    var label = (chips[i].textContent || '').trim().toLowerCase();
    chips[i].classList.toggle('is-active', label && current.indexOf(label) >= 0);
  }
}
function closeNoteModal(){
  document.getElementById('noteModal').classList.remove('show');
  noteItemName = null;
  noteItemId = null;
  var hint = document.getElementById('noteModalSentHint');
  if (hint) hint.classList.add('pos-hidden');
}
async function saveNote(){
  if (_savingNote) return;
  try {
    _savingNote = true;
    var note = document.getElementById('noteInput').value.trim();
    var item = noteItemId != null
      ? getOrder().find(function(o) { return o.id === noteItemId; })
      : (noteItemName ? getOrder().find(function(o) { return o.name === noteItemName; }) : null);
    if (!item) { closeNoteModal(); return; }

    if (_isServerOrderItem(item) && currentOrderId) {
      var itemId = item.id;
      var putNoteOnce = async function() {
        var res = await api.put('/orders/' + currentOrderId + '/items/' + itemId, { note: note, version: currentOrderVersion });
        if (res && res.orderVersion != null) currentOrderVersion = res.orderVersion;
        await loadTableOrder(selectedTableId, true);
      };
      try {
        await putNoteOnce();
      } catch (e) {
        if (e.message && e.message.indexOf('inym pouzivatelom') >= 0) {
          await loadTableOrder(selectedTableId, true);
          var after = getOrder().find(function(o) { return o.id === itemId; });
          if (after && _isServerOrderItem(after) && currentOrderId) await putNoteOnce();
          else throw e;
        } else throw e;
      }
    } else {
      item.note = note;
      setOrder(getOrder());
      _orderDirty = true;
    }
    renderOrder();
    if (isMobile()) renderMobOrder();
    closeNoteModal();
    showToast('Poznamka ulozena', true);
  } catch(e) {
    console.error('saveNote error:', e);
    showToast('Chyba: ' + e.message);
  } finally {
    _savingNote = false;
  }
}

// Split mode: 'equal' = N-way rovnomerne, 'items' = priatel plati len
// svoje 2 polozky. Server podporuje oba (itemGroups parameter).
var _splitMode = 'equal';

async function splitBill(){
  if(!getOrder().length){showToast('Prazdna objednavka');return}
  try{
    if(!currentOrderId||_orderDirty) await syncOrderToServer();
    if(!currentOrderId){showToast('Objednavku sa nepodarilo pripravit');return}
    const total=getOrderTotal();
    document.getElementById('splitCount').value=2;
    document.getElementById('splitPreview').textContent='Kazdy plati: '+fmt(total/2);
    _splitMode = 'equal';
    _renderSplitTabs();
    _renderSplitItemsList();
    document.getElementById('splitModal').classList.add('show');
  }catch(e){
    console.error('splitBill error:', e);
    showToast('Chyba: ' + e.message);
  }
}

document.getElementById('splitCount')?.addEventListener('input',function(){
  const n=parseInt(this.value)||2;
  const total=getOrderTotal();
  document.getElementById('splitPreview').textContent='Kazdy plati: '+fmt(total/n);
});

// === Split modal tabby + per-item picker ===
// Tab switch: equal vs items mode. Polozky picker: tap-toggle riadky,
// running subtotal "vybrate na novy ucet". Confirm posiela itemGroups.
function _renderSplitTabs(){
  var tabs = document.querySelectorAll('.split-tab-btn');
  if (!tabs.length) return;
  tabs.forEach(function(t){
    var on = t.dataset.splitMode === _splitMode;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.getElementById('splitModeEqual').hidden = (_splitMode !== 'equal');
  document.getElementById('splitModeItems').hidden = (_splitMode !== 'items');
}

document.addEventListener('click', function(e){
  var btn = e.target && e.target.closest && e.target.closest('.split-tab-btn');
  if (!btn) return;
  _splitMode = btn.dataset.splitMode;
  _renderSplitTabs();
});

// Selektovane polozky pre item-split mode. Map itemId -> qty (number).
// Ak je itemId v mape, polozka je vybrata. qty je kolko z nej ide na
// novy ucet (1..original_qty). Ak je qty rovny original_qty, ide cela
// polozka; inak server cez /move-items rozdeli zdrojovy riadok.
var _splitSelectedItems = new Map();

function _renderSplitItemsList(){
  var host = document.getElementById('splitItemsList');
  if (!host) return;
  _splitSelectedItems.clear();
  var order = getOrder() || [];
  // Filter: companion rows (Záloha fľaša atd.) sa nezobrazuju samostatne —
  // pojdu s primary. Aj sauce annotation rows skryjeme.
  var pickable = order.filter(function(it){
    if (it._companionOf) return false;
    if (it.name === 'Omáčka (combo)') return false;
    return it.qty > 0;
  });
  if (!pickable.length){
    host.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-sec);font-size:13px">Ziadne polozky</div>';
    return;
  }
  host.innerHTML = pickable.map(function(it){
    return _splitItemRowHtml(it);
  }).join('');
  _updateSplitItemsTotal();
}

// Render jeden split-item-row. Vyziadane separatne aby update po qty
// pickeri prerendroval len konkrety riadok.
function _splitItemRowHtml(it){
  var selectedQty = _splitSelectedItems.get(it.id) || 0;
  var isSelected = selectedQty > 0;
  var lineTotal = (Number(it.price) || 0) * selectedQty;
  var fullLineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
  // Vizual: ked vybrate, ramcek + check, suma vpravo je za selectedQty.
  // Ked nevybrate, suma vpravo = celkova suma riadku.
  var bg = isSelected ? 'rgba(139,124,246,.12)' : 'var(--color-bg-surface)';
  var border = isSelected ? 'var(--color-accent,#8b7cf6)' : 'var(--color-border)';
  var checkBg = isSelected ? 'var(--color-accent,#8b7cf6)' : 'transparent';
  var checkContent = isSelected ? '✓' : '';
  // Ked qty>1 a vybrate ciastocne, pridame badge "selectedQty/total".
  var qtyBadge = '';
  if (it.qty > 1) {
    if (isSelected && selectedQty < it.qty){
      qtyBadge = '<span style="font-size:12px;font-weight:700;color:var(--color-accent);background:rgba(139,124,246,.18);padding:2px 8px;border-radius:10px">' + selectedQty + '/' + it.qty + '</span>';
    } else {
      qtyBadge = '<span style="font-size:12px;color:var(--color-text-sec)">' + it.qty + '×</span>';
    }
  }
  var amountShown = isSelected ? fmt(lineTotal) : fmt(fullLineTotal);
  return '<button type="button" class="split-item-row" data-split-item-id="' + it.id + '" '
    + 'style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;cursor:pointer;text-align:left;transition:background .15s,border-color .15s">'
    + '<span class="split-item-check" style="width:24px;height:24px;border-radius:4px;border:2px solid ' + border + ';background:' + checkBg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;color:#fff;font-size:14px">' + checkContent + '</span>'
    + '<span style="flex:1;font-size:14px">' + escAttr(it.emoji + ' ' + it.name) + '</span>'
    + qtyBadge
    + '<span style="font-size:14px;font-weight:600;color:var(--color-text);min-width:70px;text-align:right">' + amountShown + '</span>'
    + '</button>';
}

function _updateSplitItemRow(itemId){
  var order = getOrder() || [];
  var it = order.find(function(x){ return x.id === itemId; });
  if (!it) return;
  var oldRow = document.querySelector('.split-item-row[data-split-item-id="' + itemId + '"]');
  if (!oldRow) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = _splitItemRowHtml(it);
  var newRow = tmp.firstChild;
  oldRow.parentNode.replaceChild(newRow, oldRow);
}

function _updateSplitItemsTotal(){
  var total = 0;
  var order = getOrder() || [];
  _splitSelectedItems.forEach(function(qty, id){
    var it = order.find(function(x){ return x.id === id; });
    if (it) total += (Number(it.price) || 0) * qty;
  });
  var el = document.getElementById('splitItemsTotal');
  if (el) el.textContent = fmt(total);
}

document.addEventListener('click', function(e){
  var row = e.target && e.target.closest && e.target.closest('.split-item-row');
  if (!row) return;
  var id = Number(row.dataset.splitItemId);
  if (!id) return;
  var order = getOrder() || [];
  var it = order.find(function(x){ return x.id === id; });
  if (!it) return;
  // Ak uz vybrata, klik = odznacit
  if (_splitSelectedItems.has(id)){
    _splitSelectedItems.delete(id);
    _updateSplitItemRow(id);
    _updateSplitItemsTotal();
    return;
  }
  // Ak qty == 1, rovno selektni cele
  if ((Number(it.qty) || 0) <= 1){
    _splitSelectedItems.set(id, 1);
    _updateSplitItemRow(id);
    _updateSplitItemsTotal();
    return;
  }
  // qty > 1 → opyt sa kolko cez existujuci _showMoveQtyPicker (reuse).
  // Picker vrati number (1..maxQty) alebo null pri zruseni.
  _showMoveQtyPicker(it, function(chosenQty){
    if (chosenQty == null || chosenQty < 1) return;
    _splitSelectedItems.set(id, chosenQty);
    _updateSplitItemRow(id);
    _updateSplitItemsTotal();
  });
});

async function confirmSplit(){
  try{
    if (_splitMode === 'items'){
      if (!_splitSelectedItems.size){
        showToast('Vyber aspon jednu polozku', 'warning');
        return;
      }
      // Sanity: ked uzivatel vybral celu objednavku (vsetky polozky + ich
      // cele qty), nedava zmysel pretoze by sa neostalo nic na povodnom.
      var order = getOrder() || [];
      var pickable = order.filter(function(it){
        if (it._companionOf) return false;
        if (it.name === 'Omáčka (combo)') return false;
        return it.qty > 0;
      });
      var movingEverything = pickable.length === _splitSelectedItems.size
        && pickable.every(function(it){ return _splitSelectedItems.get(it.id) === it.qty; });
      if (movingEverything){
        showToast('Aspon jedna polozka (alebo jej cast) musi ostat na povodnom ucte', 'warning');
        return;
      }

      // Reuse /move-items endpoint cez itemQtys — uz podporuje partial
      // qty (zdrojovy riadok rozdeli, ked qty < original). Najprv vytvor
      // novy ucet, potom presun vybrane polozky+qty.
      var label = 'Ucet ' + (tableOrdersList.length + 1);
      var newOrder = await api.post('/orders', { tableId: selectedTableId, items: [], label: label });
      var itemQtys = [];
      _splitSelectedItems.forEach(function(qty, id){
        var it = pickable.find(function(x){ return x.id === id; });
        if (!it) return;
        // qty=null znamena "cele" pre server fallback, ale my mame
        // konkretne cislo. Posli ho.
        itemQtys.push({ itemId: id, qty: qty });
      });
      await api.post('/orders/'+currentOrderId+'/move-items', {
        itemQtys: itemQtys, targetTableId: selectedTableId, targetOrderId: newOrder.id
      });

      document.getElementById('splitModal').classList.remove('show');
      _splitSelectedItems.clear();
      await loadTableOrder(selectedTableId, true);
      renderOrder();
      if(isMobile()) renderMobOrder();
      var n = itemQtys.reduce(function(s, x){ return s + (x.qty || 0); }, 0);
      showToast(n + ' pol. presunutych na novy ucet', true);
      return;
    }
    // equal N-way split
    const parts=parseInt(document.getElementById('splitCount').value)||2;
    await api.post('/orders/'+currentOrderId+'/split',{parts});
    document.getElementById('splitModal').classList.remove('show');
    await loadTableOrder(selectedTableId, true);
    renderOrder();
    if(isMobile()) renderMobOrder();
    showToast('Ucet rozdeleny na '+parts+' casti',true);
  }catch(e){
    showToast('Chyba: '+e.message);
  }
}

function closeSplitModal(){
  document.getElementById('splitModal').classList.remove('show');
  _splitSelectedItems.clear();
}

// === Inline Move Mode (Tap-to-Move) ===
// moveSelectedItems je teraz pole objektov {id, qty}. qty=null znamená
// "celé množstvo", číslo < pôvodné qty znamená čiastočný presun (server
// rozdelí riadok na zdroji a vytvorí nový na destinácii).
var moveSelectedItems = [];
var moveMode = false;
var moveSourceTableId = null;
var moveSourceOrderId = null;

function _findItemById(itemId) {
  var order = getOrder();
  for (var i = 0; i < order.length; i++) {
    if (order[i].id === itemId) return order[i];
  }
  return null;
}

function enterMoveMode(preselectedItemId) {
  moveMode = true;
  moveSelectedItems = [];
  moveSourceOrderId = currentOrderId;
  moveSourceTableId = selectedTableId;
  document.querySelector('.order-panel').classList.add('move-mode');
  if (preselectedItemId != null) {
    // Ak má item qty>1, neselectujeme rovno všetko — najprv sa
    // operátora opýtame koľko chce presunúť cez qty picker.
    var item = _findItemById(preselectedItemId);
    if (item && Number(item.qty) > 1) {
      _showMoveQtyPicker(item, function (chosenQty) {
        if (chosenQty != null) {
          moveSelectedItems.push({ id: item.id, qty: chosenQty });
        }
        renderOrder(); if (isMobile()) renderMobOrder();
      });
      return;
    }
    moveSelectedItems.push({ id: preselectedItemId, qty: null });
  }
  renderOrder(); if(isMobile()) renderMobOrder();
}

function exitMoveMode() {
  moveMode = false;
  moveSelectedItems = [];
  moveSourceOrderId = null;
  moveSourceTableId = null;
  document.querySelector('.order-panel').classList.remove('move-mode');
  closeTablePicker();
  renderOrder(); if(isMobile()) renderMobOrder();
}

function _findSelectedIdx(itemId) {
  for (var i = 0; i < moveSelectedItems.length; i++) {
    if (moveSelectedItems[i].id === itemId) return i;
  }
  return -1;
}

function toggleMoveSelection(itemId) {
  var idx = _findSelectedIdx(itemId);
  if (idx >= 0) {
    moveSelectedItems.splice(idx, 1);
    renderOrder(); if (isMobile()) renderMobOrder();
    return;
  }
  // Nový select — ak má item qty>1, otvor picker; inak pridaj rovno.
  var item = _findItemById(itemId);
  if (item && Number(item.qty) > 1) {
    _showMoveQtyPicker(item, function (chosenQty) {
      if (chosenQty != null) {
        moveSelectedItems.push({ id: itemId, qty: chosenQty });
      }
      renderOrder(); if (isMobile()) renderMobOrder();
    });
    return;
  }
  moveSelectedItems.push({ id: itemId, qty: null });
  renderOrder(); if (isMobile()) renderMobOrder();
}

// Helper pre render-side: vráti zvolenú qty pre daný item (alebo null
// pre celé). Použité v renderOrder kvôli zobrazeniu badge "2/5" pri
// items čo sú čiastočne vybrané.
function _moveSelectionQtyFor(itemId) {
  var idx = _findSelectedIdx(itemId);
  if (idx < 0) return null;
  return moveSelectedItems[idx].qty;
}

// Qty picker — redesigned: big stepper +/- s zivym mnozstvom v strede,
// suma preview, quick chips (1 / Polovica / Vsetko) pre rychly vyber,
// Potvrdit + Zrusit. Vsetko v CSS classes (mqp-*), ziadne inline styly.
//
// Default = celé množstvo (operator najcastejsie chce presunut vsetko;
// keby chcel ciastocne, mini-mini logika sa zmeni cez stepper). Stepper
// clamp 1..maxQty. Quick chips disabled ak duplicitne (napr. maxQty=2 ->
// "Polovica" sa neukaze, lebo by bola identicka s "1").
function _showMoveQtyPicker(item, callback) {
  var existing = document.getElementById('moveQtyPicker');
  if (existing) existing.parentNode.removeChild(existing);

  var maxQty = Number(item.qty) || 1;
  var unitPrice = Number(item.price) || 0;
  var current = maxQty; // default = vsetko
  var half = Math.max(1, Math.floor(maxQty / 2));

  var overlay = document.createElement('div');
  overlay.id = 'moveQtyPicker';
  overlay.className = 'u-overlay show';
  overlay.style.zIndex = '10000';

  // Quick chips — len tie ktore davaju zmysel pre tento qty:
  //   "1"        — vzdy ak maxQty > 1
  //   "Polovica" — ak maxQty >= 4 a polovica != 1 a != vsetko
  //   "Vsetko"   — vzdy
  var quickChipsHtml = '';
  quickChipsHtml += '<button type="button" class="mqp-quick-chip" data-q="1">1</button>';
  if (maxQty >= 4 && half !== 1 && half !== maxQty) {
    quickChipsHtml += '<button type="button" class="mqp-quick-chip" data-q="' + half + '">Polovica (' + half + ')</button>';
  }
  quickChipsHtml += '<button type="button" class="mqp-quick-chip is-all" data-q="' + maxQty + '">Všetko (' + maxQty + ')</button>';

  overlay.innerHTML =
    '<div class="u-modal mqp-modal" role="dialog" aria-modal="true" aria-labelledby="mqpTitle">' +
      '<div class="mqp-header">' +
        '<div class="mqp-icon" aria-hidden="true">↗</div>' +
        '<div class="mqp-title-block">' +
          '<div class="mqp-title" id="mqpTitle">Koľko presunúť?</div>' +
          '<div class="mqp-item">' + escAttr((item.emoji || '') + ' ' + (item.name || '')) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="mqp-stepper-wrap">' +
        '<button type="button" class="mqp-step mqp-step-minus" aria-label="Znížiť">−</button>' +
        '<div class="mqp-value-wrap">' +
          '<div class="mqp-value" id="mqpValue">' + current + '</div>' +
          '<div class="mqp-of">z celkom ' + maxQty + ' ks</div>' +
        '</div>' +
        '<button type="button" class="mqp-step mqp-step-plus" aria-label="Zvýšiť">+</button>' +
      '</div>' +

      '<div class="mqp-total" id="mqpTotal">' + fmt(unitPrice * current) + '</div>' +

      '<div class="mqp-quick-row">' + quickChipsHtml + '</div>' +

      '<div class="u-modal-btns">' +
        '<button class="u-btn u-btn-ghost" id="mqpCancel" type="button">Zrušiť</button>' +
        '<button class="u-btn u-btn-mint" id="mqpConfirm" type="button">Potvrdiť</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function updateUI() {
    var vEl = document.getElementById('mqpValue');
    if (vEl) vEl.textContent = current;
    var tEl = document.getElementById('mqpTotal');
    if (tEl) tEl.textContent = fmt(unitPrice * current);
    // Disable stepper buttons na hraniciach
    var minus = overlay.querySelector('.mqp-step-minus');
    var plus = overlay.querySelector('.mqp-step-plus');
    if (minus) minus.classList.toggle('is-disabled', current <= 1);
    if (plus)  plus.classList.toggle('is-disabled',  current >= maxQty);
    // Highlight aktivny quick chip
    var chips = overlay.querySelectorAll('.mqp-quick-chip');
    Array.prototype.forEach.call(chips, function(c){
      c.classList.toggle('is-active', Number(c.dataset.q) === current);
    });
  }
  updateUI();

  overlay.querySelector('.mqp-step-minus').addEventListener('click', function(){
    if (current > 1) { current -= 1; updateUI(); }
  });
  overlay.querySelector('.mqp-step-plus').addEventListener('click', function(){
    if (current < maxQty) { current += 1; updateUI(); }
  });
  Array.prototype.forEach.call(overlay.querySelectorAll('.mqp-quick-chip'), function(c){
    c.addEventListener('click', function(){
      current = Math.max(1, Math.min(maxQty, parseInt(c.dataset.q, 10) || 1));
      updateUI();
    });
  });
  overlay.querySelector('#mqpConfirm').addEventListener('click', function(){
    _closeMoveQtyPicker();
    callback(current);
  });
  overlay.querySelector('#mqpCancel').addEventListener('click', function(){
    _closeMoveQtyPicker();
    callback(null);
  });
  // Klik na overlay (mimo modalu) zrusi.
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) {
      _closeMoveQtyPicker();
      callback(null);
    }
  });
  // Hardware keyboard support — Enter potvrdi, +/- stepuje, Esc zrusi.
  var keyHandler = function(e){
    if (e.key === 'Enter')   { e.preventDefault(); _closeMoveQtyPicker(); document.removeEventListener('keydown', keyHandler, true); callback(current); }
    else if (e.key === 'Escape'){ e.preventDefault(); _closeMoveQtyPicker(); document.removeEventListener('keydown', keyHandler, true); callback(null); }
    else if (e.key === '+' || e.key === 'ArrowUp')   { e.preventDefault(); if (current < maxQty){ current += 1; updateUI(); } }
    else if (e.key === '-' || e.key === 'ArrowDown') { e.preventDefault(); if (current > 1){ current -= 1; updateUI(); } }
  };
  document.addEventListener('keydown', keyHandler, true);
}

function _closeMoveQtyPicker() {
  var el = document.getElementById('moveQtyPicker');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// Move selected items to a target account tab (inline, no modal).
// Ak nie je nič vybraté, ticho vyjdeme z move-mode — UX požiadavka:
// operátor klikne "Presunúť" a potom si to rozmyslí (klikne stôl,
// účet alebo "+ Nový účet"); pôvodne to vyhodilo error 'Vyberte polozky',
// teraz sa to chápe ako "nič netreba presúvať" a kontext sa zruší.
async function moveToTab(targetOrderId) {
  if (!moveSelectedItems.length) { exitMoveMode(); return; }
  try {
    var count = moveSelectedItems.length;
    // Server akceptuje itemQtys s {itemId, qty}. Ak qty=null (celé), tak
    // server fallne na pôvodné item.qty. Server tiež prijíma legacy itemIds
    // ale my pošleme nový formát aby fungoval čiastočný presun.
    var itemQtys = moveSelectedItems
      .filter(function (s) { return s && (s.qty == null || s.qty > 0); })
      .map(function (s) { return { itemId: s.id, qty: s.qty }; });
    await api.post('/orders/' + moveSourceOrderId + '/move-items', {
      itemQtys: itemQtys, targetTableId: selectedTableId, targetOrderId: targetOrderId
    });
    // Clear move state without rendering (avoid flicker before data refresh)
    moveMode = false;
    moveSelectedItems = [];
    moveSourceOrderId = null;
    moveSourceTableId = null;
    document.querySelector('.order-panel').classList.remove('move-mode');
    await loadTableOrder(selectedTableId, true);
    _activateLoadedOrder(targetOrderId);
    renderOrder(); if(isMobile()) renderMobOrder();
    showToast(count + ' pol. presunutych', true);
  } catch(e) { showToast('Chyba: ' + e.message); }
}

// Move to a brand new account (inline target). Empty selection = silent exit.
async function moveToNewAccountInline() {
  if (!moveSelectedItems.length) { exitMoveMode(); return; }
  try {
    var label = 'Ucet ' + (tableOrdersList.length + 1);
    var newOrder = await api.post('/orders', { tableId: selectedTableId, items: [], label: label });
    await moveToTab(newOrder.id);
  } catch(e) { showToast('Chyba: ' + e.message); }
}

// Table picker for cross-table moves. Empty selection = silent exit.
function showTablePicker() {
  if (!moveSelectedItems.length) { exitMoveMode(); return; }
  var sl = { free: 'Volny', occupied: 'Obsad.', reserved: 'Rez.', dirty: 'Spinavy' };
  var grid = TABLES.filter(function(t) { return t.id !== selectedTableId; }).map(function(t) {
    var st = t.status || 'free';
    return '<button class="tp-chip s-' + st + '" onclick="handleMoveToTable(' + t.id + ')">' +
      '<span class="tp-name">' + escHtml(t.name) + '</span>' +
      '<span class="tp-status">' + (sl[st] || st) + '</span>' +
    '</button>';
  }).join('');
  document.getElementById('tablePickerGrid').innerHTML = grid;
  document.getElementById('tablePicker').classList.add('show');
}

function closeTablePicker() {
  var el = document.getElementById('tablePicker');
  if (el) el.classList.remove('show');
}

async function handleMoveToTable(targetTableId) {
  // Empty selection — operátor klikol "Presunúť" omylom alebo si to
  // rozmyslel a klikol na iný stôl; ticho vyjdi z move-mode a otvor
  // ten stôl normálne (žiadny error). Bez tohto fixu sa stáva, že
  // operátor uviazne v move-mode a stránka mu hlási "Nie je co presunut".
  if (!moveSelectedItems.length) {
    exitMoveMode();
    if (typeof selectTable === 'function' && targetTableId !== moveSourceTableId) {
      selectTable(targetTableId);
    }
    return;
  }
  if (targetTableId === moveSourceTableId) { showToast('Vyberte INY stol'); return; }
  try {
    var count = moveSelectedItems.length;
    var itemQtys = moveSelectedItems
      .filter(function (s) { return s && (s.qty == null || s.qty > 0); })
      .map(function (s) { return { itemId: s.id, qty: s.qty }; });
    await api.post('/orders/' + moveSourceOrderId + '/move-items', {
      itemQtys: itemQtys, targetTableId: targetTableId
    });
    var targetTable = TABLES.find(function(t) { return t.id === targetTableId; });
    showToast(count + ' pol. \u2192 ' + (targetTable ? targetTable.name : 'stol'), true);
    // Clear move state without extra render (data will be refreshed below)
    moveMode = false;
    moveSelectedItems = [];
    moveSourceOrderId = null;
    moveSourceTableId = null;
    document.querySelector('.order-panel').classList.remove('move-mode');
    closeTablePicker();
    await loadTableOrder(selectedTableId, true);
    // Refresh target table cache for correct status display
    if (targetTableId !== selectedTableId) {
      try {
        var targetOrders = await api.get('/orders/table/' + targetTableId);
        allOrdersCache[targetTableId] = Array.isArray(targetOrders) ? targetOrders : [];
      } catch(e) { /* skip */ }
    }
    renderOrder();
    if (isMobile()) renderMobOrder();
    updateTableStatuses();
    renderFloor();
    if (isMobile()) renderMobTables();
  } catch(e) { showToast('Chyba: ' + e.message); }
}

// === MERGE ACCOUNTS ===
async function mergeAccounts() {
  if (tableOrdersList.length < 2) { showToast('Len 1 ucet'); return; }
  var totalItems = tableOrdersList.reduce(function(s, o) { return s + (o.items ? o.items.length : 0); }, 0);
  var totalAmount = tableOrdersList.reduce(function(s, o) {
    return s + (o.items ? o.items.reduce(function(s2, i) { return s2 + parseFloat(i.price) * i.qty; }, 0) : 0);
  }, 0);
  showConfirm(
    'Spojit ucty',
    'Spojit ' + tableOrdersList.length + ' uctov (' + totalItems + ' poloziek, ' + fmt(totalAmount) + ') do jedneho?',
    doMergeAccounts,
    { icon: '\u21C4', confirmText: 'Spojit' }
  );
}

async function doMergeAccounts() {
  var targetOrderId = tableOrdersList[0].id;
  var toMerge = tableOrdersList.filter(function(o) { return o.id !== targetOrderId; });
  try {
    for (var i = 0; i < toMerge.length; i++) {
      var items = toMerge[i].items;
      if (items && items.length) {
        var itemIds = items.map(function(it) { return it.id; });
        await api.post('/orders/' + toMerge[i].id + '/move-items', {
          itemIds: itemIds, targetTableId: selectedTableId, targetOrderId: targetOrderId
        });
      } else {
        // Prazdny ucet bez poloziek — move-items by len echo-loval ze nic
        // nie je co presunut. Vymaz priamo. Ak medzitym ostatny tab uz
        // zmazal stol, 404 je benign.
        try { await api.del('/orders/' + toMerge[i].id); } catch (e) {}
      }
      // POZN: po move-items server SAM vymaze zdrojovy order ak ostal
      // prazdny (server/routes/orders.js:727 — `if (!remaining.length)
      // tx.delete(orders)`). Predtym sa tu volal explicitny DELETE ktory
      // dostaval 404 lebo order uz neexistoval — len zbytocny sum v
      // konzole. Odstraneny.
    }
    await loadTableOrder(selectedTableId, true);
    _activateLoadedOrder(targetOrderId);
    renderOrder();
    if (isMobile()) renderMobOrder();
    showToast('Ucty spojene', true);
  } catch(e) { showToast('Chyba: ' + e.message); }
}
