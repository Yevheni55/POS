// Alarm pre online objednávky — spoločný pre KDS (kitchen.html) a kasu
// (pos-enterprise.html): zvuk, vibrácia (Android), wake lock proti zhasnutiu.
//
// Prehliadač drží AudioContext „suspended", kým sa používateľ obrazovky
// nedotkne — KDS sa ráno načíta bez dotyku a prvá objednávka dňa by bola
// nemá. Preto: odomknutie pri PRVOM geste (pointerdown/keydown), znovu pri
// návrate do karty, a kto sa pýta (`isUnlocked`), vie ukázať „Klepnite pre
// zapnutie zvuku". Alarm sa opakuje každých 20 s, po 3 minútach hlasnejšie,
// kým ho niekto nezastaví (prijatie, odmietnutie, „Neskôr").
(function () {
  'use strict';

  var ctx = null, loopTimer = null, startedAt = 0, kind = 'web', wake = null, listeners = [];
  var REPEAT_MS = 20000, LOUD_AFTER_MS = 180000;

  function ensureCtx() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
    return ctx;
  }
  function isUnlocked() { return !!(ctx && ctx.state === 'running'); }
  function notify() { listeners.forEach(function (f) { try { f(isUnlocked()); } catch (e) { /* nič */ } }); }

  function unlock() {
    var c = ensureCtx();
    if (!c) return Promise.resolve(false);
    var p = c.state === 'suspended' ? c.resume() : Promise.resolve();
    return p.then(function () { notify(); requestWake(); return isUnlocked(); }).catch(function () { return false; });
  }

  function tone(freq, at, dur, gain) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = freq; g.gain.value = gain;
    o.start(at); g.gain.exponentialRampToValueAtTime(0.001, at + dur); o.stop(at + dur);
  }
  // Wolt = tri stúpajúce tóny, web = dva rovnaké — nech je počuť, odkiaľ to je.
  function play(k, loud) {
    vibrate(k);
    if (!isUnlocked()) return false;
    var t = ctx.currentTime, g = loud ? 0.55 : 0.3;
    if (k === 'wolt') { tone(660, t, 0.18, g); tone(880, t + 0.22, 0.18, g); tone(1100, t + 0.44, 0.3, g); }
    else { tone(880, t, 0.3, g); tone(880, t + 0.4, 0.3, g); }
    return true;
  }
  function vibrate(k) {
    try { if (navigator.vibrate) navigator.vibrate(k === 'wolt' ? [300, 100, 300, 100, 300] : [400, 200, 400]); } catch (e) { /* iOS nemá */ }
  }

  function start(k) {
    if (k) kind = k;
    if (loopTimer) return;
    startedAt = Date.now();
    play(kind, false);
    loopTimer = setInterval(function () { play(kind, Date.now() - startedAt > LOUD_AFTER_MS); }, REPEAT_MS);
  }
  function stop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }
  function isRunning() { return !!loopTimer; }

  function requestWake() {
    try {
      if (!navigator.wakeLock || wake) return;
      navigator.wakeLock.request('screen').then(function (l) {
        wake = l; l.addEventListener('release', function () { wake = null; });
      }).catch(function () { /* bez wake locku sa dá žiť */ });
    } catch (e) { /* nič */ }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (ctx && ctx.state === 'suspended') ctx.resume().then(notify).catch(function () {});
    requestWake();
  });
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (!isUnlocked()) unlock(); else requestWake(); }, { passive: true });
  });

  window.ooAlarm = {
    unlock: unlock, isUnlocked: isUnlocked, start: start, stop: stop, isRunning: isRunning,
    play: play, onChange: function (fn) { listeners.push(fn); }, requestWake: requestWake,
  };
})();
