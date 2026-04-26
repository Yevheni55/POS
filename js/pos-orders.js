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
  var primaryMenu = (typeof MENU_ITEM_BY_ID !== 'undefined') ? MENU_ITEM_BY_ID.get(primary.menuItemId) : null;
  if (!primaryMenu || !primaryMenu.companionMenuItemId) return;
  var companionMenu = MENU_ITEM_BY_ID.get(primaryMenu.companionMenuItemId);
  if (!companionMenu) return;
  var order = getOrder();
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

function addToOrder(name, emoji, price) {
  var menuItemId = MENU_ID_MAP.get(name);
  if (!menuItemId) return;

  // Combos open a sauce-picker modal first. After the waiter confirms,
  // we add the combo itself plus a 0-price "Omáčka (combo)" annotation
  // line so the cook sees the selection on the kitchen ticket.
  if (/^combo\s/i.test(name) && typeof showSauceSelector === 'function') {
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
      _addSauceAnnotationForCombo(combo, sauceNote);
    });
    return;
  }

  _addToOrderCore(name, emoji, price);
}

// For combos: push a 0-price "Omáčka (combo)" line whose note carries the sauces
// the waiter picked, and tie it to the combo via _companionOf so qty changes /
// storno on the combo cascade onto this line too.
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
    note: sauceNote,
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
  var esc = name.replace(/'/g, "\\'");
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
      '<div class="order-item-inner"><span class="order-item-emoji">' + emoji + '</span>' +
      '<div class="order-item-info"><div class="order-item-name">' + name + '</div></div>' +
      '<div class="order-item-qty"><button class="qty-btn" onclick="changeQty(\'' + esc + '\', -1, ' + changedItem.id + ')" onpointerdown="startQtyHold(\'' + esc + '\', -1, ' + changedItem.id + ')">&minus;</button><span class="qty-val">1</span><button class="qty-btn" onclick="changeQty(\'' + esc + '\', 1, ' + changedItem.id + ')" onpointerdown="startQtyHold(\'' + esc + '\', 1, ' + changedItem.id + ')">&plus;</button></div>' +
      '<div class="order-item-total">' + fmt(price) + '</div></div>' +
      '<div class="order-item-swipe-left"><button class="swipe-btn swipe-btn-move" onclick="enterMoveMode(' + changedItem.id + ')" aria-label="Presunut polozku">&#8599;</button><button class="swipe-btn swipe-btn-note" onclick="openNoteModal(\'' + esc + '\',' + changedItem.id + ')" aria-label="Poznamka">&#9998;</button><button class="swipe-btn swipe-btn-del" onclick="removeItem(\'' + esc + '\')" aria-label="Odstranit polozku">&#10005;</button></div></div>';
    c.insertAdjacentHTML('afterbegin', html);
  }

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
  return newItem;
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
  document.getElementById('noteModal').classList.add('show');
  setTimeout(function() { document.getElementById('noteInput').focus(); }, 100);
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

async function splitBill(){
  if(!getOrder().length){showToast('Prazdna objednavka');return}
  try{
    if(!currentOrderId||_orderDirty) await syncOrderToServer();
    if(!currentOrderId){showToast('Objednavku sa nepodarilo pripravit');return}
    const total=getOrderTotal();
    document.getElementById('splitCount').value=2;
    document.getElementById('splitPreview').textContent='Kazdy plati: '+fmt(total/2);
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

async function confirmSplit(){
  const parts=parseInt(document.getElementById('splitCount').value)||2;
  try{
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
}

// === Inline Move Mode (Tap-to-Move) ===
var moveSelectedItems = [];
var moveMode = false;
var moveSourceTableId = null;
var moveSourceOrderId = null;

function enterMoveMode(preselectedItemId) {
  moveMode = true;
  moveSelectedItems = preselectedItemId ? [preselectedItemId] : [];
  moveSourceOrderId = currentOrderId;
  moveSourceTableId = selectedTableId;
  document.querySelector('.order-panel').classList.add('move-mode');
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

function toggleMoveSelection(itemId) {
  var idx = moveSelectedItems.indexOf(itemId);
  if (idx >= 0) moveSelectedItems.splice(idx, 1);
  else moveSelectedItems.push(itemId);
  renderOrder(); if(isMobile()) renderMobOrder();
}

// Move selected items to a target account tab (inline, no modal)
async function moveToTab(targetOrderId) {
  if (!moveSelectedItems.length) { showToast('Vyberte polozky'); return; }
  try {
    var count = moveSelectedItems.length;
    await api.post('/orders/' + moveSourceOrderId + '/move-items', {
      itemIds: moveSelectedItems, targetTableId: selectedTableId, targetOrderId: targetOrderId
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

// Move to a brand new account (inline target)
async function moveToNewAccountInline() {
  if (!moveSelectedItems.length) { showToast('Vyberte polozky'); return; }
  try {
    var label = 'Ucet ' + (tableOrdersList.length + 1);
    var newOrder = await api.post('/orders', { tableId: selectedTableId, items: [], label: label });
    await moveToTab(newOrder.id);
  } catch(e) { showToast('Chyba: ' + e.message); }
}

// Table picker for cross-table moves
function showTablePicker() {
  if (!moveSelectedItems.length) { showToast('Vyberte polozky'); return; }
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
  if (targetTableId === moveSourceTableId) { showToast('Vyberte INY stol'); return; }
  if (!moveSelectedItems.length) { showToast('Vyberte polozky'); return; }
  try {
    var count = moveSelectedItems.length;
    await api.post('/orders/' + moveSourceOrderId + '/move-items', {
      itemIds: moveSelectedItems, targetTableId: targetTableId
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
      }
      try { await api.del('/orders/' + toMerge[i].id); } catch(e) {}
    }
    await loadTableOrder(selectedTableId, true);
    _activateLoadedOrder(targetOrderId);
    renderOrder();
    if (isMobile()) renderMobOrder();
    showToast('Ucty spojene', true);
  } catch(e) { showToast('Chyba: ' + e.message); }
}
