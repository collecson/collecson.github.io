/* Collecson phone app. App files come from this site; collection data always comes live
   from the collector's own Apps Script and is never cached here. */
const CACHE = 'collecson-app-cs94-20261122a';
const BASE = new URL(self.registration.scope).pathname;   // wherever the app is hosted
const SHELL = ['./', './index.html', './app.js?cs94-20261122a', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './lib/zxing.min.js?v4', './assets/LuckiestGuy-Regular.ttf', './assets/nunito.woff2', './assets/baloo2.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => (k.indexOf('collecson-app-') === 0 || k.indexOf('ck-app-') === 0) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(BASE) !== 0) return;
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./', { ignoreSearch: true }))));
});
