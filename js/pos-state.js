'use strict';
// pos-state.js — Global state variables, data loading, and utility functions

// Auth check
if (!api.requireAuth()) throw 'no auth';
const session = api.getUser();
(function(){
  const avatarEl = document.querySelector('.header-avatar');
  const userEl = document.querySelector('.header-user');
  if (avatarEl && session && session.name) {
    const initials = session.name.split(' ').map(w=>w[0]).join('');
    avatarEl.textContent = initials;
  }
  if (userEl && session && session.name) {
    const avatarHtml = userEl.querySelector('.header-avatar').outerHTML;
    userEl.innerHTML = avatarHtml + escHtml(session.name);
  }
})();

// ===== DATA (loaded from API) =====
let MENU_DATA = []; // raw array from API
let MENU = {};      // category slug -> {label, icon, key, items}
let MENU_ID_MAP = new Map(); // item name -> menuItemId for O(1) lookup
let MENU_ITEM_BY_ID = new Map(); // menuItemId -> full item (for companion lookup etc.)
let DEST_MAP = {};
let TABLES = [];
let ZONES = [];
// Top-sold items (all time) feeding the "🔥 Najcastejsie" pseudo-category.
// Persisted to localStorage so the tab never starts empty after a page
// reload (especially on a phone where the network round-trip can take
// a noticeable second). Refreshed at most once every 24h — see loadTopItems.
const TOP_ITEMS_KEY = 'pos_topItems_v1';
const TOP_ITEMS_TS_KEY = 'pos_topItems_ts_v1';
const TOP_ITEMS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
let TOP_ITEMS = (function () {
  try {
    var raw = localStorage.getItem(TOP_ITEMS_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
})();

// Storno basket — pending storno entries the cashier queued for admin to process.
// Refreshed via loadStornoBasket() on init, every 30s poll, and on
// socket 'storno-basket:updated' events.
let _stornoBasketCache = { count: 0, value: 0, items: [] };

async function loadStornoBasket() {
  try {
    var data = await api.get('/storno-basket');
    var summary = data && data.summary || { pendingCount: 0, pendingValue: 0 };
    _stornoBasketCache = {
      count: Number(summary.pendingCount) || 0,
      value: Number(summary.pendingValue) || 0,
      items: Array.isArray(data && data.items) ? data.items : [],
    };
    if (typeof renderStornoChip === 'function') renderStornoChip();
  } catch (e) {
    // Offline / 401 — keep last cache, just log
    console.warn('loadStornoBasket failed:', e && e.message);
  }
}

const CAT_COLORS = {
  kava:'108,92,231', caj:'92,196,158', koktaily:'212,107,107',
  pivo:'108,92,231', vino:'106,142,196', jedlo:'72,180,190'
};

async function loadMenu(data) {
  MENU_DATA = data || (api.getMenu ? await api.getMenu() : await api.get('/menu'));
  MENU = {};
  DEST_MAP = {};
  MENU_ID_MAP = new Map();
  MENU_ITEM_BY_ID = new Map();
  // Synthetic "Najcastejsie" pseudo-category — must be first so init code that
  // does `Object.keys(MENU)[0]` lands here, and so renderCategories shows it
  // as the leading tab. Empty items array keeps existing MENU iteration
  // helpers (getItemCat / search) safe; renderProducts has a special branch
  // to pull from TOP_ITEMS instead.
  MENU['__top__'] = { label: 'Najcastejsie', icon: '🔥', key: 'B00', items: [] };
  MENU_DATA.forEach(cat => {
    MENU[cat.slug] = { label: cat.label, icon: cat.icon, key: cat.sortKey, items: cat.items };
    DEST_MAP[cat.slug] = cat.dest;
    cat.items.forEach(item => {
      MENU_ID_MAP.set(item.name, item.id);
      MENU_ITEM_BY_ID.set(item.id, item);
    });
  });
  // Fire-and-forget: kick off the top-sold list. Don't block menu load on it —
  // the pseudo-tab will populate as soon as the request returns and any active
  // render that's looking at __top__ will pick it up via the helper below.
  loadTopItems();
}

// Pull the top-sold items from the server. Items come back with full menu
// fields (id, name, emoji, price, imageUrl…) so the existing product-card
// template can render them directly. Failures keep the previous list — the
// pseudo-tab just stays "stale" until the next 5-minute tick succeeds.
// SALES_RANK[menuItemId] -> rank index (0 = best seller). Built from
// TOP_ITEMS so that renderProducts can sort items inside every category
// by sales without a second network call. Items not in the map sort to
// the bottom (rank = Infinity) and tie-break by id.
let SALES_RANK = (function buildRank(items) {
  var m = {};
  if (Array.isArray(items)) {
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].id != null) m[items[i].id] = i;
    }
  }
  return m;
})(TOP_ITEMS);

async function loadTopItems(force) {
  // Skip the network call if the cached list is < 24h old. Cashiers using
  // the tab don't need second-by-second freshness; the all-time top
  // sellers do not change much from minute to minute.
  if (!force) {
    try {
      var ts = parseInt(localStorage.getItem(TOP_ITEMS_TS_KEY) || '0', 10);
      if (ts && Date.now() - ts < TOP_ITEMS_TTL_MS && TOP_ITEMS.length) return;
    } catch (e) { /* localStorage unavailable — fall through and fetch */ }
  }
  try {
    var data = api.getTopItems ? await api.getTopItems() : await api.get('/menu/top');
    if (Array.isArray(data) && data.length) {
      TOP_ITEMS = data;
      // Rebuild the rank index whenever the ranking changes.
      SALES_RANK = {};
      for (var i = 0; i < TOP_ITEMS.length; i++) {
        if (TOP_ITEMS[i] && TOP_ITEMS[i].id != null) SALES_RANK[TOP_ITEMS[i].id] = i;
      }
      try {
        localStorage.setItem(TOP_ITEMS_KEY, JSON.stringify(TOP_ITEMS));
        localStorage.setItem(TOP_ITEMS_TS_KEY, String(Date.now()));
      } catch (e) { /* quota / private mode — fine, in-memory still works */ }
    }
    // The active category's product grid needs a re-render either way:
    // - on __top__ tab: list refreshed
    // - on any other category: items resorted by the new ranking
    if (typeof renderProducts === 'function' && typeof currentView !== 'undefined'
        && currentView === 'products') {
      renderProducts();
    }
  } catch (e) {
    console.warn('loadTopItems failed:', e && e.message);
  }
}

// Re-check the cache once an hour; the function itself short-circuits if
// the entry is < 24h old, so this is effectively a daily refresh tick
// that survives long-running kiosk sessions without manual reload.
setInterval(function () { loadTopItems(false); }, 60 * 60 * 1000);

async function loadTables(data) {
  TABLES = data || await api.get('/tables');
  // Pull zone labels from the server. The admin can rename zones — the
  // cashier should see those names too. Fall back to a Title-Cased slug
  // when the network call fails so a momentary outage doesn't blank the
  // floor view.
  let zoneLabels = { interior: 'Interier', bar: 'Bar', terasa: 'Terasa' };
  try {
    const zonesData = await api.get('/zones');
    if (Array.isArray(zonesData)) {
      zoneLabels = {};
      zonesData.forEach((z) => { if (z && z.slug) zoneLabels[z.slug] = z.label || z.slug; });
    }
  } catch (e) {
    // keep defaults — cashier still gets a usable layout
  }
  const zoneSet = new Map();
  TABLES.forEach((t) => {
    if (!zoneSet.has(t.zone)) {
      const lbl = zoneLabels[t.zone] || (t.zone ? t.zone.charAt(0).toUpperCase() + t.zone.slice(1) : '');
      zoneSet.set(t.zone, { id: t.zone, label: lbl });
    }
  });
  ZONES = Array.from(zoneSet.values());
  // Expose label map so other surfaces (mobile zone grouping) don't need
  // their own /zones round-trip.
  window.ZONE_LABELS = zoneLabels;
  TABLES.forEach((t) => { if (!tableOrders[t.id]) tableOrders[t.id] = []; });
}

async function loadAllOrders() {
  try {
    var allOrders = await api.get('/orders');
    var newCache = {};
    // Initialize all known tables with empty arrays
    TABLES.forEach(function(t) { newCache[t.id] = []; });
    allOrders.forEach(function(order) {
      var tid = order.tableId;
      if (!newCache[tid]) newCache[tid] = [];
      newCache[tid].push(order);
    });
    allOrdersCache = newCache;
    _lastOrdersCacheJSON = JSON.stringify(newCache);
    // Populate tableOrders for all tables so renderFloor shows totals on chips.
    // CRITICAL: preserve local-only unsent rows (id > 1e9, sent=false) — without
    // this, the 30s poll / socket refresh overwrites a draft order the cashier
    // is still typing in, and "Pay" then says "Nie je co platit" because
    // tableOrders[id] is suddenly [].
    TABLES.forEach(function(t) {
      var tOrders = newCache[t.id] || [];
      var prev = tableOrders[t.id] || [];
      if (tOrders.length) {
        // Sum all items across all open orders for this table
        var allItems = [];
        tOrders.forEach(function(o) {
          if (o.items) {
            o.items.forEach(function(i) {
              allItems.push({ id: i.id, name: i.name, emoji: i.emoji, price: parseFloat(i.price), qty: i.qty, note: i.note || '', menuItemId: i.menuItemId, orderId: o.id, desc: i.desc || '', sent: !!i.sent, _sentQty: i.sent ? i.qty : 0 });
            });
          }
        });
        // Append any local-only rows the cashier added that aren't on the server yet.
        prev.forEach(function(p) {
          if (!p || p.sent) return;
          if (typeof p.id !== 'number' || p.id <= 1000000000) return;
          if (allItems.some(function(m) { return m.id === p.id; })) return;
          allItems.push(p);
        });
        tableOrders[t.id] = allItems;
      } else {
        // No server orders for this table — keep any local-only draft rows
        // instead of wiping them. Only fully-clear if there are none.
        var keptLocal = prev.filter(function(p) {
          return p && !p.sent && typeof p.id === 'number' && p.id > 1000000000;
        });
        tableOrders[t.id] = keptLocal;
      }
    });
    _persistTableOrdersNow();
  } catch(e) {
    // Offline or error — keep old cache
    console.error('loadAllOrders error:', e);
  }
}

function updateTableStatuses() {
  TABLES.forEach(function(t) {
    // Only update occupied/free — preserve reserved and other manual statuses
    refreshTableStatus(t.id);
  });
}

function _hasItemsInOrderItems(items) {
  return Array.isArray(items) && items.some(function(item) {
    return Number(item && item.qty) > 0;
  });
}

function _tableHasAnyItems(tableId) {
  if (selectedTableId === tableId) {
    if (_hasItemsInOrderItems(tableOrders[tableId])) return true;
    if (tableOrdersList && tableOrdersList.length) {
      return tableOrdersList.some(function(order) {
        if (order.id === currentOrderId) return _hasItemsInOrderItems(tableOrders[tableId]);
        return _hasItemsInOrderItems(order.items);
      });
    }
    return false;
  }

  var cachedOrders = allOrdersCache[tableId] || [];
  return cachedOrders.some(function(order) {
    return _hasItemsInOrderItems(order && order.items);
  });
}

function refreshTableStatus(tableId) {
  var table = TABLES.find(function(t) { return t.id === tableId; });
  if (!table || table.status === 'reserved') return;
  table.status = _tableHasAnyItems(tableId) ? 'occupied' : 'free';
}

// Map a server-side order item into the client's tableOrders shape.
function _mapServerOrderItem(i, orderId) {
  return {
    id: i.id, name: i.name, emoji: i.emoji, price: i.price,
    qty: i.qty, note: i.note, menuItemId: i.menuItemId,
    orderId: orderId, desc: i.desc || '', sent: !!i.sent,
    _sentQty: i.sent ? i.qty : 0,
  };
}

// Merge fresh server items with the cashier's in-progress local additions.
// Without this, the 30s poll / socket order:updated would silently wipe rows the
// cashier is still typing in (item disappears mid-add) — see pos-init.js refresh
// and the loadTableOrder rebuild below.
//
// Local-only rows are anything still using a client-side id (> 1e9 boundary set
// by _getNextLocalOrderItemId) AND not yet synced (sent === false). Sent rows
// always come from the server, so we never preserve those from the prev state.
function _mergePreservingLocalAdditions(serverItems, prevLocalItems, orderId) {
  var mapped = serverItems.map(function (i) { return _mapServerOrderItem(i, orderId); });
  if (!Array.isArray(prevLocalItems) || !prevLocalItems.length) return mapped;
  prevLocalItems.forEach(function (p) {
    if (!p || p.sent) return;
    if (typeof p.id !== 'number' || p.id <= 1000000000) return;
    if (mapped.some(function (m) { return m.id === p.id; })) return;
    mapped.push(p);
  });
  return mapped;
}

async function loadTableOrder(tableId, forceRefresh) {
  try {
    if (!forceRefresh && allOrdersCache[tableId]) {
      // Use cached data — instant, no API call
      tableOrdersList = allOrdersCache[tableId];
    } else {
      // Fetch from API and update cache
      var ordersArr = await api.get('/orders/table/' + tableId);
      tableOrdersList = Array.isArray(ordersArr) ? ordersArr : [];
      allOrdersCache[tableId] = tableOrdersList;
    }
    if (tableOrdersList.length) {
      var current = tableOrdersList.find(function(o) { return o.id === currentOrderId; }) || tableOrdersList[0];
      currentOrderId = current.id;
      currentOrderVersion = current.version || null;
      tableOrders[tableId] = _mergePreservingLocalAdditions(
        current.items, tableOrders[tableId], current.id
      );
    } else {
      // Server has no orders for this table — but the cashier may have just
      // started a brand-new local-only order. Keep those rows; if there are
      // none, fall through to the empty-state.
      var keptLocal = (tableOrders[tableId] || []).filter(function (p) {
        return p && !p.sent && typeof p.id === 'number' && p.id > 1000000000;
      });
      if (keptLocal.length) {
        tableOrders[tableId] = keptLocal;
      } else {
        currentOrderId = null;
        currentOrderVersion = null;
        tableOrders[tableId] = [];
      }
      tableOrdersList = [];
    }
    refreshTableStatus(tableId);
    _persistTableOrdersNow();
  } catch(e) {
    console.error('loadTableOrder error:', e);
    // Do not clear or persist on error — preserve any locally cached items for crash recovery
    if (!tableOrders[tableId]) tableOrders[tableId] = [];
    currentOrderId = null; currentOrderVersion = null; tableOrdersList = [];
  }
}

function getItemCat(itemName) {
  for (const [cat, data] of Object.entries(MENU)) {
    if (data.items.some(i => i.name === itemName)) return cat;
  }
  return 'jedlo';
}

function getItemDest(itemName) {
  for (const [cat, data] of Object.entries(MENU)) {
    if (data.items.some(i => i.name === itemName)) return DEST_MAP[cat] || 'bar';
  }
  return 'bar';
}

function getUserRole() {
  try { return JSON.parse(sessionStorage.getItem('pos_user')).role; } catch(e) { return 'cisnik'; }
}

// ===== STATE =====
// activeCategory defaults to the "Najcastejsie" pseudo-tab so the cashier
// lands on the most-frequent items without drilling into a real category.
let currentView='tables', activeZone='interior', selectedTableId=null, activeCategory='__top__';
let searchQuery='', tipPercent=0, noteItemName=null, noteItemId=null, pendingPaymentMethod=null;
let editMode=false;
let currentOrderId=null;
let currentOrderVersion=null;
let currentShiftId=null;
let tableOrdersList=[];

const tableOrders=(function(){try{var s=localStorage.getItem('pos_tableOrders');return s?JSON.parse(s):{}}catch(e){return {}}})();
var allOrdersCache = {}; // tableId -> [orders with items] for instant table switching
var _lastOrdersCacheJSON = ''; // for background sync change detection

// Debounced localStorage write — prevents JSON.stringify on every rapid click
var _persistTimer=null;
function _persistTableOrders(){
  if(_persistTimer) return; // already scheduled
  _persistTimer=setTimeout(function(){
    _persistTimer=null;
    try{localStorage.setItem('pos_tableOrders',JSON.stringify(tableOrders))}catch(e){}
  },200);
}
function _persistTableOrdersNow(){
  clearTimeout(_persistTimer);_persistTimer=null;
  try{localStorage.setItem('pos_tableOrders',JSON.stringify(tableOrders))}catch(e){}
}

function savePositions(){
  // Save positions to API
  TABLES.forEach(t => {
    api.put('/tables/' + t.id, { x: t.x, y: t.y }).catch(e => console.error('savePositions error:', e));
  });
}

function getOrder(){return tableOrders[selectedTableId]||[]}
function setOrder(o){
  tableOrders[selectedTableId]=o;
  if (selectedTableId != null) refreshTableStatus(selectedTableId);
  _persistTableOrders();
}
