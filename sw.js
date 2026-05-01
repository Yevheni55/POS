// Service worker. The cache name token "__SW_VERSION__" is replaced by the
// server (server/app.js GET /sw.js) with the current build version on every
// fetch — that way each new deploy ships a different sw.js bytewise, the
// browser detects the update, install runs, and any old caches get pruned.
// No more Ctrl+Shift+R after every deploy.
var CACHE_NAME = 'pos-__SW_VERSION__';

// Pre-cached for offline use. URLs MUST exist or cache.addAll rejects and the
// whole SW install fails silently — keep the list tight + verified.
var STATIC_ASSETS = [
  '/',
  '/login.html',
  '/pos-enterprise.html',
  '/kitchen.html',
  '/admin/index.html',
  '/css/pos.css',
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
  '/js/kitchen.js',
  '/api.js',
  '/components/toast.js',
  '/components/loading.js',
  '/components/confirm.js',
  '/fonts/fonts.css',
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

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // API + sockets: never cached.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }
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
      return caches.match(e.request);
    })
  );
});
