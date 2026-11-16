/* PDF Creator — service worker (app shell cache, offline first) */
const CACHE = 'pdf-creator-v0.1.0';   // bump with VERSION in js/app.js on every release
const SHELL = [
  './', './index.html', './manifest.json', './css/app.css', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png',
  './vendor/pdf-lib.min.js',
];
// big converters are cached the first time they are used
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
