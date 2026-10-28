// CU-28: puntos con chapita NFC. Lo que importa probar:
//   · un punto SIN chapita sigue idéntico (QR y código a mano, medio anotado);
//   · en un punto CON chapita la marca solo entra con la serie que coincide, o
//     con el código a mano (observado); un QR o una chapita ajena → 422, y
//     queda en el registro de rechazos;
//   · una chapita no puede pertenecer a dos puntos (ni de dos condominios);
//   · el paquete del guardia y la hoja de QR saben qué puntos son NFC.
// Todo en MOCK: cero llamadas externas.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const { normalizarSerie } = require('../lib/codigos');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-nfc-'));
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
  assert.equal(paquete.manualEnNfc, 'observacion');
  const porteria = puntoDe(paquete, 'ronda-express', 'p-porteria');
  assert.equal(porteria.nfc, false);
  assert.equal(porteria.nfcSerie, null);

  const ej = await iniciar(guardia);
  const qr = await marcar(guardia, ej, { codigo: porteria.payload });
  assert.equal(qr.status, 200);
  // Una chapita con el texto de un punto QR no rompe nada: vale el payload.
  const quincho = puntoDe(paquete, 'ronda-express', 'p-quincho');
  assert.equal((await marcar(guardia, ej, { codigo: quincho.payload, nfc: { serie: SERIE_WEB } })).status, 200);
  assert.equal((await marcar(guardia, ej, { codigo: 'PSC234' })).status, 200);
  const marcas = store.ejecuciones.obtener(ej).escaneos;
  assert.deepEqual(marcas.map(m => m.medio), ['qr', 'qr', 'manual']);
  assert.ok(marcas.every(m => !m.puntoNfc), 'un punto sin chapita no se anota como NFC');
  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia });
  assert.ok(!cierre.datos.evaluacion.observaciones.some(o => /chapita/.test(o)));
});

test('grabar chapita: valida la serie, la normaliza y la guarda', async () => {
  const admin = await login('marta', '1111');
  assert.equal((await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: 'hola' } })).status, 422);
  assert.equal((await api('/api/admin/puntos/no-existe/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: SERIE_WEB } })).status, 404);
  const r = await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: SERIE_WEB, bloqueada: true } });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nfcSerie, SERIE);
  assert.equal(r.datos.nfcBloqueada, true);
  // Un guardia no graba chapitas.
  const guardia = await login('pedro', '2222');
  assert.equal((await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'PUT', token: guardia, cuerpo: { serie: SERIE } })).status, 403);
});

test('una chapita no puede pertenecer a dos puntos, tampoco de otro condominio', async () => {
  const marta = await login('marta', '1111');
  const otro = await api('/api/admin/puntos/p-quincho/chapita', { metodo: 'PUT', token: marta, cuerpo: { serie: SERIE } });
  assert.equal(otro.status, 409);
  assert.match(otro.datos.error, /Piscina/);
  const carmen = await login('carmen', '4444');
  const ajeno = await api('/api/admin/puntos/p-m-terraza/chapita', { metodo: 'PUT', token: carmen, cuerpo: { serie: SERIE_WEB } });
  assert.equal(ajeno.status, 409);
  // Sin revelar el nombre de un punto de otro condominio.
  assert.doesNotMatch(ajeno.datos.error, /Piscina/);
  assert.match(ajeno.datos.error, /otro condominio/);
  // Re-grabar la misma chapita en su propio punto (Reemplazar) sí se puede.
  assert.equal((await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'PUT', token: marta, cuerpo: { serie: SERIE } })).status, 200);
});

test('el paquete del guardia lleva qué puntos son NFC y su serie', async () => {
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  assert.equal(piscina.nfc, true);
  assert.equal(piscina.nfcSerie, SERIE);
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

test('punto con chapita: el código a mano entra como "manual" y el informe lo observa sin acusar', async () => {
  const guardia = await login('pedro', '2222');
  const paquete = await paqueteDe(guardia);
  const ej = await iniciar(guardia);
  // Cuatro marcas espaciadas: sin ráfaga, sin faltantes.
  const base = Date.now() - 20 * 60000;
  const ts = i => new Date(base + i * 4 * 60000).toISOString();
  assert.equal((await marcar(guardia, ej, { codigo: puntoDe(paquete, 'ronda-express', 'p-porteria').payload, ts: ts(0) })).status, 200);
  assert.equal((await marcar(guardia, ej, { codigo: 'QCH789', ts: ts(1) })).status, 200);
  assert.equal((await marcar(guardia, ej, { codigo: 'psc234', ts: ts(2) })).status, 200, 'código a mano en el punto NFC');
  assert.equal((await marcar(guardia, ej, { codigo: puntoDe(paquete, 'ronda-express', 'p-trasero').payload, ts: ts(3) })).status, 200);
  const marca = store.ejecuciones.obtener(ej).escaneos.find(e => e.puntoId === 'p-piscina');
  assert.equal(marca.medio, 'manual');
  assert.equal(marca.puntoNfc, true);

  const cierre = await api(`/api/ejecuciones/${ej}/cerrar`, { metodo: 'POST', token: guardia, cuerpo: { fin: ts(4) } });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.estado, 'completa_obs', 'observación, no sospecha');
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /código a mano en puntos con chapita NFC: Piscina/.test(o)));
  assert.deepEqual(cierre.datos.evaluacion.sospechas, []);
  // El informe muestra con qué se marcó cada punto.
  const medios = Object.fromEntries(cierre.datos.detalle.map(d => [d.puntoId, d.medio]));
  assert.deepEqual(medios, { 'p-porteria': 'qr', 'p-quincho': 'manual', 'p-piscina': 'manual', 'p-trasero': 'qr' });
  const aviso = store.notificaciones.ultimas('aromos', 1)[0];
  assert.match(aviso.texto, /Piscina — .*⌨️ a mano/);
  assert.match(aviso.texto, /Portería — .*📷 QR/);
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

test('"Volver a QR" quita la chapita y el QR vuelve a valer', async () => {
  const admin = await login('marta', '1111');
  const r = await api('/api/admin/puntos/p-piscina/chapita', { metodo: 'DELETE', token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nfcSerie, undefined);
  const guardia = await login('pedro', '2222');
  const piscina = puntoDe(await paqueteDe(guardia), 'ronda-express', 'p-piscina');
  assert.equal(piscina.nfc, false);
  const ej = await iniciar(guardia);
  assert.equal((await marcar(guardia, ej, { codigo: piscina.payload })).status, 200);
  // Y la serie queda libre para otro punto.
  assert.equal((await api('/api/admin/puntos/p-quincho/chapita', { metodo: 'PUT', token: admin, cuerpo: { serie: SERIE } })).status, 200);
  await api('/api/admin/puntos/p-quincho/chapita', { metodo: 'DELETE', token: admin });
});

test('agregar un punto "con chapita" lo deja pendiente y se marca con QR hasta grabarla', async () => {
  const admin = await login('marta', '1111');
  const creado = await api('/api/admin/puntos', { metodo: 'POST', token: admin, cuerpo: { nombre: 'Sala de calderas', medio: 'nfc' } });
  assert.equal(creado.status, 201);
  assert.equal(creado.datos.nfcPendiente, true);
  assert.equal(creado.datos.nfcSerie, undefined);
  const qr = await api('/api/admin/puntos', { metodo: 'POST', token: admin, cuerpo: { nombre: 'Jardín' } });
  assert.equal(qr.datos.nfcPendiente, undefined, 'el alta de siempre no cambia');
  const grabado = await api(`/api/admin/puntos/${creado.datos.id}/chapita`, { metodo: 'PUT', token: admin, cuerpo: { serie: '04:99:88:77:66:55:44' } });
  assert.equal(grabado.datos.nfcPendiente, undefined, 'con la chapita grabada deja de estar pendiente');
  for (const id of [creado.datos.id, qr.datos.id]) await api(`/api/admin/puntos/${id}`, { metodo: 'DELETE', token: admin });
});
