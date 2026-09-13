// Online objednávky (rozvoz z webu + aplikácia Wolt) priamo na kase.
//
// Nová objednávka: lišta pod hlavičkou so zvukom (js/oo-alarm.js) a — keď nie
// je otvorený iný modál (platba, fiškál) — celá obrazovka s výberom minút
// „10 · 15 · 20 · 30": klepnutie na minúty = prijatie, bez otázky „naozaj?".
// „Neskôr" odloží na 30 s. Odmietnuť a Hotové (Wolt) majú 6 s okno na SPÄŤ.
// Zvonček v hlavičke drží počet nových; zoznam a detail sú v modáli.
//
// Zdroj pravdy je server (/api/online-orders): socket online-order:new /
// :updated + poll každých 20 s. Každá akcia nesie stabilný idempotency kľúč
// a tlačidlo sa zamkne do odpovede — dve klepnutia nespravia dva účty.
(function () {
  'use strict';

  var POLL_MS = 20000;
  var SNOOZE_MS = 30000;
  var UNDO_MS = 6000;
  var PREP_CHOICES = [10, 15, 20, 30];
  var DEFAULT_PREP = 15;

  var rows = [];              // aktívne objednávky (new / confirmed / dispatched)
  var seenNew = {};           // id → true: nová objednávka už spustila alarm
  var snoozed = {};           // id → do kedy (ms) je odložená
  var pending = {};           // id → { action, timer, until, reason } — čaká na SPÄŤ
  var busy = {};              // id → true kým beží požiadavka
  var modal = { mode: null, id: null, rejecting: false, prep: false };
  var pollTimer = null, snoozeTimer = null, loading = false;
  var claimedAt = {};         // id → kedy sme naposledy poslali „rieši kasa"
  var escalated = {};         // id → úroveň zo strážcu (1 = kasa červená)
  function me() {
    try { var u = api.getUser && api.getUser(); if (u && u.id) return u; } catch (e) { /* bez používateľa */ }
    // Záloha: id z JWT (napr. keď je token bez uloženého používateľa).
    try { var t = sessionStorage.getItem('pos_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) || {}; } catch (e) { return {}; }
  }
  function claimText(o) {
    if (!o.claimedAt || !o.claimedBy || o.claimedBy === me().id) return '';
    if (Date.now() - new Date(o.claimedAt).getTime() > 30000) return '';
    return 'Rieši ' + (o.claimedName || 'kuchyňa');
  }
  function claim(id) {
    if (claimedAt[id] && Date.now() - claimedAt[id] < 25000) return;
    claimedAt[id] = Date.now();
    if (typeof api !== 'undefined' && api.patch) api.patch('/online-orders/' + id + '/claim', { client: 'kasa' }).catch(function () {});
  }

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
  function isWolt(o) { return o.source === 'wolt'; }
  function inHouse(o) { return isWolt(o) && (o.deliveryType === 'takeaway' || o.deliveryType === 'eatin'); }
  function whenText(o) {
    if (o.scheduledFor) return 'doručiť ' + fmtWhen.format(new Date(o.scheduledFor)) + ' (' + rel(o.scheduledFor) + ')';
    if (inHouse(o)) return o.deliveryType === 'eatin' ? 'zje v podniku' : 'zákazník si vyzdvihne';
    if (isWolt(o) && o.woltPickupEta) return 'kuriér Wolt príde ' + fmtTime.format(new Date(o.woltPickupEta)) + ' (' + rel(o.woltPickupEta) + ')';
    return 'doručiť čo najskôr';
  }
  function payText(o) { return o.paymentMethod === 'cash' ? 'hotovosť kuriérovi' : o.paymentMethod === 'wolt' ? 'zaplatené cez Wolt' : 'zaplatené vopred'; }
  function codeHtml(o) { return '<b>' + esc(o.publicCode) + '</b>' + (isWolt(o) ? ' <span class="oo-src">Wolt</span>' : ''); }
  function statusOf(o) {
    if (o.status === 'new') return { cls: 'is-new', text: isWolt(o) ? 'Nová z Woltu · čaká na prijatie' : 'Nová · čaká na potvrdenie' };
    if (o.readyAt) return { cls: 'is-ready', text: inHouse(o) ? 'Hotové · čaká na zákazníka' : (isWolt(o) ? 'Hotové · čaká na kuriéra Wolt' : 'Hotové · čaká na kuriéra') };
    if (isWolt(o) && o.status === 'confirmed') return { cls: 'is-run', text: 'Prijaté vo Wolte · varí sa' };
    if (o.woltStatus === 'error') return { cls: 'is-err', text: 'Potvrdená · kuriéra sa nepodarilo objednať' };
    if (o.status === 'dispatched') return { cls: 'is-run', text: 'Varí sa · kuriér objednaný' };
    if (o.status === 'confirmed') return { cls: 'is-run', text: 'Potvrdená · varí sa' };
    return { cls: '', text: o.status };
  }
  // Odpočet do termínu: sľúbené hotové / kuriér Wolt / naplánované doručenie.
  function due(o) {
    if (o.status === 'new') { var w = Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000); return { text: 'čaká ' + w + ' min', cls: w >= 3 ? 'late' : w >= 1 ? 'warn' : 'ok' }; }
    if (o.readyAt) return { text: inHouse(o) ? 'čaká na zákazníka' : 'čaká na kuriéra', cls: 'done' };
    var d = o.promisedReadyAt || o.woltPickupEta || o.scheduledFor;
    if (!d) return { text: 'varí sa', cls: 'ok' };
    var m = Math.round((new Date(d).getTime() - Date.now()) / 60000);
    if (m < 0) return { text: 'MEŠKÁ ' + (-m) + ' min', cls: 'late' };
    if (m <= 3) return { text: 'SÚRI · ' + m + ' min', cls: 'late' };
    if (m <= 8) return { text: 'o ' + m + ' min', cls: 'warn' };
    return { text: 'o ' + m + ' min', cls: 'ok' };
  }
  function find(id) { for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]; return null; }
  function errMsg(e) { return (e && (e.message || (e.data && e.data.error))) || 'Chyba spojenia'; }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type || 'info'); }
  // `api` je v api.js deklarované cez const — je to globálna lexikálna väzba,
  // nie window.api, preto sa testuje cez typeof.
  function hasToken() { return typeof api !== 'undefined' && typeof api.getToken === 'function' && !!api.getToken(); }
  function alarm() { return typeof window.ooAlarm !== 'undefined' ? window.ooAlarm : null; }

  // ── DOM: lišta, takeover, overlay sa vytvoria raz ──────────────────────
  function ensureDom() {
    if (document.getElementById('ooBanner')) return;
    var b = document.createElement('div');
    b.id = 'ooBanner'; b.className = 'oo-banner'; b.hidden = true; b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', onAction);
    document.body.appendChild(b);

    var t = document.createElement('div');
    t.id = 'ooTakeover'; t.className = 'oo-takeover'; t.hidden = true;
    t.setAttribute('role', 'dialog'); t.setAttribute('aria-modal', 'true'); t.setAttribute('aria-labelledby', 'ooTakeoverTitle');
    t.addEventListener('click', onAction);
    document.body.appendChild(t);

    var ov = document.createElement('div');
    ov.id = 'ooOverlay'; ov.className = 'u-overlay oo-overlay'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = '<div class="u-modal oo-modal" role="dialog" aria-modal="true" aria-labelledby="ooModalTitle"><div id="ooModalBody"></div></div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) { closeModal(); return; } onAction(e); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.classList.contains('show')) closeModal();
    });
  }

  function onAction(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    switch (btn.dataset.act) {
      case 'close': closeModal(); break;
      case 'list': openList(); break;
      case 'open': openDetail(id); break;
      case 'accept': confirmOrder(id, Number(btn.getAttribute('data-prep')) || DEFAULT_PREP); break;
      case 'prep-start': modal.prep = true; modal.rejecting = false; renderModal(); break;
      case 'prep-cancel': modal.prep = false; renderModal(); break;
      case 'snooze': snoozed[id] = Date.now() + SNOOZE_MS; var a = alarm(); if (a) a.stop(); renderAll(); break;
      case 'ready': deferred(id, 'ready'); break;
      case 'handover': handoverOrder(id); break;
      case 'fire': fireOrder(id); break;
      case 'reprint': reprintOrder(id); break;
      case 'undo': undo(id); break;
      case 'reject-start': openDetail(id, true); break;
      case 'reject-cancel': modal.rejecting = false; renderModal(); break;
      case 'reason': {
        var ov = document.getElementById('ooOverlay');
        ov.querySelector('#ooReason').value = btn.getAttribute('data-reason');
        ov.querySelectorAll('[data-act="reason"]').forEach(function (x) { x.classList.toggle('is-on', x === btn); });
        break;
      }
      case 'reject': deferred(id, 'reject', document.getElementById('ooReason').value.trim()); break;
    }
  }

  // ── Čo je „čerstvé": nové a neodložené ─────────────────────────────────
  function fresh() {
    var now = Date.now();
    return rows.filter(function (o) { return o.status === 'new' && !(snoozed[o.id] > now); })
      .sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  }
  function otherOverlayOpen() {
    // Platba / fiškál / iný modál kasy má prednosť — takeover ich nesmie prekryť.
    var open = document.querySelectorAll('.u-overlay.show');
    for (var i = 0; i < open.length; i++) if (open[i].id !== 'ooOverlay') return true;
    return !!document.getElementById('confirmModal');
  }

  function renderAll() {
    renderBell();
    renderTakeover();
    renderBanner();
    if (modal.mode) renderModal();
    scheduleSnoozeWake();
  }
  function scheduleSnoozeWake() {
    clearTimeout(snoozeTimer);
    var now = Date.now(), next = Infinity;
    Object.keys(snoozed).forEach(function (id) { if (snoozed[id] > now && snoozed[id] < next) next = snoozed[id]; });
    if (next < Infinity) snoozeTimer = setTimeout(renderAll, next - now + 50);
  }

  // ── Takeover: celá obrazovka s výberom minút ───────────────────────────
  function renderTakeover() {
    var t = document.getElementById('ooTakeover');
    if (!t) return;
    var list = fresh();
    var show = list.length && !modal.mode && !otherOverlayOpen();
    var a = alarm();
    if (!list.length && a) a.stop();
    if (!show) { t.hidden = true; return; }
    var o = list[0], more = list.length - 1, d = due(o), n = qtyOf(o);
    var items = (o.items || []).map(function (it) {
      return '<div class="oo-tk-item"><span class="q">' + (Number(it.qty) || 1) + '×</span><span>' + esc(it.name) + (it.note ? '<em>' + esc(it.note) + '</em>' : '') + '</span></div>';
    }).join('');
    var chips = PREP_CHOICES.map(function (m) {
      return '<button type="button" class="oo-chip' + (m === DEFAULT_PREP ? ' is-on' : '') + '" data-act="accept" data-id="' + o.id + '" data-prep="' + m + '"' + (busy[o.id] ? ' disabled' : '') + '>' + m + ' min</button>';
    }).join('');
    t.innerHTML =
      '<div class="oo-tk ' + (isWolt(o) ? 'is-wolt' : 'is-web') + '">' +
        '<div class="oo-tk-src"><span>' + (isWolt(o) ? 'Nová objednávka · aplikácia Wolt' : 'Nová objednávka · surfspirit.sk') + '</span><span class="oo-tk-code">' + esc(o.publicCode) + '</span></div>' +
        '<div class="oo-tk-head"><div class="oo-tk-title" id="ooTakeoverTitle">' + esc(o.customerName) + '</div><div class="oo-tk-due ' + d.cls + '" data-oo-due="' + o.id + '">' + esc(d.text) + '</div></div>' +
        (claimText(o) ? '<div class="oo-tk-claim">' + esc(claimText(o)) + '</div>' : '') +
        ((escalated[o.id] || o.escalationLevel) >= 1 ? '<div class="oo-tk-esc">Kuchyňa neprijala — prijmi ty' + ((escalated[o.id] || o.escalationLevel) >= 2 ? ' · manažér dostal správu' : '') + '</div>' : '') +
        '<div class="oo-tk-when">' + esc(whenText(o)) + ' · ' + n + ' ' + itemsWord(n) + ' · <b>' + esc(eur(o.total)) + '</b> · ' + esc(payText(o)) + (more ? ' · <b>+' + more + ' ' + (more === 1 ? 'ďalšia' : more < 5 ? 'ďalšie' : 'ďalších') + '</b>' : '') + '</div>' +
        '<div class="oo-tk-items">' + items + '</div>' +
        (o.note ? '<div class="oo-note">' + esc(o.note) + '</div>' : '') +
        '<div class="oo-tk-meta">' + esc(o.customerPhone || '') + (o.dropoffStreet ? ' · ' + esc(o.dropoffStreet) + (o.dropoffCity ? ', ' + esc(o.dropoffCity) : '') : '') + '</div>' +
        '<div class="oo-tk-actions">' +
          '<div class="oo-tk-accept"><button type="button" class="oo-tk-go" data-act="accept" data-id="' + o.id + '" data-prep="' + DEFAULT_PREP + '"' + (busy[o.id] ? ' disabled' : '') + '>' + (isWolt(o) ? 'Prijať' : 'Potvrdiť') + ' · ' + DEFAULT_PREP + ' min</button><div class="oo-chips">' + chips + '</div></div>' +
          '<button type="button" class="oo-tk-ghost" data-act="open" data-id="' + o.id + '">Zobraziť</button>' +
          '<button type="button" class="oo-tk-ghost" data-act="snooze" data-id="' + o.id + '">Neskôr (30 s)</button>' +
          '<button type="button" class="oo-tk-ghost is-danger" data-act="reject-start" data-id="' + o.id + '">Odmietnuť…</button>' +
        '</div>' +
      '</div>';
    t.hidden = false;
    if (a) a.start(isWolt(o) ? 'wolt' : 'web');
  }

  // ── Lišta pod hlavičkou (keď takeover nemôže — iný modál — alebo ako zhrnutie) ──
  function renderBanner() {
    var b = document.getElementById('ooBanner');
    if (!b) return;
    var list = fresh();
    var takeoverShown = !document.getElementById('ooTakeover').hidden;
    if (!list.length || takeoverShown) { b.hidden = true; document.body.classList.remove('has-oo-banner'); return; }
    var o = list[0], more = list.length - 1, n = qtyOf(o);
    b.innerHTML =
      '<div class="oo-banner-main">' +
        '<span class="oo-banner-kicker">' + ((escalated[o.id] || o.escalationLevel || 0) >= 1 ? 'Kuchyňa neprijala — prijmi ty · ' : '') + (isWolt(o) ? 'Nová objednávka z aplikácie Wolt' : 'Nová online objednávka') + '</span>' +
        '<span class="oo-banner-text">' + codeHtml(o) + ' · ' + esc(o.customerName) + ' · ' + n + ' ' + itemsWord(n) + ' · <b>' + esc(eur(o.total)) + '</b> · ' + esc(whenText(o)) +
          (more ? ' · <button type="button" class="oo-banner-more" data-act="list">+' + more + ' ' + (more === 1 ? 'ďalšia' : more < 5 ? 'ďalšie' : 'ďalších') + '</button>' : '') +
        '</span>' +
      '</div>' +
      '<div class="oo-banner-actions">' +
        '<button type="button" class="oo-btn oo-btn-light" data-act="open" data-id="' + o.id + '">Zobraziť</button>' +
        '<button type="button" class="oo-btn oo-btn-solid" data-act="prep-open" data-id="' + o.id + '">' + (isWolt(o) ? 'Prijať' : 'Potvrdiť') + '</button>' +
        '<button type="button" class="oo-btn oo-btn-light" data-act="snooze" data-id="' + o.id + '">Neskôr</button>' +
      '</div>';
    b.querySelector('[data-act="prep-open"]').addEventListener('click', function () { openDetail(o.id, false, true); });
    b.hidden = false;
    b.classList.toggle('is-escalated', (escalated[o.id] || o.escalationLevel || 0) >= 1);
    document.body.classList.add('has-oo-banner');
    positionBanner();
    var a = alarm();
    if (a) a.start(isWolt(o) ? 'wolt' : 'web');
  }
  // Lišta sedí pod hlavičkou (desktop .header / mobil .mob-header).
  function positionBanner() {
    var b = document.getElementById('ooBanner');
    if (!b || b.hidden) return;
    var head = null;
    document.querySelectorAll('.header, .mob-header').forEach(function (h) { if (!head && h.offsetParent !== null) head = h; });
    b.style.top = (head ? Math.max(0, Math.round(head.getBoundingClientRect().bottom)) : 0) + 'px';
  }
  window.addEventListener('resize', positionBanner);

  // ── Zvonček v hlavičke (desktop aj mobil) ─────────────────────────────
  function renderBell() {
    var n = rows.filter(function (o) { return o.status === 'new'; }).length;
    var running = rows.length - n;
    var label = n ? n + ' ' + (n === 1 ? 'nová online objednávka' : n < 5 ? 'nové online objednávky' : 'nových online objednávok')
                  : running + ' ' + (running === 1 ? 'online objednávka v príprave' : 'online objednávky v príprave');
    document.querySelectorAll('[data-oo-bell]').forEach(function (btn) {
      btn.hidden = !rows.length;
      btn.classList.toggle('is-new', n > 0);
      var c = btn.querySelector('.oo-bell-count');
      if (c) c.textContent = n || running;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    });
  }

  // ── Modál: zoznam + detail ─────────────────────────────────────────────
  function showOverlay() {
    var ov = document.getElementById('ooOverlay');
    ov.classList.add('show'); ov.setAttribute('aria-hidden', 'false');
    var first = ov.querySelector('.oo-actions .u-btn-ice') || ov.querySelector('.oo-actions button, .oo-list button');
    if (first) first.focus();
  }
  function closeModal() {
    var ov = document.getElementById('ooOverlay');
    ov.classList.remove('show'); ov.setAttribute('aria-hidden', 'true');
    modal = { mode: null, id: null, rejecting: false, prep: false };
    renderTakeover(); renderBanner();
  }
  function openList() { modal = { mode: 'list', id: null, rejecting: false, prep: false }; renderModal(); showOverlay(); renderTakeover(); renderBanner(); refresh(); }
  function openDetail(id, rejecting, prep) {
    if (!find(id)) { toast('Objednávka už nie je aktívna', 'warning'); refresh(); return; }
    modal = { mode: 'detail', id: id, rejecting: !!rejecting, prep: !!prep };
    // Niekto sa objednávke venuje — alarm stíchne; po zavretí bez akcie sa ozve znova.
    var a = alarm(); if (a) a.stop();
    claim(id);
    renderModal(); showOverlay(); renderTakeover(); renderBanner();
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
      var n = qtyOf(o), d = due(o);
      return '<button type="button" class="oo-row" data-act="open" data-id="' + o.id + '">' +
        '<span class="oo-row-main"><span class="oo-row-title">' + codeHtml(o) + ' · ' + esc(o.customerName) + '</span>' +
        '<span class="oo-row-sub">' + n + ' ' + itemsWord(n) + ' · ' + esc(ago(o.createdAt)) + ' · ' + esc(whenText(o)) + '</span>' + pill(o) + '</span>' +
        '<span class="oo-row-side">' + esc(eur(o.total)) + '<small class="oo-due ' + d.cls + '" data-oo-due="' + o.id + '">' + esc(d.text) + '</small></span></button>';
    }).join('');
    return '<div class="u-modal-title oo-title" id="ooModalTitle">Online objednávky</div>' +
      '<div class="oo-list">' + (items || '<p class="oo-sub">Žiadne aktívne online objednávky.</p>') + '</div>' +
      '<div class="oo-actions"><button type="button" class="u-btn u-btn-ice" data-act="close">Zavrieť</button></div>';
  }
  function undoHtml(id) {
    var p = pending[id];
    var left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
    var label = p.action === 'reject' ? 'Odmietnuté' : 'Hotové';
    return '<div class="oo-actions"><button type="button" class="u-btn oo-btn-undo" data-act="undo" data-id="' + id + '" data-undo="' + id + '">' + label + ' · <b>SPÄŤ (' + left + ')</b></button></div>';
  }
  function detailHtml(o) {
    var lines = (o.items || []).map(function (i) {
      return '<div class="oo-item"><span class="oo-item-q">' + (Number(i.qty) || 1) + '×</span><span class="oo-item-n">' + esc(i.name) +
        (i.note ? '<em>' + esc(i.note) + '</em>' : '') + '</span><span class="oo-item-p">' + esc(eur((Number(i.unitPrice) || 0) * (Number(i.qty) || 1))) + '</span></div>';
    }).join('');
    var d = due(o);
    var actions;
    if (pending[o.id]) {
      actions = undoHtml(o.id);
    } else if (modal.rejecting) {
      actions = '<div class="oo-reject"><div class="oo-reject-title">Dôvod odmietnutia (uvidí ho zákazník)</div>' +
        '<div class="oo-reasons">' + REASONS.map(function (r) { return '<button type="button" class="oo-reason" data-act="reason" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
        '<input id="ooReason" class="oo-input" maxlength="300" placeholder="alebo vlastný dôvod…" autocomplete="off">' +
        '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="reject-cancel">Späť</button>' +
        '<button type="button" class="u-btn oo-btn-danger" data-act="reject" data-id="' + o.id + '">Odmietnuť objednávku</button></div></div>';
    } else if (o.status === 'new' && modal.prep) {
      actions = '<div class="oo-prep"><div class="oo-reject-title">Kedy bude hotové? Čas ide ' + (isWolt(o) ? 'kuriérovi Woltu' : 'kuriérovi') + ', bon sa vytlačí hneď.</div>' +
        '<div class="oo-chips">' + PREP_CHOICES.map(function (m) {
          return '<button type="button" class="oo-chip' + (m === DEFAULT_PREP ? ' is-on' : '') + '" data-act="accept" data-id="' + o.id + '" data-prep="' + m + '"' + (busy[o.id] ? ' disabled' : '') + '>' + m + ' min</button>';
        }).join('') + '</div>' +
        '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="prep-cancel">Späť</button></div></div>';
    } else if (o.status === 'new') {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn oo-btn-danger" data-act="reject-start" data-id="' + o.id + '">Odmietnuť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="prep-start" data-id="' + o.id + '">' + (isWolt(o) ? 'Prijať vo Wolte' : 'Potvrdiť a objednať kuriéra') + '</button></div>';
    } else if (o.status === 'confirmed' && !o.firedAt && !o.posOrderId) {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="fire" data-id="' + o.id + '">' + (o.fireAt ? 'Začať variť teraz' : 'Vytvoriť účet a bon') + '</button></div>';
    } else if (!o.readyAt && (o.status === 'confirmed' || o.status === 'dispatched')) {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="ready" data-id="' + o.id + '">' + (inHouse(o) ? 'Hotové — zákazník si môže prísť' : 'Hotové — čaká na kuriéra') + '</button></div>';
    } else if (o.readyAt && inHouse(o) && o.status === 'confirmed') {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ghost" data-act="close">Zavrieť</button>' +
        '<button type="button" class="u-btn u-btn-ice" data-act="handover" data-id="' + o.id + '">Odovzdané zákazníkovi</button></div>';
    } else {
      actions = '<div class="oo-actions"><button type="button" class="u-btn u-btn-ice" data-act="close">Zavrieť</button></div>';
    }
    return '<div class="u-modal-title oo-title" id="ooModalTitle">' + codeHtml(o) + ' ' + pill(o) + '</div>' +
      '<p class="oo-sub">prijaté ' + esc(fmtTime.format(new Date(o.createdAt))) + ' (' + esc(ago(o.createdAt)) + ') · <b>' + esc(whenText(o)) + '</b>' +
        (o.status !== 'new' ? ' · <span class="oo-due ' + d.cls + '" data-oo-due="' + o.id + '">' + esc(d.text) + '</span>' : '') + '</p>' +
      '<div class="oo-items">' + lines + '</div>' +
      '<div class="oo-tots"><div class="oo-tot"><span>Jedlo a nápoje</span><span>' + esc(eur(o.subtotal)) + '</span></div>' +
        '<div class="oo-tot"><span>Doručenie</span><span>' + esc(eur(o.deliveryFee)) + '</span></div>' +
        '<div class="oo-tot is-big"><span>Spolu</span><span>' + esc(eur(o.total)) + '</span></div></div>' +
      (o.note ? '<div class="oo-note">' + esc(o.note) + '</div>' : '') +
      '<div class="oo-kv"><span>Zákazník</span><span><b>' + esc(o.customerName) + '</b> · <a href="tel:' + esc(String(o.customerPhone || '').replace(/\s+/g, '')) + '">' + esc(o.customerPhone) + '</a></span></div>' +
      '<div class="oo-kv"><span>Adresa</span><span>' + esc(o.dropoffStreet) + (o.dropoffPostCode ? ', ' + esc(o.dropoffPostCode) : '') + (o.dropoffCity ? ' ' + esc(o.dropoffCity) : '') + (o.dropoffComment ? ' · ' + esc(o.dropoffComment) : '') + '</span></div>' +
      '<div class="oo-kv"><span>Platba</span><span>' + esc(payText(o)) + '</span></div>' +
      (o.prepMinutes ? '<div class="oo-kv"><span>Príprava</span><span>' + o.prepMinutes + ' min · hotové ' + esc(fmtTime.format(new Date(o.promisedReadyAt || Date.now()))) + '</span></div>' : '') +
      (o.fireAt && !o.firedAt ? '<div class="oo-kv"><span>Plán</span><span>predobjednávka · bon pôjde ' + esc(fmtTime.format(new Date(o.fireAt))) + '</span></div>' : '') +
      (o.status !== 'new' && o.bonStatus ? '<div class="oo-kv"><span>Bon</span><span>' + (o.bonStatus === 'ok' ? 'vytlačený' : o.bonStatus === 'none' ? 'bez položiek z kasy' : '<b class="oo-bon-bad">nevytlačený</b>') + ' · <button type="button" class="oo-link" data-act="reprint" data-id="' + o.id + '">vytlačiť znova</button></span></div>' : '') +
      (claimText(o) ? '<div class="oo-kv"><span>Rieši</span><span>' + esc(claimText(o).replace(/^Rieši /, '')) + '</span></div>' : '') +
      (o.woltTrackingUrl ? '<div class="oo-kv"><span>Kuriér</span><span><a href="' + esc(o.woltTrackingUrl) + '" target="_blank" rel="noopener">sledovať kuriéra</a></span></div>' : '') +
      (isWolt(o) && !inHouse(o) ? '<div class="oo-kv"><span>Kuriér</span><span>posiela Wolt' + (o.woltPickupEta ? ' · príde ' + esc(fmtTime.format(new Date(o.woltPickupEta))) : '') + '</span></div>' : '') +
      actions;
  }

  // ── Akcie ──────────────────────────────────────────────────────────────
  function guardOnline() {
    if (typeof api !== 'undefined' && typeof api.isOnline === 'function' && !api.isOnline()) { toast('Bez spojenia so serverom — skúste o chvíľu', 'warning'); return false; }
    return true;
  }
  function post(id, action, body) {
    return api.post('/online-orders/' + id + '/' + action, body || {}, 'oo:' + id + ':' + action);
  }
  /** Prijatie s minútami — jediná cesta; bez otázky „naozaj?". */
  function confirmOrder(id, prep) {
    var o = find(id);
    if (!o || busy[id] || !guardOnline()) return;
    busy[id] = true;
    var a = alarm(); if (a) a.stop();
    renderAll();
    post(id, 'confirm', { prepMinutes: prep || DEFAULT_PREP }).then(function (r) {
      delete busy[id];
      if (r && r.error) toast((isWolt(o) ? 'Prijaté vo Wolte, ale ' : 'Potvrdené, ale ') + r.error, 'warning');
      else toast((isWolt(o) ? 'Prijaté vo Wolte' : 'Potvrdené') + ' · ' + o.publicCode + ' · ' + (prep || DEFAULT_PREP) + ' min — bon ide do kuchyne', 'success');
      if (modal.id === id) closeModal();
      refresh();
    }).catch(function (e) {
      delete busy[id];
      toast(errMsg(e), e && e.status === 409 ? 'warning' : 'error');
      refresh();
    });
  }
  /** Odmietnuť / Hotové: 6 s na SPÄŤ, potom odchádza na server (Wolt aj zákazník sa to dozvedia až vtedy). */
  function deferred(id, action, reason) {
    var o = find(id);
    if (!o || pending[id] || busy[id] || !guardOnline()) return;
    // Hotové pri objednávke z webu nič nevolá von — netreba čakať.
    var wait = action === 'reject' || isWolt(o) ? UNDO_MS : 0;
    if (!wait) return fire(id, action, reason);
    pending[id] = { action: action, reason: reason || '', until: Date.now() + wait, timer: setTimeout(function () { fire(id, action, reason); }, wait) };
    modal.rejecting = false;
    renderAll();
  }
  function undo(id) {
    var p = pending[id];
    if (!p) return;
    clearTimeout(p.timer);
    delete pending[id];
    toast('Zrušené — objednávka ostáva ako bola', 'info');
    renderAll();
  }
  function fire(id, action, reason) {
    delete pending[id];
    var o = find(id);
    if (!o) return;
    busy[id] = true;
    var body = action === 'reject' ? { reason: reason || '' } : {};
    post(id, action, body).then(function () {
      delete busy[id];
      toast(action === 'reject' ? 'Objednávka ' + o.publicCode + ' odmietnutá' : 'Objednávka ' + o.publicCode + ' označená ako hotová', action === 'reject' ? 'info' : 'success');
      if (modal.id === id) closeModal();
      refresh();
    }).catch(function (e) { delete busy[id]; toast(errMsg(e), 'error'); refresh(); });
  }
  function fireOrder(id) {
    var o = find(id);
    if (!o || busy[id] || !guardOnline()) return;
    busy[id] = true;
    post(id, 'fire', {}).then(function (r) {
      delete busy[id];
      if (r && r.error) toast(r.error, 'warning'); else toast('Účet založený, bon ide do kuchyne', 'success');
      closeModal(); refresh();
    }).catch(function (e) { delete busy[id]; toast(errMsg(e), 'error'); refresh(); });
  }
  function reprintOrder(id) {
    api.post('/online-orders/' + id + '/reprint', {}).then(function (r) {
      toast(r.bon === 'ok' ? 'Bon vytlačený (kópia)' : 'Bon je vo fronte — tlačiareň neodpovedá', r.bon === 'ok' ? 'success' : 'warning');
      refresh();
    }).catch(function (e) { toast(errMsg(e), 'error'); });
  }
  function handoverOrder(id) {
    var o = find(id);
    if (!o || busy[id] || !guardOnline()) return;
    busy[id] = true;
    post(id, 'handed-over', {}).then(function () {
      delete busy[id];
      toast('Objednávka ' + o.publicCode + ' odovzdaná zákazníkovi', 'success');
      closeModal();
      refresh();
    }).catch(function (e) { delete busy[id]; toast(errMsg(e), 'error'); refresh(); });
  }

  // ── Načítanie ──────────────────────────────────────────────────────────
  function refresh() {
    if (loading || !hasToken()) return Promise.resolve();
    loading = true;
    return api.get('/online-orders?status=active').then(function (res) {
      rows = (res && res.rows) || [];
      var ids = rows.filter(function (o) { return o.status === 'new'; });
      ids.forEach(function (o) { if (!seenNew[o.id]) { seenNew[o.id] = true; delete snoozed[o.id]; } });
      Object.keys(pending).forEach(function (id) { if (!find(Number(id))) { clearTimeout(pending[id].timer); delete pending[id]; } });
      renderAll();
    }).catch(function (e) {
      if (e && !/network|fetch|offline|401|403/i.test(String(e.message || e))) console.warn('[online-orders] refresh zlyhal:', e);
    }).then(function () { loading = false; });
  }

  // Odpočty a okná SPÄŤ bez prekreslenia (fokus ostáva na tlačidle).
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll('[data-oo-due]').forEach(function (el) {
      var o = find(Number(el.getAttribute('data-oo-due')));
      if (!o) return;
      var d = due(o);
      el.textContent = d.text;
      el.className = el.className.replace(/\b(ok|warn|late|done)\b/g, '').trim() + ' ' + d.cls;
    });
    document.querySelectorAll('[data-undo]').forEach(function (el) {
      var p = pending[Number(el.getAttribute('data-undo'))];
      if (p) el.querySelector('b').textContent = 'SPÄŤ (' + Math.max(0, Math.ceil((p.until - now) / 1000)) + ')';
    });
  }, 1000);

  function bindSocket(socket) {
    if (!socket) return;
    socket.on('online-order:new', function () { refresh(); });
    socket.on('online-order:updated', function () { refresh(); });
    socket.on('online-order:claimed', function () { refresh(); });
    // Strážca: kuchyňa minútu nereagovala → kasa zčervenie, odložené sa vráti, alarm nahlas.
    socket.on('online-order:alert', function (data) {
      if (data && data.id) { escalated[data.id] = data.level || 1; delete snoozed[data.id]; }
      var a = alarm(); if (a) a.play(data && data.source === 'wolt' ? 'wolt' : 'web', true);
      refresh();
    });
    // Wolt zrušil už prijatú objednávku → STOP.
    socket.on('online-order:stop', function (data) {
      toast('STOP — Wolt zrušil objednávku ' + ((data && data.code) || '') + '. Kuchyňa nevarí, účet uzavrieť ako odpis.', 'error');
      var a = alarm(); if (a) a.play('wolt', true);
      refresh();
    });
    socket.on('connect', function () { refresh(); });
  }

  function start() {
    ensureDom();
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, POLL_MS);
    // Zvuk sa odomkne prvým gestom (PIN pri prihlásení je gesto) — js/oo-alarm.js.
    var a = alarm(); if (a) a.unlock();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.posOnlineOrders = {
    refresh: refresh, openList: openList, openDetail: openDetail, bindSocket: bindSocket,
    _debug: function () { return { rows: rows.length, loading: loading, seen: Object.keys(seenNew), snoozed: Object.keys(snoozed), pending: Object.keys(pending), modal: modal }; },
  };
})();
