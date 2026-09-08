'use strict';
// Standalone dochadzka terminal — no JWT, no api.js. Talks only to
// /api/attendance/identify and /api/attendance/clock with a PIN.

(function () {
  var pin = '';
  var currentStaff = null;
  var currentState = 'clocked_out';
  var resetTimer = null;
  // Identify debounce — request odide az ~350 ms po poslednej cislici,
  // nie pri kazdom stlaceni od 4. cislice. Generacia oznacuje najnovsi
  // odoslany request; starsie odpovede (out-of-order fetch) zahadzujeme.
  var identifyTimer = null;
  var identifyGen = 0;

  var $ = function (id) { return document.getElementById(id); };

  function fmtMinutes(m) {
    if (!Number.isFinite(m)) return '0h 0m';
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return h + 'h ' + mm + 'm';
  }

  function showToast(msg, ok) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'doch-toast show ' + (ok ? 'ok' : 'err');
    setTimeout(function () { t.className = 'doch-toast'; }, 2400);
  }

  function renderPin() {
    var dots = '';
    for (var i = 0; i < pin.length; i++) dots += '<span class="dot"></span>';
    $('pinDisplay').innerHTML = dots;
  }

  function renderStatus(staff, state, todayMinutes) {
    var s = $('status');
    if (!staff) {
      s.innerHTML = '<div class="doch-status-empty">Zadaj svoj PIN</div>';
      $('actions').hidden = true;
      return;
    }
    var label = state === 'clocked_in' ? 'V praci' : 'Doma';
    s.innerHTML =
      '<div class="doch-status-name">' + escapeHtml(staff.name) + '</div>' +
      (staff.position ? '<div class="doch-status-pos">' + escapeHtml(staff.position) + '</div>' : '') +
      '<div class="doch-status-state ' + state + '">' + label + '</div>' +
      '<div class="doch-status-today">Dnes: ' + fmtMinutes(todayMinutes) + '</div>';
    $('actions').hidden = false;
    $('btnIn').hidden = state === 'clocked_in';
    $('btnOut').hidden = state === 'clocked_out';
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function resetSoon() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      // Kým je otvorený niektorý overlay, terminál sa NESMIE resetovať.
      // Zamestnanec práve vypĺňa žiadosť o opravu (alebo si číta smeny) a
      // reset by mu zmazal PIN — odoslanie by potom tichо nespravilo nič.
      var busy = (function () {
        var f = document.getElementById('fixOverlay');
        var m = document.getElementById('myShiftsOverlay');
        return (f && !f.hidden) || (m && !m.hidden);
      })();
      if (busy) { resetSoon(); return; }
      pin = ''; currentStaff = null; currentState = 'clocked_out';
      renderPin(); renderStatus(null);
    }, 8000);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  function scheduleIdentify() {
    clearTimeout(identifyTimer);
    if (pin.length < 4) return;
    identifyTimer = setTimeout(tryIdentify, 350);
  }

  function tryIdentify() {
    if (pin.length < 4) return;
    var gen = ++identifyGen;
    var sentPin = pin;
    postJson('/api/attendance/identify', { pin: sentPin }).then(function (res) {
      // Zahod odpoved ak medzitym odisiel novsi request, alebo sa PIN
      // zmenil (zamestnanec este pise / stlacil C) — stara odpoved by
      // inak prepisala aktualny stav.
      if (gen !== identifyGen || pin !== sentPin) return;
      if (!res.ok) {
        showToast(res.data.error || 'Neplatny PIN', false);
        // PIN nemazeme pocas pisania — 4-miestny prefix dlhsieho PINu
        // legitimne zlyha. Vycistime az pri maximalnej dlzke (uz sa neda
        // dopisat); kratsi zly PIN si zamestnanec opravi sam (C/Backspace).
        if (pin.length >= 6) { pin = ''; renderPin(); }
        return;
      }
      currentStaff = res.data.staff;
      currentState = res.data.currentState;
      renderStatus(currentStaff, currentState, res.data.todayMinutes);
      resetSoon();
    });
  }

  function clock(type) {
    if (!currentStaff || !pin) return;
    postJson('/api/attendance/clock', { pin: pin, type: type }).then(function (res) {
      if (!res.ok) {
        showToast(res.data.error || 'Chyba', false);
        return;
      }
      currentState = res.data.currentState;
      renderStatus(res.data.staff, currentState, res.data.todayMinutes);
      showSplash(type, res.data.staff && res.data.staff.name);
      setTimeout(function () {
        pin = ''; currentStaff = null; currentState = 'clocked_out';
        renderPin(); renderStatus(null);
      }, 3200);
    });
  }

  function showSplash(type, name) {
    var el = document.getElementById('splash');
    if (!el) return;
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('splashTitle').textContent =
      (type === 'clock_in' ? 'Príchod ' : 'Odchod ') + hh + ':' + mm;
    document.getElementById('splashName').textContent = name || '';
    el.className = 'doch-splash show ' + (type === 'clock_in' ? 'in' : 'out');
    el.hidden = false;
    setTimeout(function () { el.className = 'doch-splash'; el.hidden = true; }, 3000);
  }

  document.querySelectorAll('.doch-key[data-d]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (pin.length >= 6) return;
      pin += b.getAttribute('data-d');
      renderPin();
      scheduleIdentify();
    });
  });
  $('pinClr').addEventListener('click', function () { clearTimeout(identifyTimer); pin = ''; renderPin(); renderStatus(null); });
  $('pinBk').addEventListener('click', function () { pin = pin.slice(0, -1); renderPin(); scheduleIdentify(); });
  $('btnIn').addEventListener('click', function () { clock('clock_in'); });
  $('btnOut').addEventListener('click', function () { clock('clock_out'); });

  // === MÔJ ZÁROBOK (moje smeny) ===
  // PIN-authenticated self-service view. Server vráti prehľad PO MESIACOCH
  // (`months`, každý so sumou) + smeny zvoleného obdobia. Zamestnanec si tak
  // pozrie august aj júl bez manažéra. Auto-close po 60 s nečinnosti.
  var msPeriod = 'month';
  var msAutoClose = null;
  var MONTHS_SK = ['Január', 'Február', 'Marec', 'Apríl', 'Máj', 'Jún',
                   'Júl', 'August', 'September', 'Október', 'November', 'December'];
  var DAYS_SK = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];

  function fmtEur(n) {
    var x = Number(n) || 0;
    return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }
  function fmtHours(min) {
    var h = Math.floor((min || 0) / 60);
    var m = (min || 0) % 60;
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }
  function monthName(ym) {
    var p = String(ym).split('-');
    return MONTHS_SK[parseInt(p[1], 10) - 1] || String(ym);
  }
  function monthLabel(ym) { return monthName(ym) + ' ' + String(ym).split('-')[0]; }
  // "Pi 5. 9." — deň v týždni pomôže spomenúť si, ktorá smena to bola.
  function fmtDay(iso) {
    var d = new Date(iso);
    return DAYS_SK[d.getDay()] + ' ' + d.getDate() + '. ' + (d.getMonth() + 1) + '.';
  }
  function shiftsWord(n) { return n === 1 ? 'smena' : (n >= 2 && n <= 4 ? 'smeny' : 'smien'); }

  function fetchMyShifts() {
    if (!pin || pin.length < 4) return;
    postJson('/api/attendance/my-shifts', { pin: pin, period: msPeriod }).then(function (res) {
      if (!res.ok) {
        showToast(res.data.error || 'Chyba', false);
        return;
      }
      renderMyShifts(res.data);
      $('myShiftsOverlay').hidden = false;
      scheduleMsAutoClose();
    });
  }

  function scheduleMsAutoClose() {
    clearTimeout(msAutoClose);
    msAutoClose = setTimeout(closeMyShifts, 60000);
  }

  function closeMyShifts() {
    clearTimeout(msAutoClose);
    $('myShiftsOverlay').hidden = true;
    pin = ''; currentStaff = null; currentState = 'clocked_out';
    renderPin(); renderStatus(null);
  }

  // Pás mesiacov so sumou + „Celá sezóna" na konci. Aktívny = zvolené obdobie.
  function renderMonths(data) {
    var months = data.months || [];
    var p = data.period || {};
    var activeKey = p.kind === 'season' ? 'season' : (p.kind === 'all' ? 'all' : (p.ym || ''));
    var html = months.map(function (m) {
      var on = m.ym === activeKey;
      return '<button type="button" class="ms-month' + (on ? ' active' : '') + '" data-period="' + escapeHtml(m.ym) + '" aria-pressed="' + on + '">' +
        '<span class="ms-month-name">' + escapeHtml(monthName(m.ym)) + '</span>' +
        '<span class="ms-month-eur">' + fmtEur(m.earnings) + '</span>' +
      '</button>';
    }).join('');
    html += '<button type="button" class="ms-month ms-month-all' + (activeKey === 'season' ? ' active' : '') +
      '" data-period="season" aria-pressed="' + (activeKey === 'season') + '">' +
      '<span class="ms-month-name">Celá sezóna</span></button>';
    $('msMonths').innerHTML = html;
    var act = $('msMonths').querySelector('.ms-month.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderMyShifts(data) {
    var s = data.staff || {};
    var sum = data.summary || {};
    var p = data.period || {};
    var hourlyRate = Number(s.hourlyRate) || 0;
    $('msSub').textContent = [s.name, s.position, hourlyRate > 0 ? fmtEur(hourlyRate) + '/h' : '']
      .filter(Boolean).join(' · ');
    renderMonths(data);

    // Hero: jedno číslo (zárobok), pod ním hodiny/smeny a pásik vyplatené vs. zostáva.
    var label = p.kind === 'season' ? 'Celá sezóna'
      : (p.kind === 'all' ? 'Celé obdobie' : (p.ym ? monthLabel(p.ym) : 'Tento mesiac'));
    var earnings = Number(sum.totalEarnings) || 0;
    var paid = Number(sum.paidEarnings) || 0;
    var unpaid = Number(sum.unpaidEarnings) || 0;
    var pct = earnings > 0 ? Math.max(0, Math.min(100, Math.round(paid / earnings * 100))) : 0;
    var empty = !sum.shiftCount && !sum.openShifts;
    var meta = fmtHours(sum.totalMinutes || 0)
      + ' · ' + (sum.shiftCount || 0) + ' ' + shiftsWord(sum.shiftCount || 0)
      + (sum.openShifts ? ' · ' + sum.openShifts + ' prebieha' : '')
      + (hourlyRate > 0 ? ' · ' + fmtEur(hourlyRate) + '/h' : '');
    var ov = sum.overlap;
    var hero = $('msSummary');
    hero.className = 'ms-hero' + (empty ? ' is-empty' : (unpaid <= 0.005 ? ' is-clear' : ''));
    hero.innerHTML =
      '<div class="ms-hero-top">' +
        '<span class="ms-hero-label">Zárobok · ' + escapeHtml(label) + '</span>' +
        '<span class="ms-hero-num">' + (empty ? 'zatiaľ nič' : fmtEur(earnings)) + '</span>' +
      '</div>' +
      '<div class="ms-hero-meta">' + escapeHtml(meta) + '</div>' +
      (ov && ov.minutes > 0
        ? '<div class="ms-hero-note">z toho ' + fmtHours(ov.minutes) + ' v spoločnej smene @ ' + fmtEur(ov.rate) + '/h</div>'
        : '') +
      (empty ? '' :
        '<div class="ms-bar" role="img" aria-label="Vyplatené ' + pct + ' %"><span class="ms-bar-paid" style="width:' + pct + '%"></span></div>' +
        '<div class="ms-hero-pay">' +
          '<span class="is-paid">✓ Vyplatené ' + fmtEur(paid) + '</span>' +
          (unpaid > 0.005 ? '<span class="is-due">Zostáva ' + fmtEur(unpaid) + '</span>' : '<span class="is-paid">všetko vyplatené</span>') +
        '</div>');

    var shifts = data.shifts || [];
    if (!shifts.length) {
      $('msList').innerHTML = '<div class="ms-empty">' +
        (p.kind === 'month' ? 'V tomto mesiaci zatiaľ žiadne smeny.' : 'Za toto obdobie žiadne smeny.') + '</div>';
      return;
    }
    $('msList').innerHTML = shifts.map(function (sh) {
      var inT = fmtTime(sh.inAt);
      var outT = sh.outAt ? fmtTime(sh.outAt) : '— stále vo vnútri —';
      var paidBadge = '';
      var statusClass = sh.closed ? 'ms-shift-closed' : 'ms-shift-open';
      if (sh.paid) {
        paidBadge = '<span class="ms-paid">✓ vyplatené</span>';
      } else if (sh.closed) {
        paidBadge = '<span class="ms-unpaid">čaká</span>';
      }
      return (
        '<div class="ms-shift ' + statusClass + '">' +
          '<div class="ms-shift-date">' + escapeHtml(fmtDay(sh.inAt)) + '</div>' +
          '<div class="ms-shift-times">' + inT + ' – ' + outT + '</div>' +
          '<div class="ms-shift-hours">' + fmtHours(sh.minutes) + '</div>' +
          '<div class="ms-shift-eur">' +
            (sh.closed ? fmtEur(sh.earnings) : '<span class="ms-running">prebieha</span>') +
            paidBadge +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  $('btnMyShifts').addEventListener('click', function () {
    if (!currentStaff || !pin) {
      showToast('Najprv zadaj PIN', false);
      return;
    }
    msPeriod = 'month';
    fetchMyShifts();
  });

  $('msClose').addEventListener('click', closeMyShifts);

  // Chipy mesiacov sa kreslia nanovo pri každej odpovedi — delegácia.
  $('msMonths').addEventListener('click', function (e) {
    var b = e.target.closest('[data-period]');
    if (!b) return;
    msPeriod = b.getAttribute('data-period');
    fetchMyShifts();
  });

  // Reset auto-close timer on any user interaction inside overlay
  $('myShiftsOverlay').addEventListener('click', scheduleMsAutoClose);
  $('myShiftsOverlay').addEventListener('touchstart', scheduleMsAutoClose, { passive: true });

  // === NAHLÁSENIE OPRAVY DOCHÁDZKY ===
  //
  // Terminál vie zapísať len „teraz". Kto príde o 8:00 a PIN stihne zadať až
  // o 9:30, prišiel o hodinu a pol mzdy; kto sa niektorý deň neoznačí, ten deň
  // v evidencii nemá. Doteraz to vedel opraviť len manažér — teda len ak mu to
  // niekto povedal a on si spomenul.
  //
  // Žiadosť dochádzku NEMENÍ. Je to návrh, ktorý manažér v admine schváli
  // alebo zamietne; až schválenie zapíše do attendance_events.
  var fixAutoClose = null;
  var REQUEST_MAX_AGE_DAYS = 31;

  function isoDay(offset) {
    var d = new Date();
    d.setDate(d.getDate() + (offset || 0));
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fmtDayLabel(iso) {
    var p = iso.split('-');
    return p[2] + '.' + p[1] + '.';
  }

  function scheduleFixAutoClose() {
    clearTimeout(fixAutoClose);
    // Dlhšie než pri „Moje smeny" — tu sa píše, nie iba pozerá.
    fixAutoClose = setTimeout(closeFix, 120000);
  }

  function closeFix() {
    clearTimeout(fixAutoClose);
    $('fixOverlay').hidden = true;
  }

  function setFixError(msg) {
    var el = $('fixError');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function selectedFixType() {
    var checked = document.querySelector('input[name="fixType"]:checked');
    return checked ? checked.value : 'late_pin';
  }

  // Pri zabudnutom dni je odchod POVINNÝ — bez neho by vznikla smena, ktorá
  // sa nikdy neskončí a mzda by sa z nej nedala spočítať.
  function syncOutRequirement() {
    var missing = selectedFixType() === 'missing_day';
    $('fixOut').required = missing;
    $('fixOutOptional').textContent = missing ? '(povinné)' : '(voliteľné)';
  }

  function renderFixDays() {
    var wrap = $('fixDays');
    var today = isoDay(0);
    var chips = [
      { iso: today, label: 'Dnes' },
      { iso: isoDay(-1), label: 'Včera' },
      { iso: isoDay(-2), label: fmtDayLabel(isoDay(-2)) },
    ];
    wrap.innerHTML = chips.map(function (c) {
      return '<button type="button" class="doch-fix-day" data-day="' + c.iso + '">' +
        escapeHtml(c.label) + '</button>';
    }).join('');
    wrap.querySelectorAll('.doch-fix-day').forEach(function (b) {
      b.addEventListener('click', function () {
        $('fixDate').value = b.dataset.day;
        wrap.querySelectorAll('.doch-fix-day').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        setFixError('');
      });
    });
  }

  function openFix() {
    if (!currentStaff || !pin) return;
    setFixError('');
    $('fixForm').hidden = false;
    $('fixList').hidden = true;
    $('tabNew').classList.add('active');
    $('tabNew').setAttribute('aria-selected', 'true');
    $('tabMine').classList.remove('active');
    $('tabMine').setAttribute('aria-selected', 'false');

    renderFixDays();
    var d = $('fixDate');
    d.max = isoDay(0);
    d.min = isoDay(-REQUEST_MAX_AGE_DAYS);
    d.value = isoDay(0);
    $('fixIn').value = '';
    $('fixOut').value = '';
    $('fixNote').value = '';
    syncOutRequirement();
    var firstChip = $('fixDays').querySelector('.doch-fix-day');
    if (firstChip) firstChip.classList.add('active');

    $('fixOverlay').hidden = false;
    scheduleFixAutoClose();
  }

  function submitFix(ev) {
    ev.preventDefault();
    // Bez PINu sa odoslať nedá — a NESMIE to byť tiché `return`, inak
    // tlačidlo vyzerá pokazené.
    if (!pin) {
      setFixError('Odhlásilo ťa to. Zavri okno a zadaj PIN znova.');
      return;
    }
    setFixError('');

    var type = selectedFixType();
    var body = {
      pin: pin,
      type: type,
      targetDate: $('fixDate').value,
      claimedIn: $('fixIn').value,
      note: $('fixNote').value || '',
    };
    var out = $('fixOut').value;
    if (out) body.claimedOut = out;

    if (!body.targetDate) { setFixError('Vyber deň.'); return; }
    if (!body.claimedIn) { setFixError('Zadaj čas príchodu.'); return; }
    if (type === 'missing_day' && !out) { setFixError('Pri zabudnutom dni zadaj aj odchod.'); return; }
    if (out && out <= body.claimedIn) { setFixError('Odchod musí byť neskôr ako príchod.'); return; }

    var btn = $('fixSubmit');
    btn.disabled = true;
    postJson('/api/attendance/requests', body).then(function (res) {
      btn.disabled = false;
      if (!res.ok) {
        setFixError((res.data && res.data.error) || 'Žiadosť sa nepodarilo odoslať.');
        return;
      }
      showToast('Žiadosť odoslaná manažérovi', true);
      closeFix();
      resetSoon();
    }).catch(function () {
      btn.disabled = false;
      setFixError('Bez pripojenia sa žiadosť nedá odoslať.');
    });
  }

  var FIX_STATUS = {
    pending:  { label: 'Čaká na schválenie', cls: 'pending' },
    approved: { label: 'Schválené', cls: 'approved' },
    rejected: { label: 'Zamietnuté', cls: 'rejected' },
  };

  function renderFixList(rows) {
    var el = $('fixList');
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="doch-fix-empty">Zatiaľ si nič nenahlásil.</div>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var st = FIX_STATUS[r.status] || FIX_STATUS.pending;
      var day = String(r.targetDate).slice(0, 10);
      var times = fmtTime(r.claimedIn) + (r.claimedOut ? ' – ' + fmtTime(r.claimedOut) : '');
      var typeLabel = r.type === 'missing_day' ? 'Zabudnutý deň' : 'Neskorý PIN';
      return '<div class="doch-fix-item">' +
        '<div class="doch-fix-item-head">' +
          '<span class="doch-fix-item-day">' + escapeHtml(fmtDayLabel(day)) + '</span>' +
          '<span class="doch-fix-badge ' + st.cls + '">' + escapeHtml(st.label) + '</span>' +
        '</div>' +
        '<div class="doch-fix-item-body">' +
          escapeHtml(typeLabel) + ' · ' + escapeHtml(times) +
        '</div>' +
        (r.note ? '<div class="doch-fix-item-note">' + escapeHtml(r.note) + '</div>' : '') +
        (r.reviewNote ? '<div class="doch-fix-item-review">Manažér: ' + escapeHtml(r.reviewNote) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function openMyRequests() {
    if (!pin) return;
    postJson('/api/attendance/my-requests', { pin: pin }).then(function (res) {
      if (!res.ok) { showToast((res.data && res.data.error) || 'Chyba', false); return; }
      renderFixList(res.data.requests);
      $('fixForm').hidden = true;
      $('fixList').hidden = false;
      $('tabMine').classList.add('active');
      $('tabMine').setAttribute('aria-selected', 'true');
      $('tabNew').classList.remove('active');
      $('tabNew').setAttribute('aria-selected', 'false');
      scheduleFixAutoClose();
    });
  }

  $('btnFix').addEventListener('click', openFix);
  $('fixClose').addEventListener('click', closeFix);
  $('fixForm').addEventListener('submit', submitFix);
  $('tabNew').addEventListener('click', function () {
    $('fixForm').hidden = false;
    $('fixList').hidden = true;
    $('tabNew').classList.add('active');
    $('tabNew').setAttribute('aria-selected', 'true');
    $('tabMine').classList.remove('active');
    $('tabMine').setAttribute('aria-selected', 'false');
    scheduleFixAutoClose();
  });
  $('tabMine').addEventListener('click', openMyRequests);
  document.querySelectorAll('input[name="fixType"]').forEach(function (r) {
    r.addEventListener('change', function () { syncOutRequirement(); setFixError(''); });
  });
  $('fixOverlay').addEventListener('click', scheduleFixAutoClose);
  $('fixOverlay').addEventListener('touchstart', scheduleFixAutoClose, { passive: true });

  document.addEventListener('keydown', function (e) {
    // Kým je otvorený formulár opravy, číslice patria do políčok, nie do PINu.
    var fixOpen = !$('fixOverlay').hidden;
    if (fixOpen) {
      if (e.key === 'Escape') closeFix();
      return;
    }
    if (/^\d$/.test(e.key)) {
      if (pin.length >= 6) return;
      pin += e.key; renderPin();
      scheduleIdentify();
    } else if (e.key === 'Backspace') {
      pin = pin.slice(0, -1); renderPin(); scheduleIdentify();
    } else if (e.key === 'Escape') {
      clearTimeout(identifyTimer);
      pin = ''; renderPin(); renderStatus(null);
    }
  });

  renderPin();
  renderStatus(null);
})();
