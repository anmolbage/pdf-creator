/* PDF Creator — service worker: offline app shell + receives files shared from other apps */
const CACHE = 'pdf-creator-v0.2.1';   // bump with VERSION in js/app.js on every release
const SHELL = [
  './', './index.html', './manifest.json', './css/app.css', './js/app.js', './js/basket.js',
  './icons/icon-192.png', './icons/icon-512.png',
  './vendor/pdf-lib.min.js',
];
importScripts('./js/basket.js');

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
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // "Share → PDF Creator" from WhatsApp, Drive, scanner apps…: Android POSTs the files here
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  const opts = e.request.mode === 'navigate' ? { ignoreSearch: true } : undefined;
  e.respondWith(caches.match(e.request, opts).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && e.request.mode !== 'navigate') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});

async function receiveShare(request) {
  let n = 0;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    await Basket.add(files);
    n = files.length;
  } catch (err) {
    console.error('share failed', err);
  }
  return Response.redirect(new URL('./?shared=' + n, self.registration.scope).href, 303);
}
