(function(){
  'use strict';

  // State
  let currentView = 'kuchyna';
  let soundEnabled = true;
  let previousDataHash = '';
  let previousOrderIds = new Set();
  let perItemMode = {};
  let audioCtx = null;

  // Clock
  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const s = String(now.getSeconds()).padStart(2,'0');
    document.getElementById('clock').textContent = h + ':' + m + ':' + s;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // View toggle
  window.setView = function(view) {
    currentView = view;
    const btnK = document.getElementById('btnKuchyna');
    const btnB = document.getElementById('btnBar');
    if (view === 'kuchyna') {
      btnK.className = 'view-btn active-kuchyna';
      btnB.className = 'view-btn inactive';
    } else {
      btnK.className = 'view-btn inactive';
      btnB.className = 'view-btn active-bar';
    }
    previousDataHash = '';
    loadOrders();
  };

  // Sound toggle
  window.toggleSound = function() {
    soundEnabled = !soundEnabled;
    const btn = document.getElementById('soundBtn');
    if (soundEnabled) {
      btn.className = 'sound-btn on';
      btn.textContent = 'Zvuk: ZAP';
    } else {
      btn.className = 'sound-btn off';
      btn.textContent = 'Zvuk: VYP';
    }
  };

  // Audio
  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function playBeep(freq, duration) {
    if (!soundEnabled) return;
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq || 880;
      osc.type = 'sine';
      gain.gain.value = 0.3;
      osc.start(ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (duration || 0.5));
      osc.stop(ctx.currentTime + (duration || 0.5));
    } catch(e) {}
  }

  function playNotification(dest, hasUrgent) {
    if (!soundEnabled) return;
    if (hasUrgent) {
      playBeep(1000, 0.15);
      setTimeout(function(){ playBeep(1000, 0.15); }, 180);
      setTimeout(function(){ playBeep(1000, 0.15); }, 360);
    } else if (dest === 'kuchyna') {
      playBeep(880, 0.3);
      setTimeout(function(){ playBeep(880, 0.3); }, 400);
    } else {
      playBeep(880, 0.3);
    }
  }

  // Elapsed time
  function getElapsed(sentAt) {
    const sent = new Date(sentAt);
    const now = new Date();
    const diffMs = now - sent;
    const mins = Math.floor(diffMs / 60000);
    return mins;
  }

  function formatElapsed(mins) {
    if (mins < 1) return 'prave teraz';
    return 'pred ' + mins + ' min';
  }

  function formatTime(sentAt) {
    const d = new Date(sentAt);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  // Load orders
  function loadOrders() {
    let raw;
    try {
      raw = localStorage.getItem('pos_orders');
    } catch(e) { return; }

    if (!raw) raw = '{}';

    const allOrders = JSON.parse(raw);
    const filteredTables = {};

    for (const tableId in allOrders) {
      const items = allOrders[tableId];
      if (!Array.isArray(items)) continue;
      const sentItems = items.filter(function(it) {
        return it.status === 'sent' && it.dest === currentView;
      });
      if (sentItems.length > 0) {
        filteredTables[tableId] = sentItems;
      }
    }

    // Build a hash to check if data changed
    const dataHash = JSON.stringify(filteredTables);
    if (dataHash === previousDataHash) return;
    previousDataHash = dataHash;

    // Detect new orders
    const currentIds = new Set(Object.keys(filteredTables));
    let hasNew = false;
    let hasUrgent = false;
    currentIds.forEach(function(id) {
      if (!previousOrderIds.has(id)) hasNew = true;
      const items = filteredTables[id];
      const oldest = items.reduce(function(mn, it) {
        return it.sentAt && it.sentAt < mn ? it.sentAt : mn;
      }, items[0].sentAt || new Date().toISOString());
      if (getElapsed(oldest) > 15) hasUrgent = true;
    });

    if (hasNew && previousOrderIds.size > 0) {
      playNotification(currentView, false);
      document.getElementById('header').classList.remove('flash');
      void document.getElementById('header').offsetWidth;
      document.getElementById('header').classList.add('flash');
    }

    previousOrderIds = currentIds;

    // Update count
    document.getElementById('orderCount').textContent = currentIds.size;

    // Sort by oldest sentAt
    const sorted = Object.entries(filteredTables).sort(function(a, b) {
      const aTime = a[1].reduce(function(mn, it) { return it.sentAt && it.sentAt < mn ? it.sentAt : mn; }, a[1][0].sentAt || '');
      const bTime = b[1].reduce(function(mn, it) { return it.sentAt && it.sentAt < mn ? it.sentAt : mn; }, b[1][0].sentAt || '');
      return aTime < bTime ? -1 : 1;
    });

    // Render
    const grid = document.getElementById('grid');

    if (sorted.length === 0) {
      grid.innerHTML = '<div class="empty-state">' +
        '<div class="empty-icon">&#x1F373;</div>' +
        '<div class="empty-text">Ziadne aktivne objednavky</div>' +
        '<div class="empty-sub">' + (currentView === 'kuchyna' ? 'Kuchyna' : 'Bar') + ' - cakam na objednavky</div>' +
        '</div>';
      return;
    }

    let html = '';
    sorted.forEach(function(entry) {
      const tableId = entry[0];
      const items = entry[1];
      const oldestSentAt = items.reduce(function(mn, it) {
        return it.sentAt && it.sentAt < mn ? it.sentAt : mn;
      }, items[0].sentAt || new Date().toISOString());
      const elapsed = getElapsed(oldestSentAt);

      let timeClass = '';
      let cardClass = 'order-card';
      let elapsedClass = 'card-elapsed';
      if (elapsed >= 15) {
        cardClass += ' time-urgent';
        elapsedClass += ' urgent';
      } else if (elapsed >= 5) {
        cardClass += ' time-warn';
        elapsedClass += ' warn';
      }

      const tableName = tableId.replace(/^t/, 'Stol ').toUpperCase();
      const isPerItem = perItemMode[tableId] || false;

      html += '<div class="' + cardClass + '" data-table="' + tableId + '" tabindex="0" role="article" aria-label="' + escHtml(tableName) + ' - ' + formatElapsed(elapsed) + '">';
      if (elapsed >= 15) {
        html += '<div class="urgent-badge">URGENTNE</div>';
      }
      html += '<div class="card-header">';
      html += '<div class="card-table">' + escHtml(tableName) + '</div>';
      html += '<div class="' + elapsedClass + '">' + formatElapsed(elapsed) + '</div>';
      html += '</div>';
      html += '<div class="card-time">' + formatTime(oldestSentAt) + '</div>';
      html += '<div class="card-items">';

      items.forEach(function(item, idx) {
        const done = item._uiDone || false;
        html += '<button class="card-item' + (done ? ' done' : '') + '" onclick="toggleItem(\'' + tableId + '\',' + idx + ')" type="button">';
        html += '<span class="item-qty">' + (item.qty || 1) + 'x</span>';
        html += '<span class="item-info">';
        html += '<div class="item-name">' + (item.emoji ? item.emoji + ' ' : '') + escHtml(item.name) + '</div>';
        if (item.note) {
          html += '<div class="item-note">' + escHtml(item.note) + '</div>';
        }
        html += '</span>';
        html += '<span class="item-check">&#x2714;</span>';
        html += '</button>';
      });

      html += '</div>';
      html += '<div class="card-actions">';
      html += '<button class="btn-ready" onclick="markAllReady(\'' + tableId + '\')">&#x2713; Hotove</button>';
      html += '<button class="btn-per-item' + (isPerItem ? ' active' : '') + '" onclick="togglePerItem(\'' + tableId + '\')">Per polozku</button>';
      html += '<button class="btn-print" onclick="printOrder(\'' + tableId + '\')" aria-label="Tlacit objednavku">&#x1F5A8;</button>';
      html += '</div>';
      html += '</div>';
    });

    var focusedTable = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.table : null;
    grid.innerHTML = html;
    if (focusedTable) { var el = grid.querySelector('[data-table="' + focusedTable + '"]'); if (el) el.focus(); }
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Toggle individual item
  window.toggleItem = function(tableId, idx) {
    if (!perItemMode[tableId]) return;
    markItemReady(tableId, idx);
  };

  // Mark single item ready
  function markItemReady(tableId, itemIdx) {
    let raw;
    try { raw = localStorage.getItem('pos_orders'); } catch(e) { return; }
    if (!raw) return;
    const orders = JSON.parse(raw);
    if (!orders[tableId] || !Array.isArray(orders[tableId])) return;

    // Find the sent items matching current dest
    let sentIdx = -1;
    for (let i = 0; i < orders[tableId].length; i++) {
      const it = orders[tableId][i];
      if (it.status === 'sent' && it.dest === currentView) {
        sentIdx++;
        if (sentIdx === itemIdx) {
          orders[tableId][i].status = 'ready';
          break;
        }
      }
    }

    localStorage.setItem('pos_orders', JSON.stringify(orders));
    previousDataHash = '';
    loadOrders();
  }

  // Mark all ready
  window.markAllReady = function(tableId) {
    showConfirm({
      title: 'Oznacit vsetko ako hotove',
      message: 'Naozaj chcete oznacit vsetky polozky ako pripravene?',
      confirmText: 'Ano, oznacit',
      danger: false,
      onConfirm: function() {
        let raw;
        try { raw = localStorage.getItem('pos_orders'); } catch(e) { return; }
        if (!raw) return;
        const orders = JSON.parse(raw);
        if (!orders[tableId] || !Array.isArray(orders[tableId])) return;

        // Animate card out
        const card = document.querySelector('[data-table="' + tableId + '"]');
        if (card) {
          card.classList.add('card-out');
        }

        setTimeout(function() {
          for (let i = 0; i < orders[tableId].length; i++) {
            if (orders[tableId][i].status === 'sent' && orders[tableId][i].dest === currentView) {
              orders[tableId][i].status = 'ready';
            }
          }
          localStorage.setItem('pos_orders', JSON.stringify(orders));
          delete perItemMode[tableId];
          previousDataHash = '';
          loadOrders();
        }, 400);
      }
    });
  };

  // Toggle per-item mode
  window.togglePerItem = function(tableId) {
    perItemMode[tableId] = !perItemMode[tableId];
    previousDataHash = '';
    loadOrders();
  };

  // Print order
  window.printOrder = function(tableId) {
    let raw;
    try { raw = localStorage.getItem('pos_orders'); } catch(e) { return; }
    if (!raw) return;
    const orders = JSON.parse(raw);
    if (!orders[tableId]) return;

    const items = orders[tableId].filter(function(it) {
      return it.status === 'sent' && it.dest === currentView;
    });
    if (items.length === 0) return;

    const tableName = tableId.replace(/^t/, 'Stol ').toUpperCase();
    const dest = currentView.toUpperCase();
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

    let content = '<!DOCTYPE html><html><head><style>' +
      'body{font-family:monospace;font-size:14px;width:72mm;margin:0 auto;padding:4mm}' +
      'h1{font-size:20px;text-align:center;margin:0 0 4px}' +
      'h2{font-size:16px;text-align:center;margin:0 0 8px;font-weight:normal}' +
      '.line{border-top:1px dashed #000;margin:6px 0}' +
      '.item{margin:4px 0}' +
      '.note{font-size:12px;font-style:italic;margin-left:24px;color:#666}' +
      '.time{text-align:center;font-size:12px;margin-top:8px}' +
      '</style></head><body>' +
      '<h1>' + dest + '</h1>' +
      '<h2>' + tableName + '</h2>' +
      '<div class="line"></div>';

    items.forEach(function(it) {
      content += '<div class="item"><b>' + (it.qty || 1) + 'x</b> ' + escHtml(it.name) + '</div>';
      if (it.note) {
        content += '<div class="note">' + escHtml(it.note) + '</div>';
      }
    });

    content += '<div class="line"></div>' +
      '<div class="time">' + timeStr + '</div>' +
      '</body></html>';

    const frame = document.getElementById('printFrame');
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(content);
    doc.close();
    setTimeout(function() {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 300);
  };

  // Polling (fallback, reduced frequency — WebSocket is primary)
  setInterval(loadOrders, 30000);
  window.addEventListener('storage', function(e) {
    if (e.key === 'pos_orders') {
      previousDataHash = '';
      loadOrders();
    }
  });

  // Initial load
  loadOrders();

  // Keyboard navigation for order cards
  document.addEventListener('keydown', function(e) {
    var grid = document.getElementById('grid');
    var cards = grid.querySelectorAll('.order-card');
    if (!cards.length) return;
    var focused = document.activeElement;
    var idx = Array.from(cards).indexOf(focused);

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      if (idx === -1) { cards[0].focus(); e.preventDefault(); }
      else if (idx < cards.length - 1) { cards[idx + 1].focus(); e.preventDefault(); }
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      if (idx > 0) { cards[idx - 1].focus(); e.preventDefault(); }
    }
    if (e.key === 'Enter' && idx >= 0) {
      var btn = cards[idx].querySelector('.btn-ready');
      if (btn) btn.click();
      e.preventDefault();
    }
  });

  // --- WebSocket layer for reliable event delivery ---
  var wsToken = (function() {
    // Read token from URL query param ?token=XXX or from sessionStorage
    var params = new URLSearchParams(window.location.search);
    var t = params.get('token');
    if (t) {
      sessionStorage.setItem('pos_token', t);
      return t;
    }
    return sessionStorage.getItem('pos_token') || '';
  })();

  var lastEventId = parseInt(localStorage.getItem('pos_kitchen_lastEventId')) || 0;

  function updateLastEventId(id) {
    if (id && id > lastEventId) {
      lastEventId = id;
      localStorage.setItem('pos_kitchen_lastEventId', String(id));
    }
  }

  function replayMissedEvents() {
    if (!wsToken) return;
    fetch('/api/events?since=' + lastEventId + '&limit=500', {
      headers: { 'Authorization': 'Bearer ' + wsToken }
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.events || !data.events.length) return;
      data.events.forEach(function(evt) {
        updateLastEventId(evt.id);
      });
      // Any order-related events mean we should refresh the display
      var hasOrderEvents = data.events.some(function(evt) {
        return evt.type && evt.type.indexOf('order:') === 0;
      });
      if (hasOrderEvents) {
        previousDataHash = '';
        loadOrders();
      }
    })
    .catch(function(e) {
      console.error('Event replay error:', e);
    });
  }

  if (wsToken && typeof io !== 'undefined') {
    var socket = io({
      auth: { token: wsToken },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', function() {
      console.log('KDS WebSocket connected');
      // Catch up on any events missed while disconnected
      replayMissedEvents();
    });

    socket.on('disconnect', function() {
      console.log('KDS WebSocket disconnected');
    });

    // Listen for order-related events
    var orderEvents = ['order:created', 'order:updated', 'order:closed', 'order:sent', 'order:split', 'order:cancelled', 'items:moved', 'payment:created', 'table:updated'];
    orderEvents.forEach(function(eventName) {
      socket.on(eventName, function(data) {
        if (data && data._eventId) {
          updateLastEventId(data._eventId);
        }
        previousDataHash = '';
        loadOrders();
      });
    });
  } else if (wsToken) {
    // Socket.io not loaded, rely on polling + periodic replay
    setInterval(replayMissedEvents, 10000);
  }

})();
