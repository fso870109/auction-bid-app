const CACHE = 'auction-bid-v100';
const NETWORK_TIMEOUT_MS = 3000;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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
  '/items-catalog.js',
  '/sync-core.js',
  '/sync.js',
  '/global-progress.js',
  '/qrcode.js',
  '/sw.js',
  '/manifest.json',
  '/manifest.webmanifest'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
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
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return path;
}

function isNetworkFirst(request, url) {
  if (request.mode === 'navigate') return true;
  const path = assetPath(url);
  if (NETWORK_FIRST_PATHS.has(path)) return true;
  const base = '/' + path.split('/').pop();
  return NETWORK_FIRST_PATHS.has(base);
}

function putInCache(request, res) {
  if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => {
      cache.put(request, copy);
      if (request.mode === 'navigate') cache.put('./index.html', res.clone());
    });
  }
}

function matchCached(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return caches.match('./index.html').then((html) => html || caches.match('./'));
    }
    return undefined;
  });
}

function networkFirst(request) {
  const network = fetch(request).then((res) => {
    putInCache(request, res);
    return res;
  });
  const limited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
    network.then((res) => {
      clearTimeout(timer);
      resolve(res);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return limited.catch(() =>
    matchCached(request).then((cached) => {
      if (cached) return cached;
      return network.catch(() => new Response('離線，找不到快取', {
        status: 504,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }));
    })
  );
}

function cacheThenNetwork(request) {
  return caches.match(request).then((cached) => {
    const fetching = fetch(request)
      .then((res) => {
        putInCache(request, res);
        return res;
      })
      .catch(() => cached);
    return cached || fetching;
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (isNetworkFirst(event.request, url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(cacheThenNetwork(event.request));
});
