const CACHE = 'auction-bid-v115';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './compat.js',
  './items-catalog.js',
  './sync-core.js',
  './qrcode.js',
  './sync.js',
  './global-progress.js',
  './manifest.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './fonts/inter-700.woff2',
  './fonts/inter-800.woff2'
];

const NETWORK_FIRST_PATHS = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/compat.js',
  '/items-catalog.js',
  '/sync-core.js',
  '/sync.js',
  '/global-progress.js',
  '/qrcode.js',
  '/sw.js',
  '/manifest.json',
  '/manifest.webmanifest'
]);

/* v114: cache first. Every file of one version is stored together when the new
   worker installs, and the app is always opened from that set, so a bad signal at
   the market no longer makes the app wait up to 3 s for the network. A new version
   is downloaded in the background (the browser checks sw.js), installs as a whole,
   takes over, and the page reloads by itself (or the user presses 檢查更新). */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function assetPath(url) {
  return url.pathname.replace(/\/+$/, '') || '/';
}

function isCoreAsset(request, url) {
  if (request.mode === 'navigate') return true;
  const path = assetPath(url);
  if (NETWORK_FIRST_PATHS.has(path)) return true;
  return NETWORK_FIRST_PATHS.has('/' + path.split('/').pop());
}

function putInCache(request, res) {
  if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
}

function offlineResponse() {
  return new Response('離線，找不到快取', {
    status: 504,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// The app files of this version: straight from this version's cache. Only when a
// file is missing (first run, cache cleared) go to the network.
function coreFromCache(request) {
  const opts = { ignoreSearch: true };
  const lookup = request.mode === 'navigate'
    ? caches.open(CACHE).then((c) => c.match('./index.html', opts).then((r) => r || c.match('./', opts)))
    : caches.open(CACHE).then((c) => c.match(request, opts));
  // A miss (first run, or 檢查更新 cleared the cache): ask the server, not the
  // browser's own HTTP cache, so a fresh update never gets yesterday's file.
  const fresh = () => fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
  return lookup.then((cached) => cached || fresh().then((res) => {
    if (request.mode !== 'navigate') putInCache(request, res);
    return res;
  }).catch(() => offlineResponse()));
}

// Pictures, fonts and other extras: cache first, refresh quietly.
function cacheThenRefresh(request) {
  return caches.match(request).then((cached) => {
    const fetching = fetch(request).then((res) => { putInCache(request, res); return res; }).catch(() => cached || offlineResponse());
    return cached || fetching;
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  // Version check (檢查更新) and the worker file itself always ask the server.
  if (assetPath(url) === '/sw.js' || url.searchParams.has('check')) return;
  if (isCoreAsset(event.request, url)) {
    event.respondWith(coreFromCache(event.request));
    return;
  }
  event.respondWith(cacheThenRefresh(event.request));
});

// The page can ask a waiting worker to take over now (檢查更新).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
