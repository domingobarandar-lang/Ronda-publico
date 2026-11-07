// Comentario opcional del guardia al cerrar la ronda: se guarda con la
// ejecución, sale en el informe de la ronda (panel y aviso) y en la sección 6
// del informe semanal.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const { calcular, revisarCoherencia } = require('../lib/informe-semanal');
const { isoChile } = require('../lib/fechas-chile');

let base;
let servidor;
let store;
let guardia;
let admin;

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

// Una ronda con una marca, cerrada con el cuerpo que se indique.
async function rondaCerrada(cuerpo) {
  const id = 'com-' + Math.random().toString(36).slice(2, 12);
  const r = await api('/api/ejecuciones', { metodo: 'POST', token: guardia.token, cuerpo: { id, rondaId: 'ronda-express', inicio: new Date().toISOString() } });
  assert.equal(r.status, 201, JSON.stringify(r.datos));
  await api(`/api/ejecuciones/${id}/escaneos`, { metodo: 'POST', token: guardia.token, cuerpo: { codigo: 'PRT234', ts: new Date().toISOString() } });
  const c = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token: guardia.token, cuerpo });
  assert.equal(c.status, 200, JSON.stringify(c.datos));
  return { id, informe: c.datos };
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-com-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
  const reg = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'aromos', codigo: 'AROMOS', usuario: 'comentador', nombre: 'Delia Comentadora', pin: '2468' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.datos));
  guardia = (await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'comentador', pin: '2468' } })).datos;
  admin = (await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: '1111' } })).datos;
});

test.after(() => servidor && servidor.close());

test('el comentario del cierre queda en la ronda, en su informe y en el aviso al administrador', async () => {
  const { id, informe } = await rondaCerrada({ comentario: '  Luminaria apagada\n en el   estacionamiento.  ' });
  assert.equal(informe.comentario, 'Luminaria apagada en el estacionamiento.', 'espacios y saltos compactados');
  assert.equal(store.ejecuciones.obtener(id).comentario, 'Luminaria apagada en el estacionamiento.');

  const panel = await api(`/api/admin/informes/${id}`, { token: admin.token });
  assert.equal(panel.status, 200);
  assert.equal(panel.datos.comentario, 'Luminaria apagada en el estacionamiento.');

  assert.ok(store.notificaciones.ultimas('aromos', 50).some(n => n.texto.includes('Comentario del guardia: Luminaria apagada en el estacionamiento.')));
});

test('es opcional: sin comentario (o con la app vieja, que no lo manda) la ronda cierra igual', async () => {
  const sinCampo = await rondaCerrada({ fin: new Date().toISOString() });
  assert.equal(sinCampo.informe.comentario, null);
  assert.ok(!('comentario' in store.ejecuciones.obtener(sinCampo.id)));
  const vacio = await rondaCerrada({ comentario: '   ' });
  assert.equal(vacio.informe.comentario, null);
});

test('el comentario se corta en 280 caracteres y reenviar el cierre no lo cambia', async () => {
  const { id, informe } = await rondaCerrada({ comentario: 'x'.repeat(500) });
  assert.equal(informe.comentario.length, 280);
  // La cola del teléfono reintenta: el segundo cierre es idempotente.
  const otra = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token: guardia.token, cuerpo: { comentario: 'otro texto' } });
  assert.equal(otra.status, 200);
  assert.equal(store.ejecuciones.obtener(id).comentario, 'x'.repeat(280));
});

test('el informe semanal lista solo las rondas con comentario y lo cuenta en la conclusión', async () => {
  const hoy = isoChile(Date.now());
  const d = calcular(store, { condominioId: 'aromos', desde: hoy, hasta: hoy });
  const mios = d.comentarios.filter(c => c.guardia === 'Delia Comentadora');
  assert.equal(mios.length, 2, 'dos de las cuatro rondas de este archivo tienen comentario');
  assert.ok(mios.some(c => c.texto === 'Luminaria apagada en el estacionamiento.' && c.estado === 'Incompleta'));
  assert.ok(d.conclusion.endsWith(`Los guardias dejaron ${d.comentarios.length} comentarios (sección 6).`), d.conclusion);
  assert.deepEqual(revisarCoherencia(d), []);
});
