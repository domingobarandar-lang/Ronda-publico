// Una ronda empezada no se pierde (v1.25.1): sesión vencida, otro guardia en
// el mismo teléfono, salir con marcas sin enviar, y la ronda recuperada del
// servidor cuando el teléfono ya no la tiene. La prueba completa en Chromium
// es scripts/probar-sesion-ronda.js; esto es lo que corre con npm test.
'use strict';

process.env.MOCK = 'true';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');

const publico = path.join(__dirname, '..', 'public');

// ---------- La app, en un navegador de mentira (como app-nfc.test.js) ----------

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

// `servidor(ruta, opciones)` contesta las llamadas de la app; por defecto, nada.
function cargarApp({ servidor = () => ({}), confirmar = () => true } = {}) {
  const elementos = new Map();
  const llamadas = [];
  const ctx = {
    TextDecoder, TextEncoder, AbortController, DOMException, crypto: globalThis.crypto,
    confirm: confirmar,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {},
      getElementById: id => {
        if (!elementos.has(id)) elementos.set(id, elementoFalso());
        return elementos.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [...elementos.entries()].filter(([id]) => id.startsWith('vista-')).map(([, e]) => e),
      createElement: () => ({ ...elementoFalso(), querySelector: () => elementoFalso() }),
      activeElement: null
    },
    navigator: { onLine: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140', vibrate: () => true, geolocation: { watchPosition: () => 1, clearWatch() {} } },
    fetch: async (ruta, opciones = {}) => {
      const auth = (opciones.headers || {}).authorization || null;
      llamadas.push({ ruta, metodo: opciones.method || 'GET', auth });
      const r = servidor(ruta, opciones) || {};
      return { ok: true, status: 200, json: async () => r };
    },
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    console: { warn() {}, log() {}, error() {} }
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'geo.js'), 'utf8'), ctx, { filename: 'geo.js' });
  vm.runInContext(fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  const correr = expr => vm.runInContext(expr, ctx);
  const visible = id => Boolean(elementos.get(id)) && !elementos.get(id).classList.contains('oculta');
  return { ctx, elementos, llamadas, correr, visible };
}

const PAQUETE = {
  condominio: { id: 'aromos', nombre: 'Los Aromos' },
  gps: null,
  rondas: [{
    id: 'r1', nombre: 'Express', ordenEstricto: false,
    puntos: [
      { id: 'p1', nombre: 'Portería', codigoCorto: 'PRT234', payload: 'RQR:aromos:p1:PRT234', nfc: false },
      { id: 'p2', nombre: 'Quincho', codigoCorto: 'QCH789', payload: 'RQR:aromos:p2:QCH789', nfc: false }
    ]
  }]
};
const sesion = (usuario, token) => ({ token, rol: 'guardia', nombre: usuario.toUpperCase(), usuario, condominio: { id: 'aromos' } });
const tick = () => new Promise(r => setTimeout(r, 20));

// Pedro en plena ronda: una marca hecha y en la cola.
function pedroEnRonda(app) {
  app.correr(`estado.sesion = ${JSON.stringify(sesion('pedro', 'tP'))};
    estado.paquete = ${JSON.stringify(PAQUETE)};
    iniciarRonda('r1');
    procesarCodigo('PRT234');`);
}

test('sesión vencida a mitad de la ronda: sigue en la ronda, con aviso, y no va al login', () => {
  const app = cargarApp();
  pedroEnRonda(app);
  app.correr('estado.sesion.vencida = true; render()');
  assert.ok(app.visible('vista-ronda'), 'la sesión vencida sacó al guardia de la ronda');
  assert.ok(!app.visible('vista-login'));
  assert.ok(app.visible('aviso-sesion'), 'no se le dijo que la sesión venció');
  assert.match(app.elementos.get('aviso-sesion-texto').textContent, /La ronda sigue/);
  // Y sigue marcando: la marca queda en la cola.
  app.correr("procesarCodigo('QCH789')");
  assert.ok(app.visible('vista-ronda'));
  assert.equal(app.correr('estado.ejecucion.escaneos.length'), 2);
  // "Entrar de nuevo" abre el login con su usuario, y deja volver.
  app.correr('irAEntrarDeNuevo()');
  assert.ok(app.visible('vista-login'));
  assert.ok(!app.visible('aviso-sesion'), 'el aviso queda tapando el login');
  assert.equal(app.elementos.get('campo-usuario').value, 'pedro');
  assert.ok(app.visible('btn-volver-ronda'));
});

test('el mismo guardia vuelve a entrar: conserva su ronda y su cola', async () => {
  const app = cargarApp({ servidor: ruta => (ruta === '/api/login' ? sesion('pedro', 'tP2') : ruta === '/api/mi/paquete' ? PAQUETE : {}) });
  pedroEnRonda(app);
  app.correr('estado.sesion.vencida = true');
  const id = app.correr('estado.ejecucion.id');
  const cola = app.correr('estado.cola.length');
  await app.correr("iniciarSesionGuardia('pedro', '2222')");
  assert.equal(app.correr('estado.ejecucion.id'), id);
  assert.equal(app.correr('estado.cola.length'), cola);
  assert.equal(app.correr('estado.sesion.token'), 'tP2');
  assert.equal(app.correr('estado.apartadas'), undefined);
  assert.ok(app.visible('vista-ronda'));
});

test('salir con marcas sin enviar ya no las borra: quedan apartadas y vuelven al entrar', async () => {
  const app = cargarApp({ servidor: ruta => (ruta === '/api/login' ? sesion('pedro', 'tP2') : ruta === '/api/mi/paquete' ? PAQUETE : {}) });
  pedroEnRonda(app);
  app.correr('cerrarRonda()');
  const cola = app.correr('estado.cola.length');
  assert.ok(cola > 0);
  app.correr('salir()');
  assert.equal(app.correr('estado.sesion'), null);
  assert.equal(app.correr('estado.cola.length'), 0);
  assert.equal(app.correr('estado.apartados.length'), 1);
  assert.equal(app.correr('estado.apartados[0].usuario'), 'pedro');
  assert.equal(app.correr('estado.apartados[0].eventos.length'), cola, 'se perdieron marcas al salir');
  await app.correr("iniciarSesionGuardia('pedro', '2222')");
  assert.equal(app.correr('estado.cola.length'), cola, 'al volver a entrar no recuperó lo suyo');
  assert.equal(app.correr('estado.apartados.length'), 0);
  // Sin nada pendiente, salir es como siempre.
  const limpio = cargarApp();
  limpio.correr(`estado.sesion = ${JSON.stringify(sesion('pedro', 'tP'))}; estado.paquete = ${JSON.stringify(PAQUETE)};`);
  limpio.correr('salir()');
  assert.ok(limpio.llamadas.some(l => l.ruta === '/api/logout'));
  assert.equal(limpio.correr('estado.apartados.length'), 0);
});

test('sesión vencida y entra otro guardia: lo del primero queda aparte (v1.25.0), no en manos del segundo', async () => {
  const app = cargarApp({ servidor: ruta => (ruta === '/api/login' ? sesion('luis', 'tL') : ruta === '/api/mi/paquete' ? PAQUETE : {}) });
  pedroEnRonda(app);
  app.correr('estado.sesion.vencida = true');
  const cola = app.correr('estado.cola.length');
  await app.correr("iniciarSesionGuardia('luis', '3333')");
  assert.equal(app.correr('estado.ejecucion'), null);
  assert.equal(app.correr('estado.cola.length'), 0);
  assert.equal(app.correr('estado.apartados[0].usuario'), 'pedro');
  assert.equal(app.correr('estado.apartados[0].eventos.length'), cola);
  assert.ok(!app.visible('aviso-sesion'), 'la sesión de Luis no está vencida');
});

test('una sesión de antes (borrada por el 401) deja la cola y se entra por el login, como siempre', async () => {
  const app = cargarApp({ servidor: ruta => (ruta === '/api/login' ? sesion('pedro', 'tP2') : ruta === '/api/mi/paquete' ? PAQUETE : {}) });
  pedroEnRonda(app);
  app.correr('estado.sesion = null; render()');
  assert.ok(app.visible('vista-login'), 'con cola y sin sesión se entra por el login, como siempre');
  const id = app.correr('estado.ejecucion.id');
  await app.correr("iniciarSesionGuardia('pedro', '2222')");
  assert.equal(app.correr('estado.ejecucion.id'), id);
});

test('sin nada en el teléfono, al entrar se retoma la ronda abierta que tiene el servidor', async () => {
  const abierta = { id: 'e-srv', rondaId: 'r1', inicio: '2026-10-30T10:00:00Z', comentario: '', escaneos: [{ puntoId: 'p1', ts: '2026-10-30T10:01:00Z', offline: false, medio: 'qr' }] };
  const app = cargarApp({
    servidor: ruta => ({ '/api/login': sesion('pedro', 'tP'), '/api/mi/paquete': PAQUETE, '/api/mi/ronda-en-curso': { ejecucion: abierta } })[ruta]
  });
  await app.correr("iniciarSesionGuardia('pedro', '2222')");
  assert.equal(app.correr('estado.ejecucion.id'), 'e-srv');
  assert.equal(app.correr('estado.ejecucion.escaneos.length'), 1);
  assert.equal(app.correr('estado.cola.length'), 0, 'no hay que reenviar el inicio: el servidor ya lo tiene');
  assert.ok(app.visible('vista-ronda'));
  assert.match(app.elementos.get('aviso').textContent, /desde el servidor/);
  // Una ronda que no está en el paquete (la borraron) no se retoma.
  const otra = cargarApp({
    servidor: ruta => ({ '/api/login': sesion('pedro', 'tP'), '/api/mi/paquete': PAQUETE, '/api/mi/ronda-en-curso': { ejecucion: { ...abierta, rondaId: 'r-borrada' } } })[ruta]
  });
  await otra.correr("iniciarSesionGuardia('pedro', '2222')");
  assert.equal(otra.correr('estado.ejecucion'), null);
});

// ---------- El servidor: GET /api/mi/ronda-en-curso ----------

test('servidor: /api/mi/ronda-en-curso devuelve solo la ronda abierta del propio guardia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-sesion-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const { app } = crearApp({ rutaDb, enviarPush: async () => {} });
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const api = async (ruta, { metodo = 'GET', cuerpo, token } = {}) => {
    const resp = await fetch(base + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    return { status: resp.status, datos: await resp.json().catch(() => ({})) };
  };
  const login = async (usuario, pin) => (await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).datos.token;
  try {
    const pedro = await login('pedro', '2222');
    const luis = await login('luis', '3333');
    const marta = await login('marta', '1111');
    assert.deepEqual((await api('/api/mi/ronda-en-curso', { token: pedro })).datos, { ejecucion: null });
    assert.equal((await api('/api/mi/ronda-en-curso')).status, 401);
    await api('/api/ejecuciones', { metodo: 'POST', token: pedro, cuerpo: { id: 'srv-pedro-1', rondaId: 'ronda-express', inicio: new Date().toISOString() } });
    await api('/api/ejecuciones/srv-pedro-1/escaneos', { metodo: 'POST', token: pedro, cuerpo: { codigo: 'PRT234', ts: new Date().toISOString() } });
    const r = await api('/api/mi/ronda-en-curso', { token: pedro });
    assert.equal(r.datos.ejecucion.id, 'srv-pedro-1');
    assert.equal(r.datos.ejecucion.rondaId, 'ronda-express');
    assert.deepEqual(r.datos.ejecucion.escaneos.map(e => [e.puntoId, e.medio]), [['p-porteria', 'manual']]);
    assert.equal(r.datos.ejecucion.escaneos[0].gps, undefined, 'las ubicaciones no viajan de vuelta');
    // Otro guardia del mismo condominio no la ve, ni el administrador.
    assert.deepEqual((await api('/api/mi/ronda-en-curso', { token: luis })).datos, { ejecucion: null });
    assert.deepEqual((await api('/api/mi/ronda-en-curso', { token: marta })).datos, { ejecucion: null });
    // Cerrada, ya no se retoma.
    await api('/api/ejecuciones/srv-pedro-1/cerrar', { metodo: 'POST', token: pedro, cuerpo: { fin: new Date().toISOString() } });
    assert.deepEqual((await api('/api/mi/ronda-en-curso', { token: pedro })).datos, { ejecucion: null });
  } finally {
    servidor.close();
  }
});
