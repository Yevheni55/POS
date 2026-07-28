'use strict';
// Registrácia service workera + upozornenie na novú verziu.
//
// PREČO NIE AUTO-RELOAD: sw.js volá skipWaiting() + clients.claim(), takže nový
// worker preberie kontrolu okamžite — ale UŽ NAČÍTANÁ stránka beží ďalej na
// starých js/*.js moduloch. Po deployi tak môže kasa hodiny bežať na starom
// kóde proti novej API schéme a nikto o tom nevie. Automatický reload je ale
// ešte horší: zhodil by rozrobenú QR platbu alebo rozpísaný účet uprostred
// obsluhy. Preto len nenápadný banner — reload si obsluha spustí sama, keď má
// chvíľu.
//
// Načítava sa ako klasický skript na konci <body> (pos-enterprise.html,
// login.html).

(function () {
  if (!('serviceWorker' in navigator)) return;

  var BANNER_ID = 'swUpdateBanner';

  function showUpdateBanner() {
    if (document.getElementById(BANNER_ID)) return;

    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', 'status');
    bar.className = 'sw-update-banner';
    bar.innerHTML =
      '<span class="sw-update-text">Je pripravená nová verzia kasy.</span>' +
      '<button type="button" class="sw-update-btn" id="swUpdateReload">Obnoviť</button>' +
      '<button type="button" class="sw-update-dismiss" id="swUpdateLater" aria-label="Zavrieť">&times;</button>';
    document.body.appendChild(bar);

    document.getElementById('swUpdateReload').addEventListener('click', function () {
      // Reload vyžiada obsluha — nikdy nie my sami.
      window.location.reload();
    });
    document.getElementById('swUpdateLater').addEventListener('click', function () {
      bar.remove();
    });
  }

  navigator.serviceWorker.register('/sw.js').then(function (reg) {
    // Nový worker sa objavil počas behu stránky.
    reg.addEventListener('updatefound', function () {
      var incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', function () {
        // controller != null znamená, že toto NIE je prvá inštalácia, ale
        // aktualizácia bežiacej appky — len vtedy má banner zmysel.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      });
    });

    // Kontrola aktualizácie pri návrate k tabu (typicky ráno pri otvorení
    // kasy) — bez toho by sa update zistil až pri tvrdom reloade.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        try { reg.update(); } catch (e) {}
      }
    });
  }).catch(function (e) {
    console.warn('SW registration failed:', e && e.message);
  });
})();
