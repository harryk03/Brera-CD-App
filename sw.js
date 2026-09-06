/* ============================================================
   sw.js — service worker for offline app-shell caching.

   The app shell (HTML/CSS/JS/icons) is precached so the app opens
   and runs fully offline. iTunes API calls and remote artwork are
   intentionally NOT cached here — those are live lookups that
   require signal; artwork is instead copied into IndexedDB by the
   app once fetched, which is what makes covers work offline.
   ============================================================ */

const CACHE = 'brera-shell-v6';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/itunes.js',
  './js/spotify.js',
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
    caches.keys().then(keys => {
      const old = keys.filter(k => k !== CACHE);
      // If there were old caches, notify all clients that an update is ready.
      if (old.length > 0) {
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'update-ready' }));
        });
      }
      return Promise.all(old.map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept iTunes / remote artwork — always go to network.
  if (url.origin !== self.location.origin) return;

  // App shell: stale-while-revalidate. Serve the cached copy immediately
  // (fast + works offline), but always fetch a fresh copy in the background
  // and update the cache, so the NEXT launch picks up any deploy without any
  // manual steps. Pure cache-first would freeze the installed app on an old
  // build forever; this keeps it self-updating.
  event.respondWith(
    caches.open(CACHE).then(cache =>
      // ignoreSearch: the Spotify sign-in redirect lands on "/?code=…", which
      // must still resolve to the cached app shell (and work offline).
      cache.match(req, { ignoreSearch: true }).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
