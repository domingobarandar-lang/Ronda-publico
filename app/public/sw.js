// Service worker: deja la app (guardia + panel admin) disponible sin conexión.
//
// Estrategia: network-first con respaldo en caché. Con conexión, siempre se
// sirve la versión fresca del servidor (los deploys llegan solos a los
// teléfonos); sin conexión, se sirve el shell cacheado y la ronda sigue.
// El API va siempre por red (la cola offline vive en la app, no acá).
//
// VERSION: subirla en cada release (junto con package.json) — invalida el
// caché viejo en activate.
const VERSION = 'v1.4.0';
const CACHE = 'rondasqr-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'app.js',
  'estilos.css',
  'admin.html',
  'admin.js',
  'admin.css',
  'manifest.webmanifest',
  'icono.svg',
  'icono-192.png',
  'icono-512.png',
  'vendor/jsqr.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copia = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Aviso push del panel admin (ronda incompleta): suena aunque la app esté cerrada.
self.addEventListener('push', e => {
  let datos = {};
  try { datos = e.data ? e.data.json() : {}; } catch { /* payload no JSON: se muestra genérico */ }
  e.waitUntil(self.registration.showNotification(datos.titulo || 'Rondas QR', {
    body: datos.cuerpo || '',
    icon: 'icono-192.png',
    badge: 'icono-192.png',
    data: { url: datos.url || 'admin.html' }
  }));
});

// Tocar la notificación abre el informe de esa ronda (o enfoca la pestaña si ya está abierta).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const destino = new URL((e.notification.data || {}).url || 'admin.html', self.registration.scope).href;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ventanas => {
      const abierta = ventanas.find(v => v.url === destino);
      return abierta ? abierta.focus() : clients.openWindow(destino);
    })
  );
});
