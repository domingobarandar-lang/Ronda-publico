// Sentry (v1.20.1): filtro de datos personales, arranque sin DSN y sin SDK,
// endpoint de config y el bundle del navegador. NUNCA envía eventos reales:
// los tests no definen un DSN que apunte a un Sentry de verdad.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const sentry = require('../lib/sentry');
const { crearApp } = require('../server');
const publico = path.join(__dirname, '..', 'public');

function eventoSucio() {
  return {
    message: 'fallo pin=4821 nombre: Juan Pérez',
    request: {
      url: 'https://rondas.example/api/mi/ronda?token=secreto&lat=-33.44',
      method: 'POST',
      headers: { authorization: 'Bearer abc123', cookie: 'sid=zzz' },
      cookies: { sid: 'zzz' },
      data: { pin: '4821', lat: -33.448912, lng: -70.669265 },
      query_string: 'token=secreto'
    },
    user: { id: 'u_17', username: 'jperez', email: 'j@x.cl', ip_address: '1.2.3.4' },
    breadcrumbs: [{ category: 'fetch', data: { url: '/api/mi/ronda', body: '{"pin":"4821"}' } }],
    server_name: 'railway-abc',
    extra: { guardia: 'Juan Pérez' },
    contexts: { device: { name: 'x' }, runtime: { name: 'node' } },
    exception: { values: [{
      type: 'Error', value: 'JSON inválido {"pin":"4821","nombre":"Juan Pérez","lat":-33.448912} en /api/x?token=secreto',
      stacktrace: { frames: [{ filename: '/app/server.js', vars: { pin: '4821' }, context_line: 'const pin = "4821"' }] }
    }] }
  };
}

test('servidor: beforeSend quita cabeceras, cookies, cuerpo, PIN, GPS y nombre', () => {
  const e = sentry.filtrarEvento(eventoSucio());
  const texto = JSON.stringify(e);
  for (const dato of ['abc123', 'zzz', '4821', 'Juan', 'Pérez', '33.448912', '70.669265', 'secreto', 'jperez', 'j@x.cl', '1.2.3.4', 'railway-abc']) {
    assert.ok(!texto.includes(dato), `se coló "${dato}": ${texto}`);
  }
  assert.deepEqual(e.user, { id: 'u_17' }, 'al guardia solo se lo identifica por su id interno');
  assert.equal(e.request.url, 'https://rondas.example/api/mi/ronda');
  assert.equal(e.request.headers, undefined);
  assert.equal(e.request.data, undefined);
  assert.equal(e.breadcrumbs, undefined);
  assert.equal(e.contexts.device, undefined);
  assert.equal(e.contexts.runtime.name, 'node', 'lo útil se conserva');
  assert.equal(e.exception.values[0].stacktrace.frames[0].filename, '/app/server.js');
  assert.equal(sentry.filtrarEvento(null), null);
});

test('servidor: sin SENTRY_DSN no se inicia ni se carga el SDK', () => {
  delete process.env.SENTRY_DSN;
  assert.equal(sentry.iniciar(), false);
  assert.equal(sentry.estaActivo(), false);
  assert.ok(!Object.keys(require.cache).some(k => k.includes(`${path.sep}@sentry${path.sep}node${path.sep}`)),
    'el SDK no debe cargarse sin DSN');
  // capturar sin iniciar es inocuo
  assert.doesNotThrow(() => sentry.capturar({ contexto: 'x', error: new Error('x'), origen: 'servidor' }));
  return sentry.vaciar();
});

test('servidor: con un DSN inválido iniciar no lanza y la app sigue', () => {
  process.env.SENTRY_DSN = 'esto-no-es-un-dsn';
  try {
    assert.doesNotThrow(() => sentry.iniciar());
  } finally { delete process.env.SENTRY_DSN; }
});

test('GET /api/config-errores: vacío sin DSN, con dsn y release con DSN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-'));
  const { app, store } = crearApp({ rutaDb: path.join(dir, 'db.sqlite') });
  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${servidor.address().port}/api/config-errores`;
  try {
    delete process.env.SENTRY_DSN;
    let r = await fetch(url);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});

    process.env.SENTRY_DSN = 'https://clave@o0.ingest.sentry.io/1';
    r = await fetch(url);
    const cfg = await r.json();
    assert.equal(cfg.dsn, process.env.SENTRY_DSN);
    assert.equal(cfg.release, 'ronda@' + require('../package.json').version);
    assert.ok(['production', 'development'].includes(cfg.entorno));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally {
    delete process.env.SENTRY_DSN;
    await new Promise(r => servidor.close(r));
    if (store.cerrar) store.cerrar();
  }
});

test('la ruta de prueba no existe sin SENTRY_PRUEBA', async () => {
  delete process.env.SENTRY_PRUEBA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-'));
  const { app, store } = crearApp({ rutaDb: path.join(dir, 'db.sqlite') });
  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/sentry-prueba`, { method: 'POST' });
    assert.equal(r.status, 404);
  } finally {
    await new Promise(r => servidor.close(r));
    if (store.cerrar) store.cerrar();
  }
});

// ---- navegador ------------------------------------------------------------

// errores.js con un window de mentira. `cfg`: respuesta de /api/config-errores
// (null = el fetch falla); `conSdk`: si window.Sentry existe.
function navegador({ cfg, conSdk = true } = {}) {
  const oyentes = {};
  const llamadas = { init: [], capturas: [] };
  const window = { addEventListener: (t, fn) => { oyentes[t] = fn; } };
  if (conSdk) {
    window.Sentry = {
      init: o => llamadas.init.push(o),
      captureException: (e, o) => llamadas.capturas.push({ e, o })
    };
  }
  const ctx = vm.createContext({
    window,
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {} } },
    location: { pathname: '/index.html' },
    fetch: url => (String(url).includes('config-errores')
      ? (cfg === null ? Promise.reject(new Error('sin señal')) : Promise.resolve({ ok: true, json: () => Promise.resolve(cfg) }))
      : Promise.resolve({})),
    setTimeout: () => 0
  });
  vm.runInContext(fs.readFileSync(path.join(publico, 'errores.js'), 'utf8'), ctx);
  const listo = () => new Promise(r => setImmediate(r));
  return { window, oyentes, llamadas, listo };
}

test('navegador: con DSN inicia Sentry sin integraciones y reporta con tope y dedupe', async () => {
  const b = navegador({ cfg: { dsn: 'https://k@o0.ingest.sentry.io/1', release: 'ronda@1.20.1', entorno: 'production' } });
  b.window.__reportarError(new Error('antes de la config')); // queda en espera
  await b.listo(); await b.listo();
  assert.equal(b.llamadas.init.length, 1);
  const o = b.llamadas.init[0];
  assert.equal(o.release, 'ronda@1.20.1');
  assert.equal(o.environment, 'production');
  assert.equal(o.defaultIntegrations, false, 'sin handlers globales ni breadcrumbs automáticos');
  assert.equal(o.integrations.length, 0);
  assert.equal(o.beforeBreadcrumb(), null);
  assert.equal(b.llamadas.capturas.length, 1, 'lo pendiente sale al iniciar');

  for (let i = 0; i < 5; i++) b.window.__reportarError(new Error('repetido'));
  assert.equal(b.llamadas.capturas.length, 2, 'el mismo mensaje pasa una sola vez');
  for (let i = 0; i < 30; i++) b.window.__reportarError(new Error('otro ' + i));
  assert.equal(b.llamadas.capturas.length, 10, 'mismo tope de 10 por sesión');

  b.window.__reportarError(new Error('Script error.'));
  assert.equal(b.llamadas.capturas.length, 10, 'el ruido no llega a Sentry');
});

test('navegador: sin DSN, sin SDK o sin señal no hay Sentry y errores.js funciona igual', async () => {
  for (const opciones of [{ cfg: {} }, { cfg: { dsn: '' } }, { cfg: null }, { cfg: { dsn: 'x' }, conSdk: false }]) {
    const b = navegador(opciones);
    assert.doesNotThrow(() => b.window.__reportarError(new Error('algo')));
    await b.listo(); await b.listo();
    assert.equal(b.llamadas.init.length, 0, JSON.stringify(opciones));
    assert.equal(b.llamadas.capturas.length, 0, JSON.stringify(opciones));
    assert.equal(typeof b.window.__reportarError, 'function');
  }
});

test('navegador: la etiqueta condominio la da la página (window.__erroresCondominio)', async () => {
  const etiquetas = async proveedor => {
    const b = navegador({ cfg: { dsn: 'https://k@o0.ingest.sentry.io/1' } });
    if (proveedor) b.window.__erroresCondominio = proveedor;
    await b.listo(); await b.listo();
    b.window.__reportarError(new Error('con condominio'));
    return b.llamadas.capturas[0].o.tags;
  };
  assert.equal((await etiquetas(() => 'aromos')).condominio, 'aromos');
  assert.equal((await etiquetas(() => 'x'.repeat(80))).condominio.length, 40, 'recortado');
  // Sin sesión, sin proveedor o con uno roto: sin etiqueta, y el reporte sale igual.
  for (const proveedor of [() => null, null, () => { throw new Error('roto'); }]) {
    const t = await etiquetas(proveedor);
    assert.equal(t.condominio, undefined);
    assert.equal(t.pagina, '/index.html');
  }
});

test('navegador: un Sentry que lanza no rompe el reporte', async () => {
  const b = navegador({ cfg: { dsn: 'https://k@o0.ingest.sentry.io/1' } });
  b.window.Sentry.captureException = () => { throw new Error('sdk roto'); };
  await b.listo(); await b.listo();
  assert.doesNotThrow(() => b.window.__reportarError(new Error('x')));
});

test('navegador: beforeSend quita query de la URL, cabeceras, breadcrumbs y usuario', () => {
  const { window } = navegador({ cfg: {} });
  const e = window.__erroresFiltrarEvento({
    request: { url: 'https://r.cl/index.html?token=secreto#x', headers: { authorization: 'Bearer abc' }, cookies: 'a=b', data: '{"pin":"1234"}' },
    breadcrumbs: [{ category: 'fetch', data: { url: '/api/x', body: '{"pin":"1234"}' } }],
    user: { id: 'u1', ip_address: '1.2.3.4' },
    exception: { values: [{ value: 'falló pin=1234 y Bearer abc en -33.448912, -70.669265', stacktrace: { frames: [{ filename: 'https://r.cl/app.js?v=1' }] } }] }
  });
  const texto = JSON.stringify(e);
  for (const dato of ['secreto', 'abc', '1234', '33.448912', '1.2.3.4', 'u1']) assert.ok(!texto.includes(dato), `se coló "${dato}": ${texto}`);
  assert.equal(e.request.url, 'https://r.cl/index.html');
  assert.equal(e.breadcrumbs.length, 0);
  assert.equal(e.exception.values[0].stacktrace.frames[0].filename, 'https://r.cl/app.js');
  assert.equal(window.__erroresFiltrarEvento(null), null);
});

// ---- empaquetado y garita -------------------------------------------------

test('el bundle del navegador está comiteado, expone Sentry y entra al SHELL del service worker', () => {
  const ruta = path.join(publico, 'vendor', 'sentry.js');
  assert.ok(fs.existsSync(ruta), 'falta public/vendor/sentry.js: corre `npm run build:sentry`');
  const ctx = vm.createContext({ window: {}, self: {}, document: {}, navigator: {}, location: {}, setTimeout, clearTimeout });
  ctx.window.window = ctx.window;
  // Solo se comprueba que cargue sin lanzar: no se inicia ni se manda nada.
  try { vm.runInContext(fs.readFileSync(ruta, 'utf8'), ctx); } catch { /* el entorno de mentira puede quedarse corto */ }
  assert.ok(fs.readFileSync(path.join(publico, 'sw.js'), 'utf8').includes("'vendor/sentry.js'"));
  for (const html of ['index.html', 'admin.html', 'fabrica.html']) {
    const t = fs.readFileSync(path.join(publico, html), 'utf8');
    const i = t.indexOf('vendor/sentry.js');
    assert.ok(i !== -1 && i < t.indexOf('src="errores.js"'), `${html} debe cargar sentry.js antes de errores.js`);
  }
});

test('el SDK del navegador y esbuild son devDependencies (no van a producción)', () => {
  const p = require('../package.json');
  assert.ok(p.dependencies['@sentry/node']);
  for (const d of ['@sentry/browser', 'esbuild']) {
    assert.ok(p.devDependencies[d], `${d} debe ser devDependency`);
    assert.ok(!p.dependencies[d], `${d} no debe estar en dependencies`);
  }
});
