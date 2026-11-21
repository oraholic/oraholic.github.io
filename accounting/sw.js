/* 오라홀릭 회계 정산 — service worker
   /accounting/ 하위 경로에서만 동작하도록 상대 경로만 사용합니다.
   예약 앱(/)의 캐시와 섞이지 않도록 캐시 이름을 따로 쓰고, 자기 캐시만 지웁니다. */
const CACHE = 'oraholic-accounting-v1.0.1';
const PREFIX = 'oraholic-accounting-';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // Firebase 동기화 요청은 그대로 통과
  const scope = self.registration ? new URL(self.registration.scope).pathname : new URL('./', self.location.href).pathname;
  if (url.pathname.indexOf(scope) !== 0) return;        // 이 앱 경로 밖은 건드리지 않음

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return r;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
