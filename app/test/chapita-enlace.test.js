// La chapita lleva un enlace a la app además del texto (v1.25.1). Si se acerca
// con la app cerrada o en segundo plano, Android abre la app en vez de su
// pantalla de etiquetas («la pantalla en blanco»). Lo que no puede cambiar:
// las chapitas ya grabadas (solo texto) y los QR siguen marcando igual, y la
// app de antes lee las chapitas nuevas.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publico = path.join(__dirname, '..', 'public');
const admin = fs.readFileSync(path.join(publico, 'admin.js'), 'utf8');

// Las funciones de admin.js, sacadas del fuente real (como cola-reintentos).
function extraer(fuente, nombre) {
  const i = fuente.indexOf(`\nfunction ${nombre}(`) + 1;
  assert.ok(i > 0, `falta ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

function panel(origen, extra = {}) {
  const ctx = { TextEncoder, TextDecoder, location: { origin: origen }, ...extra };
  vm.createContext(ctx);
  const capacidad = /const CAPACIDAD_CHAPITA = (\d+);/.exec(admin)[1];
  vm.runInContext(`const CAPACIDAD_CHAPITA = ${capacidad};
    ${extraer(admin, 'enlaceDeChapita')}
    ${extraer(admin, 'bytesChapita')}
    ${extraer(admin, 'registrosChapita')}
    ${extraer(admin, 'textoDeChapita')}`, ctx);
  return expr => vm.runInContext(expr, ctx);
}

// El mensaje NDEF tal como lo entrega Web NFC al leer.
function mensaje(registros) {
  return {
    records: registros.map(r => {
      const bytes = new TextEncoder().encode(r.data);
      return { recordType: r.recordType, encoding: 'utf-8', data: new DataView(bytes.buffer) };
    })
  };
}

// Un payload de verdad: el id de un punto nuevo es un UUID.
const PAYLOAD = 'RQR:los-aromos:3f1c2a9e-8b7d-4c6e-9a1f-0e2d3c4b5a69:BMB892';

test('el panel graba primero el enlace a la app y después el texto', () => {
  const correr = panel('https://tu-servidor.example.com');
  const r = correr(`registrosChapita(${JSON.stringify(PAYLOAD)})`);
  assert.equal(r.length, 2);
  // Android decide qué abrir con el PRIMER registro.
  assert.deepEqual({ ...r[0] }, { recordType: 'url', data: 'https://tu-servidor.example.com/#nfc' });
  assert.deepEqual({ ...r[1] }, { recordType: 'text', lang: 'es', data: PAYLOAD });
  assert.ok(correr(`bytesChapita(${JSON.stringify(r[0].data)}, ${JSON.stringify(PAYLOAD)})`) <= 137, 'no cabe en una NTAG213');
  // Y la verificación del panel (y el bloqueo) siguen leyendo el texto.
  const leer = panel('https://tu-servidor.example.com', { __m: mensaje(r.map(x => ({ ...x }))) });
  assert.equal(leer('textoDeChapita(__m)'), PAYLOAD);
});

test('si el enlace no cabe en la chapita, se graba solo el texto, como antes', () => {
  const largo = panel(`https://${'servidor-con-un-nombre-muy-largo'.repeat(3)}.ejemplo.cl`);
  const r = largo(`registrosChapita(${JSON.stringify(PAYLOAD)})`);
  assert.equal(r.length, 1);
  assert.equal(r[0].recordType, 'text');
  assert.equal(r[0].data, PAYLOAD);
});

test('el tamaño calculado coincide con el mensaje NDEF real', () => {
  const correr = panel('https://x.cl');
  // URL: 3 de cabecera + "U" + 1 de prefijo + "x.cl/#nfc" (9) = 14.
  // Texto: 3 + "T" + 1 de estado + "es" + 4 = 11.
  assert.equal(correr('bytesChapita("https://x.cl/#nfc", "RQR:")'), 14 + 11);
  assert.equal(correr('bytesChapita(null, "RQR:")'), 11);
});

// ---------- La app del guardia lee las chapitas nuevas y las viejas ----------

function cargarApp(extra = {}) {
  const elementos = new Map();
  const almacen = {};
  const elemento = () => {
    const clases = new Set(['oculta']);
    return {
      textContent: '', value: '', innerHTML: '', className: '', style: {},
      classList: { add: (...c) => c.forEach(x => clases.add(x)), remove: (...c) => c.forEach(x => clases.delete(x)), contains: c => clases.has(c), toggle: (c, si) => ((si ?? !clases.has(c)) ? clases.add(c) : clases.delete(c)) },
      addEventListener() {}, appendChild() {}, insertAdjacentHTML() {}, focus() {}, setAttribute() {},
      querySelector: () => null, querySelectorAll: () => []
    };
  };
  const ctx = {
    TextDecoder, TextEncoder, AbortController, DOMException, crypto: globalThis.crypto,
    confirm: () => true,
    localStorage: { getItem: k => almacen[k] ?? null, setItem: (k, v) => { almacen[k] = v; }, removeItem: k => { delete almacen[k]; } },
    document: {
      addEventListener() {},
      getElementById: id => { if (!elementos.has(id)) elementos.set(id, elemento()); return elementos.get(id); },
      querySelector: () => null, querySelectorAll: () => [], createElement: elemento, activeElement: null
    },
    navigator: { onLine: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140', vibrate: () => true, geolocation: { watchPosition: () => 1, clearWatch() {} } },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    console: { warn() {}, log() {}, error() {} },
    ...extra
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'geo.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ctx);
  return { ctx, elementos, correr: expr => vm.runInContext(expr, ctx) };
}

test('la app lee el texto de una chapita nueva (enlace + texto) y de una vieja (solo texto)', () => {
  const app = cargarApp();
  const correr = panel('https://rondas.ejemplo.cl');
  const nuevos = correr(`registrosChapita(${JSON.stringify(PAYLOAD)})`).map(r => ({ ...r }));
  app.ctx.__nueva = mensaje(nuevos);
  app.ctx.__vieja = mensaje([{ recordType: 'text', data: PAYLOAD }]);
  assert.equal(app.correr('textoDeChapita(__nueva)'), PAYLOAD);
  assert.equal(app.correr('textoDeChapita(__vieja)'), PAYLOAD);
});

test('la app de antes (v1.24.1) también lee las chapitas nuevas: busca el registro de texto', () => {
  // Es el mismo textoDeChapita de la v1.24: recorre los registros hasta el de
  // texto. Si alguien lo cambia para leer solo el primero, esto falla.
  const fuente = fs.readFileSync(path.join(publico, 'app.js'), 'utf8');
  const cuerpo = extraer(fuente, 'textoDeChapita');
  assert.match(cuerpo, /for \(const registro of/);
  assert.match(cuerpo, /recordType !== 'text'/);
});

test('abierta por la chapita (#nfc): avisa que hay que acercarla otra vez y limpia la dirección', () => {
  let reemplazada = null;
  const app = cargarApp({ location: { hash: '#nfc', pathname: '/', search: '' }, history: { replaceState: (a, b, url) => { reemplazada = url; } } });
  app.correr(`estado.sesion = { token: 't', usuario: 'pedro' };
    estado.ejecucion = { id: 'e1', rondaId: 'r1', escaneos: [], cerrada: false };`);
  app.correr('abiertaPorChapita()');
  assert.equal(reemplazada, '/');
  assert.match(app.elementos.get('aviso').textContent, /acércala otra vez para marcar/);
  // Sin #nfc no dice nada.
  const normal = cargarApp({ location: { hash: '', pathname: '/', search: '' }, history: { replaceState() { throw new Error('no'); } } });
  normal.correr("estado.sesion = { token: 't' }; abiertaPorChapita()");
  assert.equal((normal.elementos.get('aviso') || { textContent: '' }).textContent, '');
});

test('dos pestañas de la app: la que se queda atrás toma lo que guardó la otra (no lo pisa)', () => {
  const app = cargarApp();
  app.correr(`estado.sesion = { token: 't' };
    estado.ejecucion = { id: 'e1', rondaId: 'r1', escaneos: [{ puntoId: 'p1' }], cerrada: false };
    estado.rev = 10;`);
  const otra = JSON.stringify({ rev: 11, sesion: { token: 't' }, ejecucion: { id: 'e1', rondaId: 'r1', escaneos: [{ puntoId: 'p1' }, { puntoId: 'p2' }], cerrada: false }, cola: [{ tipo: 'escaneo' }] });
  assert.equal(app.correr(`tomarEstadoDeOtraPestana(${JSON.stringify(otra)})`), true);
  assert.equal(app.correr('estado.ejecucion.escaneos.length'), 2);
  assert.equal(app.correr('estado.cola.length'), 1);
  // Una copia más vieja (o rota) no pisa la de esta pestaña.
  assert.equal(app.correr(`tomarEstadoDeOtraPestana(${JSON.stringify(JSON.stringify({ rev: 5, cola: [] }))})`), false);
  assert.equal(app.correr('tomarEstadoDeOtraPestana("{roto")'), false);
  assert.equal(app.correr('estado.cola.length'), 1);
});
