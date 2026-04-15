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
let DEST_MAP = {};
let TABLES = [];
let ZONES = [];

const CAT_COLORS = {
  kava:'108,92,231', caj:'92,196,158', koktaily:'212,107,107',
  pivo:'108,92,231', vino:'106,142,196', jedlo:'72,180,190'
};

async function loadMenu(data) {
  MENU_DATA = data || (api.getMenu ? await api.getMenu() : await api.get('/menu'));
  MENU = {};
  DEST_MAP = {};
  MENU_ID_MAP = new Map();
  MENU_DATA.forEach(cat => {
    MENU[cat.slug] = { label: cat.label, icon: cat.icon, key: cat.sortKey, items: cat.items };
    DEST_MAP[cat.slug] = cat.dest;
    cat.items.forEach(item => { MENU_ID_MAP.set(item.name, item.id); });
  });
}

async function loadTables(data) {
  TABLES = data || await api.get('/tables');
  // Reset floor reference space cache
  if (typeof renderFloor !== 'undefined') renderFloor._refW = 0;
  // Derive zones from table data
  const zoneSet = new Map();
  const zoneLabels = {interior:'Interier', bar:'Bar', terasa:'Terasa'};
  TABLES.forEach(t => {
    if (!zoneSet.has(t.zone)) {
      zoneSet.set(t.zone, { id: t.zone, label: zoneLabels[t.zone] || t.zone });
    }
  });
  ZONES = Array.from(zoneSet.values());
  TABLES.forEach(t => { if (!tableOrders[t.id]) tableOrders[t.id] = []; });
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
    // Populate tableOrders for all tables so renderFloor shows totals on chips
    TABLES.forEach(function(t) {
      var tOrders = newCache[t.id] || [];
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
        tableOrders[t.id] = allItems;
      } else {
        tableOrders[t.id] = [];
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
      tableOrders[tableId] = current.items.map(function(i) {
        return {
          id: i.id, name: i.name, emoji: i.emoji, price: i.price,
          qty: i.qty, note: i.note, menuItemId: i.menuItemId,
          orderId: current.id, desc: i.desc || '', sent: !!i.sent,
          _sentQty: i.sent ? i.qty : 0
        };
      });
    } else {
      currentOrderId = null;
      currentOrderVersion = null;
      tableOrders[tableId] = [];
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
let currentView='tables', activeZone='interior', selectedTableId=null, activeCategory=null;
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
