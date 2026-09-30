// Los otros tests montan funciones sueltas de public/app.js. Este carga los DOS
// archivos enteros, en el mismo orden que index.html, dentro de un navegador de
// mentira. Es lo más cerca que se puede llegar sin un teléfono, y cubre lo que
// la extracción por función no ve:
//   · que geo.js quede visible para app.js (si no, la app muere al primer fix);
//   · que el nivel superior de app.js corra sin explotar;
//   · que el camino completo watchPosition → buffer → consolidación → veredicto
//     dé lo que tiene que dar;
//   · que el buffer NO termine serializado en localStorage.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publico = path.join(__dirname, '..', 'public');

// Navegador de mentira: lo justo para que corran los dos <script>. Los elementos
// del DOM no existen, y eso está bien: todo lo que pinta hace `if (!el) return`.
function cargarApp({ almacen = {}, indexedDB, extras = {} } = {}) {
  let alFix = null;
  const ctx = {
    ...(indexedDB ? { indexedDB } : {}),
    ...extras,
    localStorage: {
      getItem: k => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = v; },
      removeItem: k => { delete almacen[k]; }
    },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    navigator: {
      onLine: true,
      userAgent: 'test',
      geolocation: { watchPosition: ok => { alFix = ok; return 1; }, clearWatch() {} }
    },
    matchMedia: () => ({ matches: false }),
    setInterval() {}, setTimeout() {}, console
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  // El mismo orden de index.html. Al revés, app.js no encontraría geo.
  vm.runInContext(fs.readFileSync(path.join(publico, 'geo.js'), 'utf8'), ctx, { filename: 'geo.js' });
  vm.runInContext(fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  vm.runInContext('iniciarGps()', ctx);
  return {
    ctx,
    correr: expr => vm.runInContext(expr, ctx),
    // Simula una lectura del GPS entrando por watchPosition, como en el teléfono.
    fix: (lat, lon, accuracy, ts) => alFix({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: ts })
  };
}

const LAT = -33.45;
const LON = -70.66;
const PUNTO = `{nombre:"Portería",lat:${LAT},lon:${LON},verificacion:"gps",radioM:20,ventanaMs:20000,precisionM:5}`;

test('app.js y geo.js cargan juntos y el GPS queda observándose', () => {
  const app = cargarApp();
  assert.equal(app.correr('typeof geo.centroidePonderado'), 'function', 'app.js no ve geo: la app muere al primer fix');
  assert.notEqual(app.correr('gpsWatchId'), null);
  assert.equal(app.correr('gpsUltimo()'), null, 'sin lecturas todavía no hay fix');
});

test('el guardia parado sobre el punto: la lectura de antena no le mueve la posición', () => {
  const app = cargarApp();
  const ahora = Date.now();
  // Once lecturas de ±8 m repartidas en unos metros alrededor del QR…
  for (let i = 0; i < 11; i++) {
    app.fix(LAT + ((i % 3) - 1) * 0.00005, LON, 8, ahora - (11 - i) * 1000);
  }
  // …y una de antena, a 445 m, que es exactamente la que hacía saltar el
  // "acércate al punto" con alguien encima del QR.
  app.fix(LAT + 0.004, LON, 300, ahora);

  const d = app.correr(`distanciaM(gpsUltimo(), {lat:${LAT}, lon:${LON}})`);
  assert.ok(d <= 3, `el fix consolidado quedó a ${d} m del punto`);

  const v = app.correr(`verificarPresencia(${PUNTO})`);
  assert.equal(v.ok, true, `rechazó a alguien parado encima: ${v.motivo}`);
  // Y el tope no se aflojó para conseguirlo: con un solo fix de ±8 m habría sido
  // 20 + 5 + 8 = 33 m. Promediando queda MÁS estrecho, no más ancho.
  assert.ok(v.topeM <= 33, `el tope se aflojó a ${v.topeM} m`);
});

test('lejos de verdad sigue rechazado, y el veredicto trae con qué registrarlo', () => {
  const app = cargarApp();
  const ahora = Date.now();
  for (let i = 0; i < 8; i++) app.fix(LAT + 0.01, LON, 6, ahora - (8 - i) * 1000);
  const v = app.correr(`verificarPresencia(${PUNTO})`);
  assert.equal(v.ok, false);
  assert.ok(v.distanciaM > 1000);
  assert.ok(v.topeM > 0);
});

test('el buffer de fixes NO se serializa a localStorage', () => {
  const app = cargarApp();
  const ahora = Date.now();
  for (let i = 0; i < 20; i++) app.fix(LAT, LON, 7, ahora - i * 500);
  app.correr('guardarEstado()');
  const guardado = app.ctx.localStorage.getItem('rondasqr');
  assert.ok(guardado, 'guardarEstado() no escribió nada');
  assert.deepEqual(Object.keys(JSON.parse(guardado)).sort(),
    // `rev` es el contador de guardados que decide entre localStorage y el
    // respaldo en IndexedDB al arrancar (ver recuperarRespaldo en app.js).
    ['cola', 'ejecucion', 'paquete', 'rev', 'sesion', 'ultimoInforme'],
    'apareció una clave nueva en el estado persistido: ¿se coló el buffer?');
  assert.ok(app.correr('bufferFixes.length') > 0, 'el buffer sí tiene lecturas — la prueba no es vacía');
});

// ---------- Respaldo en IndexedDB (la ronda sobrevive al apagón) ----------

// IndexedDB de mentira: un Map, con los callbacks asíncronos como el real.
function idbFalso(inicial = {}) {
  const datos = new Map(Object.entries(inicial));
  const durabilidades = [];
  const db = {
    transaction(_, modo, opciones) {
      if (modo === 'readwrite') durabilidades.push(opciones && opciones.durability);
      const tx = {
        objectStore: () => ({
          put(valor, clave) { datos.set(clave, valor); setTimeout(() => tx.oncomplete && tx.oncomplete()); },
          get(clave) {
            const pedido = {};
            setTimeout(() => { pedido.result = datos.get(clave); pedido.onsuccess && pedido.onsuccess(); });
            return pedido;
          }
        })
      };
      return tx;
    },
    objectStoreNames: { contains: () => true },
    createObjectStore() {}
  };
  return {
    datos,
    durabilidades,
    open() {
      const pedido = { result: db };
      setTimeout(() => pedido.onsuccess && pedido.onsuccess());
      return pedido;
    }
  };
}

const esperar = () => new Promise(r => setTimeout(r, 5));
const EJECUCION = '{"id":"e1","rondaId":"r1","inicio":"2026-09-30T02:00:00.000Z","escaneos":[{"puntoId":"p1"}],"cerrada":false}';

test('respaldo: si localStorage quedó atrás (apagón), la ronda se recupera de IndexedDB', async () => {
  const viejo = '{"sesion":{"token":"t"},"paquete":null,"ejecucion":null,"cola":[],"ultimoInforme":null,"rev":3}';
  const nuevo = `{"sesion":{"token":"t"},"paquete":null,"ejecucion":${EJECUCION},"cola":[{"tipo":"escaneo"}],"ultimoInforme":null,"rev":9}`;
  const idb = idbFalso({ actual: nuevo });
  const app = cargarApp({ almacen: { rondasqr: viejo }, indexedDB: idb });
  assert.equal(app.correr('estado.ejecucion'), null, 'arrancó con lo de localStorage');

  const recuperada = await app.correr('recuperarRespaldo()');
  assert.equal(recuperada, true, 'avisa que recuperó una ronda');
  assert.equal(app.correr('estado.ejecucion.id'), 'e1');
  assert.equal(app.correr('estado.cola.length'), 1, 'la cola sin enviar también vuelve');
  assert.equal(JSON.parse(app.ctx.localStorage.getItem('rondasqr')).rev, 9, 'localStorage queda al día');
});

test('respaldo: si localStorage es igual o más nuevo, manda localStorage', async () => {
  const local = `{"sesion":{"token":"t"},"paquete":null,"ejecucion":${EJECUCION},"cola":[],"ultimoInforme":null,"rev":12}`;
  const idb = idbFalso({ actual: '{"sesion":{"token":"t"},"ejecucion":null,"cola":[],"rev":11}' });
  const app = cargarApp({ almacen: { rondasqr: local }, indexedDB: idb });
  assert.equal(await app.correr('recuperarRespaldo()'), false);
  assert.equal(app.correr('estado.ejecucion.id'), 'e1');
  await esperar();
  assert.equal(JSON.parse(idb.datos.get('actual')).rev, 12, 'y se respalda lo de localStorage');
});

test('respaldo: cada guardado llega a IndexedDB con durabilidad estricta', async () => {
  const idb = idbFalso();
  const app = cargarApp({ indexedDB: idb });
  app.correr(`estado.ejecucion = ${EJECUCION}; guardarEstado(); guardarEstado(); guardarEstado();`);
  await esperar();
  await esperar();
  const guardado = JSON.parse(idb.datos.get('actual'));
  assert.equal(guardado.rev, 3, 'queda el último guardado');
  assert.equal(guardado.ejecucion.id, 'e1');
  assert.ok(idb.durabilidades.length >= 1 && idb.durabilidades.every(d => d === 'strict'));
});

test('respaldo: salir no reinicia el contador (si no, el respaldo resucitaría la sesión)', async () => {
  const idb = idbFalso();
  const app = cargarApp({
    indexedDB: idb,
    extras: { fetch: () => Promise.reject(new Error('sin red')), confirm: () => true, clearInterval() {}, clearTimeout() {} }
  });
  app.correr(`estado.sesion = { token: 't' }; estado.ejecucion = ${EJECUCION}; estado.rev = 40;`);
  try { app.correr('salir()'); } catch { /* el render sin DOM puede fallar: lo que importa es el estado */ }
  await esperar();
  await esperar();
  const guardado = JSON.parse(idb.datos.get('actual'));
  assert.equal(guardado.sesion, null);
  assert.ok(guardado.rev > 40, `rev ${guardado.rev}: un rev menor perdería contra el respaldo viejo`);

  // Y al volver a abrir, el respaldo no le gana a localStorage.
  const otra = cargarApp({ almacen: { rondasqr: app.ctx.localStorage.getItem('rondasqr') }, indexedDB: idb });
  assert.equal(await otra.correr('recuperarRespaldo()'), false);
  assert.equal(otra.correr('estado.sesion'), null);
});

test('respaldo: sin IndexedDB (navegador viejo) la app sigue funcionando con localStorage', async () => {
  const app = cargarApp();
  app.correr('guardarEstado()');
  assert.equal(await app.correr('recuperarRespaldo()'), false);
  assert.ok(app.ctx.localStorage.getItem('rondasqr'));
});
