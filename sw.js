/* ============================================================
   sw.js — service worker for offline app-shell caching.

   The app shell (HTML/CSS/JS/icons) is precached so the app opens
   and runs fully offline. iTunes API calls and remote artwork are
   intentionally NOT cached here — those are live lookups that
   require signal; artwork is instead copied into IndexedDB by the
   app once fetched, which is what makes covers work offline.
   ============================================================ */

const CACHE = 'brera-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/itunes.js',
  './js/util.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
  './assets/alfa-badge.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // addAll fails atomically if any file 404s (e.g. the user hasn't
      // supplied the badge yet), so add individually and ignore misses.
      Promise.all(SHELL.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept iTunes / remote artwork — always go to network.
  if (url.origin !== self.location.origin) return;

  // App shell: cache-first, fall back to network, then update cache.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
