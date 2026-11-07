// Actualización remota de la app del guardia: el servidor dice qué versión
// sirve, anota con cuál se conectó cada guardia y el panel la muestra.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');

const ACTUAL = 'v' + require('../package.json').version;
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

async function registrar(usuario, nombre) {
  const r = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'aromos', codigo: 'AROMOS', usuario, nombre, pin: '2468' } });
  assert.equal(r.status, 201, JSON.stringify(r.datos));
  const s = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin: '2468' } });
  return { id: r.datos.id, token: s.datos.token };
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-ver-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor && servidor.close());

test('sin sesión (pantalla de login) el servidor informa su versión', async () => {
  const r = await api('/api/version');
  assert.equal(r.status, 200);
  assert.equal(r.datos.version, ACTUAL);
});

test('el panel muestra con qué versión se conectó cada guardia y si está al día', async () => {
  const viejo = await registrar('anselmo', 'Anselmo Vera');
  const nuevo = await registrar('brigida', 'Brígida Paz');
  const callado = await registrar('ciro', 'Ciro Mena');

  const r = await api('/api/mi/version', { metodo: 'POST', token: viejo.token, cuerpo: { version: 'v0.0.1' } });
  assert.equal(r.status, 200);
  assert.equal(r.datos.version, ACTUAL, 'le responde la versión a la que tiene que llegar');
  await api('/api/mi/version', { metodo: 'POST', token: nuevo.token, cuerpo: { version: ACTUAL } });

  const admin = (await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: '1111' } })).datos;
  const guardias = (await api('/api/admin/guardias', { token: admin.token })).datos;
  const de = id => guardias.find(g => g.id === id);

  assert.equal(de(viejo.id).appVersion, 'v0.0.1');
  assert.equal(de(viejo.id).appAlDia, false);
  assert.ok(de(viejo.id).appVista);
  assert.equal(de(nuevo.id).appVersion, ACTUAL);
  assert.equal(de(nuevo.id).appAlDia, true);
  assert.equal(de(callado.id).appVersion, null, 'quien nunca avisó su versión queda sin datos');
  assert.equal(de(callado.id).appAlDia, false);

  // Tras recargarse, el mismo guardia avisa la versión nueva y queda al día.
  await api('/api/mi/version', { metodo: 'POST', token: viejo.token, cuerpo: { version: ACTUAL } });
  const despues = (await api('/api/admin/guardias', { token: admin.token })).datos.find(g => g.id === viejo.id);
  assert.equal(despues.appAlDia, true);
});

test('sin sesión válida no se anota ninguna versión', async () => {
  const r = await api('/api/mi/version', { metodo: 'POST', token: 'x', cuerpo: { version: ACTUAL } });
  assert.equal(r.status, 401);
});
