// Alarma de ronda: el administrador fija cada cuánto suena y el teléfono de la
// garita (suscrito desde la app del guardia) la recibe. Las alertas del
// administrador y la alarma del guardia van a públicos distintos.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const recordatorios = require('../lib/recordatorios');

let base;
let servidor;
let store;
let push;
const enviados = [];

async function api(ruta, { metodo = 'GET', cuerpo, token, condominio } = {}) {
  const cabeceras = { 'content-type': 'application/json' };
  if (token) cabeceras.authorization = `Bearer ${token}`;
  if (condominio) cabeceras['x-condominio'] = condominio;
  const resp = await fetch(base + ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}
const login = async (usuario, pin) => (await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).datos;
const suscripcion = n => ({ endpoint: `https://push.ejemplo/${n}`, keys: { p256dh: 'p', auth: 'a' } });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-alarma-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async (s, payload) => { enviados.push({ endpoint: s.endpoint, datos: JSON.parse(payload) }); } });
  ({ store, push } = creado);
  await new Promise(r => { servidor = creado.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('validarMinutos y textoIntervalo', () => {
  assert.equal(recordatorios.validarMinutos(0).minutos, 0);
  assert.equal(recordatorios.validarMinutos(90).minutos, 90);
  assert.ok(recordatorios.validarMinutos(2).error);
  assert.ok(recordatorios.validarMinutos(1441).error);
  assert.ok(recordatorios.validarMinutos('media hora').error);
  assert.equal(recordatorios.textoIntervalo(30), '30 minutos');
  assert.equal(recordatorios.textoIntervalo(60), '1 hora');
  assert.equal(recordatorios.textoIntervalo(90), '1 hora y media');
  assert.equal(recordatorios.textoIntervalo(120), '2 horas');
});

test('el administrador fija el intervalo; el guardia no puede', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');

  assert.equal((await api('/api/admin/alarma-ronda', { token: pedro.token })).status, 403);
  assert.equal((await api('/api/admin/alarma-ronda', { metodo: 'PUT', token: marta.token, cuerpo: { minutos: 3 } })).status, 422);

  const r = await api('/api/admin/alarma-ronda', { metodo: 'PUT', token: marta.token, cuerpo: { minutos: 120 } });
  assert.equal(r.status, 200);
  assert.equal(r.datos.minutos, 120);
  assert.equal(r.datos.texto, '2 horas');

  // El guardia lo ve en su paquete.
  const paquete = await api('/api/mi/paquete', { token: pedro.token });
  assert.equal(paquete.datos.alarmaMin, 120);
  // El otro condominio no se tocó.
  const jorge = await login('jorge', '5555');
  assert.equal((await api('/api/mi/paquete', { token: jorge.token })).datos.alarmaMin, 0);
});

test('la alarma va solo a los teléfonos del guardia de ese condominio, cada X tiempo', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  const jorge = await login('jorge', '5555');

  assert.equal((await api('/api/push/clave', { token: pedro.token })).status, 200);
  assert.equal((await api('/api/mi/push/suscribir', { metodo: 'POST', token: pedro.token, cuerpo: { suscripcion: suscripcion('garita-aromos') } })).status, 201);
  assert.equal((await api('/api/mi/push/suscribir', { metodo: 'POST', token: jorge.token, cuerpo: { suscripcion: suscripcion('garita-mirador') } })).status, 201);
  await api('/api/admin/push/suscribir', { metodo: 'POST', token: marta.token, cuerpo: { suscripcion: suscripcion('admin-aromos') } });

  assert.equal((await api('/api/admin/alarma-ronda', { token: marta.token })).datos.telefonos, 1);

  const aromos = store.db.condominios.find(c => c.id === 'aromos');
  const desde = Date.parse(aromos.recordatorioDesde);
  // Antes de tiempo, nada.
  enviados.length = 0;
  await recordatorios.revisar(store, push, desde + 119 * 60000);
  assert.equal(enviados.length, 0);

  // Cumplidas las 2 horas: suena en la garita de aromos y en nada más.
  await recordatorios.revisar(store, push, desde + 120 * 60000);
  assert.deepEqual(enviados.map(e => e.endpoint), ['https://push.ejemplo/garita-aromos']);
  assert.equal(enviados[0].datos.insistente, true);
  assert.equal(aromos.recordatorioUltimo.ok, 1);

  // El siguiente tick no repite; a las 2 horas de la anterior, vuelve a sonar.
  await recordatorios.revisar(store, push, desde + 121 * 60000);
  assert.equal(enviados.length, 1);
  await recordatorios.revisar(store, push, desde + 240 * 60000);
  assert.equal(enviados.length, 2);

  // Una alerta de ronda incompleta sigue yendo solo al administrador.
  enviados.length = 0;
  await push.avisar(aromos, { titulo: 'x', cuerpo: 'y', url: 'z' });
  assert.deepEqual(enviados.map(e => e.endpoint), ['https://push.ejemplo/admin-aromos']);
});

test('una ronda iniciada reinicia el conteo y, en curso, no suena', () => {
  const aromos = store.db.condominios.find(c => c.id === 'aromos');
  const ultimo = Date.parse(aromos.recordatorioUltimo.ts);
  const ejecucion = { id: 'e-alarma', condominioId: 'aromos', estado: 'en_curso', inicio: new Date(ultimo + 60 * 60000).toISOString() };
  store.ejecuciones.guardar(ejecucion);
  try {
    assert.equal(recordatorios.leToca(store, aromos, ultimo + 200 * 60000), false, 'en curso no suena');
    store.ejecuciones.guardar({ ...ejecucion, estado: 'completa' });
    // Cuenta desde el inicio de la ronda (ultimo + 60), no desde la alarma.
    assert.equal(recordatorios.leToca(store, aromos, ultimo + 179 * 60000), false);
    assert.equal(recordatorios.leToca(store, aromos, ultimo + 180 * 60000), true);
  } finally {
    store.ejecuciones.eliminar('e-alarma');
  }
});

test('apagada no suena; la prueba exige un teléfono activo', async () => {
  const carmen = await login('carmen', '4444');
  const marta = await login('marta', '1111');
  await api('/api/admin/alarma-ronda', { metodo: 'PUT', token: marta.token, cuerpo: { minutos: 0 } });
  const aromos = store.db.condominios.find(c => c.id === 'aromos');
  assert.equal(recordatorios.leToca(store, aromos, Date.now() + 365 * 86400000), false);

  enviados.length = 0;
  const prueba = await api('/api/admin/alarma-ronda/prueba', { metodo: 'POST', token: marta.token });
  assert.equal(prueba.status, 200);
  assert.deepEqual(enviados.map(e => e.endpoint), ['https://push.ejemplo/garita-aromos']);

  // El guardia de otro condominio no puede dar de baja la garita ajena.
  const jorge = await login('jorge', '5555');
  await api('/api/mi/push/suscribir', { metodo: 'DELETE', token: jorge.token, cuerpo: { endpoint: 'https://push.ejemplo/garita-aromos' } });
  assert.equal(push.dispositivos('aromos', 'guardia').length, 1);

  const pedro = await login('pedro', '2222');
  await api('/api/mi/push/suscribir', { metodo: 'DELETE', token: pedro.token, cuerpo: { endpoint: 'https://push.ejemplo/garita-aromos' } });
  assert.equal(push.dispositivos('aromos', 'guardia').length, 0);
  assert.equal((await api('/api/admin/alarma-ronda/prueba', { metodo: 'POST', token: marta.token })).status, 422);

  // carmen (otro admin) mira mirador vía x-condominio: el teléfono de jorge sigue ahí.
  assert.equal((await api('/api/admin/alarma-ronda', { token: carmen.token, condominio: 'mirador' })).datos.telefonos, 1);
});
