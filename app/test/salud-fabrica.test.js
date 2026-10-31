// Salud del producto en la pantalla de la operación (v1.26): el login anota
// al guardia que vuelve a entrar con una ronda en curso, y GET
// /api/fabrica/condominios trae los tres indicadores de cada condominio con
// los datos de la base. Los conteos en detalle están en salud.test.js.
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

let base;
let servidor;
let store;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-salud-fab-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('/fabrica: reingreso a mitad de ronda y rondas por estado, por condominio', async () => {
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
  assert.deepEqual(aromos.reingresos, { rondas: 1, veces: 1, porcentaje: 100 });
  assert.equal(aromos.rondas.cerradas, 1);
  assert.equal(aromos.rondas.incompletas, 1, 'se cerró sin marcar ningún punto');
  assert.equal(aromos.rondas.porcentaje.incompletas, 100);
  assert.deepEqual(aromos.alarmasRetenidas, { veces: 0, rondas: 0 });

  // Mirador no tiene rondas: ceros, no NaN ni un error.
  const mirador = datos.condominios.find(c => c.id === 'mirador').salud;
  assert.equal(mirador.rondas.cerradas, 0);
  assert.equal(mirador.rondas.porcentaje.completas, 0);
  assert.deepEqual(mirador.reingresos, { rondas: 0, veces: 0, porcentaje: 0 });

  // Solo la fábrica lo ve.
  assert.equal((await api('/api/fabrica/condominios', { token: pedro.token })).status, 403);
  assert.equal(store.salud.listar('aromos', 'reingreso-en-ronda', '2000-01-01', '9999-12-31').length, 1);
});
