// CU-28: puntos con chapita NFC. Lo que importa probar:
//   · un punto SIN chapita sigue idéntico con QR y código a mano (medio
//     anotado), y una chapita en él no marca: es la que quedó tras «Volver a QR»
//     o una copia del QR;
//   · en un punto CON chapita la marca solo entra con la serie que coincide, o
//     con el código a mano (observado); un QR o una chapita ajena → 422, y
//     queda en el registro de rechazos;
//   · una chapita no puede pertenecer a dos puntos (ni de dos condominios);
//   · el paquete del guardia y la hoja de QR saben qué puntos son NFC.
// Todo en MOCK: cero llamadas externas.
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
const { normalizarSerie, huellaSerie } = require('../lib/codigos');

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
  const { status, datos } = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(status, 200);
  return datos.token;
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

// Serie de un NTAG213 tal como la entrega Web NFC, y la misma normalizada.
const SERIE_WEB = '04:a2:3b:4c:5d:6e:80';
const SERIE = '04A23B4C5D6E80';

async function paqueteDe(token) {
  return (await api('/api/mi/paquete', { token })).datos;
}

function puntoDe(paquete, rondaId, puntoId) {
  return paquete.rondas.find(r => r.id === rondaId).puntos.find(p => p.id === puntoId);
}

async function iniciar(token, rondaId = 'ronda-express') {
  const r = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId } });
  assert.equal(r.status, 201);
  return r.datos.id;
}

function marcar(token, ejecucionId, cuerpo) {
  return api(`/api/ejecuciones/${ejecucionId}/escaneos`, { metodo: 'POST', token, cuerpo });
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-nfc-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('normalizarSerie: hex en mayúsculas sin separadores; lo demás no es serie', () => {
  assert.equal(normalizarSerie(SERIE_WEB), SERIE);
  assert.equal(normalizarSerie('04-A2-3B-4C-5D-6E-80'), SERIE);
  assert.equal(normalizarSerie('04a23b4c5d6e80'), SERIE);
  for (const malo of ['', null, undefined, '04:a2', 'zz:zz:zz:zz', '04A23B4C5D6E8', 'RQR:aromos:p:X', {}]) {
    assert.equal(normalizarSerie(malo), null, `"${malo}" no es una serie`);
  }
});

test('punto sin chapita: idéntico a antes, y cada marca anota su medio', async () => {
  const guardia = await login('pedro', '2222');
  const paquete = await paqueteDe(guardia);
  assert.equal(paquete.manualEnNfc, 'rechazo');
  const porteria = puntoDe(paquete, 'ronda-express', 'p-porteria');
  assert.equal(porteria.nfc, false);
  assert.equal(porteria.nfcHuella, null);

  const ej = await iniciar(guardia);
  const qr = await marcar(guardia, ej, { codigo: porteria.payload });
  assert.equal(qr.status, 200);
  // Una chapita con el texto de un punto QR no marca (después de la v1.27.0 ya no
  // vale solo el payload: ver «Volver a QR» más abajo). Su QR sí.
  const quincho = puntoDe(paquete, 'ronda-express', 'p-quincho');
  assert.equal((await marcar(guardia, ej, { codigo: quincho.payload, nfc: { serie: SERIE_WEB } })).status, 422);
  assert.equal((await marcar(guardia, ej, { codigo: quincho.payload })).status, 200);
  assert.equal((await marcar(guardia, ej, { codigo: 'PSC234' })).status, 200);
  const marcas = store.ejecuciones.obtener(ej).escaneos;
  assert.deepEqual(marcas.map(m => m.medio), ['qr', 'qr', 'manual']);
  assert.ok(marcas.every(m => !m.puntoNfc), 'un punto sin chapita no se anota como NFC');
  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia });
  assert.ok(!cierre.datos.evaluacion.observaciones.some(o => /chapita/.test(o)));
});

test('grabar chapita: valida la serie, la normaliza y la guarda', async () => {
  const admin = await login('marta', '1111');
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', cuerpo: { serie: 'hola' } })).status, 422);
  assert.equal((await configurarPunto('/no-existe/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE_WEB } })).status, 404);
  const r = await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE_WEB, bloqueada: true } });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nfcSerie, SERIE);
  assert.equal(r.datos.nfcBloqueada, true);
  // Un guardia no graba chapitas, y el administrador del condominio tampoco:
  // solo la cuenta de la operación.
  const guardia = await login('pedro', '2222');
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', token: guardia, cuerpo: { serie: SERIE } })).status, 403);
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: '04:11:22:33:44:55:66' } })).status, 403);
  const porElPanel = await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: '04:11:22:33:44:55:66' } });
  assert.equal(porElPanel.status, 403);
  assert.match(porElPanel.datos.error, /equipo de Ronda/);
  assert.equal((await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'DELETE', token: admin })).status, 403);
  assert.equal(store.db.puntos.find(p => p.id === 'p-piscina').nfcSerie, SERIE, 'la chapita sigue siendo la que grabó la operación');
});

test('bloquear la chapita es un paso aparte, y solo con la chapita registrada', async () => {
  const marta = await login('marta', '1111');
  // Se graba sin bloquear (como lo hace el panel).
  const grabada = await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE } });
  assert.equal(grabada.datos.nfcBloqueada, false);
  const bloqueo = cuerpo => configurarPunto('/p-piscina/chapita/bloqueo', { metodo: 'PUT', cuerpo });
  assert.equal((await bloqueo({ serie: '04:11:22:33:44:55:66' })).status, 422, 'otra chapita no se anota bloqueada');
  assert.equal((await bloqueo({})).status, 422);
  assert.equal((await configurarPunto('/p-quincho/chapita/bloqueo', { metodo: 'PUT', cuerpo: { serie: SERIE } })).status, 409, 'un punto sin chapita no se bloquea');
  const guardia = await login('pedro', '2222');
  assert.equal((await configurarPunto('/p-piscina/chapita/bloqueo', { metodo: 'PUT', token: guardia, cuerpo: { serie: SERIE } })).status, 403);
  assert.equal((await api('/api/admin/puntos/p-piscina/chapita/bloqueo', { metodo: 'PUT', token: marta, cuerpo: { serie: SERIE } })).status, 403, 'el administrador no bloquea chapitas');
  const ok = await bloqueo({ serie: SERIE_WEB });
  assert.equal(ok.status, 200);
  assert.equal(ok.datos.nfcBloqueada, true);
  assert.ok(ok.datos.nfcBloqueadaEn);
  // Repetir no cambia nada.
  const otraVez = await bloqueo({ serie: SERIE });
  assert.equal(otraVez.datos.nfcBloqueadaEn, ok.datos.nfcBloqueadaEn);
  // El punto es de Los Aromos: pedido dentro de otro condominio, no existe.
  assert.equal((await configurarPunto('/p-piscina/chapita/bloqueo', { metodo: 'PUT', cuerpo: { serie: SERIE } }, 'mirador')).status, 404);
  // Bloquear no cambia cómo se marca: la misma chapita sigue valiendo.
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  const ej = await iniciar(guardia);
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE } })).status, 200);
});

test('una chapita no puede pertenecer a dos puntos, tampoco de otro condominio', async () => {
  const marta = await login('marta', '1111');
  const otro = await configurarPunto('/p-quincho/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE } });
  assert.equal(otro.status, 409);
  assert.match(otro.datos.error, /Piscina/);
  const ajeno = await configurarPunto('/p-m-terraza/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE_WEB } }, 'mirador');
  assert.equal(ajeno.status, 409);
  // Sin revelar el nombre de un punto de otro condominio.
  assert.doesNotMatch(ajeno.datos.error, /Piscina/);
  assert.match(ajeno.datos.error, /otro condominio/);
  // Re-grabar la misma chapita en su propio punto (Reemplazar) sí se puede.
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE } })).status, 200);
});

test('el paquete del guardia lleva qué puntos son NFC y la huella de la serie, no la serie', async () => {
  const guardia = await login('pedro', '2222');
  const paquete = await paqueteDe(guardia);
  const piscina = puntoDe(paquete, 'ronda-express', 'p-piscina');
  assert.equal(piscina.nfc, true);
  assert.equal(piscina.nfcHuella, huellaSerie(SERIE));
  assert.match(piscina.nfcHuella, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(paquete).includes(SERIE), 'la serie no puede viajar al teléfono del guardia');
  assert.ok(piscina.payload.startsWith('RQR:aromos:p-piscina:'), 'la chapita lleva el mismo texto del QR');
});

test('punto con chapita: QR sin serie y chapita ajena → 422 y queda como rechazo; la serie correcta entra', async () => {
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  const ej = await iniciar(guardia);

  const foto = await marcar(guardia, ej, { codigo: piscina.payload, ts: '2026-10-28T10:00:00.000Z' });
  assert.equal(foto.status, 422);
  assert.match(foto.datos.error, /Este punto se marca con la chapita NFC/);
  const copia = await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: '04:11:22:33:44:55:66' }, ts: '2026-10-28T10:00:05.000Z' });
  assert.equal(copia.status, 422);
  assert.match(copia.datos.error, /no es la registrada/);
  const sinSerie = await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: '' }, ts: '2026-10-28T10:00:06.000Z' });
  assert.equal(sinSerie.status, 422);

  let ejecucion = store.ejecuciones.obtener(ej);
  assert.equal(ejecucion.escaneos.length, 0, 'ninguno de los rechazos entró como marca');
  assert.equal(ejecucion.rechazos.length, 3);
  assert.ok(ejecucion.rechazos.every(r => r.puntoId === 'p-piscina' && r.motivo));
  // La cola reenvía el mismo rechazo: no se duplica.
  await marcar(guardia, ej, { codigo: piscina.payload, ts: '2026-10-28T10:00:00.000Z' });
  assert.equal(store.ejecuciones.obtener(ej).rechazos.length, 3);

  // La chapita de verdad, con la serie escrita como la entrega el navegador.
  const ok = await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE_WEB } });
  assert.equal(ok.status, 200);
  ejecucion = store.ejecuciones.obtener(ej);
  assert.equal(ejecucion.escaneos[0].medio, 'nfc');
  // Un reenvío de una marca ya hecha es duplicado, no rechazo (idempotencia).
  const reenvio = await marcar(guardia, ej, { codigo: piscina.payload });
  assert.equal(reenvio.status, 200);
  assert.equal(reenvio.datos.duplicado, true);
});

test('punto con chapita: el código a mano NO entra y queda como rechazo', async () => {
  const guardia = await login('pedro', '2222');
  const ej = await iniciar(guardia);
  const r = await marcar(guardia, ej, { codigo: 'psc234', ts: '2026-10-28T11:00:00.000Z' });
  assert.equal(r.status, 422);
  assert.match(r.datos.error, /el código a mano no sirve/);
  const ejecucion = store.ejecuciones.obtener(ej);
  assert.equal(ejecucion.escaneos.length, 0);
  assert.equal(ejecucion.rechazos.length, 1, 'el intento queda a la vista del administrador');
  // En un punto sin chapita el código a mano sigue funcionando.
  assert.equal((await marcar(guardia, ej, { codigo: 'QCH789' })).status, 200);
});

test('"La chapita no lee": el punto queda faltante y el informe dice por qué', async () => {
  const guardia = await login('pedro', '2222');
  const paquete = await paqueteDe(guardia);
  const ej = await iniciar(guardia);
  const base = Date.now() - 20 * 60000;
  const ts = i => new Date(base + i * 4 * 60000).toISOString();
  assert.equal((await marcar(guardia, ej, { codigo: puntoDe(paquete, 'ronda-express', 'p-porteria').payload, ts: ts(0) })).status, 200);
  assert.equal((await marcar(guardia, ej, { codigo: 'QCH789', ts: ts(1) })).status, 200);
  const reporte = await api(`/api/ejecuciones/${ej}/rechazos`, {
    metodo: 'POST', token: guardia,
    cuerpo: { puntoId: 'p-piscina', ts: ts(2), reporte: 'chapita', motivo: 'El guardia reportó que la chapita no leyó.' }
  });
  assert.equal(reporte.status, 201);
  // Un valor de reporte desconocido no se guarda como tal.
  await api(`/api/ejecuciones/${ej}/rechazos`, { metodo: 'POST', token: guardia, cuerpo: { puntoId: 'p-piscina', ts: ts(2.5), reporte: 'otra-cosa' } });
  assert.deepEqual(store.ejecuciones.obtener(ej).rechazos.map(r => r.reporte), ['chapita', undefined]);
  assert.equal((await marcar(guardia, ej, { codigo: puntoDe(paquete, 'ronda-express', 'p-trasero').payload, ts: ts(3) })).status, 200);

  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia, cuerpo: { fin: ts(4) } });
  assert.equal(cierre.datos.estado, 'incompleta', 'el punto sin marcar es faltante: el aviso no lo marca');
  assert.deepEqual(cierre.datos.evaluacion.faltantes, ['p-piscina']);
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /avisó que la chapita no leyó en: Piscina \(\d\d:\d\d\)/.test(o)));
  const aviso = store.notificaciones.ultimas('aromos', 1)[0];
  assert.match(aviso.texto, /chapita no leyó en: Piscina/);
  assert.match(aviso.texto, /Portería — .*📷 QR/);
  assert.match(aviso.texto, /Quincho — .*⌨️ a mano/);
});

test('el informe muestra 📶 NFC en la marca hecha con la chapita', async () => {
  const guardia = await login('pedro', '2222');
  const paquete = await paqueteDe(guardia);
  const ej = await iniciar(guardia);
  await marcar(guardia, ej, { codigo: puntoDe(paquete, 'ronda-express', 'p-piscina').payload, nfc: { serie: SERIE } });
  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia });
  assert.equal(cierre.datos.detalle.find(d => d.puntoId === 'p-piscina').medio, 'nfc');
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /Piscina — .*📶 NFC/);
});

test('hoja de QR: el punto con chapita sale marcado y sin QR', async () => {
  const admin = await login('marta', '1111');
  const { datos } = await api('/api/admin/hoja-qr', { token: admin });
  const piscina = datos.puntos.find(p => p.id === 'p-piscina');
  assert.equal(piscina.nfc, true);
  assert.equal(piscina.dataUrl, null);
  assert.ok(datos.puntos.filter(p => p.id !== 'p-piscina').every(p => p.dataUrl.startsWith('data:image/png')));
});

test('un rechazo en un punto con chapita no reabre una ronda que el sistema cerró solo', async () => {
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  const ej = await iniciar(guardia);
  // Así la deja cerrarAbandonadas(): cerrada por el sistema, reabrible.
  const ejecucion = store.ejecuciones.obtener(ej);
  Object.assign(ejecucion, { estado: 'incompleta', fin: new Date().toISOString(), cierreAutomatico: true, evaluacion: { faltantes: [], observaciones: [], sospechas: [] } });
  store.ejecuciones.guardar(ejecucion);
  const foto = await marcar(guardia, ej, { codigo: piscina.payload });
  assert.equal(foto.status, 422);
  const despues = store.ejecuciones.obtener(ej);
  assert.equal(despues.estado, 'incompleta', 'una marca que no entró no puede reabrir la ronda');
  assert.equal(despues.cierreAutomatico, true);
  // Y con la chapita de verdad sí se reabre y entra, como cualquier marca.
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE } })).status, 200);
  assert.equal(store.ejecuciones.obtener(ej).estado, 'en_curso');
});

test('"La chapita no lee" no queda en el informe si al final el guardia sí marcó el punto', async () => {
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  const ej = await iniciar(guardia);
  for (const ts of ['2026-10-28T12:00:00.000Z', '2026-10-28T12:00:30.000Z']) {
    await api(`/api/ejecuciones/${ej}/rechazos`, { metodo: 'POST', token: guardia, cuerpo: { puntoId: 'p-piscina', ts, reporte: 'chapita' } });
  }
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE } })).status, 200);
  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia });
  assert.ok(!cierre.datos.evaluacion.observaciones.some(o => /chapita no leyó/.test(o)));
});

test('rondas guardadas antes de la v1.24 (sin medio) se informan igual que antes', async () => {
  const { armarInforme, informeTexto } = require('../lib/informes');
  const db = store.db;
  const vieja = {
    id: 'e-vieja', rondaId: 'ronda-nocturna', condominioId: 'aromos', guardiaId: 'u-pedro',
    inicio: '2026-09-01T03:00:00.000Z', fin: '2026-09-01T03:40:00.000Z', estado: 'completa',
    escaneos: [{ puntoId: 'p-porteria', ts: '2026-09-01T03:01:00.000Z', offline: false, gps: null }],
    evaluacion: { faltantes: [], observaciones: [], sospechas: [], duracionMin: 40 }
  };
  const inf = armarInforme(db, vieja);
  assert.equal(inf.detalle[0].medio, null, 'una marca vieja no inventa con qué se hizo');
  assert.doesNotMatch(informeTexto(inf), /📷|📶|⌨️/);
});

test('mover un punto con chapita a otro lugar de la ronda no obliga a regrabarla', async () => {
  const admin = await login('marta', '1111');
  const ronda = (await api('/api/admin/rondas', { token: admin })).datos.find(r => r.id === 'ronda-express');
  // Piscina (con chapita) pasa del puesto 3 al 1, en una ronda con orden.
  const orden = ['p-piscina', ...ronda.puntoIds.filter(id => id !== 'p-piscina')];
  const cambio = await api('/api/admin/rondas/ronda-express', {
    metodo: 'PUT', token: admin,
    cuerpo: { nombre: ronda.nombre, puntoIds: orden, ordenEstricto: true, duracionMaxMin: ronda.duracionMaxMin }
  });
  assert.equal(cambio.status, 200);
  const guardia = await login('pedro', '2222');
  const express = (await paqueteDe(guardia)).rondas.find(r => r.id === 'ronda-express');
  assert.deepEqual(express.puntos.map(p => p.id), orden, 'el guardia recibe el orden nuevo');
  const piscina = express.puntos[0];
  assert.equal(piscina.nfc, true);
  const ej = await iniciar(guardia);
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE } })).status, 200, 'la misma chapita sigue valiendo');
  await api('/api/admin/rondas/ronda-express', {
    metodo: 'PUT', token: admin,
    cuerpo: { nombre: ronda.nombre, puntoIds: ronda.puntoIds, ordenEstricto: ronda.ordenEstricto, duracionMaxMin: ronda.duracionMaxMin }
  });
});

test('"Volver a QR" quita la chapita y el QR vuelve a valer', async () => {
  const admin = await login('marta', '1111');
  const r = await configurarPunto('/p-piscina/chapita', { metodo: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nfcSerie, undefined);
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  assert.equal(piscina.nfc, false);
  const ej = await iniciar(guardia);
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload })).status, 200);
  // Y la serie queda libre para otro punto.
  assert.equal((await configurarPunto('/p-quincho/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE } })).status, 200);
  await configurarPunto('/p-quincho/chapita', { metodo: 'DELETE' });
});

// José en terreno, 2026-11-11: pasó un punto a QR con «Volver a QR», acercó
// el teléfono a la chapita vieja y la marca entró, como 'qr' y sin control de
// serie. La chapita lleva el mismo texto que el QR; lo que la delata es que el
// teléfono manda su serie.
test('"Volver a QR": la chapita vieja ya no marca (422, rechazo registrado); el QR y el código sí', async () => {
  const guardia = await login('pedro', '2222');
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'PUT', cuerpo: { serie: SERIE } })).status, 200);
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  assert.equal(piscina.nfc, true);
  assert.equal((await configurarPunto('/p-piscina/chapita', { metodo: 'DELETE' })).status, 200);
  assert.equal(puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina').nfc, false);

  const ej = await iniciar(guardia);
  const ts = '2026-11-11T22:00:00.000Z';
  const vieja = await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE_WEB }, ts });
  assert.equal(vieja.status, 422, 'la chapita vieja no marca');
  assert.match(vieja.datos.error, /Este punto se marca con QR/);
  // Un tag cualquiera con el texto del QR copiado, o uno que no entregó la serie: tampoco.
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: '04:11:22:33:44:55:66' }, ts })).status, 422);
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: null }, ts })).status, 422);
  // La cola reenvía la misma marca: el rechazo no se duplica.
  await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE_WEB }, ts });

  let ejecucion = store.ejecuciones.obtener(ej);
  assert.equal(ejecucion.escaneos.length, 0);
  assert.equal(ejecucion.rechazos.length, 1, 'queda registrado, una vez');
  const [rechazo] = ejecucion.rechazos;
  assert.equal(rechazo.puntoId, 'p-piscina');
  // En /fabrica cuenta como medio equivocado (fallo del usuario), no como GPS.
  const { dificultades } = require('../lib/salud');
  const d = dificultades({ rechazos: ejecucion.rechazos });
  assert.deepEqual([[...d.usuario], [...d.app], d.rechazosGps], [['medio'], [], 0]);

  // El QR de siempre y el código a mano siguen marcando.
  const qr = await marcar(guardia, ej, { codigo: piscina.payload });
  assert.equal(qr.status, 200);
  assert.equal(store.ejecuciones.obtener(ej).escaneos[0].medio, 'qr');
  // Y la chapita, ya con la marca hecha, es un reenvío: duplicado, no rechazo.
  const reenvio = await marcar(guardia, ej, { codigo: piscina.payload, nfc: { serie: SERIE_WEB } });
  assert.equal(reenvio.status, 200);
  assert.equal(reenvio.datos.duplicado, true);
  assert.equal(store.ejecuciones.obtener(ej).rechazos.length, 1);
  assert.equal((await marcar(guardia, ej, { codigo: 'QCH789' })).status, 200, 'código a mano en otro punto QR');
});

test('agregar un punto "con chapita" lo deja pendiente, fuera de la hoja de QR, y se marca a mano hasta grabarla', async () => {
  const admin = await login('marta', '1111');
  const creado = await configurarPunto('', { metodo: 'POST', cuerpo: { nombre: 'Sala de calderas', medio: 'nfc' } });
  assert.equal(creado.status, 201);
  assert.equal(creado.datos.nfcPendiente, true);
  assert.equal(creado.datos.nfcSerie, undefined);
  const qr = await api('/api/admin/puntos', { metodo: 'POST', token: admin, cuerpo: { nombre: 'Jardín' } });
  assert.equal(qr.datos.nfcPendiente, undefined, 'el alta de siempre no cambia');
  const hoja = (await api('/api/admin/hoja-qr', { token: admin })).datos.puntos;
  const pendiente = hoja.find(p => p.id === creado.datos.id);
  assert.deepEqual([pendiente.nfc, pendiente.pendiente, pendiente.dataUrl], [true, true, null], 'el punto elegido NFC no se imprime como QR');
  assert.ok(hoja.find(p => p.id === qr.datos.id).dataUrl.startsWith('data:image/png'));
  // Mientras no tenga chapita, el código a mano lo marca (y no es "a mano en punto NFC").
  const ronda = await api('/api/admin/rondas', { metodo: 'POST', token: admin, cuerpo: { nombre: 'Prueba NFC', puntoIds: [creado.datos.id] } });
  const guardia = await login('pedro', '2222');
  const ej = await iniciar(guardia, ronda.datos.id);
  // Una chapita sin serie registrada todavía no prueba nada: no marca.
  const payload = puntoDe(await paqueteDe(guardia), ronda.datos.id, creado.datos.id).payload;
  assert.equal((await marcar(guardia, ej, { codigo: payload, nfc: { serie: '04:99:88:77:66:55:44' } })).status, 422);
  assert.equal((await marcar(guardia, ej, { codigo: creado.datos.codigoCorto })).status, 200);
  assert.equal(store.ejecuciones.obtener(ej).escaneos[0].puntoNfc, undefined);
  await api(`/api/admin/rondas/${ronda.datos.id}`, { metodo: 'DELETE', token: admin });
  const grabado = await configurarPunto(`/${creado.datos.id}/chapita`, { metodo: 'PUT', cuerpo: { serie: '04:99:88:77:66:55:44' } });
  assert.equal(grabado.datos.nfcPendiente, undefined, 'con la chapita grabada deja de estar pendiente');
  for (const id of [creado.datos.id, qr.datos.id]) await configurarPunto(`/${id}`, { metodo: 'DELETE' });
});
