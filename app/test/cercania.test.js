// Cercanía reciente (CU-29, v1.27), del lado del servidor: lo que llega en la
// marca (la lectura del momento y la lectura cercana) se vuelve a verificar con
// la misma regla que usó el teléfono, queda guardado, y el informe lo dice.
//
// La parte que solo ve el teléfono —el rastro y las lecturas intermedias— está
// en app-gps.test.js; que los dos lados decidan lo mismo, en paridad-gps.test.js.
'use strict';

process.env.MOCK = 'true';
// Cuenta de la operación (acceso total): la única que configura los puntos.
process.env.ADMIN_TOTAL_USUARIO = 'operacion';
process.env.ADMIN_TOTAL_NOMBRE = 'Operación (test)';
process.env.ADMIN_TOTAL_PIN = 'Prueba2026Total';
process.env.ADMIN_TOTAL_CONDOMINIO = 'aromos';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const motor = require('../lib/rondas');
const { informeTexto } = require('../lib/informes');

let base;
let servidor;

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

async function login(usuario, pin) {
  const { status, datos } = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(status, 200);
  return datos;
}

// Los puntos los configura solo la cuenta de la operación (acceso total),
// parada en el condominio que elige en el selector del panel (x-condominio).
// Con `token` en las opciones se prueba la misma ruta con otra cuenta.
let tokenOperacion;
async function configurarPunto(resto, { metodo = 'GET', cuerpo, token } = {}, condominio = 'aromos') {
  const pedir = (ruta, m, c, t) => fetch(base + ruta, {
    method: m,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), 'x-condominio': condominio },
    body: c ? JSON.stringify(c) : undefined
  });
  if (!token && !tokenOperacion) {
    tokenOperacion = (await (await pedir('/api/login', 'POST', { usuario: 'operacion', pin: 'Prueba2026Total' })).json()).token;
  }
  const resp = await pedir(`/api/admin/puntos${resto}`, metodo, cuerpo, token || tokenOperacion);
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-cercania-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

const LAT = -33.45;
const LON = -70.66;
// Una lectura a `m` metros al norte del punto.
const lectura = (m, acc, edadMs) => ({ lat: LAT + m / 111320, lon: LON, acc, edadMs });
const cfg = () => motor.configGps();
const PORTERIA = { nombre: 'Portería', lat: LAT, lon: LON, precisionM: 5 };

test('motor: el alero entra por cercanía; la caseta y la vuelta no', () => {
  // Alero: el GPS lo ubica a 45 m con ±15, pero hace 50 s estuvo a 10 m con ±8.
  const alero = motor.verificarPresencia(PORTERIA, lectura(45, 15, 0), cfg(), lectura(10, 8, 50000));
  assert.equal(alero.ok, true);
  assert.equal(alero.porCercania, true);
  assert.equal(alero.distanciaM, 10);
  assert.equal(alero.distanciaAhoraM, 45);
  // Sin la lectura cercana es el rechazo de siempre.
  assert.equal(motor.verificarPresencia(PORTERIA, lectura(45, 15, 0), cfg()).ok, false);

  // Subterráneo: sin señal buena al marcar (±150 m) → entra.
  assert.equal(motor.verificarPresencia(PORTERIA, lectura(100, 150, 0), cfg(), lectura(12, 8, 90000)).ok, true);
  // Sin ninguna lectura al marcar → entra igual: nada lo desmiente.
  assert.equal(motor.verificarPresencia(PORTERIA, null, cfg(), lectura(12, 8, 90000)).ok, true);

  // Caseta: lectura buena a 150 m. Ninguna falla del GPS explica eso.
  const caseta = motor.verificarPresencia(PORTERIA, lectura(150, 10, 0), cfg(), lectura(25, 8, 180000));
  assert.equal(caseta.ok, false);
  assert.match(caseta.motivo, /Estás a 150 m/, 'el motivo es el del rechazo directo, no el de la cercanía');
});

test('motor: los bordes de la cercanía', () => {
  const ahora = lectura(45, 15, 0);
  const con = cercana => motor.verificarPresencia(PORTERIA, ahora, cfg(), cercana).ok;
  assert.equal(con(lectura(30, 8, 60000)), true, 'a 30 m es cerca');
  assert.equal(con(lectura(35, 8, 60000)), false, 'a 35 m no es cerca en un punto exacto');
  assert.equal(con(lectura(10, 20, 60000)), true, '±20 m es una lectura buena');
  assert.equal(con(lectura(10, 25, 60000)), false, '±25 m no es una lectura buena');
  assert.equal(con(lectura(10, null, 60000)), false, 'sin ± declarado no es una lectura buena');
  assert.equal(con(lectura(10, 8, 5 * 60000)), true, '5 min justos todavía valen');
  assert.equal(con(lectura(10, 8, 6 * 60000)), false, 'de hace 6 min ya no vale');
  assert.equal(con({ lat: LAT, lon: LON, acc: 8 }), false, 'sin antigüedad no se puede saber si vale');
  // La lectura del momento: 70 − 15 = 55 > 30 + 20 la desmiente; 65 − 15 = 50 no.
  const cercana = lectura(10, 8, 60000);
  assert.equal(motor.verificarPresencia(PORTERIA, lectura(70, 15, 0), cfg(), cercana).ok, false);
  assert.equal(motor.verificarPresencia(PORTERIA, lectura(65, 15, 0), cfg(), cercana).ok, true);
});

test('motor: en un punto anclado la cercanía es la entrada, con sus 15 min', () => {
  const bombas = { nombre: 'Sala de bombas', lat: LAT, lon: LON, precisionM: 8, verificacion: 'anclaje' };
  const adentro = lectura(70, 150, 0);
  // INC-002: la lectura de adentro sola no alcanza; con la de la entrada, sí.
  assert.equal(motor.verificarPresencia(bombas, adentro, cfg()).ok, false);
  const v = motor.verificarPresencia(bombas, adentro, cfg(), lectura(5, 6, 12 * 60000));
  assert.equal(v.ok, true);
  assert.equal(v.modo, 'anclaje');
  assert.equal(motor.verificarPresencia(bombas, adentro, cfg(), lectura(5, 6, 16 * 60000)).ok, false);
});

test('motor: GPS_CERCANIA_MIN=0 la apaga', () => {
  const antes = process.env.GPS_CERCANIA_MIN;
  process.env.GPS_CERCANIA_MIN = '0';
  try {
    assert.equal(motor.configGps().cercaniaMin, 0);
    assert.equal(motor.verificarPresencia(PORTERIA, lectura(45, 15, 0), motor.configGps(), lectura(10, 8, 50000)).ok, false);
  } finally {
    if (antes === undefined) delete process.env.GPS_CERCANIA_MIN;
    else process.env.GPS_CERCANIA_MIN = antes;
  }
});

test('API: la marca por cercanía entra, queda guardada y en el informe es una marca normal', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  const fijar = await configurarPunto('/p-porteria', { metodo: 'PUT', cuerpo: { lat: LAT, lon: LON, precisionM: 5 } });
  assert.equal(fijar.status, 200);

  // El paquete trae los umbrales de la cercanía: la app decide sin señal con
  // los mismos números que el servidor.
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  assert.equal(paquete.gps.lecturaBuenaM, 20);
  assert.equal(paquete.gps.cercaniaM, 30);
  assert.equal(paquete.gps.cercaniaMin, 5);
  assert.equal(paquete.gps.errorExtraM, 20);

  async function marcar(cuerpo) {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', ...cuerpo }
    });
    return { ejecucionId: ini.datos.id, esc };
  }

  // Sin la lectura cercana (una app de antes de la v1.27): rechazada, como siempre.
  const vieja = await marcar({ gps: lectura(45, 15, 0) });
  assert.equal(vieja.esc.status, 422);

  // Con la lectura cercana: entra.
  const alero = await marcar({ gps: lectura(45, 15, 0), cercania: lectura(10, 8, 50000) });
  assert.equal(alero.esc.status, 200);

  // La caseta: la cercana no la salva.
  const caseta = await marcar({ gps: lectura(150, 10, 0), cercania: lectura(25, 8, 180000) });
  assert.equal(caseta.esc.status, 422);
  assert.ok(caseta.esc.datos.presencia.distanciaM >= 150);

  // Una lectura "cercana" inventada que no lo es (a 35 m) tampoco.
  const inventada = await marcar({ gps: lectura(45, 15, 0), cercania: lectura(35, 8, 50000) });
  assert.equal(inventada.esc.status, 422);

  // El cierre no la informa como "lejos del punto" ni como sospechosa, y el
  // informe no la distingue de una marca cualquiera: el dato queda en la marca
  // (con la distancia de la cercana) para el conteo del panel. Esto prueba
  // también que la lectura cercana quedó guardada en la marca: evaluar() la
  // vuelve a mirar al cerrar, y sin ella la marca saldría "a 45 m del punto".
  const cierre = await api(`/api/ejecuciones/${alero.ejecucionId}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(cierre.status, 200);
  const detalle = cierre.datos.detalle.find(d => d.puntoId === 'p-porteria');
  assert.equal(detalle.porCercania, true);
  assert.equal(detalle.lejos, false);
  assert.equal(detalle.distanciaM, 10);
  assert.equal(cierre.datos.evaluacion.gpsLejos.length, 0);
  assert.equal(cierre.datos.evaluacion.sospechas.length, 0);
  assert.equal(detalle.distanciaAhoraM, 45);
  const linea = informeTexto(cierre.datos).split('\n').find(l => l.includes('Portería'));
  assert.match(linea, /^✅ \d+\. Portería — /);
  assert.doesNotMatch(linea, /cercanía|⚠️|m del punto/, 'el informe la muestra como una marca normal');
  assert.equal(detalle.gps.acc, 15, 'la lectura del momento también queda en la marca');

  await configurarPunto('/p-porteria', { metodo: 'PUT', cuerpo: { quitarUbicacion: true } });
});

// Para el estado de la ronda, la marca por cercanía es una marca normal: la
// ronda completa queda «completa», sin observaciones ni sospechas ni aviso,
// igual que con la lectura del momento.
test('motor: una ronda completa con una marca por cercanía queda «completa», sin observaciones', () => {
  const db = datosSemilla();
  Object.assign(db.puntos.find(p => p.id === 'p-porteria'), { lat: LAT, lon: LON, precisionM: 5 });
  const ronda = db.rondas.find(r => r.id === 'ronda-express');
  const MIN = 60000;
  const fin = Date.parse('2026-11-04T15:00:00.000Z');
  const armar = (id, enPorteria) => ({
    id, rondaId: ronda.id, condominioId: ronda.condominioId, guardiaId: 'u-pedro',
    inicio: new Date(fin - 10 * MIN).toISOString(), fin: null, estado: 'en_curso', evaluacion: null,
    escaneos: ronda.puntoIds.map((puntoId, i) => ({
      puntoId, ts: new Date(fin - (ronda.puntoIds.length - 1 - i) * 2 * MIN).toISOString(), offline: false, gps: null, medio: 'qr',
      ...(puntoId === 'p-porteria' ? enPorteria : {})
    }))
  });
  const directa = armar('e-directa', { gps: lectura(5, 8, 2000) });
  const porCercania = armar('e-cercania', { gps: lectura(45, 15, 0), cercania: lectura(10, 8, 50000) });
  for (const e of [directa, porCercania]) motor.cerrarEjecucion(db, e, { fin: new Date(fin).toISOString() });

  assert.equal(directa.estado, 'completa');
  assert.equal(porCercania.estado, 'completa');
  assert.deepEqual(porCercania.evaluacion.observaciones, []);
  assert.deepEqual(porCercania.evaluacion.sospechas, []);
  assert.equal(porCercania.escaneos.find(e => e.puntoId === 'p-porteria').porCercania, true);
});

test('API: una marca que entró por la lectura del momento no cambia en nada', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  await configurarPunto('/p-porteria', { metodo: 'PUT', cuerpo: { lat: LAT, lon: LON, precisionM: 5 } });
  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', gps: lectura(5, 6, 1000) }
  });
  assert.equal(esc.status, 200);
  const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
  const detalle = cierre.datos.detalle.find(d => d.puntoId === 'p-porteria');
  assert.equal(detalle.porCercania, false);
  assert.ok(!('distanciaAhoraM' in detalle), 'una marca directa queda con la forma de siempre');
  assert.doesNotMatch(informeTexto(cierre.datos), /por cercanía/);
  await configurarPunto('/p-porteria', { metodo: 'PUT', cuerpo: { quitarUbicacion: true } });
});
