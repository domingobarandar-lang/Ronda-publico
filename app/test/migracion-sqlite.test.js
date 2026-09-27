// Consumidores del store sobre SQLite (v1.17): el motor de rondas, los handlers
// y los módulos que leen ejecuciones y notificaciones por el repositorio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const motor = require('../lib/rondas');

const nuevoStore = () => crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-mig-')), 'rondas.sqlite'), { sinPuente: true });

test('iniciarEjecucion usa el repositorio: la nueva no se guarda sola y la repetida vuelve la guardada', () => {
  const store = nuevoStore();
  const db = { rondas: [{ id: 'r', condominioId: 'c', puntoIds: [] }], puntos: [] };
  const guardia = { id: 'g', condominioId: 'c' };

  const r = motor.iniciarEjecucion(db, store.ejecuciones, { ejecucionId: 'ejec-00000001', rondaId: 'r', guardia });
  assert.equal(r.repetida, undefined);
  assert.equal(r.ejecucion.estado, 'en_curso');
  assert.equal(store.ejecuciones.obtener('ejec-00000001'), null, 'quien llama decide cuándo guardar');
  store.ejecuciones.guardar(r.ejecucion);

  const otra = motor.iniciarEjecucion(db, store.ejecuciones, { ejecucionId: 'ejec-00000001', rondaId: 'r', guardia });
  assert.equal(otra.repetida, true);
  assert.deepEqual(otra.ejecucion, r.ejecucion);

  const ajena = motor.iniciarEjecucion(db, store.ejecuciones, { rondaId: 'r', guardia: { id: 'x', condominioId: 'otro' } });
  assert.equal(ajena.codigo, 403);
  store.cerrar();
});

test('push y notificar dejan el aviso en store.notificaciones (sin arreglo en memoria)', async () => {
  const { crearPush } = require('../lib/push');
  const { registrarAviso, notificarAdmin } = require('../lib/notificar');
  const store = nuevoStore();
  store.db.vapid = { publicKey: 'pub', privateKey: 'priv' };
  store.db.pushSuscripciones.push(
    { condominioId: 'c1', usuarioId: 'u1', destino: 'admin', suscripcion: { endpoint: 'https://push.ejemplo/ok', keys: { p256dh: 'a', auth: 'b' } } },
    { condominioId: 'c1', usuarioId: 'u2', destino: 'admin', suscripcion: { endpoint: 'https://push.ejemplo/muerto', keys: { p256dh: 'a', auth: 'b' } } }
  );
  const push = crearPush(store, {
    enviar: async s => { if (s.endpoint.endsWith('muerto')) { const e = new Error('gone'); e.statusCode = 410; throw e; } }
  });
  const log = console.log;
  console.log = () => {};
  try {
    const registro = await push.avisar({ id: 'c1' }, { titulo: 'T', cuerpo: 'C', url: 'u' });
    assert.deepEqual(registro.dispositivos, { ok: 1, total: 2 });
    registrarAviso(store, { id: 'c1', nombre: 'Uno' }, 'cierre');
    await notificarAdmin(store, { id: 'c1', nombre: 'Uno' }, 'otro cierre');
  } finally {
    console.log = log;
  }
  assert.equal(store.db.notificaciones, undefined);
  assert.deepEqual(store.notificaciones.ultimas('c1').map(n => [n.medio, n.texto]),
    [['registro', 'otro cierre'], ['registro', 'cierre'], ['push', 'T\nC']]);
  assert.equal(store.db.pushSuscripciones.length, 1, 'la suscripción muerta se limpió');
  store.cerrar();
});

// ---------- Handlers del servidor sobre el repositorio ----------

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');

let base;
let servidor;
let app;

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})), headers: resp.headers };
}
const login = async (usuario, pin) => (await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).datos;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-mig-app-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  app = crearApp({ rutaDb, enviarPush: async () => {} });
  await new Promise(r => { servidor = app.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => servidor.close());

// Ronda nueva de `n` puntos recién creados (sin GPS), sin orden estricto.
async function rondaDe(nombre, n) {
  const admin = await login('admin', '1234');
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push((await api('/api/admin/puntos', { metodo: 'POST', token: admin.token, cuerpo: { nombre: `${nombre} ${i + 1}` } })).datos.id);
  }
  const ronda = (await api('/api/admin/rondas', { metodo: 'POST', token: admin.token, cuerpo: { nombre, puntoIds: ids, ordenEstricto: false } })).datos;
  const guardia = await login('guardia', '5678');
  const paquete = (await api('/api/mi/paquete', { token: guardia.token })).datos;
  return { ronda: paquete.rondas.find(r => r.id === ronda.id), token: guardia.token, adminToken: admin.token };
}

test('invariante 1: N escaneos concurrentes a la misma ejecución quedan los N guardados', async () => {
  // La cola offline del teléfono sincroniza en ráfaga. Cada request lee su
  // propia copia de la ejecución: si alguno tuviera un `await` entre leer y
  // guardar, el último en guardar pisaría a los demás.
  const N = 12;
  const { ronda, token } = await rondaDe('Rafaga', N);
  const ejecucion = (await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } })).datos;
  const t0 = Date.now();
  const respuestas = await Promise.all(ronda.puntos.map((p, i) => api(`/api/ejecuciones/${ejecucion.id}/escaneos`, {
    metodo: 'POST', token, cuerpo: { codigo: p.payload, ts: new Date(t0 + i * 1000).toISOString(), offline: true }
  })));
  for (const r of respuestas) assert.equal(r.status, 200, JSON.stringify(r.datos));
  const guardada = app.store.ejecuciones.obtener(ejecucion.id);
  assert.equal(guardada.escaneos.length, N, 'no se perdió ninguna marca');
  assert.equal(new Set(guardada.escaneos.map(s => s.puntoId)).size, N);

  // Y los rechazos por GPS, que también llegan en ráfaga por la cola.
  const rechazos = await Promise.all(ronda.puntos.map((p, i) => api(`/api/ejecuciones/${ejecucion.id}/rechazos`, {
    metodo: 'POST', token, cuerpo: { puntoId: p.id, ts: new Date(t0 + i).toISOString(), motivo: 'lejos' }
  })));
  for (const r of rechazos) assert.equal(r.status, 201);
  assert.equal(app.store.ejecuciones.obtener(ejecucion.id).rechazos.length, N);
  assert.equal(app.store.ejecuciones.obtener(ejecucion.id).escaneos.length, N, 'los rechazos no pisaron las marcas');
});

test('invariante 2: si el aviso no se puede registrar, la ronda no queda cerrada', async () => {
  const { ronda, token } = await rondaDe('Atomica', 2);
  const ejecucion = (await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } })).datos;
  const antes = app.store.notificaciones.contar();
  const original = app.store.notificaciones.agregar;
  app.store.notificaciones.agregar = n => { original(n); throw new Error('disco lleno'); };
  const log = console.error;
  console.error = () => {};
  try {
    const r = await api(`/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token });
    assert.equal(r.status, 500);
  } finally {
    app.store.notificaciones.agregar = original;
    console.error = log;
  }
  assert.equal(app.store.ejecuciones.obtener(ejecucion.id).estado, 'en_curso', 'el cierre se deshizo junto con el aviso');
  assert.equal(app.store.notificaciones.contar(), antes, 'y el aviso a medias también');

  const r = await api(`/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token });
  assert.equal(r.status, 200);
  assert.equal(app.store.ejecuciones.obtener(ejecucion.id).estado, 'incompleta');
  assert.equal(app.store.notificaciones.contar(), antes + 1);
});

test('el listado del panel trae las últimas 200 y filtra por días de Chile', async () => {
  const { adminToken } = await rondaDe('Listado', 1);
  const { store } = app;
  const t0 = Date.parse('2026-06-01T12:00:00Z');
  store.transaccion(() => {
    for (let i = 0; i < 250; i++) {
      store.ejecuciones.guardar({ id: `lista-${String(i).padStart(4, '0')}`, rondaId: 'x', condominioId: 'aromos', guardiaId: 'u-guardia',
        inicio: new Date(t0 + i * 3600000).toISOString(), fin: null, estado: 'completa', escaneos: [], evaluacion: { faltantes: [] } });
    }
    // Domingo 20 de septiembre, 23:30 en Chile (UTC-3) = lunes 02:30 UTC.
    store.ejecuciones.guardar({ id: 'domingo-noche', rondaId: 'x', condominioId: 'aromos', guardiaId: 'u-guardia',
      inicio: '2026-09-21T02:30:00.000Z', fin: null, estado: 'completa', escaneos: [], evaluacion: { faltantes: [] } });
  });
  const todo = await api('/api/admin/ejecuciones', { token: adminToken });
  assert.equal(todo.status, 200);
  assert.equal(todo.datos.length, 200);
  assert.equal(todo.headers.get('x-limite'), '200');
  const inicios = todo.datos.map(e => e.inicio);
  assert.deepEqual(inicios, [...inicios].sort().reverse(), 'la más reciente primero');

  const domingo = await api('/api/admin/ejecuciones?desde=2026-09-20&hasta=2026-09-20', { token: adminToken });
  assert.deepEqual(domingo.datos.map(e => e.id), ['domingo-noche'], 'las 23:30 del domingo son del domingo');
  const lunes = await api('/api/admin/ejecuciones?desde=2026-09-21&hasta=2026-09-21', { token: adminToken });
  assert.ok(!lunes.datos.some(e => e.id === 'domingo-noche'));

  // Del 1 de junio 12:00 UTC (la primera) al 2 de junio 23:59 de Chile (UTC-4) = 3 de junio 03:59 UTC.
  const junio = await api('/api/admin/ejecuciones?desde=2026-06-01&hasta=2026-06-02', { token: adminToken });
  assert.equal(junio.datos.length, 40);
  assert.equal((await api('/api/admin/ejecuciones?desde=ayer', { token: adminToken })).status, 422);

  const otro = await login('carmen', '4444');
  const ajeno = await api('/api/admin/ejecuciones?desde=2026-09-20&hasta=2026-09-20', { token: otro.token });
  assert.deepEqual(ajeno.datos, [], 'cada admin ve solo su condominio');
  assert.equal((await api('/api/admin/informes/domingo-noche', { token: otro.token })).status, 404);
  assert.equal((await api('/api/admin/informes/domingo-noche', { token: adminToken })).status, 200);
});

test('el panel lee los avisos con LIMIT: los últimos 50 del condominio, el más nuevo primero', async () => {
  const { adminToken } = await rondaDe('Avisos', 1);
  for (let i = 0; i < 60; i++) {
    app.store.notificaciones.agregar({ ts: new Date().toISOString(), condominioId: 'aromos', texto: `aviso-${i}`, medio: 'registro', enviada: true });
  }
  const r = await api('/api/admin/notificaciones', { token: adminToken });
  assert.equal(r.datos.length, 50);
  assert.equal(r.datos[0].texto, 'aviso-59');
});
