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
    var btns = { kuchyna: 'btnKuchyna', bar: 'btnBar', rozvoz: 'btnRozvoz' };
    Object.keys(btns).forEach(function (k) {
      var b = document.getElementById(btns[k]);
      if (!b) return;
      b.className = 'view-btn ' + (k === view ? 'active-' + k : 'inactive');
      b.setAttribute('aria-pressed', k === view ? 'true' : 'false');
    });
    previousDataHash = '';
    if (view === 'rozvoz') { renderOnline(); loadOnline(); }
    else loadOrders();
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

  // Load orders — ZO SERVERA.
  //
  // Táto obrazovka predtým čítala localStorage['pos_orders'], ktorý NIKTO
  // nezapisuje: POS ukladá do 'pos_tableOrders' a KDS aj tak beží na inom
  // zariadení, kde je localStorage z princípu iný. Kuchynská obrazovka tak
  // bola trvalo prázdna, hoci socket časť nižšie bola napojená správne a pri
  // každej udalosti poslušne volala loadOrders().
  //
  // POZN. k času: order_items nemá stĺpec `sent_at`, takže „ako dlho čaká"
  // počítame od vytvorenia ÚČTU (order.createdAt). Pri účte otvorenom dávno
  // a doobjednávke neskôr to nadhodnocuje. Presný čas si vyžaduje migráciu
  // (pridať order_items.sent_at a plniť ho v /send) — vedomý kompromis, nech
  // je obrazovka aspoň funkčná.
  function loadOrders() {
    if (!wsToken) return;
    if (currentView === 'rozvoz') return loadOnline(); // grid patrí online objednávkam
    fetch('/api/orders', { headers: { 'Authorization': 'Bearer ' + wsToken } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (orders) { if (orders) renderFromOrders(orders); })
      .catch(function (e) { console.error('KDS load orders failed:', e); });
  }

  // ── Lokálne potvrdenie „hotové" ────────────────────────────────────────
  // order_items nemá stav 'ready' (len boolean `sent`), takže vybavenie
  // položky sa nedá uložiť na server bez migrácie. Držíme ho teda lokálne na
  // TOMTO displeji — presne ako to robí väčšina KDS: kuchár si odškrtáva na
  // svojej obrazovke. Kľúč obsahuje id položky, takže prežije aj reload.
  const ACK_KEY = 'pos_kds_ack';
  const ACK_TTL_MS = 24 * 60 * 60 * 1000;

  function loadAcks() {
    try {
      const raw = JSON.parse(localStorage.getItem(ACK_KEY) || '{}');
      const cutoff = Date.now() - ACK_TTL_MS;
      let changed = false;
      for (const k in raw) if (raw[k] < cutoff) { delete raw[k]; changed = true; }
      if (changed) localStorage.setItem(ACK_KEY, JSON.stringify(raw));
      return raw;
    } catch (e) { return {}; }
  }
  function saveAcks(acks) {
    try { localStorage.setItem(ACK_KEY, JSON.stringify(acks)); } catch (e) {}
  }
  function ackItem(itemId) {
    const acks = loadAcks();
    acks[String(itemId)] = Date.now();
    saveAcks(acks);
  }

  // Posledná odpoveď zo servera — akcie (hotovo / tlač) pracujú nad ňou,
  // netreba kvôli nim znova volať API.
  let lastOrders = [];

  function renderFromOrders(orders) {
    lastOrders = orders || [];
    const acks = loadAcks();
    const filteredTables = {};

    lastOrders.forEach(function (order) {
      const sentItems = (order.items || [])
        .filter(function (it) {
          return it.sent && it.dest === currentView && !acks[String(it.id)];
        })
        .map(function (it) {
          return {
            id: it.id,
            name: it.name,
            qty: it.qty,
            note: it.note || '',
            dest: it.dest,
            status: 'sent',
            sentAt: order.createdAt,
          };
        });
      if (!sentItems.length) return;
      // Kľúč = účet, nie stôl: na jednom stole môžu byť dva účty a kuchyňa
      // ich potrebuje vidieť oddelene.
      const key = order.label || ('Ucet ' + order.id);
      filteredTables[key] = (filteredTables[key] || []).concat(sentItems);
    });

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

      // For JS-string-in-attribute (onclick="toggleItem('<tableId>', ...)") we
      // must escape backslash + single-quote so the JS parser stays intact,
      // then attribute-escape for the HTML parser layer.
      var jsTableId = escAttr(String(tableId).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
      var safeTableId = escAttr(tableId);
      html += '<div class="' + cardClass + '" data-table="' + safeTableId + '" tabindex="0" role="article" aria-label="' + escAttr(tableName) + ' - ' + escAttr(formatElapsed(elapsed)) + '">';
      if (elapsed >= 15) {
        html += '<div class="urgent-badge">URGENTNE</div>';
      }
      html += '<div class="card-header">';
      html += '<div class="card-table">' + escHtml(tableName) + '</div>';
      html += '<div class="' + elapsedClass + '">' + escHtml(formatElapsed(elapsed)) + '</div>';
      html += '</div>';
      html += '<div class="card-time">' + escHtml(formatTime(oldestSentAt)) + '</div>';
      html += '<div class="card-items">';

      items.forEach(function(item, idx) {
        const done = item._uiDone || false;
        html += '<button class="card-item' + (done ? ' done' : '') + '" onclick="toggleItem(\'' + jsTableId + '\',' + idx + ')" type="button">';
        html += '<span class="item-qty">' + (item.qty || 1) + 'x</span>';
        html += '<span class="item-info">';
        html += '<div class="item-name">' + (item.emoji ? escHtml(item.emoji) + ' ' : '') + escHtml(item.name) + '</div>';
        if (item.note) {
          html += '<div class="item-note">' + escHtml(item.note) + '</div>';
        }
        html += '</span>';
        html += '<span class="item-check">&#x2714;</span>';
        html += '</button>';
      });

      html += '</div>';
      html += '<div class="card-actions">';
      html += '<button class="btn-ready" onclick="markAllReady(\'' + jsTableId + '\')">&#x2713; Hotove</button>';
      html += '<button class="btn-per-item' + (isPerItem ? ' active' : '') + '" onclick="togglePerItem(\'' + jsTableId + '\')">Per polozku</button>';
      html += '<button class="btn-print" onclick="printOrder(\'' + jsTableId + '\')" aria-label="Tlacit objednavku">&#x1F5A8;</button>';
      html += '</div>';
      html += '</div>';
    });

    var focusedTable = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.table : null;
    grid.innerHTML = html;
    if (focusedTable) { var el = grid.querySelector('[data-table="' + focusedTable + '"]'); if (el) el.focus(); }
  }

  // escHtml is provided globally by /js/pos-escape.js (loaded in kitchen.html
  // before this file). Legacy local helper removed as part of PR-1.3 to dedupe.

  // Toggle individual item
  window.toggleItem = function(tableId, idx) {
    if (!perItemMode[tableId]) return;
    markItemReady(tableId, idx);
  };

  // Položky práve zobrazené na karte daného účtu (v poradí, v akom sa
  // vykresľujú) — index z UI tak sedí na konkrétnu položku.
  function visibleItemsFor(tableId) {
    const acks = loadAcks();
    for (const order of lastOrders) {
      const key = order.label || ('Ucet ' + order.id);
      if (key !== tableId) continue;
      return (order.items || []).filter(function (it) {
        return it.sent && it.dest === currentView && !acks[String(it.id)];
      });
    }
    return [];
  }

  // Mark single item ready — lokálne potvrdenie na tomto displeji.
  function markItemReady(tableId, itemIdx) {
    const items = visibleItemsFor(tableId);
    const target = items[itemIdx];
    if (!target) return;
    ackItem(target.id);
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
        const items = visibleItemsFor(tableId);
        if (!items.length) return;

        // Animate card out
        const card = document.querySelector('[data-table="' + tableId + '"]');
        if (card) {
          card.classList.add('card-out');
        }

        setTimeout(function() {
          items.forEach(function (it) { ackItem(it.id); });
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
    const items = visibleItemsFor(tableId);
    if (items.length === 0) return;

    // tableId je tu už názov účtu (label), nie 't<id>' ako v starej
    // localStorage schéme.
    const tableName = String(tableId).toUpperCase();
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
      '<h1>' + escHtml(dest) + '</h1>' +
      '<h2>' + escHtml(tableName) + '</h2>' +
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
  // Iný tab/okno tej istej obrazovky odškrtlo položku — premietni to.
  window.addEventListener('storage', function(e) {
    if (e.key === ACK_KEY) {
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

  // ── Online objednávky (rozvoz cez Wolt) ──────────────────────────────────
  // Kuchár ich tu POTVRDÍ (vznikne účet „Rozvoz SS-…", bon, kuriér) alebo
  // ODMIETNE s dôvodom; keď je jedlo hotové, klepne HOTOVÉ — zákazník to
  // vidí na webe, obsluha v admine. Zoznam ide z /api/online-orders (JWT
  // kuchára stačí), obnovuje ho socket + poll každých 20 s.
  var onlineRows = [];
  var onlineKnownIds = null; // null = prvé načítanie, ešte nepípame
  var ooToastTimer = null;
  var ooFmtWhen = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  var ooFmtTime = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' });

  function ooApi(path, opts) {
    opts = opts || {};
    return fetch('/api/online-orders' + path, {
      method: opts.method || 'GET',
      headers: { 'Authorization': 'Bearer ' + wsToken, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Chyba ' + r.status));
        return j;
      });
    });
  }

  function ooToast(msg) {
    var t = document.getElementById('ooToast');
    if (!t) return;
    t.textContent = msg || 'Chyba';
    t.hidden = false;
    clearTimeout(ooToastTimer);
    ooToastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }

  function loadOnline() {
    if (!wsToken) return;
    ooApi('?status=active').then(function (data) {
      onlineRows = data.rows || [];
      var newCount = (data.counts && data.counts.new) || 0;
      var badge = document.getElementById('onlineBadge');
      if (badge) { badge.textContent = newCount; badge.hidden = newCount === 0; }
      // Nová objednávka → pípnutie a blik hlavičky aj keď je zapnutá kuchyňa/bar.
      var ids = new Set(onlineRows.filter(function (o) { return o.status === 'new'; }).map(function (o) { return o.id; }));
      if (onlineKnownIds) {
        var fresh = false;
        ids.forEach(function (id) { if (!onlineKnownIds.has(id)) fresh = true; });
        if (fresh) {
          playNotification('kuchyna', true);
          var h = document.getElementById('header');
          h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
        }
      }
      onlineKnownIds = ids;
      if (currentView === 'rozvoz') renderOnline();
    }).catch(function (e) { console.error('KDS online orders failed:', e); });
  }

  function ooRel(iso) {
    var m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (m <= 0) return 'teraz';
    if (m < 60) return 'o ' + m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return 'o ' + h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  function ooEur(n) { return Number(n || 0).toFixed(2).replace('.', ',') + ' €'; }

  function ooUrgency(o) {
    if (o.readyAt) return '';
    if (o.status === 'new') { var m = getElapsed(o.createdAt); return m >= 8 ? 'urgent' : m >= 3 ? 'warn' : ''; }
    if (o.scheduledFor) { var left = (new Date(o.scheduledFor).getTime() - Date.now()) / 60000; return left <= 20 ? 'urgent' : left <= 45 ? 'warn' : ''; }
    var e = getElapsed(o.confirmedAt || o.createdAt);
    return e >= 25 ? 'urgent' : e >= 15 ? 'warn' : '';
  }
  function ooSortKey(o) {
    if (o.status === 'new') return [0, new Date(o.createdAt).getTime()];
    if (o.readyAt) return [2, new Date(o.readyAt).getTime()];
    return [1, new Date(o.scheduledFor || o.confirmedAt || o.createdAt).getTime()];
  }
  function ooIsWolt(o) { return o.source === 'wolt'; }
  function ooInHouse(o) { return ooIsWolt(o) && (o.deliveryType === 'takeaway' || o.deliveryType === 'eatin'); }
  function ooStatus(o) {
    if (o.status === 'new') return { cls: 'oo-new', text: ooIsWolt(o) ? 'Nová z Woltu · čaká na prijatie' : 'Nová · čaká na potvrdenie' };
    if (o.readyAt) return { cls: 'oo-ready', text: ooInHouse(o) ? 'Hotové · čaká na zákazníka' : (ooIsWolt(o) ? 'Hotové · čaká na kuriéra Wolt' : 'Hotové · čaká na kuriéra') };
    if (ooIsWolt(o)) return { cls: 'oo-run', text: 'Prijaté vo Wolte · varí sa' };
    if (o.woltStatus === 'error') return { cls: 'oo-err', text: 'Varí sa · kuriér sa nepodarilo objednať' };
    if (o.status === 'dispatched') return { cls: 'oo-run', text: 'Varí sa · kuriér objednaný' };
    return { cls: 'oo-run', text: 'Varí sa' };
  }

  function renderOnline() {
    var grid = document.getElementById('grid');
    var rows = onlineRows.slice().sort(function (a, b) {
      var ka = ooSortKey(a), kb = ooSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    document.getElementById('orderCount').textContent = rows.length;
    if (!rows.length) {
      grid.innerHTML = '<div class="empty-state">' +
        '<div class="empty-icon">&#x1F6F5;</div>' +
        '<div class="empty-text">Žiadne online objednávky</div>' +
        '<div class="empty-sub">Rozvoz – čakám na objednávky z webu</div>' +
        '</div>';
      return;
    }
    var html = '';
    rows.forEach(function (o) {
      var st = ooStatus(o);
      var urg = ooUrgency(o);
      var cls = 'order-card oo-card ' + st.cls + (urg === 'urgent' ? ' time-urgent' : urg === 'warn' ? ' time-warn' : '');
      var elapsed = o.status === 'new' ? formatElapsed(getElapsed(o.createdAt)) : 'potvrdené ' + ooFmtTime.format(new Date(o.confirmedAt || o.createdAt));
      var when = o.scheduledFor
        ? '<div class="oo-when is-sched">Doručiť <b>' + escHtml(ooFmtWhen.format(new Date(o.scheduledFor))) + '</b> (' + escHtml(ooRel(o.scheduledFor)) + ')</div>'
        : ooInHouse(o)
          ? '<div class="oo-when">' + (o.deliveryType === 'eatin' ? 'Zje v podniku' : 'Zákazník si vyzdvihne') + ' · prijaté ' + escHtml(ooFmtTime.format(new Date(o.createdAt))) + '</div>'
          : (ooIsWolt(o) && o.woltPickupEta)
            ? '<div class="oo-when is-sched">Kuriér Wolt príde <b>' + escHtml(ooFmtTime.format(new Date(o.woltPickupEta))) + '</b> (' + escHtml(ooRel(o.woltPickupEta)) + ')</div>'
            : '<div class="oo-when">Čo najskôr · prijaté ' + escHtml(ooFmtTime.format(new Date(o.createdAt))) + '</div>';
      var items = (o.items || []).map(function (it) {
        return '<div class="card-item" role="listitem"><span class="item-qty">' + (it.qty || 1) + 'x</span><span class="item-info">' +
          '<div class="item-name">' + escHtml(it.name) + '</div>' + (it.note ? '<div class="item-note">' + escHtml(it.note) + '</div>' : '') + '</span></div>';
      }).join('');
      var pay = o.paymentMethod === 'cash' ? 'Hotovosť kuriérovi' : o.paymentMethod === 'wolt' ? 'Zaplatené cez Wolt' : 'Platba vopred';
      var actions;
      if (o.status === 'new') {
        actions = '<button class="btn-ready" type="button" onclick="confirmOnline(' + o.id + ')">&#x2713; ' + (ooIsWolt(o) ? 'Prijať' : 'Potvrdiť') + '</button>' +
                  '<button class="btn-reject" type="button" onclick="rejectOnline(' + o.id + ')">Odmietnuť</button>';
      } else if (!o.readyAt) {
        actions = '<button class="btn-ready" type="button" onclick="readyOnline(' + o.id + ')">&#x2713; Hotové</button>';
      } else if (ooInHouse(o)) {
        actions = '<button class="btn-ready" type="button" onclick="handoverOnline(' + o.id + ')">&#x2713; Odovzdané zákazníkovi</button>';
      } else {
        actions = '<div class="oo-wait">' + (ooIsWolt(o) ? 'Odovzdať kuriérovi Wolt' : 'Odovzdať kuriérovi') + ' · hotové ' + escHtml(ooFmtTime.format(new Date(o.readyAt))) + '</div>';
      }
      html += '<div class="' + cls + '" data-table="oo-' + o.id + '" tabindex="0" role="article" aria-label="' + escAttr(o.publicCode + ' – ' + st.text) + '">' +
        (urg === 'urgent' ? '<div class="urgent-badge">' + (o.status === 'new' ? 'ČAKÁ' : 'SÚRI') + '</div>' : '') +
        '<div class="card-header"><div class="card-table">' + escHtml(o.publicCode) + (ooIsWolt(o) ? ' <span class="oo-src">Wolt</span>' : '') + '</div><div class="card-elapsed' + (urg ? ' ' + urg : '') + '">' + escHtml(elapsed) + '</div></div>' +
        '<div class="oo-status ' + st.cls + '">' + escHtml(st.text) + '</div>' + when +
        '<div class="card-items" role="list">' + items + '</div>' +
        (o.note ? '<div class="oo-note">' + escHtml(o.note) + '</div>' : '') +
        '<div class="oo-meta"><b>' + escHtml(o.customerName) + '</b> · ' + escHtml(o.customerPhone) + '<br>' +
          escHtml(o.dropoffStreet) + ', ' + escHtml(o.dropoffCity) + (o.dropoffComment ? ' · ' + escHtml(o.dropoffComment) : '') + '<br>' +
          escHtml(pay) + ' · <b>' + escHtml(ooEur(o.total)) + '</b></div>' +
        '<div class="card-actions">' + actions + '</div></div>';
    });
    var focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.table : null;
    grid.innerHTML = html;
    if (focused) { var el = grid.querySelector('[data-table="' + focused + '"]'); if (el) el.focus(); }
  }

  function ooFind(id) {
    for (var i = 0; i < onlineRows.length; i++) if (onlineRows[i].id === id) return onlineRows[i];
    return null;
  }
  function ooAfter(id) {
    var card = document.querySelector('[data-table="oo-' + id + '"]');
    if (card) card.classList.add('card-out');
    setTimeout(loadOnline, 350);
  }

  window.confirmOnline = function (id) {
    var o = ooFind(id);
    if (!o) return;
    showConfirm({
      title: (ooIsWolt(o) ? 'Prijať objednávku z Woltu ' : 'Potvrdiť objednávku ') + o.publicCode,
      message: ooIsWolt(o)
        ? 'Objednávka sa prijme vo Wolte a do kuchyne pôjde bon. ' + (ooInHouse(o) ? 'Zákazník si ju príde vyzdvihnúť.' : 'Kuriéra pošle Wolt.')
        : 'Vytvorí sa účet Rozvoz, vytlačí bon a objedná kuriér' + (o.scheduledFor ? ' na ' + ooFmtWhen.format(new Date(o.scheduledFor)) : '') + '.',
      confirmText: ooIsWolt(o) ? 'Áno, prijať' : 'Áno, potvrdiť',
      danger: false,
      onConfirm: function () {
        ooApi('/' + id + '/confirm', { method: 'POST', body: {} })
          .then(function () { ooAfter(id); })
          .catch(function (e) { ooToast(e.message); loadOnline(); });
      }
    });
  };
  window.handoverOnline = function (id) {
    ooApi('/' + id + '/handed-over', { method: 'POST', body: {} })
      .then(function () { ooAfter(id); })
      .catch(function (e) { ooToast(e.message); loadOnline(); });
  };
  window.readyOnline = function (id) {
    ooApi('/' + id + '/ready', { method: 'POST', body: {} })
      .then(function () { ooAfter(id); })
      .catch(function (e) { ooToast(e.message); loadOnline(); });
  };

  // Odmietnutie — dôvod z predvolieb alebo vlastný.
  var ooRejectId = null;
  function ooRejectClose() { document.getElementById('ooReject').hidden = true; ooRejectId = null; }
  window.rejectOnline = function (id) {
    var o = ooFind(id);
    if (!o) return;
    ooRejectId = id;
    document.getElementById('ooRejectCode').textContent = o.publicCode;
    document.getElementById('ooRejectText').value = '';
    document.querySelectorAll('.kds-reason').forEach(function (b) { b.classList.remove('active'); });
    document.getElementById('ooReject').hidden = false;
    document.querySelector('.kds-reason').focus();
  };
  document.querySelectorAll('.kds-reason').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.kds-reason').forEach(function (x) { x.classList.toggle('active', x === b); });
      document.getElementById('ooRejectText').value = b.getAttribute('data-reason');
    });
  });
  document.getElementById('ooRejectCancel').addEventListener('click', ooRejectClose);
  document.getElementById('ooReject').addEventListener('click', function (e) { if (e.target === e.currentTarget) ooRejectClose(); });
  document.getElementById('ooRejectOk').addEventListener('click', function () {
    var id = ooRejectId;
    if (!id) return;
    var btn = this;
    btn.disabled = true;
    ooApi('/' + id + '/reject', { method: 'POST', body: { reason: document.getElementById('ooRejectText').value.trim() } })
      .then(function () { ooRejectClose(); ooAfter(id); })
      .catch(function (e) { ooToast(e.message); })
      .then(function () { btn.disabled = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.getElementById('ooReject').hidden) ooRejectClose();
  });

  setInterval(loadOnline, 20000);
  // wsToken je až tu priradený — prvé načítanie oboch zoznamov ide odtiaľto
  // (volanie loadOrders() vyššie prebehlo ešte s prázdnym tokenom).
  loadOrders();
  loadOnline();

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
      if (data.events.some(function (evt) { return evt.type && evt.type.indexOf('online-order:') === 0; })) loadOnline();
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
    ['online-order:new', 'online-order:updated'].forEach(function (eventName) {
      socket.on(eventName, function (data) {
        if (data && data._eventId) updateLastEventId(data._eventId);
        loadOnline();
      });
    });
  } else if (wsToken) {
    // Socket.io not loaded, rely on polling + periodic replay
    setInterval(replayMissedEvents, 10000);
  }

})();
