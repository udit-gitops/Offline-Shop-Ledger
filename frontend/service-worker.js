/*
  service-worker.js — makes the app open without internet.

  It only deals with the app's FILES (HTML, CSS, JS, icon) using the Cache API.
  Business data (products, sales, ...) is NOT stored here; that lives in IndexedDB.

  Strategy: "network first, cache as fallback"
    - online  -> fetch the fresh file and update the copy in the cache
    - offline -> the fetch fails, so serve the copy from the cache

  Change CACHE_NAME whenever the list of files changes, so old caches are removed.
*/
const CACHE_NAME = 'shop-ledger-v3';

const APP_FILES = [
  './',
  'index.html',
  'products.html',
  'sales.html',
  'customers.html',
  'reports.html',
  'css/style.css',
  'js/db.js',
  'js/sync.js',
  'js/app.js',
  'js/dashboard.js',
  'js/products.js',
  'js/sales.js',
  'js/customers.js',
  'js/reports.js',
  'manifest.json',
  'assets/icon.svg',
  'assets/chart.umd.min.js',
];

// Install: download and cache every app file once.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())
  );
});

// Activate: delete caches left behind by older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // API calls are never cached: sync.js must see the real success or failure.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      // ignoreSearch: "customers.html?id=..." should still find "customers.html".
      .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || Response.error()))
  );
});
