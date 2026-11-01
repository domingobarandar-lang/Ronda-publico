// Manejo global de errores (v1.20): filtro de datos personales, tope y
// deduplicación, la ruta pública y el script del navegador.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const errores = require('../lib/errores');
const { crearApp } = require('../server');

// Captura lo que se escribe a console.error mientras corre `fn` (sync o async).
async function capturar(fn) {
  const lineas = [];
  const original = console.error;
  console.error = (...a) => lineas.push(a.join(' '));
  try { await fn(); } finally { console.error = original; }
  return lineas;
}

test('el filtro oculta token, PIN, coordenadas y nombre', () => {
  const sucio = 'fallo con Authorization: Bearer abc123def456 {"pin":"4821","nombre":"Juan Pérez","lat":-33.448912,"lng":-70.669265} '
    + 'en -33.448912, -70.669265 y /api/mi/ronda?token=secreto&x=1';
  const limpio = errores.limpiar(sucio, 1000);
  for (const dato of ['abc123def456', '4821', 'Juan', 'Pérez', '33.448912', '70.669265', 'secreto']) {
    assert.ok(!limpio.includes(dato), `se coló "${dato}": ${limpio}`);
  }
  assert.ok(limpio.includes('fallo con'), 'el resto del mensaje se conserva');
});

test('el log no admite saltos de línea inyectados y se trunca', async () => {
  const [linea, ...mas] = await capturar(() => errores.reportarCliente({
    pagina: '/index.html?x=1', mensaje: 'uno\n[error-cliente] falso\r\ndos' + 'x'.repeat(5000),
    pila: 'a\nb\nc'.repeat(2000), version: 'v1.20.0'
  }, { ua: 'Mozilla\nInyectado' }, Date.now() + 1e9));
  assert.equal(mas.length, 0);
  assert.ok(!/[\r\n]/.test(linea), 'una sola línea');
  assert.ok(linea.length < 2500, `línea demasiado larga: ${linea.length}`);
  assert.ok(linea.startsWith('[error-cliente] pagina=/index.html version=v1.20.0'));
});

test('el servidor descarta el mismo error repetido', async () => {
  const t = Date.now() + 2e9;
  const datos = { pagina: '/', mensaje: 'bucle' };
  const lineas = await capturar(() => {
    for (let i = 0; i < 20; i++) errores.reportarCliente(datos, {}, t + i);
  });
  assert.equal(lineas.length, 1);
});

test('reportar usa el filtro y avisa a los ganchos', async () => {
  const vistos = [];
  errores.alReportar(d => vistos.push(d.contexto));
  const lineas = await capturar(() => errores.reportar('prueba', new Error('pin: 9999 falló')));
  assert.equal(lineas.length, 1);
  assert.ok(!lineas[0].includes('9999'));
  assert.ok(lineas[0].includes('[prueba]'));
  assert.ok(vistos.includes('prueba'));
});

test('reportar con condominio: va en la línea y a los ganchos (etiqueta de Sentry)', async () => {
  const vistos = [];
  errores.alReportar(d => vistos.push(d));
  const lineas = await capturar(() => errores.reportar('alarma-ronda', new Error('sin push'), { condominioId: 'aromos' }));
  assert.ok(lineas[0].includes('[alarma-ronda] sin push condominio=aromos'), lineas[0]);
  assert.equal(vistos.find(d => d.contexto === 'alarma-ronda').condominioId, 'aromos');
  await capturar(() => errores.reportar('sin-condominio', new Error('x')));
  assert.equal(vistos.find(d => d.contexto === 'sin-condominio').condominioId, null);
});

test('el limitador corta pasado el tope y se renueva con la ventana', () => {
  const permitir = errores.crearLimitador({ max: 3, ventanaMs: 1000 });
  assert.deepEqual([1, 2, 3, 4].map(() => permitir('ip', 0)), [true, true, true, false]);
  assert.equal(permitir('otra', 0), true);
  assert.equal(permitir('ip', 1000), true);
});

test('la red del proceso registra los rechazos y sale tras una excepción', async () => {
  const proc = new (require('node:events'))();
  const salidas = [];
  errores.instalarRedProceso(proc, c => salidas.push(c));
  const lineas = await capturar(() => {
    proc.emit('unhandledRejection', new Error('suelta'));
    proc.emit('uncaughtException', new Error('grave'));
  });
  assert.equal(lineas.length, 2);
  assert.deepEqual(salidas, []);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(salidas, [1]);
});

test('POST /api/errores-cliente: acepta, sanitiza y rechaza cuerpos enormes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-'));
  const { app, store } = crearApp({ rutaDb: path.join(dir, 'db.sqlite') });
  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const enviar = cuerpo => fetch(base + '/api/errores-cliente', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)
  });
  try {
    let resp;
    const lineas = await capturar(async () => {
      resp = await enviar({ pagina: '/admin.html', mensaje: 'falló\nINYECTADO pin=1234 lat: -33.4501', version: 'v1.20.0', pila: 'x' });
    });
    assert.equal(resp.status, 204);
    assert.equal(lineas.length, 1);
    assert.ok(!/[\r\n]/.test(lineas[0]) && !lineas[0].includes('1234') && !lineas[0].includes('33.4501'), lineas[0]);
    assert.ok(lineas[0].includes('[error-cliente]'));

    const grande = await enviar({ pagina: '/', mensaje: 'x'.repeat(50000) });
    assert.equal(grande.status, 413);
    const raro = await enviar('esto no es json');
    assert.ok(raro.status >= 400 && raro.status < 500);
  } finally {
    await new Promise(r => servidor.close(r));
    if (store.cerrar) store.cerrar();
  }
});

// errores.js del navegador, ejecutado con un window/document de mentira.
function navegador() {
  const oyentes = {};
  const envios = [];
  const window = { addEventListener: (tipo, fn) => { oyentes[tipo] = fn; } };
  const documento = {
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, parentNode: null }),
    body: { appendChild() {} }
  };
  const ctx = vm.createContext({
    window, document: documento, location: { pathname: '/index.html' },
    fetch: (url, opts) => { envios.push({ url, opts }); return Promise.resolve({}); },
    setTimeout: () => 0
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'errores.js'), 'utf8'), ctx);
  return { window, oyentes, envios };
}

test('errores.js: tope por sesión, deduplicación y ruido ignorado', () => {
  const { window, oyentes, envios } = navegador();
  for (let i = 0; i < 5; i++) oyentes.error({ error: new Error('mismo'), message: 'mismo' });
  assert.equal(envios.length, 1, 'el mismo mensaje se manda una sola vez');
  for (let i = 0; i < 30; i++) window.__reportarError(new Error('distinto ' + i));
  assert.equal(envios.length, 10, 'tope de 10 por sesión');

  const b = navegador();
  b.oyentes.error({ message: 'Script error.' });
  b.oyentes.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  b.oyentes.error({ message: 'x', error: new Error('x'), filename: 'chrome-extension://abc/inject.js' });
  b.oyentes.unhandledrejection({ reason: new TypeError('Failed to fetch') });
  assert.equal(b.envios.length, 0);

  b.oyentes.unhandledrejection({ reason: new Error('promesa real') });
  assert.equal(b.envios.length, 1);
  assert.equal(b.envios[0].url, '/api/errores-cliente');
  assert.equal(b.envios[0].opts.keepalive, true);
  assert.equal(JSON.parse(b.envios[0].opts.body).pagina, '/index.html');
});

test('errores.js no toca el almacenamiento ni recarga o navega', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'public', 'errores.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/localStorage|sessionStorage|indexedDB|location\.(reload|href|assign|replace)/.test(fuente));
});

test('las tres páginas cargan errores.js antes que su código', () => {
  const pub = path.join(__dirname, '..', 'public');
  const orden = (html, antes) => {
    const h = fs.readFileSync(path.join(pub, html), 'utf8');
    const i = h.indexOf('src="errores.js"');
    assert.ok(i !== -1, `${html} no carga errores.js`);
    for (const s of antes) assert.ok(i < h.indexOf(`src="${s}"`), `${html}: errores.js debe ir antes de ${s}`);
  };
  orden('index.html', ['geo.js', 'app.js']);
  orden('admin.html', ['geo.js', 'admin.js']);
  orden('fabrica.html', ['fabrica.js']);
  const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.ok(index.indexOf('src="vigia.js"') < index.indexOf('src="errores.js"'));
});
