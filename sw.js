/* PDF Creator — service worker: offline support + receives files shared from other apps */
const CACHE = 'pdf-creator-v0.2.3';   // bump with VERSION in js/app.js on every release
const SHELL = [
  './', './index.html', './manifest.json', './css/app.css', './js/app.js', './js/basket.js',
  './icons/icon-192.png?v=2', './icons/icon-512.png?v=2',
  './vendor/pdf-lib.min.js',
];
importScripts('./js/basket.js');

// cache: 'reload' skips the browser's HTTP cache, so a new release never stores stale copies
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // "Share → PDF Creator" from WhatsApp, Drive, scanner apps…: Android POSTs the files here
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  // big libraries and icons never change under the same name → cache first
  if (/\/(vendor|icons)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetchAndStore(req)));
    return;
  }
  // the app's own pages, code and manifest → always try the network first, cache when offline
  e.respondWith(fetchAndStore(req, { cache: 'no-cache' }).catch(() =>
    caches.match(req, { ignoreSearch: req.mode === 'navigate' })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});

async function fetchAndStore(req, init) {
  const res = await fetch(req.mode === 'navigate' ? req.url : req, init);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    const key = req.mode === 'navigate' ? './index.html' : req;
    caches.open(CACHE).then((c) => c.put(key, copy));
  }
  return res;
}

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
