// El service worker es el archivo de mayor consecuencia del proyecto: si falla,
// el guardia abre la app en una ronda sin señal y ve una pantalla en blanco. No
// hay reintento ni mensaje de error — se queda sin poder marcar la ronda entera.
//
// sw-shell.test.js lee el arreglo SHELL como TEXTO. Esto ejecuta los handlers de
// verdad, con un Cache Storage y un fetch de mentira, y hace el recorrido
// completo: instalar → precachear → cortar la red → pedir la app. Es lo más
// cerca de "modo avión + purgar caché" que se puede llegar sin un teléfono, y
// cubre lo que la lectura estática no ve: que la estrategia network-first
// realmente caiga al caché, y que caiga con las llaves correctas.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ORIGEN = 'https://rondas.test/';

// Cache Storage de mentira, con la semántica que importa: addAll() resuelve las
// rutas relativas contra el scope del service worker, y match() busca por URL
// absoluta. Modelarlo mal haría pasar el test con un SHELL roto.
function cacheStorageFalso() {
  const cachés = new Map();
  const abrir = nombre => {
    if (!cachés.has(nombre)) cachés.set(nombre, new Map());
    const almacen = cachés.get(nombre);
    return {
      addAll: rutas => Promise.all(rutas.map(r => {
        const url = new URL(r, ORIGEN).href;
        // Un 404 hace fallar addAll() ENTERO en un service worker real: la
        // instalación se cae y el usuario queda con el worker viejo (o sin uno).
        if (!existeEnDisco(r)) return Promise.reject(new Error(`404 ${r}`));
        almacen.set(url, { cuerpo: `contenido de ${r}`, desde: 'precache' });
        return Promise.resolve();
      })),
      put: (req, resp) => {
        almacen.set(new URL(req.url, ORIGEN).href, resp);
        return Promise.resolve();
      }
    };
  };
  return {
    _cachés: cachés,
    open: nombre => Promise.resolve(abrir(nombre)),
    keys: () => Promise.resolve([...cachés.keys()]),
    delete: nombre => Promise.resolve(cachés.delete(nombre)),
    match: req => {
      const url = new URL(typeof req === 'string' ? req : req.url, ORIGEN).href;
      for (const almacen of cachés.values()) {
        if (almacen.has(url)) return Promise.resolve(almacen.get(url));
      }
      return Promise.resolve(undefined);
    }
  };
}

const publico = path.join(__dirname, '..', 'public');
function existeEnDisco(ruta) {
  if (ruta === './') return true;
  // vendor/jsqr.js lo sirve el servidor desde node_modules, no vive en public/.
  if (ruta.startsWith('vendor/')) return true;
  return fs.existsSync(path.join(publico, ruta));
}

// Monta sw.js en un worker de mentira y devuelve sus handlers.
function montarSw() {
  const handlers = {};
  const ctx = {
    self: {
      addEventListener: (tipo, fn) => { handlers[tipo] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
      registration: { showNotification: () => Promise.resolve(), scope: ORIGEN }
    },
    caches: cacheStorageFalso(),
    fetch: () => Promise.reject(new Error('sin red')),
    URL, console
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
  return { ctx, handlers };
}

// Dispara un handler y devuelve la promesa que el service worker retuvo.
const instalar = handlers => new Promise((res, rej) => {
  handlers.install({ waitUntil: p => p.then(res, rej) });
});
const pedir = (handlers, url, metodo = 'GET') => new Promise(res => {
  let respondio = false;
  handlers.fetch({
    request: { url, method: metodo },
    respondWith: p => { respondio = true; Promise.resolve(p).then(res); }
  });
  // Sin respondWith el service worker deja pasar la petición a la red.
  if (!respondio) res('PASA_DE_LARGO');
});

test('instalar precachea el shell completo sin caerse', async () => {
  // Si addAll() falla —un archivo del SHELL que no existe— la instalación se
  // cae entera y el teléfono se queda con el worker viejo, sin el archivo nuevo.
  const { ctx, handlers } = montarSw();
  await instalar(handlers);
  const almacen = [...ctx.caches._cachés.values()][0];
  assert.ok(almacen.size >= 10, `solo se precachearon ${almacen.size} archivos`);
  assert.ok(almacen.has(ORIGEN + 'geo.js'), 'geo.js no quedó en el caché');
  assert.ok(almacen.has(ORIGEN + 'app.js'), 'app.js no quedó en el caché');
  assert.ok(almacen.has(ORIGEN), 'la raíz no quedó en el caché');
});

test('CRÍTICO sin red, la app del guardia se sirve entera desde el caché', async () => {
  // El recorrido de "modo avión + purgar caché + abrir la app". Cada uno de
  // estos archivos que no responda es una pantalla en blanco en una ronda.
  const { handlers } = montarSw();
  await instalar(handlers);
  for (const archivo of ['', 'index.html', 'app.js', 'geo.js', 'estilos.css', 'vendor/jsqr.js']) {
    const resp = await pedir(handlers, ORIGEN + archivo);
    assert.ok(resp && resp !== 'PASA_DE_LARGO', `sin red, "${archivo || '/'}" no lo sirve nadie`);
  }
});

test('con red se sirve la versión fresca y se reguarda en caché', async () => {
  // network-first: los despliegues llegan solos al teléfono, sin reinstalar.
  const { ctx, handlers } = montarSw();
  await instalar(handlers);
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, cuerpo: 'app.js recién salido', clone: () => ({ cuerpo: 'copia' }) });
  const resp = await pedir(handlers, ORIGEN + 'app.js');
  assert.equal(resp.cuerpo, 'app.js recién salido', 'sirvió el caché habiendo red');
  await new Promise(r => setImmediate(r));
  assert.equal((await ctx.caches.match(ORIGEN + 'app.js')).cuerpo, 'copia', 'no reguardó la versión fresca');
});

test('CRÍTICO un error del servidor a mitad de deploy no reemplaza la app ni ensucia el caché', async () => {
  // El teléfono de la garita se recarga solo y corre en kiosco. Si justo ahí el
  // proxy contesta 502, esa página de error no puede quedar como "la app": no
  // hay nadie para sacarlo. Se sirve la copia buena y el caché no se toca.
  const { ctx, handlers } = montarSw();
  await instalar(handlers);
  ctx.fetch = () => Promise.resolve({ ok: false, status: 502, cuerpo: 'Application failed to respond', clone: () => ({ cuerpo: 'copia del 502' }) });
  for (const archivo of ['', 'app.js', 'vigia.js']) {
    const resp = await pedir(handlers, ORIGEN + archivo);
    assert.equal(resp.desde, 'precache', `"${archivo || '/'}" sirvió el error del servidor en vez de la copia`);
  }
  await new Promise(r => setImmediate(r));
  assert.equal((await ctx.caches.match(ORIGEN + 'app.js')).desde, 'precache', 'el 502 pisó la copia buena');
});

test('un 404 se entrega tal cual y no se guarda', async () => {
  const { ctx, handlers } = montarSw();
  await instalar(handlers);
  ctx.fetch = () => Promise.resolve({ ok: false, status: 404, cuerpo: 'no existe', clone: () => ({ cuerpo: 'copia' }) });
  const resp = await pedir(handlers, ORIGEN + 'no-existe.js');
  assert.equal(resp.status, 404);
  await new Promise(r => setImmediate(r));
  assert.equal(await ctx.caches.match(ORIGEN + 'no-existe.js'), undefined);
});

test('el API nunca pasa por el caché', async () => {
  // La cola offline vive en la app, no acá. Un /api/ servido desde caché le
  // devolvería al guardia un paquete de rondas viejo como si fuera fresco.
  const { handlers } = montarSw();
  await instalar(handlers);
  assert.equal(await pedir(handlers, ORIGEN + 'api/mi/paquete'), 'PASA_DE_LARGO');
  assert.equal(await pedir(handlers, ORIGEN + 'api/ejecuciones/x/escaneos', 'POST'), 'PASA_DE_LARGO');
  // Y un POST a cualquier cosa tampoco: guardar una marca en caché no tiene sentido.
  assert.equal(await pedir(handlers, ORIGEN + 'app.js', 'POST'), 'PASA_DE_LARGO');
});

test('activar borra los cachés de versiones anteriores', async () => {
  // Sin esto el teléfono acumula un caché por release y sirve mezclas.
  const { ctx, handlers } = montarSw();
  await ctx.caches.open('rondasqr-v1.13.0').then(c => c.put({ url: ORIGEN + 'app.js' }, { cuerpo: 'viejo' }));
  await instalar(handlers);
  await new Promise((res, rej) => handlers.activate({ waitUntil: p => p.then(res, rej) }));
  assert.ok(!ctx.caches._cachés.has('rondasqr-v1.13.0'), 'el caché de la versión anterior sobrevivió');
  assert.equal(ctx.caches._cachés.size, 1);
});
