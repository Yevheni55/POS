// Online objednávky (rozvoz z webu) priamo na kase.
//
// Pri novej objednávke sa hore cez celú obrazovku vysunie lišta so zvukom:
// obsluha ju odtiaľ otvorí, POTVRDÍ (vznikne účet „Rozvoz", bon do kuchyne,
// kuriér cez Wolt) alebo ODMIETNE s dôvodom, ktorý uvidí zákazník. Zvonček
// v hlavičke drží počet nových; zoznam a detail sú v modáli. Kým nová
// objednávka čaká, lišta sa každých 90 s pripomenie.
//
// Zdroj pravdy je server (/api/online-orders): socket udalosti
// online-order:new / :updated + poll každých 20 s ako poistka. Modul nič
// nepredpokladá o tom, či je obsluha prihlásená — bez tokenu je ticho.
(function () {
  'use strict';

  var POLL_MS = 20000;
  var REMIND_MS = 90000;

  var rows = [];              // aktívne objednávky (new / confirmed / dispatched)
  var seenNew = {};           // id → true: nová objednávka už spustila lištu
  var dismissed = {};         // id → čas: obsluha lištu zavrela (pripomenie sa)
  var modal = { mode: null, id: null, rejecting: false };
  var pollTimer = null, remindTimer = null, audioCtx = null, loading = false;

  var fmtWhen = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  var fmtTime = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' });
  var REASONS = ['Dnes už nevaríme', 'Niektorá položka je vypredaná', 'Adresa je mimo doručovacej zóny', 'Kuchyňa je preťažená, skúste neskôr'];

  // ── Pomocníci ──────────────────────────────────────────────────────────
  function esc(v) {
    if (typeof window.escHtml === 'function') return window.escHtml(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function eur(n) { return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function itemsWord(n) { return n === 1 ? 'položka' : (n >= 2 && n <= 4 ? 'položky' : 'položiek'); }
  function qtyOf(o) { return (o.items || []).reduce(function (s, i) { return s + (Number(i.qty) || 0); }, 0); }
  function rel(iso) {
    var m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (m <= 0) return 'teraz';
    if (m < 60) return 'o ' + m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return 'o ' + h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  function ago(iso) {
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? 'práve teraz' : m < 60 ? 'pred ' + m + ' min' : 'pred ' + Math.floor(m / 60) + ' h';
  }
  function whenText(o) { return o.scheduledFor ? 'doručiť ' + fmtWhen.format(new Date(o.scheduledFor)) + ' (' + rel(o.scheduledFor) + ')' : 'doručiť čo najskôr'; }
  function payText(o) { return o.paymentMethod === 'cash' ? 'hotovosť kuriérovi' : 'zaplatené vopred'; }
  function statusOf(o) {
    if (o.status === 'new') return { cls: 'is-new', text: 'Nová · čaká na potvrdenie' };
    if (o.readyAt) return { cls: 'is-ready', text: 'Hotové · čaká na kuriéra' };
    if (o.woltStatus === 'error') return { cls: 'is-err', text: 'Potvrdená · kuriéra sa nepodarilo objednať' };
    if (o.status === 'dispatched') return { cls: 'is-run', text: 'Varí sa · kuriér objednaný' };
    if (o.status === 'confirmed') return { cls: 'is-run', text: 'Potvrdená · varí sa' };
    return { cls: '', text: o.status };
  }
  function find(id) { for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]; return null; }
  function errMsg(e) { return (e && (e.message || (e.data && e.data.error))) || 'Chyba spojenia'; }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type || 'info'); }
  // `api` je v api.js deklarované cez const — je to globálna lexikálna väzba,
  // nie window.api, preto sa testuje cez typeof.
  function hasToken() { return typeof api !== 'undefined' && typeof api.getToken === 'function' && !!api.getToken(); }

  function beep(twice) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var play = function (t) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.25;
        o.start(t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3); o.stop(t + 0.3);
      };
      var now = audioCtx.currentTime;
      play(now);
      if (twice) play(now + 0.4);
    } catch (e) { /* bez zvuku sa dá žiť */ }
  }

  // ── DOM: lišta + overlay sa vytvoria raz ───────────────────────────────
  function ensureDom() {
    if (document.getElementById('ooBanner')) return;
    var b = document.createElement('div');
    b.id = 'ooBanner'; b.className = 'oo-banner'; b.hidden = true; b.setAttribute('role', 'alert');
    b.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      if (btn.dataset.act === 'open') openDetail(id);
      else if (btn.dataset.act === 'confirm') confirmOrder(id);
      else if (btn.dataset.act === 'reject') openDetail(id, true);
      else if (btn.dataset.act === 'dismiss') { dismissed[id] = Date.now(); renderBanner(); }
    });
    document.body.appendChild(b);

    var ov = document.createElement('div');
    ov.id = 'ooOverlay'; ov.className = 'u-overlay oo-overlay'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = '<div class="u-modal oo-modal" role="dialog" aria-modal="true" aria-labelledby="ooModalTitle"><div id="ooModalBody"></div></div>';
    ov.addEventListener('click', function (e) {
      if (e.target === ov) { closeModal(); return; }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      switch (btn.dataset.act) {
        case 'close': closeModal(); break;
        case 'list': openList(); break;
        case 'open': openDetail(id); break;
        case 'confirm': confirmOrder(id); break;
        case 'ready': readyOrder(id); break;
        case 'reject-start': modal.rejecting = true; renderModal(); break;
        case 'reject-cancel': modal.rejecting = false; renderModal(); break;
        case 'reason': ov.querySelector('#ooReason').value = btn.getAttribute('data-reason'); ov.querySelectorAll('[data-act="reason"]').forEach(function (x) { x.classList.toggle('is-on', x === btn); }); break;
        case 'reject': rejectOrder(id, ov.querySelector('#ooReason').value.trim()); break;
      }
    });
    document.body.appendChild(ov);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.classList.contains('show')) closeModal();
    });
  }

  // ── Lišta hore ─────────────────────────────────────────────────────────
  function renderBanner() {
    var b = document.getElementById('ooBanner');
    if (!b) return;
    var fresh = rows.filter(function (o) { return o.status === 'new' && !dismissed[o.id]; });
    if (!fresh.length) { b.hidden = true; document.body.classList.remove('has-oo-banner'); return; }
    var o = fresh[0], more = fresh.length - 1, n = qtyOf(o);
    b.innerHTML =
      '<div class="oo-banner-main">' +
        '<span class="oo-banner-kicker">Nová online objednávka</span>' +
        '<span class="oo-banner-text"><b>' + esc(o.publicCode) + '</b> · ' + esc(o.customerName) + ' · ' + n + ' ' + itemsWord(n) +
          ' · <b>' + esc(eur(o.total)) + '</b> · ' + esc(whenText(o)) +
          (more ? ' · <button type="button" class="oo-banner-more" data-act="list">+' + more + ' ' + (more === 1 ? 'ďalšia' : more < 5 ? 'ďalšie' : 'ďalších') + '</button>' : '') +
        '</span>' +
      '</div>' +
      '<div class="oo-banner-actions">' +
        '<button type="button" class="oo-btn oo-btn-light" data-act="open" data-id="' + o.id + '">Zobraziť</button>' +
        '<button type="button" class="oo-btn oo-btn-light" data-act="reject" data-id="' + o.id + '">Odmietnuť</button>' +
        '<button type="button" class="oo-btn oo-btn-solid" data-act="confirm" data-id="' + o.id + '">Potvrdiť</button>' +
        '<button type="button" class="oo-btn oo-btn-x" data-act="dismiss" data-id="' + o.id + '" aria-label="Skryť upozornenie, objednávka ostáva v zvončeku">&times;</button>' +
      '</div>';
    b.hidden = false;
    document.body.classList.add('has-oo-banner');
    positionBanner();
  }
  // Lišta sedí pod hlavičkou (desktop .header / mobil .mob-header), aby hodiny,
  // Admin či Odhlásiť ostali dostupné aj kým objednávka čaká.
  function positionBanner() {
    var b = document.getElementById('ooBanner');
    if (!b || b.hidden) return;
    var head = null;
    document.querySelectorAll('.header, .mob-header').forEach(function (h) { if (!head && h.offsetParent !== null) head = h; });
    var top = head ? Math.max(0, Math.round(head.getBoundingClientRect().bottom)) : 0;
    b.style.top = top + 'px';
  }
  window.addEventListener('resize', positionBanner);

  // ── Zvonček v hlavičke (desktop aj mobil) ─────────────────────────────
  function renderBell() {
    var fresh = rows.filter(function (o) { return o.status === 'new'; }).length;
    var running = rows.length - fresh;
    var label = fresh ? fresh + ' ' + (fresh === 1 ? 'nová online objednávka' : fresh < 5 ? 'nové online objednávky' : 'nových online objednávok')
                      : running + ' ' + (running === 1 ? 'online objednávka v príprave' : 'online objednávky v príprave');
    document.querySelectorAll('[data-oo-bell]').forEach(function (btn) {
      btn.hidden = !rows.length;
      btn.classList.toggle('is-new', fresh > 0);
      var c = btn.querySelector('.oo-bell-count');
      if (c) c.textContent = fresh || running;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    });
  }

  // ── Modál: zoznam + detail ─────────────────────────────────────────────
  function showOverlay() {
    var ov = document.getElementById('ooOverlay');
    ov.classList.add('show'); ov.setAttribute('aria-hidden', 'false');
    // Fokus na hlavnú akciu (Potvrdiť / Hotové / Zavrieť), v zozname na prvý riadok.
    var first = ov.querySelector('.oo-actions .u-btn-ice') || ov.querySelector('.oo-actions button, .oo-list button');
    if (first) first.focus();
  }
  function closeModal() {
    var ov = document.getElementById('ooOverlay');
    ov.classList.remove('show'); ov.setAttribute('aria-hidden', 'true');
    modal = { mode: null, id: null, rejecting: false };
  }
  function openList() { modal = { mode: 'list', id: null, rejecting: false }; renderModal(); showOverlay(); refresh(); }
  function openDetail(id, rejecting) {
    if (!find(id)) { toast('Objednávka už nie je aktívna', 'warning'); refresh(); return; }
    modal = { mode: 'detail', id: id, rejecting: !!rejecting };
    renderModal(); showOverlay();
  }
  function renderModal() {
    var body = document.getElementById('ooModalBody');
    if (!body || !modal.mode) return;
    if (modal.mode === 'list') { body.innerHTML = listHtml(); return; }
    var o = find(modal.id);
    if (!o) { body.innerHTML = '<div class="u-modal-title oo-title" id="ooModalTitle">Objednávka</div><p class="oo-sub">Už nie je aktívna (bola vybavená alebo zrušená).</p><div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="list">Zoznam</button><button type="button" class="u-btn u-btn-ice" data-act="close">Zavrieť</button></div>'; return; }
    body.innerHTML = detailHtml(o);
    if (modal.rejecting) { var inp = body.querySelector('#ooReason'); if (inp) inp.focus(); }
  }
  function pill(o) { var s = statusOf(o); return '<span class="oo-pill ' + s.cls + '">' + esc(s.text) + '</span>'; }
  function listHtml() {
    var sorted = rows.slice().sort(function (a, b) {
      var ka = a.status === 'new' ? 0 : a.readyAt ? 2 : 1, kb = b.status === 'new' ? 0 : b.readyAt ? 2 : 1;
      return ka - kb || new Date(a.createdAt) - new Date(b.createdAt);
    });
    var items = sorted.map(function (o) {
      var n = qtyOf(o);
      return '<button type="button" class="oo-row" data-act="open" data-id="' + o.id + '">' +
        '<span class="oo-row-main"><span class="oo-row-title"><b>' + esc(o.publicCode) + '</b> · ' + esc(o.customerName) + '</span>' +
        '<span class="oo-row-sub">' + n + ' ' + itemsWord(n) + ' · ' + esc(ago(o.createdAt)) + ' · ' + esc(whenText(o)) + '</span>' + pill(o) + '</span>' +
        '<span class="oo-row-side">' + esc(eur(o.total)) + '<small>' + esc(payText(o)) + '</small></span></button>';
    }).join('');
    return '<div class="u-modal-title oo-title" id="ooModalTitle">Online objednávky</div>' +
      '<div class="oo-list">' + (items || '<p class="oo-sub">Žiadne aktívne online objednávky.</p>') + '</div>' +
      '<div class="oo-actions"><button type="button" class="u-btn u-btn-ice" data-act="close">Zavrieť</button></div>';
  }
  function detailHtml(o) {
    var lines = (o.items || []).map(function (i) {
      return '<div class="oo-item"><span class="oo-item-q">' + (Number(i.qty) || 1) + '×</span><span class="oo-item-n">' + esc(i.name) +
        (i.note ? '<em>' + esc(i.note) + '</em>' : '') + '</span><span class="oo-item-p">' + esc(eur((Number(i.unitPrice) || 0) * (Number(i.qty) || 1))) + '</span></div>';
    }).join('');
    var actions;
    if (modal.rejecting) {
      actions = '<div class="oo-reject"><div class="oo-reject-title">Dôvod odmietnutia (uvidí ho zákazník)</div>' +
        '<div class="oo-reasons">' + REASONS.map(function (r) { return '<button type="button" class="oo-reason" data-act="reason" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
        '<input id="ooReason" class="oo-input" maxlength="300" placeholder="alebo vlastný dôvod…" autocomplete="off">' +
        '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="reject-cancel">Späť</button>' +
        '<button type="button" class="u-btn oo-btn-danger" data-act="reject" data-id="' + o.id + '">Odmietnuť objednávku</button></div></div>';
    } else if (o.status === 'new') {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn oo-btn-danger" data-act="reject-start">Odmietnuť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="confirm" data-id="' + o.id + '">Potvrdiť a objednať kuriéra</button></div>';
    } else if (!o.readyAt && (o.status === 'confirmed' || o.status === 'dispatched')) {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="ready" data-id="' + o.id + '">Hotové — čaká na kuriéra</button></div>';
    } else {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ice" data-act="close">Zavrieť</button></div>';
    }
    return '<div class="u-modal-title oo-title" id="ooModalTitle">' + esc(o.publicCode) + ' ' + pill(o) + '</div>' +
      '<p class="oo-sub">prijaté ' + esc(fmtTime.format(new Date(o.createdAt))) + ' (' + esc(ago(o.createdAt)) + ') · <b>' + esc(whenText(o)) + '</b></p>' +
      '<div class="oo-items">' + lines + '</div>' +
      '<div class="oo-tots"><div class="oo-tot"><span>Jedlo a nápoje</span><span>' + esc(eur(o.subtotal)) + '</span></div>' +
        '<div class="oo-tot"><span>Doručenie</span><span>' + esc(eur(o.deliveryFee)) + '</span></div>' +
        '<div class="oo-tot is-big"><span>Spolu</span><span>' + esc(eur(o.total)) + '</span></div></div>' +
      (o.note ? '<div class="oo-note">' + esc(o.note) + '</div>' : '') +
      '<div class="oo-kv"><span>Zákazník</span><span><b>' + esc(o.customerName) + '</b> · <a href="tel:' + esc(String(o.customerPhone || '').replace(/\s+/g, '')) + '">' + esc(o.customerPhone) + '</a></span></div>' +
      '<div class="oo-kv"><span>Adresa</span><span>' + esc(o.dropoffStreet) + ', ' + esc(o.dropoffPostCode) + ' ' + esc(o.dropoffCity) + (o.dropoffComment ? ' · ' + esc(o.dropoffComment) : '') + '</span></div>' +
      '<div class="oo-kv"><span>Platba</span><span>' + esc(payText(o)) + '</span></div>' +
      (o.woltTrackingUrl ? '<div class="oo-kv"><span>Kuriér</span><span><a href="' + esc(o.woltTrackingUrl) + '" target="_blank" rel="noopener">sledovať kuriéra</a></span></div>' : '') +
      actions;
  }

  // ── Akcie ──────────────────────────────────────────────────────────────
  function guardOnline() {
    if (typeof api !== 'undefined' && typeof api.isOnline === 'function' && !api.isOnline()) { toast('Bez spojenia so serverom — skúste o chvíľu', 'warning'); return false; }
    return true;
  }
  function confirmOrder(id) {
    var o = find(id);
    if (!o || !guardOnline()) return;
    var go = function () {
      api.post('/online-orders/' + id + '/confirm', {}).then(function () {
        toast('Objednávka ' + o.publicCode + ' potvrdená — bon a kuriér objednané', 'success');
        dismissed[id] = Date.now();
        if (modal.id === id) closeModal();
        refresh();
      }).catch(function (e) { toast(errMsg(e), 'error'); refresh(); });
    };
    ask('Potvrdiť objednávku ' + o.publicCode,
      'Vznikne účet Rozvoz, do kuchyne pôjde bon a objedná sa kuriér' + (o.scheduledFor ? ' na ' + fmtWhen.format(new Date(o.scheduledFor)) : '') + '.',
      'Áno, potvrdiť', go);
  }
  // Kasa má vlastný showConfirm(title, text, onConfirm, opts) v pos-ui.js, KDS
  // a admin používajú components/confirm.js so showConfirm({…}). Rozlíšime ich
  // podľa počtu parametrov.
  function ask(title, message, confirmText, onConfirm) {
    var sc = window.showConfirm;
    if (typeof sc !== 'function') return onConfirm();
    if (sc.length >= 3) sc(title, message, onConfirm, { type: 'info', confirmText: confirmText });
    else sc({ title: title, message: message, confirmText: confirmText, danger: false, onConfirm: onConfirm });
  }
  function rejectOrder(id, reason) {
    var o = find(id);
    if (!o || !guardOnline()) return;
    api.post('/online-orders/' + id + '/reject', { reason: reason || '' }).then(function () {
      toast('Objednávka ' + o.publicCode + ' odmietnutá', 'info');
      dismissed[id] = Date.now();
      closeModal();
      refresh();
    }).catch(function (e) { toast(errMsg(e), 'error'); refresh(); });
  }
  function readyOrder(id) {
    var o = find(id);
    if (!o || !guardOnline()) return;
    api.post('/online-orders/' + id + '/ready', {}).then(function () {
      toast('Objednávka ' + o.publicCode + ' označená ako hotová', 'success');
      closeModal();
      refresh();
    }).catch(function (e) { toast(errMsg(e), 'error'); refresh(); });
  }

  // ── Načítanie + pripomienka ────────────────────────────────────────────
  function refresh() {
    if (loading || !hasToken()) return Promise.resolve();
    loading = true;
    return api.get('/online-orders?status=active').then(function (res) {
      rows = (res && res.rows) || [];
      var fresh = rows.filter(function (o) { return o.status === 'new' && !seenNew[o.id]; });
      fresh.forEach(function (o) { seenNew[o.id] = true; delete dismissed[o.id]; });
      renderBell(); renderBanner();
      if (fresh.length) beep(true);
      if (modal.mode) renderModal();
      scheduleReminder();
    }).catch(function (e) {
      // Offline alebo bez práva — poll to skúsi znova; chybu v renderi chceme vidieť.
      if (e && !/network|fetch|offline|401|403/i.test(String(e.message || e))) console.warn('[online-orders] refresh zlyhal:', e);
    }).then(function () { loading = false; });
  }
  function scheduleReminder() {
    clearTimeout(remindTimer);
    var waiting = rows.some(function (o) { return o.status === 'new'; });
    if (!waiting) return;
    remindTimer = setTimeout(function () {
      // Obsluha lištu zavrela, ale objednávka stále čaká — ukážeme ju znova.
      rows.forEach(function (o) { if (o.status === 'new') delete dismissed[o.id]; });
      renderBanner();
      beep(false);
      refresh();
    }, REMIND_MS);
  }

  function bindSocket(socket) {
    if (!socket) return;
    socket.on('online-order:new', function () { refresh(); });
    socket.on('online-order:updated', function () { refresh(); });
    socket.on('connect', function () { refresh(); });
  }

  function start() {
    ensureDom();
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.posOnlineOrders = {
    refresh: refresh, openList: openList, openDetail: openDetail, bindSocket: bindSocket,
    _debug: function () { return { rows: rows.length, loading: loading, seen: Object.keys(seenNew), dismissed: Object.keys(dismissed), modal: modal }; },
  };
})();
