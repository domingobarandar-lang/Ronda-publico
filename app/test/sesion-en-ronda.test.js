// La sesión se renueva con la actividad de ronda (v1.25). Hasta la v1.24
// vencía a la hora y media del LOGIN, y en el teléfono compartido de una
// garita eso cortaba rondas a la mitad: el guardia había entrado para la ronda
// anterior y la siguiente empezaba con la sesión casi gastada. Ver
// VIDA_SESION_MS y renovarSesion en lib/auth.js.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const auth = require('../lib/auth');

let base;
let servidor;
let store;
let rutaDb;

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

const MIN = 60000;
const hace = min => new Date(Date.now() - min * MIN).toISOString();

async function login(usuario, pin) {
  const r = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(r.status, 200);
  return r.datos.token;
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-ses-'));
  rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('una ronda que pasa de la hora y media del login no pide el PIN a la mitad', async () => {
  const token = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const puntos = paquete.rondas.find(r => r.id === 'ronda-express').puntos;

  // El guardia entró hace 80 minutos (para la ronda anterior) y empieza otra.
  store.db.sesiones[token].creada = hace(80);
  const id = 'ses-' + Math.random().toString(36).slice(2, 12);
  const inicio = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id, rondaId: 'ronda-express' } });
  assert.equal(inicio.status, 201);
  assert.ok(Date.now() - Date.parse(store.db.sesiones[token].renovada) < MIN, 'iniciar la ronda renueva');

  // Veinte minutos de recorrido después ya pasó la hora y media del login.
  store.db.sesiones[token].creada = hace(100);
  store.db.sesiones[token].renovada = hace(20);
  for (const punto of puntos) {
    const r = await api(`/api/ejecuciones/${id}/escaneos`, { metodo: 'POST', token, cuerpo: { codigo: punto.payload, offline: true } });
    assert.equal(r.status, 200, 'la marca entra: antes era un 401 y el teléfono volvía al login');
  }
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.status, 200);
});

test('la renovación queda guardada: un reinicio del servidor a mitad de ronda no la pierde', async () => {
  const token = await login('pedro', '2222');
  store.db.sesiones[token].creada = hace(80);
  const id = 'ses-' + Math.random().toString(36).slice(2, 12);
  assert.equal((await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id, rondaId: 'ronda-express' } })).status, 201);

  // Lo mismo que lee el servidor al arrancar (un deploy en plena ronda).
  const otro = crearApp({ rutaDb, enviarPush: async () => {} });
  const releida = otro.store.db.sesiones[token];
  assert.ok(releida && releida.renovada, 'la renovación se escribió en la base');
  assert.equal(auth.vencida(releida, Date.now() + 15 * MIN), false, 'y la sesión sigue viva pasada la hora y media del login');
  await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token });
});

test('lo que no es ronda no renueva: una sesión olvidada en un teléfono prendido vence igual', async () => {
  const token = await login('pedro', '2222');
  store.db.sesiones[token].creada = hace(80);
  assert.equal((await api('/api/mi/paquete', { token })).status, 200);
  assert.equal(store.db.sesiones[token].renovada, undefined);

  store.db.sesiones[token].creada = hace(91);
  const r = await api('/api/mi/paquete', { token });
  assert.equal(r.status, 401);
  assert.match(r.datos.error, /venció/i);
});

test('renovarSesion: a lo más cada 5 minutos, y nunca revive una vencida', () => {
  const ahora = Date.now();
  const recien = { usuarioId: 'u', creada: new Date(ahora - 2 * MIN).toISOString() };
  assert.equal(auth.renovarSesion(recien, ahora), false, 'no escribe la base en cada marca');
  assert.equal(recien.renovada, undefined);

  const media = { usuarioId: 'u', creada: new Date(ahora - 10 * MIN).toISOString() };
  assert.equal(auth.renovarSesion(media, ahora), true);
  assert.equal(Date.parse(media.renovada), ahora);
  assert.equal(auth.renovarSesion(media, ahora + MIN), false, 'recién renovada');

  const vencida = { usuarioId: 'u', creada: new Date(ahora - 100 * MIN).toISOString() };
  assert.equal(auth.renovarSesion(vencida, ahora), false);
  assert.equal(auth.vencida(vencida, ahora), true);

  // Vence a la hora y media de la ÚLTIMA renovación.
  const renovada = { usuarioId: 'u', creada: new Date(ahora - 200 * MIN).toISOString(), renovada: new Date(ahora - 89 * MIN).toISOString() };
  assert.equal(auth.vencida(renovada, ahora), false);
  assert.equal(auth.vencida(renovada, ahora + 2 * MIN), true);
  // Una renovación ilegible no salva a una sesión vieja.
  assert.equal(auth.vencida({ creada: new Date(ahora - 100 * MIN).toISOString(), renovada: 'x' }, ahora), true);
  assert.equal(auth.vencida({ renovada: new Date(ahora).toISOString() }, ahora), true, 'sin fecha de creación sigue contando como vencida');
});
