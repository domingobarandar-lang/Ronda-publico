// El teléfono compartido de la garita (v1.25, cambiarDeGuardia en
// public/app.js). La sesión de un guardia se corta con su ronda sin enviar y
// entra otro: hasta la v1.24 la app mandaba lo del primero con la sesión del
// segundo, el servidor contestaba 403 ("Esta ronda no te pertenece") y la cola
// lo descartaba. Así se perdió el cierre de una ronda con los 9 puntos.
//
// Carga geo.js y app.js enteros en un navegador de mentira con un servidor de
// mentira que, como el de verdad, solo acepta los datos de una ronda con la
// sesión de su dueño.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publico = path.join(__dirname, '..', 'public');

function elementoFalso() {
  const clases = new Set();
  return {
    value: '', style: {}, dataset: {}, disabled: false, textContent: '', innerHTML: '',
    get className() { return [...clases].join(' '); },
    set className(v) { clases.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => clases.add(c)); },
    classList: {
      add: (...c) => c.forEach(x => clases.add(x)),
      remove: (...c) => c.forEach(x => clases.delete(x)),
      contains: c => clases.has(c),
      toggle: (c, si) => ((si ?? !clases.has(c)) ? clases.add(c) : clases.delete(c))
    },
    addEventListener() {}, removeEventListener() {}, appendChild: h => h, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute: () => null, querySelector: () => elementoFalso(), querySelectorAll: () => [], focus() {}
  };
}

const PAQUETE = {
  condominio: { id: 'rsf', nombre: 'Condominio Piloto' },
  rondas: [{
    id: 'r1', nombre: 'Perimetral', ordenEstricto: false,
    puntos: [
      { id: 'p1', nombre: 'Portería', payload: 'RQR:rsf:p1:AAA111' },
      { id: 'p2', nombre: 'Piscina', payload: 'RQR:rsf:p2:BBB222' }
    ]
  }]
};

const GUARDIAS = {
  jonathan: { token: 'tok-jonathan', nombre: 'Jonathan Reyes' },
  karl: { token: 'tok-karl', nombre: 'Karl Muñoz' }
};

function cargarApp() {
  const elementos = new Map();
  const almacen = {};
  const avisos = [];
  const llamadas = [];
  // ejecucionId -> usuario dueño, como en el servidor.
  const duenosServidor = new Map();
  const quien = token => Object.keys(GUARDIAS).find(u => GUARDIAS[u].token === token);

  const responder = (status, datos) => ({ ok: status < 400, status, json: async () => datos });
  async function fetch(ruta, { method = 'GET', headers = {}, body } = {}) {
    const usuario = quien(String(headers.authorization || '').replace('Bearer ', ''));
    const cuerpo = body ? JSON.parse(body) : {};
    llamadas.push({ metodo: method, ruta, usuario });
    if (ruta === '/api/login') {
      const g = GUARDIAS[cuerpo.usuario];
      return responder(200, { token: g.token, rol: 'guardia', nombre: g.nombre, usuario: cuerpo.usuario, condominio: 'rsf' });
    }
    if (ruta === '/api/mi/paquete') return responder(200, PAQUETE);
    if (ruta === '/api/ejecuciones' && method === 'POST') {
      duenosServidor.set(cuerpo.id, usuario);
      return responder(201, { id: cuerpo.id });
    }
    const m = /^\/api\/ejecuciones\/([^/]+)\/(escaneos|rechazos|cerrar)$/.exec(ruta);
    if (m) {
      if (!duenosServidor.has(m[1])) return responder(404, { error: 'La ejecución no existe.' });
      if (duenosServidor.get(m[1]) !== usuario) return responder(403, { error: 'Esta ronda no te pertenece.' });
      if (m[2] === 'cerrar') return responder(200, { id: m[1], estado: 'completa', detalle: [], evaluacion: { observaciones: [], duracionMin: 9 } });
      return responder(200, { duplicado: false });
    }
    return responder(200, {});
  }

  const ctx = {
    fetch, crypto: globalThis.crypto, TextDecoder, TextEncoder, console,
    confirm: () => true,
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
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => elementoFalso(),
      documentElement: elementoFalso(), head: elementoFalso(), body: elementoFalso(),
      visibilityState: 'visible', activeElement: null
    },
    navigator: {
      onLine: true, userAgent: 'test', vibrate() {},
      geolocation: { watchPosition: () => 1, clearWatch() {} }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'geo.js'), 'utf8'), ctx, { filename: 'geo.js' });
  vm.runInContext(fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  // Los avisos se leen del elemento #aviso cada vez que la app escribe uno.
  const elAviso = ctx.document.getElementById('aviso');
  let texto = '';
  Object.defineProperty(elAviso, 'textContent', { get: () => texto, set: v => { texto = String(v); avisos.push(texto); } });

  const correr = expr => vm.runInContext(expr, ctx);
  return {
    correr,
    avisos,
    llamadas,
    duenosServidor,
    estado: () => JSON.parse(correr('JSON.stringify(estado)')),
    entrar: usuario => correr(`iniciarSesionGuardia(${JSON.stringify(usuario)}, '1234')`),
    // La app sincroniza sola después de cada evento: se espera a que termine esa
    // vuelta y se corre una más, para que la cola quede procesada entera.
    sincronizar: async () => {
      for (let i = 0; i < 200 && correr('sincronizando'); i++) await new Promise(r => setImmediate(r));
      await correr('sincronizar()');
    }
  };
}

// Jonathan hace la ronda entera sin señal y se le corta la sesión antes de
// que la cola alcance a subir: el teléfono queda en el login con todo pendiente.
async function rondaDeJonathanSinEnviar(app) {
  await app.entrar('jonathan');
  app.correr('navigator.onLine = false');
  app.correr("iniciarRonda('r1')");
  app.correr("registrarMarca(estado.paquete.rondas[0].puntos[0], 'RQR:rsf:p1:AAA111')");
  app.correr("registrarMarca(estado.paquete.rondas[0].puntos[1], 'RQR:rsf:p2:BBB222')");
  app.correr('cerrarRonda()');
  // Lo que hace sincronizar() con un 401.
  app.correr('estado.sesion = null; guardarEstado()');
  app.correr('navigator.onLine = true');
  const e = app.estado();
  assert.deepEqual(e.cola.map(x => x.tipo), ['iniciar', 'escaneo', 'escaneo', 'cerrar']);
  return e.ejecucion.id;
}

test('entra otro guardia: lo de Jonathan no se manda con la sesión de Karl ni aparece en su pantalla', async () => {
  const app = cargarApp();
  const id = await rondaDeJonathanSinEnviar(app);
  const antes = app.llamadas.length;

  await app.entrar('karl');
  await app.sincronizar();

  const e = app.estado();
  assert.equal(e.sesion.usuario, 'karl');
  assert.equal(e.ejecucion, null, 'Karl empieza con la pantalla limpia');
  assert.deepEqual(e.cola, []);
  const enviadas = app.llamadas.slice(antes).filter(l => l.ruta.startsWith('/api/ejecuciones'));
  assert.deepEqual(enviadas, [], 'nada de la ronda de Jonathan viajó con la sesión de Karl');
  assert.equal(e.apartados.length, 1);
  assert.equal(e.apartados[0].usuario, 'jonathan');
  assert.deepEqual(e.apartados[0].eventos.map(x => x.tipo), ['iniciar', 'escaneo', 'escaneo', 'cerrar']);
  assert.equal(e.apartados[0].ejecucion.id, id);
  assert.match(app.avisos.at(-1), /Lo pendiente de Jonathan Reyes quedó guardado aparte/);
});

test('Karl sale y Jonathan vuelve a entrar: su ronda vuelve a la cola, en orden, y se envía con su sesión', async () => {
  const app = cargarApp();
  const id = await rondaDeJonathanSinEnviar(app);
  await app.entrar('karl');
  await app.sincronizar();
  app.correr('salir()');
  assert.equal(app.estado().apartados.length, 1, 'salir no borra lo de otro guardia');

  const antes = app.llamadas.length;
  await app.entrar('jonathan');
  assert.match(app.avisos.at(-1), /Recuperamos tu ronda pendiente/);
  let e = app.estado();
  assert.deepEqual(e.apartados, []);
  assert.equal(e.ejecucion.id, id);
  assert.deepEqual(e.cola.map(x => x.tipo), ['iniciar', 'escaneo', 'escaneo', 'cerrar']);

  await app.sincronizar();
  e = app.estado();
  const enviadas = app.llamadas.slice(antes).filter(l => l.ruta.startsWith('/api/ejecuciones'));
  assert.deepEqual(enviadas.map(l => [l.ruta.split('/').pop(), l.usuario]), [
    ['ejecuciones', 'jonathan'], ['escaneos', 'jonathan'], ['escaneos', 'jonathan'], ['cerrar', 'jonathan']
  ]);
  assert.deepEqual(e.cola, []);
  assert.equal(e.ejecucion, null);
  assert.equal(e.ultimoInforme.id, id, 'el informe llegó');
});

test('el mismo guardia que vuelve a entrar sigue con su ronda, como antes', async () => {
  const app = cargarApp();
  const id = await rondaDeJonathanSinEnviar(app);
  await app.entrar('jonathan');
  assert.deepEqual(app.estado().apartados, []);
  await app.sincronizar();
  const e = app.estado();
  assert.deepEqual(e.cola, []);
  assert.equal(e.ultimoInforme.id, id);
});

test('una ronda de antes de la v1.25 (sin dueño anotado) queda como estaba', async () => {
  const app = cargarApp();
  await rondaDeJonathanSinEnviar(app);
  app.correr('estado.duenos = {}; guardarEstado()');
  await app.entrar('karl');
  const e = app.estado();
  assert.deepEqual(e.apartados, []);
  assert.equal(e.cola.length, 4);
});

test('lo apartado se guarda un día: después el servidor ya cerró esa ronda', async () => {
  const app = cargarApp();
  await rondaDeJonathanSinEnviar(app);
  await app.entrar('karl');
  app.correr("estado.apartados[0].desde = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); guardarEstado()");
  app.correr('salir()');
  await app.entrar('jonathan');
  const e = app.estado();
  assert.deepEqual(e.apartados, []);
  assert.deepEqual(e.cola, [], 'no resucita una ronda de ayer');
  assert.equal(e.ejecucion, null);
});

test('un cierre que el servidor rechaza no deja la pantalla esperando para siempre', async () => {
  const app = cargarApp();
  await app.entrar('karl');
  app.correr("iniciarRonda('r1')");
  await app.sincronizar();
  // El servidor no la reconoce como de Karl (p. ej. una ronda de antes de la
  // v1.25 que siguió en el teléfono).
  const id = app.estado().ejecucion.id;
  app.duenosServidor.set(id, 'jonathan');
  app.correr('cerrarRonda()');
  await app.sincronizar();
  const e = app.estado();
  assert.deepEqual(e.cola, []);
  assert.equal(e.ejecucion, null);
  assert.match(app.avisos.at(-1), /no aceptó el cierre de la ronda: Esta ronda no te pertenece/);
});

test('con todos los puntos marcados, «Terminar ronda» pasa a ser el botón grande', async () => {
  const app = cargarApp();
  await app.entrar('karl');
  app.correr("iniciarRonda('r1')");
  const clases = () => app.correr("[$('btn-cerrar-ronda').className, $('btn-escanear').classList.contains('oculta'), $('btn-manual').classList.contains('oculta'), $('ronda-lista').classList.contains('oculta')]");
  app.correr("registrarMarca(estado.paquete.rondas[0].puntos[0], 'RQR:rsf:p1:AAA111')");
  assert.deepEqual([...clases()], ['btn btn-peligro', false, false, true]);
  app.correr("registrarMarca(estado.paquete.rondas[0].puntos[1], 'RQR:rsf:p2:BBB222')");
  assert.deepEqual([...clases()], ['btn btn-principal btn-gigante', true, true, false]);
  assert.match(app.avisos.at(-1), /✅ Piscina \(2\/2\)/, 'el aviso de la marca no cambia');
});
