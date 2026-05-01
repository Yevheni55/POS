'use strict';
// Standalone dochadzka terminal — no JWT, no api.js. Talks only to
// /api/attendance/identify and /api/attendance/clock with a PIN.

(function () {
  var pin = '';
  var currentStaff = null;
  var currentState = 'clocked_out';
  var resetTimer = null;

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

  function tryIdentify() {
    if (pin.length < 4) return;
    postJson('/api/attendance/identify', { pin: pin }).then(function (res) {
      if (!res.ok) {
        showToast(res.data.error || 'Neplatny PIN', false);
        pin = ''; renderPin();
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
      if (pin.length >= 4) tryIdentify();
    });
  });
  $('pinClr').addEventListener('click', function () { pin = ''; renderPin(); renderStatus(null); });
  $('pinBk').addEventListener('click', function () { pin = pin.slice(0, -1); renderPin(); });
  $('btnIn').addEventListener('click', function () { clock('clock_in'); });
  $('btnOut').addEventListener('click', function () { clock('clock_out'); });

  document.addEventListener('keydown', function (e) {
    if (/^\d$/.test(e.key)) {
      if (pin.length >= 6) return;
      pin += e.key; renderPin();
      if (pin.length >= 4) tryIdentify();
    } else if (e.key === 'Backspace') {
      pin = pin.slice(0, -1); renderPin();
    } else if (e.key === 'Escape') {
      pin = ''; renderPin(); renderStatus(null);
    }
  });

  renderPin();
  renderStatus(null);
})();
