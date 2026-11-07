// Salud del producto en la pantalla de la operación (v1.26): el login anota
// al guardia que vuelve a entrar con una ronda en curso, GET
// /api/fabrica/condominios trae los indicadores de cada condominio con los
// datos de la base, y GET /api/fabrica/sentry los errores de Sentry (con un
// Sentry de mentira). Los conteos en detalle están en salud.test.js y
// sentry-lectura.test.js.
'use strict';

process.env.MOCK = 'true';
process.env.FABRICA_USUARIO = 'fabrica';
process.env.FABRICA_PIN = '87654321';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const { crearLectorSentry } = require('../lib/sentry-lectura');

let base;
let servidor;
let store;
const consultasSentry = [];

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

async function login(usuario, pin) {
  const r = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  return r.datos;
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-salud-fab-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  // Sentry de mentira: un problema en aromos, ninguno en mirador, uno sin condominio.
  const lectorSentry = crearLectorSentry({
    env: { SENTRY_DSN: 'https://k@o1.ingest.us.sentry.io/2', SENTRY_TOKEN_LECTURA: 'lectura' },
    fetch: async url => {
      const query = new URL(url).searchParams.get('query');
      consultasSentry.push(query);
      const lista = query.endsWith('condominio:aromos') ? [{ title: 'TypeError: punto is undefined', count: '3', permalink: 'https://x.sentry.io/issues/9/' }]
        : query.includes('!has:condominio') ? [{ title: 'Error: SMTP', count: '1' }] : [];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => lista };
    }
  });
  const creado = crearApp({ rutaDb, enviarPush: async () => {}, lectorSentry });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('/fabrica: sesión cortada a mitad de ronda y rondas por estado, por condominio', async () => {
  const pedro = await login('pedro', '2222');
  const inicio = new Date(Date.now() - 20 * 60000).toISOString();
  const r = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { id: 'salud-0001', rondaId: 'ronda-express', inicio } });
  assert.equal(r.status, 201);

  // La sesión se le corta a Pedro y vuelve a entrar con la ronda abierta.
  const otra = await login('pedro', '2222');
  // Luis entra en el mismo condominio sin ronda propia: no cuenta.
  await login('luis', '3333');
  await api('/api/ejecuciones/salud-0001/cerrar', { metodo: 'POST', token: otra.token, cuerpo: {} });

  const jefe = await login('fabrica', '87654321');
  const { status, datos } = await api('/api/fabrica/condominios', { token: jefe.token });
  assert.equal(status, 200);
  const aromos = datos.condominios.find(c => c.id === 'aromos').salud;
  assert.equal(aromos.dias, 7);
  assert.deepEqual(aromos.dificultades.app, { rondas: 1, porcentaje: 100, causas: { gps: 0, sesion: 1, telefono: 0, chapita: 0 } });
  assert.equal(aromos.dificultades.usuario.rondas, 0);
  assert.equal(aromos.rondas.total, 1);
  assert.equal(aromos.rondas.cerradas, 1);
  assert.equal(aromos.rondas.incompletas, 1, 'se cerró sin marcar ningún punto');
  assert.equal(aromos.rondas.porcentaje.incompletas, 100);

  // Mirador no tiene rondas: ceros, no NaN ni un error.
  const mirador = datos.condominios.find(c => c.id === 'mirador').salud;
  assert.equal(mirador.rondas.cerradas, 0);
  assert.equal(mirador.rondas.porcentaje.completas, 0);
  assert.equal(mirador.dificultades.rondas, 0);
  assert.equal(mirador.dificultades.porcentaje, 0);

  // Solo la fábrica lo ve.
  assert.equal((await api('/api/fabrica/condominios', { token: pedro.token })).status, 403);
  assert.equal(store.salud.listar('aromos', 'reingreso-en-ronda', '2000-01-01', '9999-12-31').length, 1);
});

test('/fabrica: sin ubicación, vieja o imprecisa es del GPS aunque el teléfono no mande tope; el medio equivocado, del guardia', async () => {
  const jorge = await login('jorge', '5555');
  const inicio = new Date(Date.now() - 20 * 60000).toISOString();
  const r = await api('/api/ejecuciones', { metodo: 'POST', token: jorge.token, cuerpo: { id: 'salud-0002', rondaId: 'ronda-mirador', inicio } });
  assert.equal(r.status, 201);

  // Los cuerpos que manda la cola del teléfono (sincronizar en public/app.js):
  // el tope viaja solo cuando hubo distancia que medir.
  const rechazo = (hace, campos) => ({
    puntoId: 'p-m-subterraneo', ts: new Date(Date.now() - hace * 60000).toISOString(),
    motivo: null, distanciaM: null, topeM: null, acc: null, edadMs: null, reporte: null, ...campos
  });
  const cuerpos = [
    rechazo(5, { motivo: '📍 Sin ubicación (buscando señal): "Subterráneo" no se puede marcar hasta confirmar que estás ahí.' }),
    rechazo(4, { motivo: '📍 Tu ubicación es de hace 3 min: hace falta una más reciente para marcar "Subterráneo".', acc: 8, edadMs: 180000 }),
    rechazo(3, { motivo: '📍 Señal demasiado imprecisa (±900 m) para confirmar que estás en "Subterráneo". Espera unos segundos a que el GPS afine y vuelve a escanear.', acc: 900, edadMs: 1000 }),
    rechazo(2, { puntoId: 'p-m-terraza', motivo: 'Este punto se marca con la chapita NFC: acerca la parte trasera del teléfono a la chapita de "Terraza".' })
  ];
  for (const cuerpo of cuerpos) {
    assert.equal((await api('/api/ejecuciones/salud-0002/rechazos', { metodo: 'POST', token: jorge.token, cuerpo })).status, 201);
  }

  const jefe = await login('fabrica', '87654321');
  const { datos } = await api('/api/fabrica/condominios', { token: jefe.token });
  const d = datos.condominios.find(c => c.id === 'mirador').salud.dificultades;
  assert.deepEqual(d.app.causas, { gps: 1, sesion: 0, telefono: 0, chapita: 0 });
  assert.deepEqual(d.usuario.causas, { lejos: 0, medio: 1, terminar: 0 });
  assert.deepEqual(d.gps, { rondas: 1, porcentaje: 100, rechazos: 3 });
});

test('/fabrica: errores de Sentry por condominio y los que no tienen, solo para la fábrica', async () => {
  const jefe = await login('fabrica', '87654321');
  const { status, datos } = await api('/api/fabrica/sentry', { token: jefe.token });
  assert.equal(status, 200);
  assert.equal(datos.conectado, true);
  assert.equal(datos.dias, 7);
  assert.equal(datos.porCondominio.aromos.problemas, 1);
  assert.equal(datos.porCondominio.aromos.lista[0].titulo, 'TypeError: punto is undefined');
  assert.equal(datos.porCondominio.aromos.lista[0].eventos, 3);
  assert.deepEqual(datos.porCondominio.mirador, { problemas: 0, lista: [] });
  assert.equal(datos.sinCondominio.lista[0].titulo, 'Error: SMTP');
  // El token de lectura no sale del servidor.
  assert.ok(!JSON.stringify(datos).includes('lectura'));

  // Una segunda carga sale del caché: no vuelve a preguntarle a Sentry.
  const antes = consultasSentry.length;
  await api('/api/fabrica/sentry', { token: jefe.token });
  assert.equal(consultasSentry.length, antes);

  const pedro = await login('pedro', '2222');
  assert.equal((await api('/api/fabrica/sentry', { token: pedro.token })).status, 403);
  assert.equal((await api('/api/fabrica/sentry')).status, 401);
});

test('/fabrica: sin token de lectura, dice qué falta y no llama a Sentry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-salud-fab-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const otra = crearApp({ rutaDb, enviarPush: async () => {}, lectorSentry: crearLectorSentry({ env: { SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' }, fetch: () => { throw new Error('no debía llamar'); } }) });
  const srv = await new Promise(resolve => { const s = otra.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const login = await (await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: 'fabrica', pin: '87654321' }) })).json();
    const datos = await (await fetch(`${url}/api/fabrica/sentry`, { headers: { authorization: `Bearer ${login.token}` } })).json();
    assert.equal(datos.conectado, false);
    assert.match(datos.falta, /SENTRY_TOKEN_LECTURA/);
  } finally {
    await new Promise(r => srv.close(r));
    if (otra.store.cerrar) otra.store.cerrar();
  }
});
