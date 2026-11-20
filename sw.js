/* Service worker: копилка открывается и без интернета.
   Сначала берём свежие файлы из сети, при её отсутствии — из кэша. */
const CACHE = 'kopilka-v2';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/night-180.png', 'icons/night-192.png', 'icons/night-512.png', 'icons/night-maskable-512.png',
  'icons/jar-180.png', 'icons/jar-192.png', 'icons/jar-512.png', 'icons/jar-maskable-512.png',
  'icons/sun-180.png', 'icons/sun-192.png', 'icons/sun-512.png', 'icons/sun-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
      )
  );
});
