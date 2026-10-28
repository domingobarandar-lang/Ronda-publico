// CU-28 en la app del guardia: qué abre "Escanear", la validación offline de
// la chapita (espejo del servidor) y el camino completo lectura → cola. Carga
// public/app.js entero en un navegador de mentira, como app-integracion.test.js,
// con un NDEFReader simulado: Web NFC no existe en Node ni en Chrome de
// escritorio.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizarSerie } = require('../lib/codigos');

const publico = path.join(__dirname, '..', 'public');

// Elementos permisivos: la app pinta sin que nada exista de verdad.
function elementoFalso() {
  const clases = new Set(['oculta']);
  return {
    textContent: '', value: '', innerHTML: '', className: '', style: {}, disabled: false,
    classList: {
      add: (...c) => c.forEach(x => clases.add(x)),
      remove: (...c) => c.forEach(x => clases.delete(x)),
      contains: c => clases.has(c),
      toggle: (c, si) => ((si ?? !clases.has(c)) ? clases.add(c) : clases.delete(c))
    },
    addEventListener() {}, appendChild() {}, insertAdjacentHTML() {}, focus() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => []
  };
}

function cargarApp({ ventana = {}, userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/140' } = {}) {
  const elementos = new Map();
  const almacen = {};
  const ctx = {
    ...ventana,
    TextDecoder, AbortController, DOMException,
    localStorage: {
      getItem: k => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = v; },
      removeItem: k => { delete almacen[k]; }
    },
    document: {
      addEventListener() {},
      getElementById: id => {
        if (!elementos.has(id)) elementos.set(id, elementoFalso());
        return elementos.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => elementoFalso(),
      activeElement: null
    },
    navigator: { onLine: false, userAgent, vibrate: () => true, geolocation: { watchPosition: () => 1, clearWatch() {} } },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    console: { warn() {}, log() {}, error() {} }
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'geo.js'), 'utf8'), ctx, { filename: 'geo.js' });
  vm.runInContext(fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, elementos, correr: expr => vm.runInContext(expr, ctx) };
}

const SERIE = '04A23B4C5D6E80';
const P_QR = { id: 'p1', nombre: 'Portería', codigoCorto: 'PRT234', payload: 'RQR:aromos:p1:PRT234', lat: null, lon: null, nfc: false, nfcSerie: null };
const P_NFC = { id: 'p2', nombre: 'Sala de bombas', codigoCorto: 'BMB892', payload: 'RQR:aromos:p2:BMB892', lat: null, lon: null, nfc: true, nfcSerie: SERIE };

function conRonda(app, { puntos = [P_QR, P_NFC], ordenEstricto = false, manualEnNfc = 'observacion' } = {}) {
  const paquete = { manualEnNfc, gps: null, rondas: [{ id: 'r1', nombre: 'Nocturna', ordenEstricto, puntos }] };
  app.correr(`estado.sesion = { token: 't' };
    estado.paquete = ${JSON.stringify(paquete)};
    estado.ejecucion = { id: 'e1', rondaId: 'r1', inicio: new Date().toISOString(), escaneos: [], cerrada: false };
    estado.cola = [];`);
}

// Un mensaje NDEF como lo entrega Web NFC: registros con data en un DataView.
function lectura(texto, serie = '04:a2:3b:4c:5d:6e:80') {
  const bytes = new TextEncoder().encode(texto);
  return { serialNumber: serie, message: { records: [{ recordType: 'text', encoding: 'utf-8', data: new DataView(bytes.buffer) }] } };
}

test('medioEscaner: qué abre "Escanear" según los puntos que faltan', () => {
  const app = cargarApp();
  const medio = (puntos, ordenEstricto, marcados = []) => app.correr(
    `medioEscaner(${JSON.stringify({ puntos, ordenEstricto })}, ${JSON.stringify({ escaneos: marcados.map(puntoId => ({ puntoId })) })})`);
  assert.equal(medio([P_QR], false), 'qr', 'ronda sin chapitas: la cámara, como siempre');
  assert.equal(medio([P_NFC], false), 'nfc');
  assert.equal(medio([P_QR, P_NFC], false), 'ambos', 'mixta sin orden: cámara y lector a la vez');
  assert.equal(medio([P_QR, P_NFC], false, ['p1']), 'nfc', 'solo falta la chapita');
  assert.equal(medio([P_QR, P_NFC], false, ['p2']), 'qr');
  assert.equal(medio([P_NFC, P_QR], true), 'nfc', 'orden estricto: el medio del próximo punto');
  assert.equal(medio([P_NFC, P_QR], true, ['p2']), 'qr');
  assert.equal(medio([P_QR, P_NFC], true, ['p1', 'p2']), 'qr', 'todo marcado: la cámara');
  assert.equal(app.correr('medioEscaner(null, null)'), 'qr');
});

test('normalizarSerie de la app es la misma que la del servidor', () => {
  const app = cargarApp();
  for (const s of ['04:a2:3b:4c:5d:6e:80', '04-A2-3B-4C-5D-6E-80', '04a23b4c5d6e80', '', 'zz', '04:a2', '1234567', '0123456789ABCDEF0123', '0123456789ABCDEF012345']) {
    assert.equal(app.correr(`normalizarSerie(${JSON.stringify(s)})`), normalizarSerie(s), `difieren con "${s}"`);
  }
});

test('motivoMedio: espejo de la regla del servidor', () => {
  const app = cargarApp();
  conRonda(app);
  const motivo = (punto, texto, nfc) => app.correr(`motivoMedio(${JSON.stringify(punto)}, ${JSON.stringify(texto)}, ${JSON.stringify(nfc)})`);
  assert.equal(motivo(P_QR, P_QR.payload, null), null, 'punto QR: igual que siempre');
  assert.equal(motivo(P_QR, 'PRT234', null), null);
  assert.match(motivo(P_NFC, P_NFC.payload, null), /^Este punto se marca con la chapita NFC/);
  assert.match(motivo(P_NFC, P_NFC.payload, { serie: '04112233445566' }), /no es la registrada/);
  assert.match(motivo(P_NFC, P_NFC.payload, { serie: null }), /número de serie/);
  assert.equal(motivo(P_NFC, P_NFC.payload, { serie: SERIE }), null);
  assert.equal(motivo(P_NFC, 'BMB892', null), null, 'código a mano: entra (observado por el servidor)');
  conRonda(app, { manualEnNfc: 'rechazo' });
  assert.match(motivo(P_NFC, 'BMB892', null), /solo con la chapita/);
});

test('la chapita correcta entra a la cola con su serie y medio nfc', () => {
  const app = cargarApp();
  conRonda(app);
  app.correr(`chapitaLeida(${JSON.stringify({})})`); // sin mensaje: no es de Rondas QR
  assert.equal(app.correr('estado.cola.length'), 0);
  app.ctx.__lectura = lectura(P_NFC.payload);
  app.correr('chapitaLeida(__lectura)');
  const evento = app.correr('estado.cola[0]');
  assert.equal(evento.tipo, 'escaneo');
  assert.equal(evento.codigo, P_NFC.payload);
  assert.deepEqual({ ...evento.nfc }, { serie: SERIE });
  assert.equal(app.correr('estado.ejecucion.escaneos[0].medio'), 'nfc');
  // La misma chapita apoyada un instante después no es una lectura nueva.
  app.correr('chapitaLeida(__lectura)');
  assert.equal(app.correr('estado.cola.length'), 1);
});

test('QR o chapita ajena en un punto NFC: rechazo registrado, nunca una marca', () => {
  const app = cargarApp();
  conRonda(app);
  app.correr(`procesarCodigo(${JSON.stringify(P_NFC.payload)})`);
  app.ctx.__copia = lectura(P_NFC.payload, '04:11:22:33:44:55:66');
  app.correr('chapitaLeida(__copia)');
  const cola = app.correr('estado.cola');
  assert.deepEqual([...cola].map(e => e.tipo), ['rechazo', 'rechazo']);
  assert.match(cola[0].motivo, /chapita NFC/);
  assert.equal(app.correr('estado.ejecucion.escaneos.length'), 0);
  // El punto QR de la misma ronda sigue funcionando con la cámara.
  app.correr(`procesarCodigo(${JSON.stringify(P_QR.payload)})`);
  assert.equal(app.correr('estado.ejecucion.escaneos[0].medio'), 'qr');
  assert.equal(app.correr('estado.cola[2].nfc'), null);
  // Y el código a mano en el punto NFC entra como manual.
  app.correr('procesarCodigo("bmb892")');
  assert.equal(app.correr('estado.ejecucion.escaneos[1].medio'), 'manual');
});

test('sin Web NFC: cada teléfono recibe un mensaje claro y la salida a mano', () => {
  const fully = cargarApp({ ventana: { fully: { playSound() {} } } });
  assert.match(fully.correr('sinLectorNfc()'), /^Este teléfono todavía no lee chapitas NFC: usa el código a mano/);
  const iphone = cargarApp({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  assert.match(iphone.correr('sinLectorNfc()'), /iPhone/);
  const firefox = cargarApp({ userAgent: 'Mozilla/5.0 (Android 14; Mobile) Firefox/130' });
  assert.match(firefox.correr('sinLectorNfc()'), /Chrome/);
  const chrome = cargarApp({ ventana: { NDEFReader: function NDEFReader() {} } });
  assert.equal(chrome.correr('sinLectorNfc()'), null);
});

test('errores de Web NFC: permiso negado, NFC apagado y sin NFC se dicen distinto', () => {
  const app = cargarApp();
  const texto = nombre => app.correr(`textoErrorNfc({ name: ${JSON.stringify(nombre)} })`);
  assert.match(texto('NotAllowedError'), /permiso/);
  assert.match(texto('NotReadableError'), /apagado/);
  assert.match(texto('NotSupportedError'), /no tiene NFC/);
  assert.match(texto('Raro'), /Raro/);
});

test('pantalla de la chapita: el lector arranca con el toque y se detiene al cerrar', async () => {
  let señal = null;
  let lector = null;
  class NDEFReader {
    constructor() { lector = this; }
    scan({ signal }) { señal = signal; return Promise.resolve(); }
  }
  const app = cargarApp({ ventana: { NDEFReader } });
  conRonda(app, { puntos: [P_NFC] });
  app.correr('escanear()');
  assert.equal(app.elementos.get('modal-nfc').classList.contains('oculta'), false, 'no se abrió la pantalla de la chapita');
  assert.ok(señal && !señal.aborted, 'el lector no arrancó con el toque');
  // La lectura entra por el mismo camino que el QR.
  lector.onreading(lectura(P_NFC.payload));
  assert.equal(app.correr('estado.ejecucion.escaneos[0].medio'), 'nfc');
  assert.equal(señal.aborted, true, 'el lector siguió encendido después de leer');
  assert.equal(app.elementos.get('modal-nfc').classList.contains('oculta'), true);

  // Permiso negado: el mensaje queda en la pantalla, con Reintentar.
  class Negado { scan() { return Promise.reject(new DOMException('no', 'NotAllowedError')); } }
  const negado = cargarApp({ ventana: { NDEFReader: Negado } });
  conRonda(negado, { puntos: [P_NFC] });
  negado.correr('abrirPantallaNfc()');
  await new Promise(r => setImmediate(r));
  assert.match(negado.elementos.get('nfc-texto').textContent, /permiso/);
  assert.equal(negado.elementos.get('btn-reintentar-nfc').classList.contains('oculta'), false);
  // Cancelar con el lector vivo lo apaga.
  const otra = cargarApp({ ventana: { NDEFReader } });
  conRonda(otra, { puntos: [P_NFC] });
  otra.correr('abrirPantallaNfc()');
  otra.correr('cerrarPantallaNfc()');
  assert.equal(señal.aborted, true);
});
