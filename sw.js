var CACHE_NAME = 'pos-v10';
var STATIC_ASSETS = [
  '/',
  '/login.html',
  '/pos-enterprise.html',
  '/kitchen.html',
  '/admin/index.html',
  '/admin-dashboard.html',
  '/admin-menu.html',
  '/admin-tables.html',
  '/admin-settings.html',
  '/admin-reports.html',
  '/admin-staff.html',
  '/css/pos.css?v=12',
  '/css/kitchen.css',
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
  '/fonts/bricolage-grotesque-latin.woff2',
  '/fonts/bricolage-grotesque-latin-ext.woff2',
  '/fonts/newsreader-latin.woff2',
  '/fonts/newsreader-latin-ext.woff2',
  '/manifest.json'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
          .map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // API calls & socket.io — network only
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }

  // Network first for everything — fallback to cache only when offline
  e.respondWith(
    fetch(e.request).then(function(response) {
      if (response.ok && e.request.method === 'GET') {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
      }
      return response;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});