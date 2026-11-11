// CU-25: el guardia elimina su propia cuenta (requisito de Google Play), desde
// la app (DELETE /api/mi/cuenta) o desde la página pública
// (POST /api/cuenta/eliminar). Se borra la persona; sus rondas quedan en los
// informes del condominio, anonimizadas como "Guardia eliminado".
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const { calcular, generarInformeSemanal } = require('../lib/informe-semanal');
const { anonimizarTexto, GUARDIA_ELIMINADO } = require('../lib/cuenta');
const { isoChile } = require('../lib/fechas-chile');

let base;
let servidor;
let store;
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
  assert.equal(r.status, 200, `login de ${usuario}: ${JSON.stringify(r.datos)}`);
  return r.datos;
}

// Guardia nuevo, registrado como lo hace la app (autoservicio con el código).
async function registrar(usuario, nombre, pin = '2468') {
  const r = await api('/api/registro', {
    metodo: 'POST',
    cuerpo: { condominioId: 'aromos', codigo: 'AROMOS', usuario, nombre, pin }
  });
  assert.equal(r.status, 201, JSON.stringify(r.datos));
  return { ...(await login(usuario, pin)), id: r.datos.id, pin };
}

async function iniciar(token) {
  const id = 'del-' + Math.random().toString(36).slice(2, 12);
  const r = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id, rondaId: 'ronda-express', inicio: new Date().toISOString() } });
  assert.equal(r.status, 201);
  return id;
}

async function marcar(token, ejecucionId, codigo) {
  const r = await api(`/api/ejecuciones/${ejecucionId}/escaneos`, { metodo: 'POST', token, cuerpo: { codigo, ts: new Date().toISOString() } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
}

// Nada del guardia puede quedar en lo que se conserva: ni el nombre ni el usuario.
function sinRastro(texto, ...datos) {
  for (const d of datos) assert.ok(!String(texto).includes(d), `quedó "${d}" en: ${String(texto).slice(0, 300)}`);
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-del-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  creado.push.avisar = async (condominio, aviso) => { avisosPush.push(aviso); };
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor && servidor.close());

test('desde la app: borra usuario, sesiones y push; las rondas quedan anonimizadas y la abierta se cierra', async () => {
  const g = await registrar('rigoberto', 'Rigoberto Fuenzalida');
  const marta = await login('marta', '1111');

  // Una ronda cerrada (incompleta: deja aviso con el nombre) y otra abierta.
  const cerrada = await iniciar(g.token);
  await marcar(g.token, cerrada, 'PRT234');
  assert.equal((await api(`/api/ejecuciones/${cerrada}/cerrar`, { metodo: 'POST', token: g.token })).status, 200);
  const abierta = await iniciar(g.token);
  await marcar(g.token, abierta, 'QCH789');
  // La alarma de ronda en el teléfono de este guardia.
  const sus = await api('/api/mi/push/suscribir', {
    metodo: 'POST', token: g.token,
    cuerpo: { suscripcion: { endpoint: 'https://push.ejemplo/rigoberto', keys: { p256dh: 'x', auth: 'y' } } }
  });
  assert.equal(sus.status, 201);
  const otraSesion = await login('rigoberto', g.pin);
  assert.ok(store.notificaciones.ultimas('aromos', 50).some(n => n.texto.includes('Rigoberto Fuenzalida')),
    'el aviso del cierre nombra al guardia (si no, el test no prueba la anonimización)');

  // Sin PIN o con PIN malo no borra nada.
  assert.equal((await api('/api/mi/cuenta', { metodo: 'DELETE', token: g.token })).status, 401);
  const malo = await api('/api/mi/cuenta', { metodo: 'DELETE', token: g.token, cuerpo: { pin: '0000' } });
  assert.equal(malo.status, 401);
  assert.match(malo.datos.error, /PIN/);
  assert.ok(store.db.usuarios.some(u => u.id === g.id));

  const r = await api('/api/mi/cuenta', { metodo: 'DELETE', token: g.token, cuerpo: { pin: g.pin } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.rondasAnonimizadas, 2);
  assert.equal(r.datos.rondasCerradas, 1);

  // Se borró la persona…
  assert.ok(!store.db.usuarios.some(u => u.id === g.id || u.usuario === 'rigoberto'));
  assert.ok(!Object.values(store.db.sesiones).some(s => s.usuarioId === g.id));
  assert.ok(!store.db.pushSuscripciones.some(s => s.usuarioId === g.id));
  // …y ninguno de sus tokens sirve, ni puede volver a entrar.
  for (const token of [g.token, otraSesion.token]) {
    assert.equal((await api('/api/mi/paquete', { token })).status, 401);
  }
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'rigoberto', pin: g.pin } })).status, 401);

  // Las rondas siguen, sin vínculo con la persona; la abierta quedó cerrada.
  for (const id of [cerrada, abierta]) {
    const e = store.ejecuciones.obtener(id);
    assert.equal(e.guardiaId, null);
    assert.equal(e.guardiaEliminado, true);
    assert.notEqual(e.estado, 'en_curso');
    assert.ok(e.escaneos.length, 'las marcas se conservan');
    sinRastro(JSON.stringify(e), 'Rigoberto', 'rigoberto', g.id);
  }
  // Los avisos del panel ya no lo nombran; el del cierre forzado dice por qué.
  const avisos = store.notificaciones.ultimas('aromos', 50);
  for (const n of avisos) sinRastro(n.texto, 'Rigoberto', 'rigoberto');
  assert.ok(avisos.some(n => n.texto.includes('cerrada al eliminar el guardia su cuenta') && n.texto.includes(`Guardia: ${GUARDIA_ELIMINADO}`)));

  // Panel: listado e informe muestran "Guardia eliminado" y no se caen.
  const lista = await api('/api/admin/ejecuciones', { token: marta.token });
  assert.equal(lista.status, 200);
  for (const id of [cerrada, abierta]) {
    assert.equal(lista.datos.find(x => x.id === id).guardia, GUARDIA_ELIMINADO);
    const inf = await api(`/api/admin/informes/${id}`, { token: marta.token });
    assert.equal(inf.status, 200);
    assert.equal(inf.datos.guardia, GUARDIA_ELIMINADO);
  }
});

test('desde la página pública: usuario + PIN borran la cuenta; usuario inexistente da el mismo error que el login', async () => {
  const g = await registrar('anacleta', 'Anacleta Pérez', '1357');
  const ronda = await iniciar(g.token);
  await marcar(g.token, ronda, 'PRT234');
  await api(`/api/ejecuciones/${ronda}/cerrar`, { metodo: 'POST', token: g.token });

  const nadie = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'no-existe', pin: '1357' } });
  assert.equal(nadie.status, 401);
  assert.equal(nadie.datos.error, 'Usuario o PIN incorrectos.');
  const malo = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'anacleta', pin: '9999' } });
  assert.equal(malo.status, 401);
  assert.equal(malo.datos.error, 'Usuario o PIN incorrectos.');

  // Mayúsculas y espacios como en el login.
  const r = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: '  Anacleta ', pin: '1357' } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.rondasAnonimizadas, 1);
  assert.ok(!store.db.usuarios.some(u => u.usuario === 'anacleta'));
  assert.equal((await api('/api/mi/paquete', { token: g.token })).status, 401);
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'anacleta', pin: '1357' } })).status, 401);
  sinRastro(JSON.stringify(store.ejecuciones.obtener(ronda)), 'Anacleta', 'anacleta');
});

test('rate limit: 5 PIN malos bloquean, y el bloqueo es el mismo del login', async () => {
  const g = await registrar('bloqueado', 'Bruno Bloqueado', '8642');
  for (let i = 0; i < 5; i++) {
    assert.equal((await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'bloqueado', pin: '0000' } })).status, 401);
  }
  // Ni con el PIN correcto, ni por la app, ni por el login.
  const r = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'bloqueado', pin: '8642' } });
  assert.equal(r.status, 429);
  assert.match(r.datos.error, /Demasiados intentos/);
  assert.equal((await api('/api/mi/cuenta', { metodo: 'DELETE', token: g.token, cuerpo: { pin: '8642' } })).status, 429);
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'bloqueado', pin: '8642' } })).status, 429);
  assert.ok(store.db.usuarios.some(u => u.usuario === 'bloqueado'), 'bloqueado no es borrado');

  // Y al revés: los fallos por la app también cuentan.
  const h = await registrar('insistente', 'Ignacio Insistente', '9753');
  for (let i = 0; i < 5; i++) {
    assert.equal((await api('/api/mi/cuenta', { metodo: 'DELETE', token: h.token, cuerpo: { pin: '1111' } })).status, 401);
  }
  assert.equal((await api('/api/mi/cuenta', { metodo: 'DELETE', token: h.token, cuerpo: { pin: '9753' } })).status, 429);
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'insistente', pin: '9753' } })).status, 429);
});

test('las cuentas de administrador no se eliminan por acá', async () => {
  const marta = await login('marta', '1111');
  const app = await api('/api/mi/cuenta', { metodo: 'DELETE', token: marta.token, cuerpo: { pin: '1111' } });
  assert.equal(app.status, 403);
  assert.match(app.datos.error, /Solo las cuentas de guardia/);
  const web = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: '1111' } });
  assert.equal(web.status, 403);
  assert.match(web.datos.error, /Solo las cuentas de guardia/);
  // La de acceso total y la de fábrica tampoco: el chequeo es por rol guardia.
  store.db.usuarios.push({ ...store.db.usuarios.find(u => u.usuario === 'marta'), id: 'u-total', usuario: 'total', accesoTotal: true });
  const total = await api('/api/cuenta/eliminar', { metodo: 'POST', cuerpo: { usuario: 'total', pin: '1111' } });
  assert.equal(total.status, 403);
  assert.ok(store.db.usuarios.some(u => u.usuario === 'marta'));
  assert.ok(store.db.usuarios.some(u => u.usuario === 'total'));
  assert.equal((await api('/api/admin/guardias', { token: marta.token })).status, 200, 'la sesión del admin sigue viva');
});

test('el administrador que borra un guardia desde el panel lo anonimiza igual', async () => {
  const g = await registrar('telesforo', 'Telesforo Andrade');
  const marta = await login('marta', '1111');
  const ronda = await iniciar(g.token);
  await marcar(g.token, ronda, 'PRT234');
  const r = await api(`/api/admin/guardias/${g.id}`, { metodo: 'DELETE', token: marta.token });
  assert.equal(r.status, 200);
  assert.equal(r.datos.rondasCerradas, 1);
  const e = store.ejecuciones.obtener(ronda);
  assert.equal(e.guardiaId, null);
  assert.notEqual(e.estado, 'en_curso');
  for (const n of store.notificaciones.ultimas('aromos', 50)) sinRastro(n.texto, 'Telesforo', 'telesforo');
  assert.equal((await api('/api/mi/paquete', { token: g.token })).status, 401);
});

test('informe semanal: "Guardia eliminado" en vez del nombre, y el .docx se genera', async () => {
  const hoy = isoChile(new Date().toISOString());
  const d = calcular(store, { condominioId: 'aromos', desde: hoy, hasta: hoy });
  const nombres = d.guardias.map(x => x.nombre);
  assert.ok(nombres.includes(GUARDIA_ELIMINADO), nombres.join(', '));
  // Todos los borrados van juntos en una sola fila, sin distinguir personas.
  assert.equal(nombres.filter(n => n === GUARDIA_ELIMINADO).length, 1);
  for (const x of [...d.guardias, ...d.incidencias]) sinRastro(x.nombre || x.guardia, 'Rigoberto', 'Anacleta', 'Telesforo');
  assert.ok(d.sinIdentificar > 0);

  const { buffer } = await generarInformeSemanal(store, { condominioId: 'aromos', desde: hoy, hasta: hoy });
  assert.ok(buffer.length > 1000);
  const marta = await login('marta', '1111');
  const resp = await fetch(`${base}/api/admin/informe-semanal.docx?desde=${hoy}&hasta=${hoy}`, { headers: { authorization: `Bearer ${marta.token}` } });
  assert.equal(resp.status, 200);
});

test('anonimizarTexto: solo toca la línea "Guardia:" y el título del push', () => {
  const texto = '⚠️ Ronda incompleta — Pedro Soto\n"Nocturna": 1 de 4\nGuardia: Pedro Soto\nPunto Pedro Soto ✅';
  const r = anonimizarTexto(texto, ['Pedro Soto', 'pedro']);
  assert.equal(r, `⚠️ Ronda incompleta — ${GUARDIA_ELIMINADO}\n"Nocturna": 1 de 4\nGuardia: ${GUARDIA_ELIMINADO}\nPunto Pedro Soto ✅`);
  // Nombres con caracteres de regex no rompen nada.
  assert.equal(anonimizarTexto('Guardia: J. (Pepe)*', ['J. (Pepe)*']), `Guardia: ${GUARDIA_ELIMINADO}`);
  assert.equal(anonimizarTexto('Guardia: Pedro Sotomayor', ['Pedro Soto']), 'Guardia: Pedro Sotomayor');
});

test('página pública: se sirve sin login, enlaza la política y muestra el contacto del entorno', async () => {
  const resp = await fetch(`${base}/eliminar-cuenta.html`);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /\/api\/cuenta\/eliminar/);
  assert.match(html, /href="\/privacidad.html"/);
  assert.match(html, /\/api\/cuenta\/contacto/);
  assert.ok(!html.includes('975202366'), 'el contacto no va escrito en la página');

  const antes = process.env.CONTACTO_PRIVACIDAD;
  try {
    process.env.CONTACTO_PRIVACIDAD = '+56911112222';
    assert.deepEqual((await api('/api/cuenta/contacto')).datos, { correo: null, telefono: '+56911112222' });
    process.env.CONTACTO_PRIVACIDAD = '+56 9 1111 2222';
    assert.deepEqual((await api('/api/cuenta/contacto')).datos, { correo: null, telefono: '+56911112222' });
    process.env.CONTACTO_PRIVACIDAD = 'privacidad@ejemplo.cl';
    assert.deepEqual((await api('/api/cuenta/contacto')).datos, { correo: 'privacidad@ejemplo.cl', telefono: null });
    process.env.CONTACTO_PRIVACIDAD = 'no es un contacto';
    assert.deepEqual((await api('/api/cuenta/contacto')).datos, { correo: null, telefono: null });
  } finally {
    if (antes === undefined) delete process.env.CONTACTO_PRIVACIDAD;
    else process.env.CONTACTO_PRIVACIDAD = antes;
  }
});
