// Sesión vencida en el panel (v1.20.3). Sentry juntó del 9 al 16 de octubre dos
// issues que eran uno solo: el administrador abría /panel con un token viejo en
// localStorage, el primer 401 dejaba `sesion = null` y el catch de
// cargarSelectorCondominios leía `sesion.condominio` (TypeError); después igual
// se cargaba la pestaña de informes, sin token, y ese segundo 401 ("Sesión
// inválida") quedaba como promesa sin atrapar. El panel terminaba bien en el
// login, pero con el aviso rojo de "problema inesperado" y dos errores en Sentry.
//
// Carga public/admin.js entero en un navegador de mentira, como
// app-integracion.test.js hace con app.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publico = path.join(__dirname, '..', 'public');
const CLAVE = 'rondasqr-admin';
const SESION = { token: 'a'.repeat(48), rol: 'admin', condominio: { id: 'mirador', nombre: 'Mirador' } };

// Elementos de mentira: lo justo que tocan render(), mostrarTab() y los
// cargadores. Todos nacen ocultos, como en admin.html.
function elemento() {
  const clases = new Set(['oculta']);
  return {
    classList: { add: c => clases.add(c), remove: c => clases.delete(c), contains: c => clases.has(c) },
    textContent: '', innerHTML: '', value: '', disabled: false, options: [], selectedIndex: 0, dataset: {},
    addEventListener() {}
  };
}

// `responder(ruta, cabeceras)` devuelve [status, cuerpo] para cada fetch.
function cargarPanel({ sesion = SESION, responder }) {
  const almacen = sesion ? { [CLAVE]: JSON.stringify(sesion) } : {};
  const elementos = {};
  const pedidos = [];
  const el = id => (elementos[id] = elementos[id] || elemento());
  const ctx = {
    localStorage: {
      getItem: k => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = v; },
      removeItem: k => { delete almacen[k]; }
    },
    document: {
      addEventListener() {},
      getElementById: el,
      querySelector: sel => el(`sel:${sel}`),
      querySelectorAll: () => [],
      createElement: () => elemento()
    },
    navigator: { userAgent: 'test' },
    location: { href: '/panel', pathname: '/panel' },
    fetch: async (ruta, opciones = {}) => {
      pedidos.push(ruta);
      const [status, cuerpo] = responder(ruta, opciones.headers || {});
      return { status, ok: status >= 200 && status < 300, json: async () => cuerpo };
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(publico, 'admin.js'), 'utf8'), ctx, { filename: 'admin.js' });
  return { correr: expr => vm.runInContext(expr, ctx), almacen, pedidos, el };
}

// Corre `fn` y junta las promesas que quedaron sin atrapar: en el navegador son
// las que errores.js reporta (aviso rojo + Sentry).
async function rechazosSinAtrapar(fn) {
  const rechazos = [];
  const oyente = razon => rechazos.push(razon);
  process.on('unhandledRejection', oyente);
  try {
    await fn();
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  } finally {
    process.off('unhandledRejection', oyente);
  }
  return rechazos.map(r => (r && r.message) || String(r));
}

const en401 = mensaje => () => [401, { error: mensaje }];

test('panel abierto con un token vencido: vuelve al login sin errores sin atrapar', async () => {
  const panel = cargarPanel({ responder: en401('Sesión inválida. Vuelve a iniciar sesión.') });
  const rechazos = await rechazosSinAtrapar(() => panel.correr('render()'));

  assert.deepEqual(rechazos, [], 'ni el TypeError de sesion.condominio ni el 401 deben llegar a errores.js');
  assert.ok(!panel.el('vista-login').classList.contains('oculta'), 'queda el login a la vista');
  assert.ok(panel.el('vista-panel').classList.contains('oculta'));
  assert.ok(!(CLAVE in panel.almacen), 'la sesión muerta se borra');
  assert.deepEqual(panel.pedidos, ['/api/admin/condominios'], 'sin sesión no se piden los informes');
});

for (const pestana of ['informes', 'puntos', 'guardias', 'rondas', 'avisos']) {
  test(`pestaña ${pestana} con la sesión vencida: el 401 no queda como error sin atrapar`, async () => {
    const panel = cargarPanel({ responder: en401('Tu sesión venció. Vuelve a entrar con tu usuario y PIN.') });
    const rechazos = await rechazosSinAtrapar(() => panel.correr(`mostrarTab('${pestana}')`));

    assert.deepEqual(rechazos, []);
    assert.ok(!panel.el('vista-login').classList.contains('oculta'));
  });
}

test('con la sesión viva, un fallo de verdad de la pestaña sigue llegando a errores.js', async () => {
  const panel = cargarPanel({ responder: () => [500, { error: 'Falla de prueba' }] });

  await assert.rejects(panel.correr("mostrarTab('informes')"), /Falla de prueba/);
  assert.ok(CLAVE in panel.almacen, 'un 500 no cierra la sesión');
});

test('con la sesión viva y el selector caído, el panel sigue y muestra el condominio de la cuenta', async () => {
  const panel = cargarPanel({
    responder: ruta => (ruta === '/api/admin/condominios' ? [500, { error: 'Falla de prueba' }] : [200, []])
  });
  const rechazos = await rechazosSinAtrapar(() => panel.correr('render()'));

  assert.deepEqual(rechazos, []);
  assert.equal(panel.el('nombre-condominio').textContent, 'Mirador');
  assert.ok(panel.pedidos.includes('/api/admin/ejecuciones'), 'la pestaña de informes se carga igual');
});
