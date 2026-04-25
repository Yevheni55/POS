'use strict';
// pos-init.js — Initialization, WebSocket, shift management, admin, logout

// TTLock — generate passcode and print
async function generateLockCode() {
  try {
    showToast('Generujem kod zamku...');
    var result = await api.post('/ttlock/passcode', {});
    var code = result.passcode;
    var endDate = new Date(result.endDate);
    var validUntil = endDate.toLocaleString('sk-SK', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    // Print automatically — dedicated lock code receipt
    api.post('/print/lockcode', {
      code: code,
      validUntil: validUntil,
      staffName: (api.getUser() || {}).name || ''
    }).catch(function(e) { console.error('Lock code print error:', e); });

    // Show popup with code
    showAlert('Kod zamku',
      '<div style="text-align:center;margin:16px 0">'
        + '<div style="font-family:var(--font-display);font-size:48px;font-weight:800;letter-spacing:10px;color:var(--color-accent);margin:12px 0">' + code + '</div>'
        + '<div style="font-size:var(--text-sm);color:var(--color-text-sec)">Platny do: ' + validUntil + '</div>'
        + '</div>',
      { icon: '\uD83D\uDD10' }
    );
    showToast('Kod ' + code + ' odoslany na tlac', true);
  } catch (e) {
    showToast('Chyba: ' + (e.message || 'Nepodarilo sa vygenerovat kod'), 'error');
  }
}

// Apply settings from admin panel (localStorage)
function applyPosSettings() {
  try {
    var raw = localStorage.getItem('pos_settings');
    if (!raw) return;
    var s = JSON.parse(raw);
    // Header title/subtitle
    var name = s.sName || '';
    var subtitle = 'Pokladnicny system';
    var titleEl = document.querySelector('.header-title');
    var subEl = document.querySelector('.header-subtitle');
    if (titleEl && name) titleEl.textContent = name;
    if (subEl) subEl.textContent = subtitle;
    if (name) document.title = name + ' — POS';
    var logoEl = document.querySelector('.header-logo');
    if (logoEl && name) {
      var initials = name.split(/\s+/).map(function(w) { return w[0]; }).join('').slice(0, 3).toUpperCase();
      logoEl.textContent = initials;
    }
  } catch (e) { /* ignore parse errors */ }
}

// Init
async function initPOS() {
  var mainEl = document.getElementById('main');
  if (mainEl) showLoading(mainEl, 'Nacitavam data...');
  try {
    var md, td;
    try {
      var results = await Promise.all([
        api.getMenu ? api.getMenu() : api.get('/menu'),
        api.get('/tables')
      ]);
      md = results[0];
      td = results[1];
      // Cache for offline use
      localStorage.setItem('pos_menu_cache', JSON.stringify(md));
      localStorage.setItem('pos_tables_cache', JSON.stringify(td));
    } catch (e) {
      // Offline fallback
      var cachedMenu = localStorage.getItem('pos_menu_cache');
      var cachedTables = localStorage.getItem('pos_tables_cache');
      if (cachedMenu && cachedTables) {
        md = JSON.parse(cachedMenu);
        td = JSON.parse(cachedTables);
        showToast('Offline — pouzivam cache data');
      } else {
        showToast('Offline a ziadne cache data', 'error');
        return;
      }
    }
    await loadMenu(md);
    await loadTables(td);
    try {
      if (api.getCompanyProfile && api.getToken()) {
        var PROFILE_MS = 12000;
        var serverProfile = await Promise.race([
          api.getCompanyProfile({ refresh: true }),
          new Promise(function(_, reject) {
            setTimeout(function() {
              reject(new Error('company-profile timeout'));
            }, PROFILE_MS);
          }),
        ]);
        if (serverProfile && typeof api.mergeCompanyProfileIntoPosSettingsCache === 'function') {
          api.mergeCompanyProfileIntoPosSettingsCache(serverProfile);
        }
      }
    } catch (profileErr) {
      console.warn('Company profile from server:', profileErr);
    }
    await loadAllOrders(); // Preload all open orders for instant table switching
    updateTableStatuses(); // Derive table statuses from orders cache
    var fcs = Object.keys(MENU)[0];
    if (fcs) activeCategory = fcs;
    if (ZONES.length) activeZone = ZONES[0].id;
    renderCategories();
    renderFloorZones();
    renderFloor();
    if (TABLES.length) {
      var fiz = TABLES.find(function(t){ return t.zone === activeZone; }) || TABLES[0];
      await selectTableAndLoadOrder(fiz.id);
    }
    renderProducts();
    applyPosSettings();

    // Connect WebSocket for real-time sync
    connectWS();

    // Fallback polling every 30 seconds (WebSocket handles real-time)
    setInterval(async function() {
    try {
      var oldJSON = _lastOrdersCacheJSON;
      await loadAllOrders();
      // Only re-render if data actually changed (avoid flicker)
      if (_lastOrdersCacheJSON !== oldJSON) {
        updateTableStatuses();
        if (currentView === 'tables') renderFloor();
        if (isMobile()) renderMobTables();
        // If currently viewing a table, refresh its display from new cache —
        // but preserve any local-only unsent additions the cashier is still
        // typing in (otherwise the 30s tick wipes them).
        if (selectedTableId && allOrdersCache[selectedTableId]) {
          tableOrdersList = allOrdersCache[selectedTableId];
          if (tableOrdersList.length) {
            var current = tableOrdersList.find(function(o) { return o.id === currentOrderId; }) || tableOrdersList[0];
            currentOrderId = current.id;
            currentOrderVersion = current.version || null;
            tableOrders[selectedTableId] = _mergePreservingLocalAdditions(
              current.items, tableOrders[selectedTableId], current.id
            );
          } else {
            // No server order for this table — but keep any local-only rows
            // the cashier may have just started before the order is synced.
            var keptLocal = (tableOrders[selectedTableId] || []).filter(function (p) {
              return p && !p.sent && typeof p.id === 'number' && p.id > 1000000000;
            });
            if (keptLocal.length) {
              tableOrders[selectedTableId] = keptLocal;
            } else {
              currentOrderId = null;
              currentOrderVersion = null;
              tableOrders[selectedTableId] = [];
            }
            tableOrdersList = [];
          }
          renderOrder();
          if (isMobile()) renderMobOrder();
        }
      }
    } catch(e) { /* offline, skip */ }
    }, 30000);
  } finally {
    if (mainEl) hideLoading(mainEl);
  }
}

// WebSocket connection for real-time sync
var socket = null;
function connectWS() {
  var token = api.getToken();
  if (!token || typeof io === 'undefined') return;

  socket = io({ auth: { token: token } });

  socket.on('connect', function() {
    console.log('WS connected');
  });

  socket.on('order:created', async function(data) {
    await loadAllOrders();
    updateTableStatuses();
    if (data.tableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
    renderFloor();
    if (isMobile()) renderMobTables();
  });

  socket.on('order:updated', async function(data) {
    await loadAllOrders();
    if (data.orderId === currentOrderId) {
      await loadTableOrder(selectedTableId, true);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
  });

  socket.on('order:closed', async function(data) {
    await loadAllOrders();
    updateTableStatuses();
    if (data.tableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
    renderFloor();
    if (isMobile()) renderMobTables();
  });

  socket.on('order:cancelled', async function(data) {
    await loadAllOrders();
    updateTableStatuses();
    if (data.tableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
    renderFloor();
    if (isMobile()) renderMobTables();
  });

  socket.on('order:sent', async function(data) {
    if (data.orderId === currentOrderId) {
      await loadTableOrder(selectedTableId, true);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
  });

  socket.on('order:split', async function(data) {
    await loadAllOrders();
    if (data.tableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
  });

  socket.on('items:moved', async function(data) {
    await loadAllOrders();
    updateTableStatuses();
    if (data.sourceTableId === selectedTableId || data.targetTableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
    renderFloor();
    if (isMobile()) renderMobTables();
  });

  socket.on('payment:created', async function(data) {
    await loadAllOrders();
    updateTableStatuses();
    if (data.tableId === selectedTableId) {
      await loadTableOrder(selectedTableId);
      renderOrder();
      if (isMobile()) renderMobOrder();
    }
    renderFloor();
    if (isMobile()) renderMobTables();
  });

  socket.on('table:updated', async function(data) {
    try {
      var tablesData = await api.get('/tables');
      TABLES.length = 0;
      tablesData.forEach(function(t) { TABLES.push(t); });
      renderFloor();
      if (isMobile()) renderMobTables();
    } catch(e) { /* offline, skip */ }
  });

  socket.on('disconnect', function() {
    console.log('WS disconnected');
  });
}

async function runPosBootstrap() {
  await initPOS();
  setTimeout(function() {
    if (typeof initMobile === 'function' && isMobile()) initMobile();
  }, 0);
}

async function init() {
  try {
    var shift = await api.get('/shifts/current');
    if (!shift) {
      var sm = document.getElementById('shiftModal');
      if (sm) {
        sm.classList.add('show');
        var cashIn = document.getElementById('shiftCashInput');
        if (cashIn) {
          cashIn.value = '';
          setTimeout(function() {
            try { cashIn.focus(); cashIn.select(); } catch (e) { /* ignore */ }
          }, 0);
        }
      } else {
        showToast('Chyba: modal zmeny nenajdeny', 'error');
      }
      return;
    }
    currentShiftId = shift.id;
    await runPosBootstrap();
  } catch(e) {
    console.error('init error:', e);
    showToast('Chyba nacitania dat: ' + e.message);
  }
}

async function openShift() {
  var cashIn = document.getElementById('shiftCashInput');
  var openingCash = cashIn ? parseFloat(cashIn.value) : 0;
  if (cashIn && (cashIn.value === '' || cashIn.value === null || isNaN(openingCash))) {
    openingCash = 0;
  }
  var btn = document.querySelector('#shiftModal .u-btn-mint');
  if (btn) btnLoading(btn);
  try {
    var newShift = await api.post('/shifts/open', { openingCash: openingCash });
    currentShiftId = newShift.id;
    var sm = document.getElementById('shiftModal');
    if (sm) sm.classList.remove('show');
    await runPosBootstrap();
  } catch (e) {
    showToast(e.message || 'Nepodarilo sa otvorit zmenu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}
async function showCloseShiftModal(){
  try {
    var summary = await api.get('/shifts/current/summary');
    document.getElementById('closeShiftOpening').textContent = summary.openingCash.toFixed(2);
    document.getElementById('closeShiftCashSales').textContent = summary.cashPayments.toFixed(2);
    document.getElementById('closeShiftExpected').textContent = summary.expectedCash.toFixed(2);
    document.getElementById('closeShiftActualInput').value = summary.expectedCash.toFixed(2);
    updateCloseShiftDiff();
    document.getElementById('closeShiftModal').classList.add('show');
  } catch(e){ api.logout(); }
}
function updateCloseShiftDiff(){
  var expected = parseFloat(document.getElementById('closeShiftExpected').textContent) || 0;
  var actual = parseFloat(document.getElementById('closeShiftActualInput').value) || 0;
  var diff = actual - expected;
  var el = document.getElementById('closeShiftDiff');
  el.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + ' EUR';
  el.style.color = diff === 0 ? 'var(--color-success)' : (diff < 0 ? 'var(--color-danger)' : 'var(--color-accent)');
}
async function confirmCloseShift(){
  var btn = document.querySelector('#closeShiftModal .u-btn-rose');
  if (btn) btnLoading(btn);
  try {
    var closingCash = parseFloat(document.getElementById('closeShiftActualInput').value) || 0;
    await api.post('/shifts/close', { closingCash: closingCash });
    document.getElementById('closeShiftModal').classList.remove('show');
    currentShiftId = null;
    api.logout();
  } catch(e) {
    showToast(e.message || 'Chyba pri uzatvarani zmeny', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}
function closeCloseShiftModal(){ document.getElementById('closeShiftModal').classList.remove('show'); }

// Logout
function goAdmin(){
  var role=getUserRole();
  if(role==='cisnik'){showToast('Pristup len pre admina/manazera');return}
  let ov=document.getElementById('adminOverlay');
  if(!ov){
    ov=document.createElement('div');
    ov.id='adminOverlay';
    ov.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:var(--color-bg);display:none';
    const iframe=document.createElement('iframe');
    iframe.id='adminFrame';
    iframe.style.cssText='width:100%;height:100%;border:none;background:var(--color-bg)';
    iframe.src='/admin/';
    ov.appendChild(iframe);
    document.body.appendChild(ov);
  }
  ov.style.display='block';
  document.getElementById('adminFrame').src='/admin/';
}
// Close admin overlay via postMessage
window.addEventListener('message',function(e){
  if(e.data==='closePosAdmin'){
    var ov=document.getElementById('adminOverlay');
    if(ov){ov.style.display='none';document.getElementById('adminFrame').src='about:blank'}
  }
});
function showLogoutModal(){document.getElementById('logoutModal').classList.add('show')}
function closeLogoutModal(){document.getElementById('logoutModal').classList.remove('show')}
function confirmLogout(){closeLogoutModal();if(currentShiftId){showCloseShiftModal();}else{api.logout();}}
setTimeout(function(){var lm=document.getElementById('logoutModal');if(lm)lm.addEventListener('click',function(e){if(e.target===this)closeLogoutModal()});var csm=document.getElementById('closeShiftModal');if(csm)csm.addEventListener('click',function(e){if(e.target===this)closeCloseShiftModal()});},0);

// === Startup sequence ===
init();
setupLongPress();
// Hide edit button for cisnik
if(getUserRole()==='cisnik'){var eb=document.getElementById('editToggle');if(eb)eb.classList.add('pos-hidden');}
document.getElementById('paymentModal').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.getElementById('noteModal').addEventListener('click',function(e){if(e.target===this)closeNoteModal()});
/* moveModal + moveAccountModal removed — replaced by inline move mode + table picker */
document.getElementById('managerPinModal').addEventListener('click',function(e){if(e.target===this)closeManagerPinModal()});
