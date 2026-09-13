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
    if (!soundEnabled && typeof ooAlarm !== 'undefined') ooAlarm.unlock();
    soundEnabled = !soundEnabled;
    if (!soundEnabled && typeof ooAlarm !== 'undefined') ooAlarm.stop();
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

    // Rozvoz (online objednávky) najprv — majú termín kuriéra; potom najstaršie bony.
    const onlineMap = ooByLabel();
    const sorted = Object.entries(filteredTables).sort(function(a, b) {
      const ao = onlineMap[a[0]] ? 0 : 1, bo = onlineMap[b[0]] ? 0 : 1;
      if (ao !== bo) return ao - bo;
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
      // Bon rozvozu = tá istá objednávka ako na ROZVOZ: pruh zdroja, odpočet do
      // kuriéra a jedno HOTOVÉ, ktoré odškrtne bon aj ohlási Woltu/zákazníkovi.
      const oo = onlineMap[tableId] || null;
      const due = oo ? ooDue(oo) : null;
      const stopped = /^ZRUŠENÉ/.test(tableId);
      // Hotové ohlásené inde (kasa, admin, druhý KDS) — bon je vybavený, z mriežky ide preč.
      if (oo && oo.readyAt && !ooPending[oo.id]) { items.forEach(function (it) { ackItem(it.id); }); return; }
      if (oo) {
        cardClass = 'order-card oo-card ' + (ooIsWolt(oo) ? 'oo-src-wolt' : 'oo-src-web') + (due.cls === 'late' ? ' time-urgent' : due.cls === 'warn' ? ' time-warn' : '');
        elapsedClass = 'card-elapsed oo-due ' + due.cls;
      }

      // For JS-string-in-attribute (onclick="toggleItem('<tableId>', ...)") we
      // must escape backslash + single-quote so the JS parser stays intact,
      // then attribute-escape for the HTML parser layer.
      var jsTableId = escAttr(String(tableId).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
      var safeTableId = escAttr(tableId);
      if (stopped) cardClass += ' oo-stop';
      html += '<div class="' + cardClass + '" data-table="' + safeTableId + '" tabindex="0" role="article" aria-label="' + escAttr(tableName) + ' - ' + escAttr(oo ? due.text : formatElapsed(elapsed)) + '">';
      if (stopped) html += '<div class="oo-strip is-stop">STOP — ZRUŠENÉ WOLTOM · NEVARIŤ</div>';
      else if (oo) html += '<div class="oo-strip">' + (ooIsWolt(oo) ? 'WOLT' : 'WEB') + (ooInHouse(oo) ? ' · VYZDVIHNUTIE' : '') + '</div>';
      else if (elapsed >= 15) html += '<div class="urgent-badge">URGENTNE</div>';
      if (oo && (oo.bonStatus === 'queued' || oo.bonStatus === 'failed')) html += '<div class="oo-bon"><span>Bon nevytlačený</span><button type="button" class="btn-reprint" onclick="reprintOnline(' + oo.id + ')">Vytlačiť znova</button></div>';
      html += '<div class="card-header">';
      html += '<div class="card-table">' + escHtml(oo ? oo.publicCode : tableName) + '</div>';
      if (oo) html += '<div class="' + elapsedClass + '" data-oo-due="' + oo.id + '">' + escHtml(due.text) + '</div>';
      else html += '<div class="' + elapsedClass + '">' + escHtml(formatElapsed(elapsed)) + '</div>';
      html += '</div>';
      html += '<div class="card-time">' + escHtml(formatTime(oldestSentAt)) + (oo && oo.note ? ' · ' + escHtml(oo.note) : '') + '</div>';
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
      if (oo && ooPending[oo.id]) html += undoButtonHtml(oo.id);
      else if (oo && oo.readyAt) html += '<div class="oo-wait">' + (ooInHouse(oo) ? 'Čaká na zákazníka' : 'Čaká na kuriéra') + ' · hotové ' + escHtml(ooFmtTime.format(new Date(oo.readyAt))) + '</div>';
      else if (oo) html += '<button class="btn-ready" onclick="startReady(' + oo.id + ', \'' + jsTableId + '\')">&#x2713; HOTOVÉ</button>';
      else html += '<button class="btn-ready" onclick="markAllReady(\'' + jsTableId + '\')">&#x2713; Hotové</button>';
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
  var onlineDone = [];        // dnes hotové / odmietnuté — história pod kartami v ROZVOZ
  var ooHistOpen = localStorage.getItem('pos_kitchen_histOpen') === '1';
  var ooCfgTick = 0;
  var onlineKnownIds = null; // null = prvé načítanie, ešte nepípame
  var ooToastTimer = null;
  // Prijatie s výberom minút, odloženie („Neskôr") a 6-sekundové okno na SPÄŤ.
  var PREP_CHOICES = [10, 15, 20, 30];
  var DEFAULT_PREP = 15;
  var SNOOZE_MS = 30000;
  var UNDO_MS = 6000;
  var ooSnooze = {};   // id → do kedy je odložená (ms)
  var ooPending = {};  // id → { timer, until, tableKey } — „Hotové" čaká na SPÄŤ
  var ooBusy = {};     // id → true kým beží požiadavka (proti dvojklikom)
  var ooSnoozeTimer = null;
  var ooClaimedAt = {}; // id → kedy sme naposledy poslali „rieši KDS" (len pri dotyku človeka)
  var ooMe = (function () { try { return JSON.parse(atob(wsToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) || {}; } catch (e) { return {}; } })();
  function ooIsWolt(o) { return o.source === 'wolt'; }
  function ooInHouse(o) { return ooIsWolt(o) && (o.deliveryType === 'takeaway' || o.deliveryType === 'eatin'); }
  var ooFmtWhen = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  var ooFmtTime = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' });

  function ooApi(path, opts) {
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + wsToken, 'Content-Type': 'application/json', 'X-Client': 'kds' };
    // Stabilný kľúč na akciu: opakované klepnutie / retry nespustí akciu druhýkrát.
    if (opts.key) headers['X-Idempotency-Key'] = opts.key;
    return fetch('/api/online-orders' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { ooToast('Prihlásenie KDS vypršalo — otvorte kuchynskú obrazovku znova z kasy'); throw new Error('Prihlásenie vypršalo'); }
        if (!r.ok) throw new Error(j.error || ('Chyba ' + r.status));
        return j;
      });
    });
  }

  function ooToast(msg, ok) {
    var t = document.getElementById('ooToast');
    if (!t) return;
    t.textContent = msg || 'Chyba';
    t.classList.toggle('is-ok', !!ok);
    t.hidden = false;
    clearTimeout(ooToastTimer);
    ooToastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }

  /** PAUZA v hlavičke: z /config pri štarte a raz za minútu, hneď zo socketu. */
  function ooSetPause(p) {
    var b = document.getElementById('ooPauseBadge'), u = document.getElementById('ooPauseUntil');
    if (!b || !u) return;
    var until = p && p.until ? new Date(p.until) : null;
    if (!until || until.getTime() <= Date.now()) { b.hidden = true; return; }
    u.textContent = ooFmtTime.format(until) + (p.reason ? ' · ' + p.reason : '');
    b.hidden = false;
  }
  function loadPause() { ooApi('/config').then(function (c) { ooSetPause(c.pause); }).catch(function () {}); }
  function loadOnline() {
    if (!wsToken) return;
    if (ooCfgTick++ % 3 === 0) loadPause();
    if (currentView === 'rozvoz') {
      ooApi('?status=done&limit=40').then(function (d) { onlineDone = d.rows || []; if (currentView === 'rozvoz') renderOnline(); }).catch(function () {});
    }
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
          var h = document.getElementById('header');
          h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
        }
      }
      onlineKnownIds = ids;
      if (currentView === 'rozvoz') renderOnline();
      else { previousDataHash = ''; renderFromOrders(lastOrders); } // karty rozvozu v KUCHYNA/BAR
      renderTakeover();
    }).catch(function (e) { console.error('KDS online orders failed:', e); });
  }

  // ── Odpočet do termínu (kuriér / sľúbené hotové / naplánované) ─────────
  function ooDeadline(o) {
    if (o.status === 'new') return null;
    return o.promisedReadyAt || o.woltPickupEta || o.scheduledFor || null;
  }
  function ooDue(o) {
    if (o.status === 'new') {
      var w = Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000);
      return { text: 'čaká ' + w + ' min', cls: w >= 3 ? 'late' : w >= 1 ? 'warn' : 'ok' };
    }
    if (o.readyAt) return { text: ooInHouse(o) ? 'čaká na zákazníka' : 'čaká na kuriéra', cls: 'done' };
    var d = ooDeadline(o);
    if (!d) return { text: 'varí sa', cls: 'ok' };
    var m = Math.round((new Date(d).getTime() - Date.now()) / 60000);
    if (m < 0) return { text: 'MEŠKÁ ' + (-m) + ' min', cls: 'late' };
    if (m <= 3) return { text: 'SÚRI · ' + m + ' min', cls: 'late' };
    if (m <= 8) return { text: 'o ' + m + ' min', cls: 'warn' };
    return { text: 'o ' + m + ' min', cls: 'ok' };
  }
  function ooLabelKey(o) { return (o.source === 'wolt' ? 'Wolt ' : 'Rozvoz ') + o.publicCode; }
  /** „Rieši Peter (kasa)" — keď to pred chvíľou otvoril niekto iný. */
  function ooClaimText(o) {
    if (!o.claimedAt || !o.claimedBy || o.claimedBy === ooMe.id) return '';
    if (Date.now() - new Date(o.claimedAt).getTime() > 30000) return '';
    return 'Rieši ' + (o.claimedName || 'kasa');
  }
  function ooByLabel() {
    var map = {};
    onlineRows.forEach(function (o) { map[ooLabelKey(o)] = o; });
    return map;
  }

  // ── Takeover: nová objednávka cez celú obrazovku ───────────────────────
  function ooFresh() {
    var now = Date.now();
    return onlineRows.filter(function (o) { return o.status === 'new' && !(ooSnooze[o.id] > now); })
      .sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  }
  function renderTakeover() {
    var t = document.getElementById('ooTakeover');
    if (!t) return;
    var fresh = ooFresh();
    var sheetOpen = !document.getElementById('ooReject').hidden;
    if (!fresh.length || sheetOpen) {
      t.hidden = true;
      if (!fresh.length) ooAlarm.stop();
      scheduleSnoozeWake();
      return;
    }
    var o = fresh[0], more = fresh.length - 1, due = ooDue(o);
    var isW = ooIsWolt(o);
    var items = (o.items || []).map(function (it) {
      return '<div class="oo-tk-item"><span class="q">' + (it.qty || 1) + '×</span><span>' + escHtml(it.name) +
        (it.note ? '<em>' + escHtml(it.note) + '</em>' : '') + '</span></div>';
    }).join('');
    var when = o.scheduledFor ? 'Doručiť ' + ooFmtWhen.format(new Date(o.scheduledFor)) + ' (' + ooRel(o.scheduledFor) + ')'
      : ooInHouse(o) ? (o.deliveryType === 'eatin' ? 'Zje v podniku' : 'Zákazník si vyzdvihne')
      : (isW && o.woltPickupEta) ? 'Kuriér Wolt príde ' + ooFmtTime.format(new Date(o.woltPickupEta)) + ' (' + ooRel(o.woltPickupEta) + ')'
      : 'Čo najskôr';
    var pay = o.paymentMethod === 'cash' ? 'HOTOVOSŤ ' + ooEur(o.total) + ' — vyberie kuriér' : (o.paymentMethod === 'wolt' ? 'zaplatené cez Wolt' : 'zaplatené vopred') + ' · ' + ooEur(o.total);
    var chips = PREP_CHOICES.map(function (m) {
      return '<button type="button" class="oo-tk-chip' + (m === DEFAULT_PREP ? ' is-on' : '') + '" data-act="accept" data-id="' + o.id + '" data-prep="' + m + '">' + m + ' min</button>';
    }).join('');
    t.innerHTML =
      '<div class="oo-tk ' + (isW ? 'is-wolt' : 'is-web') + '">' +
        '<div class="oo-tk-src"><span>' + (isW ? 'NOVÁ OBJEDNÁVKA · APLIKÁCIA WOLT' : 'NOVÁ OBJEDNÁVKA · WEB SURFSPIRIT.SK') + '</span><span class="oo-tk-code">' + escHtml(o.publicCode) + '</span></div>' +
        '<div class="oo-tk-head"><div class="oo-tk-title" id="ooTakeoverTitle">' + escHtml(o.customerName) + '</div><div class="oo-tk-due ' + due.cls + '" data-tk-due="' + o.id + '">' + escHtml(due.text) + '</div></div>' +
        (ooClaimText(o) ? '<div class="oo-tk-claim">' + escHtml(ooClaimText(o)) + '</div>' : '') +
        (o.escalationLevel >= 1 ? '<div class="oo-tk-esc">' + (o.escalationLevel >= 2 ? 'Čaká vyše 2 minúty — manažér dostal správu' : 'Čaká vyše minútu — kasa to vidí tiež') + '</div>' : '') +
        '<div class="oo-tk-when">' + escHtml(when) + ' · ' + escHtml(pay) + (more ? ' · <b>+' + more + ' ' + (more === 1 ? 'ďalšia' : more < 5 ? 'ďalšie' : 'ďalších') + '</b>' : '') + '</div>' +
        '<div class="oo-tk-items">' + items + '</div>' +
        (o.note ? '<div class="oo-tk-note">' + escHtml(o.note) + '</div>' : '') +
        '<div class="oo-tk-meta">' + escHtml(o.customerPhone || '') + (o.dropoffStreet ? ' · ' + escHtml(o.dropoffStreet) + (o.dropoffCity ? ', ' + escHtml(o.dropoffCity) : '') : '') + (o.dropoffComment ? ' · ' + escHtml(o.dropoffComment) : '') + '</div>' +
        '<div class="oo-tk-actions">' +
          '<div class="oo-tk-accept"><button type="button" class="oo-tk-go" data-act="accept" data-id="' + o.id + '" data-prep="' + DEFAULT_PREP + '"' + (ooBusy[o.id] ? ' disabled' : '') + '>&#x2713; ' + (isW ? 'PRIJAŤ' : 'POTVRDIŤ') + '</button><div class="oo-tk-chips">' + chips + '</div></div>' +
          '<button type="button" class="oo-tk-ghost" data-act="snooze" data-id="' + o.id + '">Neskôr (30 s)</button>' +
          '<button type="button" class="oo-tk-ghost oo-tk-reject" data-act="reject" data-id="' + o.id + '">Odmietnuť…</button>' +
        '</div>' +
      '</div>';
    t.hidden = false;
    if (soundEnabled) ooAlarm.start(isW ? 'wolt' : 'web');

    var go = t.querySelector('.oo-tk-go');
    if (go && document.activeElement !== go && !t.contains(document.activeElement)) go.focus();
  }
  function scheduleSnoozeWake() {
    clearTimeout(ooSnoozeTimer);
    var now = Date.now(), next = Infinity;
    Object.keys(ooSnooze).forEach(function (id) { if (ooSnooze[id] > now && ooSnooze[id] < next) next = ooSnooze[id]; });
    if (next < Infinity) ooSnoozeTimer = setTimeout(renderTakeover, next - now + 50);
  }
  document.getElementById('ooTakeover').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    if (btn.dataset.act === 'accept') acceptOnline(id, Number(btn.getAttribute('data-prep')) || DEFAULT_PREP);
    else if (btn.dataset.act === 'snooze') { ooSnooze[id] = Date.now() + SNOOZE_MS; ooAlarm.stop(); renderTakeover(); }
    else if (btn.dataset.act === 'reject') { ooAlarm.stop(); ooClaim(id); rejectOnline(id); }
  });
  /** Človek sa objednávky dotkol (otvoril odmietnutie) — kasa uvidí „Rieši …". Takeover sám o sebe nie je claim:
   *  zobrazuje sa automaticky na každej obrazovke a dve obrazovky by si ho len prehadzovali. */
  function ooClaim(id) {
    if (ooClaimedAt[id] && Date.now() - ooClaimedAt[id] < 25000) return;
    ooClaimedAt[id] = Date.now();
    ooApi('/' + id + '/claim', { method: 'PATCH' }).catch(function () {});
  }

  /** Prijatie s minútami — jediná cesta, ako sa objednávka prijíma (bez modalu). */
  function acceptOnline(id, prep) {
    var o = ooFind(id);
    if (!o || ooBusy[id]) return;
    ooBusy[id] = true;
    ooAlarm.stop();
    renderTakeover();
    ooApi('/' + id + '/confirm', { method: 'POST', body: { prepMinutes: prep }, key: 'oo:' + id + ':confirm' })
      .then(function (r) {
        delete ooBusy[id];
        if (r && r.error) ooToast((ooIsWolt(o) ? 'Prijaté vo Wolte, ale ' : 'Potvrdené, ale ') + r.error);
        else ooToast((ooIsWolt(o) ? 'Prijaté vo Wolte' : 'Potvrdené') + ' · ' + prep + ' min', true);
        loadOnline();
      })
      .catch(function (e) { delete ooBusy[id]; ooToast(e.message); loadOnline(); });
  }
  window.acceptOnline = acceptOnline;

  // ── Hotové so 6-sekundovým SPÄŤ (Wolt aj zákazník sa to dozvedia až potom) ──
  function startReady(id, tableKey) {
    var o = ooFind(id);
    if (!o || ooPending[id] || ooBusy[id]) return;
    ooPending[id] = { until: Date.now() + UNDO_MS, tableKey: tableKey || null, timer: setTimeout(function () { fireReady(id); }, UNDO_MS) };
    repaintAll();
  }
  function undoReady(id) {
    var p = ooPending[id];
    if (!p) return;
    clearTimeout(p.timer);
    delete ooPending[id];
    repaintAll();
  }
  function fireReady(id) {
    var p = ooPending[id];
    delete ooPending[id];
    if (!p) return;
    var o = ooFind(id);
    // Lokálne odškrtnutie bonu v KUCHYNA/BAR + hlásenie serveru.
    if (p.tableKey) visibleItemsFor(p.tableKey).forEach(function (it) { ackItem(it.id); });
    if (o && !o.readyAt) {
      ooBusy[id] = true;
      ooApi('/' + id + '/ready', { method: 'POST', body: {}, key: 'oo:' + id + ':ready' })
        .then(function () { delete ooBusy[id]; loadOnline(); })
        .catch(function (e) { delete ooBusy[id]; ooToast(e.message); loadOnline(); });
    } else { previousDataHash = ''; loadOrders(); }
  }
  window.startReady = startReady;
  window.undoReady = undoReady;
  function repaintAll() {
    previousDataHash = '';
    if (currentView === 'rozvoz') renderOnline(); else renderFromOrders(lastOrders);
  }
  function undoButtonHtml(id) {
    var p = ooPending[id];
    var left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
    return '<button class="btn-undo" type="button" onclick="undoReady(' + id + ')" data-undo="' + id + '">Hotové · <b>SPÄŤ (' + left + ')</b></button>';
  }

  // Odpočty a okná SPÄŤ sa prekresľujú bez preskladania kariet (fokus ostáva).
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll('[data-oo-due]').forEach(function (el) {
      var o = ooFind(Number(el.getAttribute('data-oo-due')));
      if (!o) return;
      var d = ooDue(o);
      el.textContent = d.text;
      el.className = el.className.replace(/\b(ok|warn|late|done)\b/g, '').trim() + ' ' + d.cls;
      var card = el.closest('.order-card');
      if (card) { card.classList.toggle('time-urgent', d.cls === 'late'); card.classList.toggle('time-warn', d.cls === 'warn'); }
    });
    document.querySelectorAll('[data-tk-due]').forEach(function (el) {
      var o = ooFind(Number(el.getAttribute('data-tk-due')));
      if (o) { var d = ooDue(o); el.textContent = d.text; el.className = 'oo-tk-due ' + d.cls; }
    });
    document.querySelectorAll('[data-undo]').forEach(function (el) {
      var p = ooPending[Number(el.getAttribute('data-undo'))];
      if (p) el.querySelector('b').textContent = 'SPÄŤ (' + Math.max(0, Math.ceil((p.until - now) / 1000)) + ')';
    });
  }, 1000);

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
  /** Dnes hotové / odmietnuté / zrušené — kuchár si overí, čo už odbavil. */
  var ooFmtDay = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', day: 'numeric', month: 'numeric' });
  function ooHistoryHtml() {
    var today = ooFmtDay.format(new Date());
    var rows = onlineDone.filter(function (o) { return ooFmtDay.format(new Date(o.readyAt || o.updatedAt || o.createdAt)) === today; });
    if (!rows.length) return '';
    var body = ooHistOpen ? rows.map(function (o) {
      var st = o.status === 'rejected' ? 'odmietnuté' + (o.rejectedReason ? ' · ' + o.rejectedReason : '') : o.status === 'cancelled' ? 'zrušené' : ooInHouse(o) ? 'odovzdané' : 'doručené';
      var t = ooFmtTime.format(new Date(o.readyAt || o.updatedAt || o.createdAt));
      return '<div class="oo-hist-row' + (o.status === 'rejected' || o.status === 'cancelled' ? ' is-off' : '') + '"><span class="oo-hist-t">' + escHtml(t) + '</span><span class="oo-hist-code">' + escHtml(ooLabelKey(o)) + '</span><span class="oo-hist-name">' + escHtml(o.customerName || '') + ' · ' + (o.items || []).length + ' pol.</span><span class="oo-hist-st">' + escHtml(st) + '</span></div>';
    }).join('') : '';
    return '<div class="oo-history"><button type="button" class="oo-hist-head" onclick="ooToggleHistory()" aria-expanded="' + ooHistOpen + '">Dnes odbavené: ' + rows.length + ' <span aria-hidden="true">' + (ooHistOpen ? '▴' : '▾') + '</span></button>' + body + '</div>';
  }
  window.ooToggleHistory = function () { ooHistOpen = !ooHistOpen; try { localStorage.setItem('pos_kitchen_histOpen', ooHistOpen ? '1' : '0'); } catch (e) {} renderOnline(); };
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
      var due = ooDue(o);
      var cls = 'order-card oo-card ' + st.cls + (ooIsWolt(o) ? ' oo-src-wolt' : ' oo-src-web') + (due.cls === 'late' ? ' time-urgent' : due.cls === 'warn' ? ' time-warn' : '');
      var elapsed = due.text;
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
      } else if (ooPending[o.id]) {
        actions = undoButtonHtml(o.id);
      } else if (o.status === 'confirmed' && !o.firedAt && !o.posOrderId) {
        // prijaté v aplikácii Wolt (iPad) alebo predobjednávka pred časom — bon ešte nešiel
        actions = '<button class="btn-ready" type="button" onclick="fireOnline(' + o.id + ')">&#x2713; ' + (o.fireAt ? 'Začať variť teraz' : 'Vytvoriť účet a bon') + '</button>';
      } else if (!o.readyAt) {
        actions = '<button class="btn-ready" type="button" onclick="startReady(' + o.id + ')">&#x2713; Hotové</button>';
      } else if (ooInHouse(o)) {
        actions = '<button class="btn-ready" type="button" onclick="handoverOnline(' + o.id + ')">&#x2713; Odovzdané zákazníkovi</button>';
      } else {
        actions = '<div class="oo-wait">' + (ooIsWolt(o) ? 'Odovzdať kuriérovi Wolt' : 'Odovzdať kuriérovi') + ' · hotové ' + escHtml(ooFmtTime.format(new Date(o.readyAt))) + '</div>';
      }
      html += '<div class="' + cls + '" data-table="oo-' + o.id + '" tabindex="0" role="article" aria-label="' + escAttr(o.publicCode + ' – ' + st.text) + '">' +
        '<div class="oo-strip">' + (ooIsWolt(o) ? 'WOLT' : 'WEB') + '</div>' +
        '<div class="card-header"><div class="card-table">' + escHtml(o.publicCode) + '</div><div class="card-elapsed oo-due ' + due.cls + '" data-oo-due="' + o.id + '">' + escHtml(elapsed) + '</div></div>' +
        '<div class="oo-status ' + st.cls + '">' + escHtml(st.text) + '</div>' + when +
        (ooClaimText(o) ? '<div class="oo-claim">' + escHtml(ooClaimText(o)) + '</div>' : '') +
        (o.fireAt && !o.firedAt ? '<div class="oo-claim">Predobjednávka · bon pôjde ' + escHtml(ooFmtTime.format(new Date(o.fireAt))) + '</div>' : '') +
        ((o.bonStatus === 'queued' || o.bonStatus === 'failed') ? '<div class="oo-bon"><span>Bon nevytlačený' + (o.bonStatus === 'queued' ? ' — tlačiareň neodpovedá' : '') + '</span><button type="button" class="btn-reprint" onclick="reprintOnline(' + o.id + ')">Vytlačiť znova</button></div>' : '') +
        '<div class="card-items" role="list">' + items + '</div>' +
        (o.note ? '<div class="oo-note">' + escHtml(o.note) + '</div>' : '') +
        '<div class="oo-meta"><b>' + escHtml(o.customerName) + '</b> · ' + escHtml(o.customerPhone) + '<br>' +
          escHtml(o.dropoffStreet) + ', ' + escHtml(o.dropoffCity) + (o.dropoffComment ? ' · ' + escHtml(o.dropoffComment) : '') + '<br>' +
          escHtml(pay) + ' · <b>' + escHtml(ooEur(o.total)) + '</b></div>' +
        '<div class="card-actions">' + actions + '</div></div>';
    });
    var focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.table : null;
    html += ooHistoryHtml();
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
    if (o.status === 'new') { delete ooSnooze[id]; renderTakeover(); return; }
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
  window.fireOnline = function (id) {
    if (ooBusy[id]) return;
    ooBusy[id] = true;
    ooApi('/' + id + '/fire', { method: 'POST', body: {}, key: 'oo:' + id + ':fire' })
      .then(function (r) {
        delete ooBusy[id];
        if (r && r.error) ooToast(r.error); else ooToast('Účet založený, bon ide do kuchyne', true);
        loadOnline(); previousDataHash = ''; loadOrders();
      })
      .catch(function (e) { delete ooBusy[id]; ooToast(e.message); loadOnline(); });
  };
  window.reprintOnline = function (id) {
    ooApi('/' + id + '/reprint', { method: 'POST', body: {} })
      .then(function (r) { ooToast(r.bon === 'ok' ? 'Bon vytlačený (kópia)' : 'Bon je vo fronte — tlačiareň neodpovedá'); loadOnline(); })
      .catch(function (e) { ooToast(e.message); });
  };
  window.handoverOnline = function (id) {
    ooApi('/' + id + '/handed-over', { method: 'POST', body: {}, key: 'oo:' + id + ':handed-over' })
      .then(function () { ooAfter(id); })
      .catch(function (e) { ooToast(e.message); loadOnline(); });
  };
  window.readyOnline = function (id) { startReady(id); };

  // Odmietnutie — dôvod z predvolieb alebo vlastný.
  var ooRejectId = null;
  function ooRejectClose() { document.getElementById('ooReject').hidden = true; ooRejectId = null; renderTakeover(); }
  window.rejectOnline = function (id) {
    var o = ooFind(id);
    if (!o) return;
    ooRejectId = id;
    document.getElementById('ooRejectCode').textContent = o.publicCode;
    document.getElementById('ooRejectText').value = '';
    document.querySelectorAll('.kds-reason').forEach(function (b) { b.classList.remove('active'); });
    document.getElementById('ooReject').hidden = false;
    renderTakeover(); // sheet je nad takeoverom — takeover sa skryje, alarm stíchne
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
    ooApi('/' + id + '/reject', { method: 'POST', body: { reason: document.getElementById('ooRejectText').value.trim() }, key: 'oo:' + id + ':reject' })
      .then(function () { ooRejectClose(); ooAfter(id); })
      .catch(function (e) { ooToast(e.message); })
      .then(function () { btn.disabled = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.getElementById('ooReject').hidden) ooRejectClose();
  });

  setInterval(loadOnline, 20000);
  // Brána: kým prehliadač nepustí zvuk, prekryje obrazovku výzva na klepnutie.
  (function () {
    var gate = document.getElementById('ooAudioGate');
    if (!gate || typeof ooAlarm === 'undefined') return;
    var sync = function (ok) { gate.hidden = !!ok; };
    ooAlarm.onChange(sync);
    ooAlarm.unlock().then(sync);
    gate.addEventListener('click', function () { ooAlarm.unlock().then(sync); });
  })();
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
    ['online-order:new', 'online-order:updated', 'online-order:claimed'].forEach(function (eventName) {
      socket.on(eventName, function (data) {
        if (data && data._eventId) updateLastEventId(data._eventId);
        loadOnline();
      });
    });
    // Strážca: minútu nikto nereagoval → odložené sa vráti, KDS skočí na ROZVOZ, alarm nahlas.
    socket.on('online-order:alert', function (data) {
      if (data && data._eventId) updateLastEventId(data._eventId);
      if (data && data.id) delete ooSnooze[data.id];
      if (currentView !== 'rozvoz') setView('rozvoz');
      if (soundEnabled) ooAlarm.play(data && data.source === 'wolt' ? 'wolt' : 'web', true);
      loadOnline();
    });
    // Wolt zrušil už prijatú objednávku → STOP pre kuchyňu.
    socket.on('online-orders:pause', function (data) { ooSetPause(data && data.until ? data : null); });
    socket.on('online-order:stop', function (data) {
      if (data && data._eventId) updateLastEventId(data._eventId);
      ooToast('STOP — Wolt zrušil objednávku ' + ((data && data.code) || '') + '. Nevariť, účet ide na odpis.');
      if (soundEnabled) { ooAlarm.play('wolt', true); setTimeout(function () { ooAlarm.play('wolt', true); }, 700); }
      previousDataHash = '';
      loadOrders(); loadOnline();
    });
  } else if (wsToken) {
    // Socket.io not loaded, rely on polling + periodic replay
    setInterval(replayMissedEvents, 10000);
  }

})();
