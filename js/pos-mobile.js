'use strict';
// pos-mobile.js — All mobile-specific code: tabs, tables, menu, order, badges, clock, payment drawer

// ===== MOBILE POS =====
var mobActiveTab = 'mobTabTables';
var mobActiveCategory = null;
var mobSearchQuery = '';

function isMobile() { return window.innerWidth <= 768; }

async function switchMobTab(tabId) {
  if (
    tabId === 'mobTabTables' &&
    mobActiveTab !== 'mobTabTables' &&
    typeof hasPendingOrderFlushState === 'function' &&
    typeof flushOrderBeforeTableLeave === 'function' &&
    hasPendingOrderFlushState()
  ) {
    var flushed = await flushOrderBeforeTableLeave();
    if (!flushed) return;
  }
  mobActiveTab = tabId;
  document.querySelectorAll('.mob-tab-content').forEach(t => {
    const active = t.id === tabId;
    t.classList.toggle('active', active);
    t.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
  document.querySelectorAll('.mob-tab').forEach(t => {
    const sel = t.dataset.tab === tabId;
    t.classList.toggle('active', sel);
    t.setAttribute('aria-selected', sel ? 'true' : 'false');
    t.tabIndex = sel ? 0 : -1;
  });
  if (tabId === 'mobTabTables') renderMobTables();
  if (tabId === 'mobTabMenu') renderMobMenu();
  if (tabId === 'mobTabOrder') renderMobOrder();
}

function renderMobTables() {
  const container = document.getElementById('mobTablesList');
  if (!container) return;
  const zones = [...new Set(TABLES.map(t => t.zone))];
  // Reuse the label map populated by loadTables() (server-side editable).
  // Falls back to the legacy hardcoded trio when /zones is unreachable.
  const zoneLabels = (window.ZONE_LABELS && typeof window.ZONE_LABELS === 'object')
    ? window.ZONE_LABELS
    : { interior: 'Interier', bar: 'Bar', terasa: 'Terasa' };
  const statusLabels = { free: 'Volny', occupied: 'Obsadeny', reserved: 'Rezervovany' };

  container.innerHTML = zones.map(zone => {
    const tables = TABLES.filter(t => t.zone === zone);
    return `<div class="mob-zone-group">
      <div class="mob-zone-title">${zoneLabels[zone] || zone}</div>
      ${tables.map(t => {
        const order = tableOrders[t.id] || [];
        const total = order.reduce((s, o) => s + o.price * o.qty, 0);
        const sel = t.id === selectedTableId ? ' selected' : '';
        var rowLabel = escHtml(t.name) + ', ' + escHtml(statusLabels[t.status] || t.status) + (total > 0 ? ', ' + escHtml(fmt(total)) : '');
        return `<button type="button" class="mob-table-row${sel}" onclick="mobSelectTable(${t.id})" aria-label="${rowLabel}">
          <div class="mob-table-icon s-${t.status}" aria-hidden="true">${t.name.charAt(0)}${t.seats}</div>
          <div class="mob-table-info">
            <div class="mob-table-name">${escHtml(t.name)}</div>
            <div class="mob-table-meta"><span>${t.seats} miest</span></div>
          </div>
          <span class="mob-table-status ${t.status}">${statusLabels[t.status] || t.status}</span>
          ${total > 0 ? `<span class="mob-table-amount">${fmt(total)}</span>` : ''}
        </button>`;
      }).join('')}
    </div>`;
  }).join('');
}

async function mobSelectTable(id) {
  if (moveMode) { await handleMoveToTable(id); return; }
  if (selectedTableId && selectedTableId !== id && typeof flushOrderBeforeTableLeave === 'function') {
    var flushed = await flushOrderBeforeTableLeave();
    if (!flushed) return;
  }
  selectedTableId = id;
  const t = TABLES.find(x => x.id === id);
  if (t) {
    document.getElementById('mobTableLabel').textContent = t.name;
    document.getElementById('mobOrderTable').textContent = t.name;
    document.getElementById('orderTableLabel').textContent = t.name;
  }
  await loadTableOrder(id);
  if (navigator.vibrate) navigator.vibrate(10);
  // If multiple accounts, show picker
  if (tableOrdersList.length > 1) {
    showAccountPicker(id, true);
  } else {
    renderOrder();
    renderMobOrder();
    switchMobTab('mobTabMenu');
  }
}

// mobEscHtml replaced by global escHtml() from components/escHtml.js
var mobEscHtml = escHtml;

function mobClearSearch() {
  mobSearchQuery = '';
  const si = document.getElementById('mobSearchInput');
  if (si) {
    si.value = '';
    si.focus();
  }
  renderMobMenu();
}

function renderMobMenu() {
  // Categories
  const catsEl = document.getElementById('mobCats');
  if (!catsEl) return;
  const catKeys = Object.keys(MENU);
  if (!mobActiveCategory && catKeys.length) mobActiveCategory = catKeys[0];
  catsEl.innerHTML = catKeys.map(key => {
    const cat = MENU[key];
    const cur = key === mobActiveCategory;
    return `<button type="button" class="mob-cat${cur ? ' active' : ''}" onclick="setMobCat('${key}')"${cur ? ' aria-current="true"' : ''}>${cat.icon} ${cat.label}</button>`;
  }).join('');

  // Products. Logical sort (compareByMenuLogic from pos-state.js):
  // family alphabetical, then volume ascending. Mirrors the desktop grid
  // — beer 0,3 l next to 0,5 l of the same family instead of scattered
  // by sales rank.
  const cmpItems = (typeof compareByMenuLogic === 'function') ? compareByMenuLogic
    : ((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  const grid = document.getElementById('mobProducts');
  if (!grid) return;
  let items;
  if (mobSearchQuery) {
    items = [];
    Object.values(MENU).forEach(c => {
      c.items.forEach(i => {
        if (i.name.toLowerCase().includes(mobSearchQuery) || i.desc.toLowerCase().includes(mobSearchQuery)) items.push(i);
      });
    });
    items.sort(cmpItems);
  } else if (mobActiveCategory === '__top__') {
    // Mirror desktop: Najcastejsie tab uses the first 12 of TOP_ITEMS,
    // which the backend already returns in sales-rank order — that's the
    // whole point of that pseudo-tab, so we DON'T re-sort it here.
    var topList = (typeof TOP_ITEMS !== 'undefined' && Array.isArray(TOP_ITEMS)) ? TOP_ITEMS : [];
    items = topList.slice(0, 12);
  } else if (mobActiveCategory && MENU[mobActiveCategory]) {
    items = MENU[mobActiveCategory].items.slice().sort(cmpItems);
  } else {
    items = [];
  }
  if (!items.length) {
    if (mobSearchQuery) {
      grid.innerHTML =
        '<div class="mob-products-empty" role="status">' +
        '<div class="mob-products-empty-icon" aria-hidden="true">&#128269;</div>' +
        '<div class="mob-products-empty-text">Žiadne výsledky pre „' + mobEscHtml(mobSearchQuery) + '“</div>' +
        '<button type="button" class="mob-products-empty-btn" onclick="mobClearSearch()">Zrušiť vyhľadávanie</button>' +
        '</div>';
    } else {
      grid.innerHTML =
        '<div class="mob-products-empty" role="status">' +
        '<div class="mob-products-empty-icon" aria-hidden="true">&#128193;</div>' +
        '<div class="mob-products-empty-text">Žiadne položky v tejto kategórii</div>' +
        '</div>';
    }
    return;
  }
  const order = getOrder();
  grid.innerHTML = items.map(item => {
    const inOrder = order.find(o => o.name === item.name);
    const badge = inOrder ? `<span class="mob-product-badge">${inOrder.qty}</span>` : '';
    var prodLabel = escHtml(item.name) + ', ' + escHtml(fmt(item.price));
    return `<button type="button" class="mob-product" onclick="mobAddItem('${item.name.replace(/'/g, "\\'")}','${item.emoji}',${item.price})" aria-label="${prodLabel}">
      ${badge}<span class="mob-product-emoji" aria-hidden="true">${escHtml(item.emoji)}</span>
      <div class="mob-product-name">${escHtml(item.name)}</div>
      <div class="mob-product-price">${fmt(item.price)}</div>
    </button>`;
  }).join('');
}

function setMobCat(key) {
  mobActiveCategory = key;
  mobSearchQuery = '';
  const si = document.getElementById('mobSearchInput');
  if (si) si.value = '';
  renderMobMenu();
}

function mobAddItem(name, emoji, price) {
  addToOrder(name, emoji, price);
  if (navigator.vibrate) navigator.vibrate(15);
  updateMobBadge();
  renderMobMenu(); // update badges
}

function _getMobTabMeta(orderSummary) {
  var items = orderSummary.items || [];
  var count = items.reduce(function(sum, item) { return sum + item.qty; }, 0);
  var total = items.reduce(function(sum, item) { return sum + (parseFloat(item.price) * item.qty); }, 0);
  return count + ' pol. · ' + fmt(total);
}

function _renderMobOrderTabs(mobTabsEl) {
  if (!mobTabsEl) return;

  if (tableOrdersList.length > 1) {
    var tabsHtml = tableOrdersList.map(function(orderSummary) {
      var isActive = orderSummary.id === currentOrderId;
      var label = escHtml(orderSummary.label || 'Ucet');
      var meta = _getMobTabMeta(orderSummary);

      if (moveMode && !isActive) {
        return '<button type="button" class="order-tab" role="tab" onclick="moveToTab(' + orderSummary.id + ')" title="Presunut sem">' +
          '<span class="tab-label">' + label + ' &#8599;</span>' +
          '<span class="tab-meta">' + meta + '</span>' +
        '</button>';
      }

      return '<button type="button" class="order-tab' + (isActive ? ' active' : '') + '" role="tab" aria-selected="' + isActive + '" onclick="switchAccount(' + orderSummary.id + ')">' +
        '<span class="tab-label">' + label + '</span>' +
        '<span class="tab-meta">' + meta + '</span>' +
      '</button>';
    }).join('');

    if (moveMode) {
      tabsHtml += '<button type="button" class="order-tab move-new-target" onclick="moveToNewAccountInline()">+ Novy ucet</button>';
      tabsHtml += '<button type="button" class="order-tab move-table-target" onclick="showTablePicker()">Na iny stol</button>';
      tabsHtml += '<button type="button" class="order-tab order-tab-cancel" onclick="exitMoveMode()">Zrusit</button>';
    } else {
      tabsHtml += '<button type="button" class="order-tab order-tab-new" onclick="newAccount()" aria-label="Novy ucet">+</button>';
      tabsHtml += '<button type="button" class="order-tab order-tab-merge" onclick="mergeAccounts()">&#x21C4; Spojit</button>';
    }

    mobTabsEl.innerHTML = tabsHtml;
    mobTabsEl.classList.remove('pos-hidden');
    return;
  }

  if (tableOrdersList.length === 1) {
    var single = tableOrdersList[0];
    var singleHtml = '<button type="button" class="order-tab active" role="tab" aria-selected="true">' +
      '<span class="tab-label">' + escHtml(single.label || 'Ucet 1') + '</span>' +
      '<span class="tab-meta">' + _getMobTabMeta(single) + '</span>' +
    '</button>';

    if (moveMode) {
      singleHtml += '<button type="button" class="order-tab move-new-target" onclick="moveToNewAccountInline()">+ Novy ucet</button>';
      singleHtml += '<button type="button" class="order-tab move-table-target" onclick="showTablePicker()">Na iny stol</button>';
      singleHtml += '<button type="button" class="order-tab order-tab-cancel" onclick="exitMoveMode()">Zrusit</button>';
    } else {
      singleHtml += '<button type="button" class="order-tab order-tab-new" onclick="newAccount()" aria-label="Novy ucet">+</button>';
    }

    mobTabsEl.innerHTML = singleHtml;
    mobTabsEl.classList.remove('pos-hidden');
    return;
  }

  mobTabsEl.innerHTML = '';
  mobTabsEl.classList.add('pos-hidden');
}

function renderMobOrder() {
  const order = getOrder();
  const container = document.getElementById('mobOrderItems');
  const totalEl = document.getElementById('mobTotal');
  if (!container) return;

  // Render mobile account tabs
  var mobTabsEl=document.getElementById('mobOrderTabs');
  _renderMobOrderTabs(mobTabsEl);

  if (!order.length) {
    container.innerHTML = `<div class="mob-order-empty"><div class="mob-order-empty-icon">&#128203;</div><div class="mob-order-empty-text">Prazdna objednavka</div></div>`;
  } else if (moveMode) {
    container.innerHTML = '<div class="mob-move-hint">Presunout vybrane polozky a potom vyberte cielovy ucet alebo stol.</div>' + order.map(o => {
      var selected = moveSelectedItems.indexOf(o.id) >= 0;
      return `<button type="button" class="mob-order-item mob-order-item-pick${o.sent ? ' sent' : ''}${selected ? ' move-selected' : ''}" onclick="toggleMoveSelection(${o.id})" aria-pressed="${selected ? 'true' : 'false'}">
        <span class="mob-move-check" aria-hidden="true">${selected ? '&#10003;' : ''}</span>
        <span class="mob-oi-emoji">${escHtml(o.emoji)}</span>
        <div class="mob-oi-info"><div class="mob-oi-name">${escHtml(o.name)}</div>${o.note ? `<div class="mob-oi-note">${escHtml(o.note)}</div>` : `<div class="mob-oi-add-note">bez poznamky</div>`}</div>
        <div class="mob-oi-price">${o.qty}x &middot; ${fmt(o.price * o.qty)}</div>
      </button>`;
    }).join('');
  } else {
    container.innerHTML = order.map(o => {
      const esc = o.name.replace(/'/g, "\\'");
      const isSent = o.sent;
      return `<div class="mob-order-item${isSent ? ' sent' : ''}">
        <span class="mob-oi-emoji">${escHtml(o.emoji)}</span>
        <div class="mob-oi-info" onclick="openNoteModal('${esc}', ${o.id});"><div class="mob-oi-name">${escHtml(o.name)}</div>${o.note ? `<div class="mob-oi-note">${escHtml(o.note)}</div>` : `<div class="mob-oi-add-note">+ poznamka</div>`}</div>
        <div class="mob-oi-qty">
          <button onclick="mobChangeQty('${esc}',-1,${o.id})">&minus;</button>
          <span>${o.qty}</span>
          <button onclick="mobChangeQty('${esc}',1,${o.id})">+</button>
        </div>
        <div class="mob-oi-price">${fmt(o.price * o.qty)}</div>
        <button type="button" class="mob-oi-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut polozku">&#8599;</button>
        <button class="mob-oi-del" onclick="removeItem('${esc}');renderMobOrder();updateMobBadge()" aria-label="Odstranit polozku">&times;</button>
      </div>`;
    }).join('');
  }

  const total = getOrderTotal();
  if (totalEl) totalEl.textContent = fmt(total);
  var mobSend = document.getElementById('mobBtnSend');
  if (mobSend) mobSend.disabled = !order.length || moveMode;
  updateMobBadge();
}

function mobChangeQty(name, d, itemId) {
  changeQty(name, d, itemId);
  renderMobOrder();
  renderMobMenu();
}

function updateMobBadge() {
  const badge = document.getElementById('mobOrderBadge');
  if (!badge) return;
  const count = getOrder().reduce((s, o) => s + o.qty, 0);
  badge.textContent = count > 0 ? count : '';
}

// Mobile search
document.addEventListener('DOMContentLoaded', function() {
  const si = document.getElementById('mobSearchInput');
  if (si) si.addEventListener('input', function(e) {
    mobSearchQuery = e.target.value.toLowerCase().trim();
    renderMobMenu();
  });

  // ----- Keyboard-aware product scroll padding (mobile) -----
  // On iOS Safari and most Android browsers the on-screen keyboard does
  // NOT resize the layout viewport; it just slides up over the page,
  // covering the bottom of .mob-products. The cashier reaches the
  // search bar but cannot scroll to items hidden under the keyboard
  // because the scroll container's last items already fit inside the
  // (uncovered) viewport — there is nothing further to scroll to.
  //
  // Fix: when the search input is focused, measure the keyboard height
  // via window.visualViewport (the only API that gives us "real visible
  // viewport") and set --kb-height as a CSS variable on the products
  // container. Its bottom padding grows by that amount so every menu
  // item is reachable above the keyboard.
  const vv = window.visualViewport;
  const products = document.getElementById('mobProducts');
  function applyKeyboardPadding() {
    if (!products) return;
    var kb = 0;
    if (vv) {
      // visualViewport.height shrinks when the OSK is visible. Diff vs
      // window.innerHeight ≈ keyboard height. Add a small safety margin.
      kb = Math.max(0, Math.round(window.innerHeight - vv.height));
    }
    products.style.setProperty('--kb-height', kb > 40 ? (kb + 24) + 'px' : '0px');
  }
  function clearKeyboardPadding() {
    if (products) products.style.setProperty('--kb-height', '0px');
  }
  if (si && products) {
    si.addEventListener('focus', applyKeyboardPadding);
    si.addEventListener('blur', clearKeyboardPadding);
    if (vv) {
      vv.addEventListener('resize', function () {
        // Only react while the input is focused — otherwise rotation /
        // browser-bar collapse would constantly repaint padding.
        if (document.activeElement === si) applyKeyboardPadding();
      });
    }
  }
});

// Mobile clock
function updateMobClock() {
  const el = document.getElementById('mobClock');
  if (!el) return;
  const n = new Date();
  el.textContent = String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
}

// Hook into existing renderOrder to also update mobile
const _origRenderOrder = typeof renderOrder === 'function' ? renderOrder : null;
if (_origRenderOrder) {
  const _patched = renderOrder;
  // We'll call mob renders after desktop render via a MutationObserver-free approach
}

// Payment drawer toggle
function toggleMobPayDrawer() {
  var drawer = document.getElementById('mobPayDrawer');
  if (drawer) drawer.classList.toggle('open');
}
function closeMobPayDrawer() {
  var drawer = document.getElementById('mobPayDrawer');
  if (drawer) drawer.classList.remove('open');
}

// Init mobile on load
function initMobile() {
  if (!isMobile()) return;
  const user = api.getUser();
  const mobUser = document.getElementById('mobUserName');
  if (mobUser && user) mobUser.textContent = user.name;
  // Show the admin shortcut only for users who can actually use the
  // admin panel — cisnik would just hit a 'Pristup odmietnuty' wall.
  const mobAdmin = document.getElementById('mobAdminBtn');
  if (mobAdmin && user && (user.role === 'admin' || user.role === 'manazer')) {
    mobAdmin.hidden = false;
  }
  updateMobClock();
  setInterval(updateMobClock, 30000);
  updateMobBadge();
  switchMobTab(mobActiveTab);
}

// Mobile admin click — sessionStorage doesn't always cross to a fresh
// target=_blank tab (Safari iOS, some PWA installs). Stash the auth
// pair into localStorage just-in-time so admin/index.html (and the api
// helper there) can recover it on the new tab; if that lookup misses
// too, deep-link through login with ?redirect=/admin/ so login lands
// us on admin after re-auth instead of back on the cashier view.
function openMobileAdmin(e) {
  try {
    var token = sessionStorage.getItem('pos_token');
    var user  = sessionStorage.getItem('pos_user');
    if (token) {
      // Short-lived handoff key — admin/index.html reads + clears it
      // immediately on boot so it doesn't sit around as a privilege
      // store. Falls back to plain ?redirect= flow if disabled.
      localStorage.setItem('pos_token_handoff', token);
      if (user) localStorage.setItem('pos_user_handoff', user);
      localStorage.setItem('pos_token_handoff_ts', String(Date.now()));
    } else {
      // No active session in this tab — short-circuit to login with
      // redirect so the round-trip is one click instead of two.
      e.preventDefault();
      // Intentionally NOT 'noopener' — the new tab needs window.opener
      // so the admin's 'Späť na POS' can call window.close() and bring
      // the cashier back to the original POS tab. Same-origin opens
      // only — no tabnap risk.
      window.open('/login.html?redirect=/admin/', '_blank');
    }
  } catch (err) {
    // Storage disabled (private mode, quota) — let the default href
    // navigate; login fallback in admin/index.html will still trigger.
  }
}
window.openMobileAdmin = openMobileAdmin;

// Patch renderOrder to also update mobile
const _baseRenderOrder = renderOrder;
renderOrder = function() {
  _baseRenderOrder.apply(this, arguments);
  if (isMobile()) {
    renderMobOrder();
    updateMobBadge();
  }
};

// Patch updateQtyBadges for mobile
const _baseUpdateQtyBadges = typeof updateQtyBadges === 'function' ? updateQtyBadges : null;
if (_baseUpdateQtyBadges) {
  updateQtyBadges = function() {
    _baseUpdateQtyBadges.apply(this, arguments);
    if (isMobile()) renderMobMenu();
  };
}

// Mobile init is called via init().then() above

// Update offline queue count periodically
setInterval(() => {
  const el = document.getElementById('offlineQueueCount');
  if (el && api._queue.length) {
    el.textContent = api._queue.length + ' vo fronte';
  } else if (el) {
    el.textContent = '';
  }
}, 5000);
