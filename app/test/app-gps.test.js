// Lo que la app del guardia decide SOLA, sin servidor y sin pantalla:
//   consolidarFixes()   convierte el buffer de lecturas del GPS en el fix único
//                       que ve el resto del sistema (v1.14, río arriba del
//                       espejo cliente/servidor).
//   evaluarPendiente()  decide si una marca que quedó esperando señal se acepta,
//                       sigue esperando o se rechaza.
//
// Las dos son puras a propósito: son el único camino nuevo por el que una marca
// puede contar o no contar, y el arnés de paridad-gps.test.js solo puede montar
// lo que no toca el DOM. Se extraen del fuente real —no de una copia— para que
// este test no pueda quedar desfasado del archivo que se despliega.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const motor = require('../lib/rondas');
const geo = require('../public/geo');

const fuente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function extraer(nombre) {
  const i = fuente.indexOf(`function ${nombre}(`);
  assert.ok(i !== -1, `public/app.js ya no define ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

// Los umbrales también salen del fuente: si alguien los mueve en app.js, este
// test tiene que moverse con ellos y no seguir probando un número que ya no es.
function constante(nombre) {
  const m = new RegExp(`const ${nombre} = (\\d+)`).exec(fuente);
  assert.ok(m, `public/app.js ya no define ${nombre}`);
  return m[1];
}

// Monta las funciones del teléfono con las globales que usan. `geo` entra como
// parámetro: en el navegador lo carga geo.js con un <script> antes de app.js.
function montarApp(cfg) {
  const nombres = [
    'cfgGps', 'umbralesDe', 'margenM', 'distanciaM', 'minutos',
    'gpsUltimo', 'verificarPresencia', 'consolidarFixes', 'agregarFix', 'evaluarPendiente'
  ];
  const codigo = `
    let estado = { paquete: { gps: CFG } };
    let gpsActual = null;
    let gpsMotivoFalla = null;
    let bufferFixes = [];
    const BUFFER_MAX = ${constante('BUFFER_MAX')};
    const VENTANA_PENDIENTE_MS = ${constante('VENTANA_PENDIENTE_MS')};
    ${nombres.map(extraer).join('\n')}
    return {
      consolidarFixes, evaluarPendiente, verificarPresencia, gpsUltimo,
      fijarGps: g => { gpsActual = g; },
      alimentar: fixes => { bufferFixes = []; for (const f of fixes) agregarFix(f); return bufferFixes; },
      ventanaMs: VENTANA_PENDIENTE_MS
    };
  `;
  return new Function('CFG', 'geo', codigo)(cfg, geo);
}

const cfg = motor.configGps();
const app = montarApp(cfg);

const LAT = -33.45;
const LON = -70.66;
// Una lectura a `dLatM` metros al norte del punto, tomada hace `edadS` segundos.
const fix = (dLatM, acc, edadS = 0, ahora = Date.now()) => ({
  lat: LAT + dLatM / 111320,
  lon: LON,
  acc,
  ts: ahora - edadS * 1000
});

// ---------- consolidarFixes ----------

test('CRÍTICO consolidarFixes con buffer vacío devuelve null, no {lat: NaN}', () => {
  // {lat: NaN} haría NaN la distancia, "NaN <= topeM" sería false, y el guardia
  // quedaría bloqueado con un mensaje que no explica nada.
  assert.equal(app.consolidarFixes([], Date.now()), null);
  assert.equal(app.consolidarFixes(null, Date.now()), null);
  assert.equal(app.consolidarFixes(undefined, Date.now()), null);
});

test('consolidarFixes promedia y devuelve un fix usable', () => {
  const ahora = Date.now();
  const c = app.consolidarFixes([fix(0, 8, 2, ahora), fix(2, 8, 1, ahora), fix(-2, 8, 0, ahora)], ahora);
  assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), 'el fix consolidado salió NaN');
  assert.ok(Number.isFinite(c.acc) && c.acc > 0);
  assert.ok(geo.metrosEntre({ lat: LAT, lon: LON }, c) < 2);
});

test('consolidarFixes: un fix malo NO desplaza a uno bueno', () => {
  // La propiedad que sostenía mejorFix() hasta v1.13. Ahora la sostiene el peso
  // 1/acc²: la lectura de ±300 m pesa 2.500 veces menos que la de ±6 m.
  const ahora = Date.now();
  const buenos = [fix(0, 6, 3, ahora), fix(1, 6, 2, ahora), fix(-1, 6, 1, ahora)];
  const conBasura = app.consolidarFixes([...buenos, fix(400, 300, 0, ahora)], ahora);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, conBasura);
  assert.ok(d < 5, `la lectura de antena se llevó el fix a ${Math.round(d)} m`);
});

test('consolidarFixes: pasada la ventana de frescura, la lectura nueva manda', () => {
  // Igual que mejorFix(): después de frescoMs el guardia probablemente ya se
  // movió, así que las lecturas viejas dejan de contar aunque fueran mejores.
  const ahora = Date.now();
  const viejoBueno = fix(0, 5, cfg.frescoMs / 1000 + 30, ahora);
  const nuevoPeor = fix(100, 40, 0, ahora);
  const c = app.consolidarFixes([viejoBueno, nuevoPeor], ahora);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, c);
  assert.ok(d > 90, `la lectura vencida siguió mandando (quedó a ${Math.round(d)} m)`);
});

test('consolidarFixes: sin ninguna precisión declarada, el acc sigue siendo desconocido', () => {
  // Declararlo por la dispersión sería inventar confianza sobre datos de calidad
  // ignorada. null hace que margenM() asuma precisionSupuestaM, que es lo justo.
  const ahora = Date.now();
  const c = app.consolidarFixes([fix(0, null, 1, ahora), fix(1, null, 0, ahora)], ahora);
  assert.equal(c.acc, null);
});

test('consolidarFixes nunca declara una precisión mejor que el piso físico', () => {
  const ahora = Date.now();
  const juntas = Array.from({ length: 20 }, (_, i) => fix(0, 1, i * 0.1, ahora));
  assert.ok(app.consolidarFixes(juntas, ahora).acc >= geo.PISO_FISICO_M);
});

test('el buffer se poda al insertar y no crece sin techo', () => {
  const ahora = Date.now();
  // 200 lecturas de un segundo cada una: solo sobreviven las de la ventana.
  const muchas = Array.from({ length: 200 }, (_, i) => fix(0, 10, 200 - i, ahora));
  const buffer = app.alimentar(muchas);
  assert.ok(buffer.length <= 60, `el buffer quedó con ${buffer.length} lecturas`);
  const tsMax = Math.max(...buffer.map(f => f.ts));
  assert.ok(buffer.every(f => tsMax - f.ts <= cfg.frescoMs), 'quedaron lecturas fuera de la ventana');
});

test('el buffer NO viaja en el estado que se serializa a localStorage', () => {
  // guardarEstado() serializa `estado` entero en cada marca: veinte lecturas de
  // GPS por segundo ahí dentro serían escrituras a disco a ese ritmo.
  assert.match(fuente, /^let bufferFixes = \[\];$/m, 'bufferFixes debe ser variable de módulo');
  const estadoInicial = /\{ sesion: null, paquete: null, ejecucion: null, cola: \[\], ultimoInforme: null \}/;
  assert.match(fuente, estadoInicial, 'cambió la forma de `estado`: revisar que el buffer no entró');
  assert.ok(!/estado\.(bufferFixes|fixes|marcaPendiente)/.test(fuente), 'el buffer se coló dentro de `estado`');
});

// ---------- evaluarPendiente ----------

const PUNTO = {
  nombre: 'Portería',
  lat: LAT,
  lon: LON,
  verificacion: 'gps',
  radioM: 20,
  ventanaMs: cfg.frescoMs,
  precisionM: 5
};
// Un fix ya consolidado, como el que le llega al reducer.
const fixA = (dLatM, acc, edadMs = 0) => ({ lat: LAT + dLatM / 111320, lon: LON, acc, edadMs });
const pendiente = desde => ({ punto: PUNTO, codigo: 'PRT234', desde, motivo: 'lejos' });

test('evaluarPendiente acepta apenas la señal entra', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 3000);
  assert.equal(r.accion, 'aceptar');
});

test('evaluarPendiente acepta en el segundo 14,9', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 14900);
  assert.equal(r.accion, 'aceptar');
});

test('evaluarPendiente rechaza en el segundo 15,1 aunque la señal ya esté buena', () => {
  // El plazo se mira ANTES que el veredicto: si no, la ventana no sería una
  // ventana sino una espera indefinida disfrazada.
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 15100);
  assert.equal(r.accion, 'rechazar');
});

test('evaluarPendiente sigue esperando cuando el fix EMPEORA', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(300, 90), desde + 5000);
  assert.equal(r.accion, 'esperar');
  assert.ok(r.restanteMs > 0 && r.restanteMs <= app.ventanaMs);
  assert.match(r.motivo, /Estás a \d+ m/);
});

test('evaluarPendiente espera también sin ningún fix', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), null, desde + 1000);
  assert.equal(r.accion, 'esperar');
});

test('evaluarPendiente no acepta nada cuando la ronda se cerró con una marca en espera', () => {
  // cerrarRonda() borra el pendiente; lo que quede en vuelo tiene que morir acá
  // y nunca colarse como aceptado.
  const r = app.evaluarPendiente(null, fixA(0, 5), Date.now());
  assert.equal(r.accion, 'rechazar');
  assert.match(r.motivo, /vuelve a escanear/i);
});

test('la espera NO afloja el criterio: lejos de verdad sigue rechazado', () => {
  // Es la garantía de todo el cambio. A 1,1 km, con la mejor señal posible y
  // todo el plazo por delante, la marca no entra ni ahora ni en 15 segundos.
  const desde = Date.now();
  for (const t of [0, 5000, 14900, 15100]) {
    const r = app.evaluarPendiente(pendiente(desde), fixA(1100, 5), desde + t);
    assert.notEqual(r.accion, 'aceptar', `a los ${t} ms la aceptó`);
  }
});

test('el veredicto que sale del reducer trae con qué registrar el rechazo', () => {
  // Sin distancia, tope y señal, la telemetría de rechazos es un texto libre y
  // el próximo ajuste de umbrales vuelve a ser a ciegas.
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(1100, 12), desde + 16000);
  assert.equal(r.accion, 'rechazar');
  assert.ok(r.veredicto.distanciaM > 1000);
  assert.equal(r.veredicto.topeM, 20 + 5 + 12);
  assert.equal(r.veredicto.acc, 12);
});
