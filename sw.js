// Service worker. The cache name token "__SW_VERSION__" is replaced by the
// server (server/app.js GET /sw.js) with the current build version on every
// fetch — that way each new deploy ships a different sw.js bytewise, the
// browser detects the update, install runs, and any old caches get pruned.
// No more Ctrl+Shift+R after every deploy.
var CACHE_NAME = 'pos-__SW_VERSION__';

// Pre-cached for offline use. URLs MUST exist or cache.addAll rejects and the
// whole SW install fails silently — keep the list tight + verified.
//
// POZOR na verzovacie query stringy: HTML nacitava napr.
// `/js/pos-render.js?v=20260629name`, kym tu je precachnute holé
// `/js/pos-render.js`. To su pre Cache API DVA RÔZNE kľúče, takže offline
// hľadanie predtým minulo 5 z 8 POS skriptov aj `/css/pos.css` a kasa sa
// offline vôbec nenaštartovala. Rieši to `ignoreSearch: true` v `caches.match`
// nižšie — a keďže sieť je aj tak vždy prvá, žiadnu čerstvosť tým nestrácame.
var STATIC_ASSETS = [
  '/',
  '/login.html',
  '/pos-enterprise.html',
  '/kitchen.html',
  '/admin/index.html',
  '/css/pos.css',
  '/css/pos-dark.css',
  '/css/kitchen.css',
  '/tokens.css',
  '/a11y.css',
  '/js/pos-state.js',
  '/js/pos-render.js',
  '/js/pos-orders.js',
  '/js/pos-payments.js',
  '/js/pos-ui.js',
  '/js/pos-init.js',
  '/js/pos-mobile.js',
  '/js/pos-escape.js',
  '/js/pos-product-icons.js',
  '/js/pos-sw-update.js',
  '/js/kitchen.js',
  '/api.js',
  '/components/escHtml.js',
  '/components/toast.js',
  '/components/loading.js',
  '/components/confirm.js',
  '/components/icons.js',
  '/components/validate.js',
  // Socket.io klient je staticky subor ako kazdy iny — bez neho je `io`
  // undefined a boot spadne. (Samotne spojenie /socket.io/?EIO=... sa
  // necachuje, viz fetch handler.)
  '/socket.io/socket.io.min.js',
  // Self-hosted fonty (predtym sa tahali z fonts.googleapis.com, takze sa
  // precachovat ani nedali).
  '/fonts/fonts.css',
  '/fonts/outfit-latin.woff2',
  '/fonts/outfit-latin-ext.woff2',
  '/fonts/jetbrains-mono-latin.woff2',
  '/fonts/jetbrains-mono-latin-ext.woff2',
  '/manifest.json',
  '/dochadzka.html',
  '/js/dochadzka.js',
  '/css/dochadzka.css',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        // Use addAll-but-tolerant: a single 404 must not abort the whole install.
        return Promise.all(STATIC_ASSETS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] precache miss', url, err.message);
          });
        }));
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Offline fallback: najprv presna zhoda, potom bez query stringu (verzovane
// `?v=` URL), a pre navigacie nakoniec cely dokument z precache.
function cacheFallback(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return caches.match(request, { ignoreSearch: true }).then(function (hit2) {
      if (hit2) return hit2;
      if (request.mode === 'navigate') {
        return caches.match('/pos-enterprise.html', { ignoreSearch: true });
      }
      return undefined;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // API sa necachuje nikdy.
  if (url.pathname.startsWith('/api/')) return;
  // Socket.io: samotny transport (polling/websocket handshake) obchadzame,
  // ale klientsky .js subor je bezny staticky asset a cachovat sa MUSI.
  if (url.pathname.startsWith('/socket.io/') && !url.pathname.endsWith('.js')) return;

  // /uploads/menu/<id>.<ext>?v=<ts> — let the cache-bust querystring drive
  // freshness; cache the resolved URL on success and serve from cache offline.
  // The default network-first below already does the right thing.

  // Network-first for HTML/JS/CSS/images. Falls back to cache when offline.
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (response) {
      if (response && response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
      }
      return response;
    }).catch(function () {
      return cacheFallback(e.request);
    })
  );
});
