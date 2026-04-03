'use strict';
(function () {
  var KEY = 'pos_header_template';
  var ORDER = ['default', 'rail', 'command', 'ledger'];
  var LABELS = {
    default: 'Štandard',
    rail: 'Lišta (mint)',
    command: 'Panel (operácie)',
    ledger: 'Kniha (minimal)',
  };

  function setTemplate(t) {
    var header = document.getElementById('appHeader');
    var btn = document.getElementById('headerLayoutBtn');
    if (!header) return;
    if (t === 'default') header.removeAttribute('data-header-template');
    else header.setAttribute('data-header-template', t);
    try {
      localStorage.setItem(KEY, t);
    } catch (e) { /* ignore */ }
    if (btn) {
      var label = LABELS[t] || LABELS.default;
      btn.setAttribute('aria-label', 'Prepínač vzhľadu hlavičky, teraz: ' + label);
      btn.title = label + ' — kliknite pre ďalší';
    }
  }

  function cycle() {
    var header = document.getElementById('appHeader');
    if (!header) return;
    var cur = header.getAttribute('data-header-template') || 'default';
    var ix = ORDER.indexOf(cur);
    if (ix < 0) ix = 0;
    setTemplate(ORDER[(ix + 1) % ORDER.length]);
  }

  var saved = 'default';
  try {
    saved = localStorage.getItem(KEY) || 'default';
  } catch (e) { /* ignore */ }
  if (ORDER.indexOf(saved) < 0) saved = 'default';
  setTemplate(saved);

  var btn = document.getElementById('headerLayoutBtn');
  if (btn) btn.addEventListener('click', cycle);
})();
