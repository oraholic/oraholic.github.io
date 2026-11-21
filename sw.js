/* 오라홀릭 게스트하우스 — service worker (오프라인 캐시)
   GitHub Pages 하위 경로에서도 동작하도록 상대 경로만 사용합니다. */
const CACHE = 'oraholic-guesthouse-v1.1.2';
const PREFIX = 'oraholic-guesthouse-';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './confirmation.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
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
        // 자기 앱의 옛 캐시만 지웁니다 (회계 앱 'oraholic-accounting-' 캐시는 그대로 둔다)
        keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase 동기화 요청은 그대로 통과

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
