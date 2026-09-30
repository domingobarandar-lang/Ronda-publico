// Rondas abandonadas: la que el teléfono inició y nunca cerró ya no queda "en
// curso" para siempre (callando la alarma del condominio), y si el teléfono
// aparece después con las marcas que traía sin señal, la ronda se reabre y
// las recibe. Ver estaAbandonada / reabrirSiAutomatica en lib/rondas.js.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const recordatorios = require('../lib/recordatorios');

let base;
let servidor;
let store;
let cerrarAbandonadas;
const avisosPush = [];

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
  assert.equal(r.status, 200);
  return r.datos;
}

const MIN = 60000;
const hace = min => new Date(Date.now() - min * MIN).toISOString();

async function iniciar(token, inicio) {
  const id = 'abn-' + Math.random().toString(36).slice(2, 12);
  const r = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id, rondaId: 'ronda-express', inicio } });
  assert.equal(r.status, 201);
  return id;
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-abn-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  cerrarAbandonadas = creado.cerrarAbandonadas;
  creado.push.avisar = async (condominio, aviso) => { avisosPush.push(aviso); };
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('una ronda reciente sin marcas NO se da por abandonada', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(30));
  assert.deepEqual(await cerrarAbandonadas(), []);
  assert.equal(store.ejecuciones.obtener(id).estado, 'en_curso');
  // Se cierra para no contaminar los tests que siguen.
  await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token });
});

test('ronda iniciada y nunca cerrada: se cierra sola, avisa y deja de callar la alarma', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(150));
  const condominio = store.db.condominios.find(c => c.id === 'aromos');
  // 20 min: la ronda del test anterior empezó hace 30 y cuenta como la última.
  condominio.recordatorioMin = 20;
  condominio.recordatorioDesde = hace(24 * 60);
  // Mientras está "en curso", la alarma del condominio no suena: ese era el daño.
  assert.equal(recordatorios.leToca(store, condominio), false);

  const pushAntes = avisosPush.length;
  const cerradas = await cerrarAbandonadas();
  assert.deepEqual(cerradas, [id]);

  const e = store.ejecuciones.obtener(id);
  assert.equal(e.estado, 'incompleta');
  assert.equal(e.cierreAutomatico, true);
  assert.equal(e.fin, e.inicio, 'el fin es la última actividad conocida, no la hora del barrido');
  assert.match(e.evaluacion.observaciones[0], /Cerrada automáticamente/);
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /cerrada automáticamente/);
  assert.equal(avisosPush.length, pushAntes + 1, 'el administrador recibe el aviso de ronda incompleta');

  // Ya no hay una "en curso" colgada: la alarma vuelve a funcionar.
  assert.equal(recordatorios.leToca(store, condominio), true);
  condominio.recordatorioMin = 0;

  // Un segundo barrido no la toca de nuevo.
  assert.deepEqual(await cerrarAbandonadas(), []);
});

test('el teléfono aparece con las marcas hechas sin señal: la ronda se reabre y el cierre real manda', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');

  const id = await iniciar(token, hace(180));
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');

  // Llega la cola del teléfono: las marcas con su hora original…
  for (const [i, punto] of express.puntos.entries()) {
    const esc = await api(`/api/ejecuciones/${id}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts: hace(175 - i * 5), offline: true }
    });
    assert.equal(esc.status, 200, 'la marca tardía entra en vez de rebotar con 409');
  }
  assert.equal(store.ejecuciones.obtener(id).estado, 'en_curso');

  // …y el cierre de verdad, con la hora de término del teléfono.
  const fin = hace(160);
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin } });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.evaluacion.faltantes.length, 0);
  const e = store.ejecuciones.obtener(id);
  assert.equal(e.fin, fin);
  assert.ok(!e.cierreAutomatico);
  assert.ok(!e.evaluacion.observaciones.some(o => /automáticamente/.test(o)));
});

test('solo el cierre tardío (sin marcas nuevas) también reemplaza al automático', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(200));
  await cerrarAbandonadas();
  const fin = hace(190);
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin } });
  assert.equal(cierre.status, 200);
  assert.equal(store.ejecuciones.obtener(id).fin, fin);
  assert.ok(!store.ejecuciones.obtener(id).cierreAutomatico);
});

test('otro guardia no puede reabrir una ronda cerrada sola; una marca repetida no la reabre', async () => {
  const pedro = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const punto = paquete.rondas.find(r => r.id === 'ronda-express').puntos[0];

  const id = await iniciar(pedro.token, hace(200));
  const primera = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: punto.payload, ts: hace(195) }
  });
  assert.equal(primera.status, 200);
  await cerrarAbandonadas();

  const luis = await login('luis', '3333');
  const ajeno = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: luis.token, cuerpo: { codigo: punto.payload }
  });
  assert.equal(ajeno.status, 403);

  // El reenvío de una marca que ya estaba no es información nueva.
  const repetida = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: punto.payload, ts: hace(195) }
  });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.datos.duplicado, true);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');
  assert.equal(store.ejecuciones.obtener(id).cierreAutomatico, true);
});

test('las colgadas de hace días se cierran sin despertar al administrador', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(3 * 24 * 60));
  const pushAntes = avisosPush.length;
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');
  assert.equal(avisosPush.length, pushAntes, 'sin push');
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /cerrada automáticamente/, 'pero sí queda en el panel');
});

test('el umbral respeta rondas largas: el doble de su duración máxima si pasa de 2 h', () => {
  const motor = require('../lib/rondas');
  assert.equal(motor.umbralAbandonoMs({ duracionMaxMin: 20 }), 120 * MIN);
  assert.equal(motor.umbralAbandonoMs({ duracionMaxMin: 90 }), 180 * MIN);
  assert.equal(motor.umbralAbandonoMs(null), 120 * MIN);
});
