// Service worker: deja la app disponible sin conexión y recibe los push.
//
// Es UNO SOLO para las dos apps (guardia en / y panel en /admin.html): las dos
// se sirven del mismo origen y raíz, y dos registros en el mismo scope se
// pisarían entre sí. Lo que cambia es qué precachea: la ronda tiene que andar
// sin señal, el panel no (todo lo suyo sale del API).
//
// Estrategia: network-first con respaldo en caché. Con conexión, siempre se
// sirve la versión fresca del servidor (los deploys llegan solos a los
// teléfonos); sin conexión, se sirve el shell cacheado y la ronda sigue.
// El API va siempre por red (la cola offline vive en la app, no acá).
//
// VERSION: subirla en cada release (junto con package.json) — invalida el
// caché viejo en activate.
const VERSION = 'v1.21.0';
const CACHE = 'rondasqr-' + VERSION;
const SHELL = [
  // App del guardia: sin esto no hay ronda sin señal.
  './',
  'index.html',
  'app.js',
  // geo.js va ANTES que app.js en index.html y app.js lo necesita para
  // consolidar los fixes. Si falta acá, la app del guardia queda en blanco sin
  // señal después de la primera purga de caché: el <script> no carga y app.js
  // revienta al primer fix. Es el único archivo nuevo del release y la razón de
  // subir VERSION.
  'geo.js',
  // El vigía de arranque: si app.js no arranca, es lo que saca al teléfono de
  // la garita del atasco (ver vigia.js). Tiene que estar también sin señal.
  'vigia.js',
  // Captura de errores: index.html la carga antes de app.js; sin esto la app
  // del guardia queda en blanco sin señal (lo vigila test/sw-shell.test.js).
  'errores.js',
  'estilos.css',
  'manifest.webmanifest',
  'icono.svg',
  'icono-192.png',
  'icono-512.png',
  'vendor/jsqr.js',
  // Sentry (bundle propio, no el CDN): index.html lo carga antes de errores.js;
  // sin esto la app del guardia queda en blanco sin señal.
  'vendor/sentry.js',
  // Panel del administrador: su código se cachea solo al visitarlo. Acá va lo
  // que el navegador pide al instalarlo como app aparte.
  'panel.webmanifest',
  'icono-panel.svg',
  'icono-panel-192.png'
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
      .then(async resp => {
        // Solo se guarda lo que salió bien. Un 502 del proxy a mitad de un
        // deploy no puede pisar la copia buena ni quedar como "la app": en el
        // teléfono de la garita (kiosco) nadie podría sacarlo de ahí. Si el
        // servidor falla y hay copia, se sirve la copia.
        if (resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
          return resp;
        }
        if (resp.status >= 500) {
          const guardada = await caches.match(e.request, { ignoreSearch: true });
          if (guardada) return guardada;
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Push: aviso del panel admin (ronda incompleta) o alarma de ronda en el
// teléfono de la garita. Suena aunque la app esté cerrada.
// La alarma trae `insistente`: queda en pantalla hasta que la toquen y vibra
// fuerte; con `tag` la nueva reemplaza a la anterior en vez de apilarse.
self.addEventListener('push', e => {
  let datos = {};
  try { datos = e.data ? e.data.json() : {}; } catch { /* payload no JSON: se muestra genérico */ }
  const opciones = {
    body: datos.cuerpo || '',
    icon: 'icono-192.png',
    badge: 'icono-192.png',
    data: { url: datos.url || 'admin.html' }
  };
  if (datos.tag) { opciones.tag = datos.tag; opciones.renotify = true; }
  if (datos.insistente) {
    opciones.requireInteraction = true;
    opciones.vibrate = [400, 200, 400, 200, 400];
  }
  e.waitUntil(self.registration.showNotification(datos.titulo || 'Rondas QR', opciones));
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
