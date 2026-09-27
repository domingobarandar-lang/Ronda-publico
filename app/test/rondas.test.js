// QA de Rondas QR — cubre los casos de uso CU-01 a CU-14 del SPEC más
// escenarios adversariales (permisos cruzados, cierre repetido, escaneo tras
// cierre). Todo en MOCK: cero llamadas externas.
'use strict';

process.env.MOCK = 'true';
// Cuenta de fábrica (alta de condominios): se crea sola al arrancar el server.
process.env.FABRICA_USUARIO = 'fabrica';
process.env.FABRICA_PIN = '87654321';
// Cuenta de panel con acceso total: solo se crea así, desde el entorno.
// Valores de prueba (no son los de producción).
process.env.ADMIN_TOTAL_USUARIO = 'operacion';
process.env.ADMIN_TOTAL_NOMBRE = 'Operación (test)';
process.env.ADMIN_TOTAL_PIN = 'Prueba2026Total';
process.env.ADMIN_TOTAL_CONDOMINIO = 'aromos';
const PIN_TOTAL = process.env.ADMIN_TOTAL_PIN;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const { hashPin } = require('../lib/auth');

let base;
let servidor;
let store;
const pushEnviados = []; // transporte falso: lo que "llegó" a cada teléfono suscrito

async function api(ruta, { metodo = 'GET', cuerpo, token, condominio } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(condominio ? { 'x-condominio': condominio } : {})
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const datos = await resp.json().catch(() => ({}));
  return { status: resp.status, datos };
}

async function login(usuario, pin) {
  const { status, datos } = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(status, 200, `login de ${usuario} debería funcionar`);
  return datos;
}

// El payload QR de un punto, tal como saldría impreso en la hoja.
function payloadDe(paquete, rondaId, nombrePunto) {
  const ronda = paquete.rondas.find(r => r.id === rondaId);
  const punto = ronda.puntos.find(p => p.nombre === nombrePunto);
  return punto.payload;
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({
    rutaDb,
    enviarPush: async (suscripcion, payload) => { pushEnviados.push({ suscripcion, payload }); }
  });
  store = creado.store;
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('CU-01: login correcto entrega sesión; PIN malo no', async () => {
  const r = await login('pedro', '2222');
  assert.ok(r.token);
  assert.equal(r.rol, 'guardia');
  assert.equal(r.condominio.id, 'aromos');

  const malo = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'pedro', pin: '9999' } });
  assert.equal(malo.status, 401);
  assert.ok(!malo.datos.token);
});

test('auth: el API exige token válido', async () => {
  const sin = await api('/api/mi/paquete');
  assert.equal(sin.status, 401);
  const falso = await api('/api/mi/paquete', { token: 'token-falso' });
  assert.equal(falso.status, 401);
});

test('CU-02: el paquete trae las rondas del condominio con sus puntos', async () => {
  const { token } = await login('pedro', '2222');
  const { status, datos } = await api('/api/mi/paquete', { token });
  assert.equal(status, 200);
  assert.equal(datos.condominio.id, 'aromos');
  assert.equal(datos.rondas.length, 2);
  const nocturna = datos.rondas.find(r => r.id === 'ronda-nocturna');
  assert.equal(nocturna.puntos.length, 8);
  assert.ok(nocturna.puntos[0].payload.startsWith('RQR:aromos:'));
  assert.match(nocturna.puntos[0].codigoCorto, /^[A-Z2-9]{6}$/);
});

test('CU-03/04/09: ronda completa en orden → informe "completa" + notificación al admin', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const nocturna = paquete.rondas.find(r => r.id === 'ronda-nocturna');

  const ini = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: 'ronda-nocturna' } });
  assert.equal(ini.status, 201);
  const ejecucionId = ini.datos.id;

  // Marcas espaciadas como una ronda caminada de verdad (5 min entre punto y
  // punto): sin esto el control de tiempo (CU-17) la leería como ráfaga.
  const base = Date.now() - 60 * 60000;
  for (const [i, punto] of nocturna.puntos.entries()) {
    const esc = await api(`/api/ejecuciones/${ejecucionId}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts: new Date(base + i * 5 * 60000).toISOString() }
    });
    assert.equal(esc.status, 200);
    assert.equal(esc.datos.avance.hechos, i + 1);
  }

  const notifsAntes = store.notificaciones.contar();
  const cierre = await api(`/api/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.estado, 'completa');
  assert.ok(cierre.datos.detalle.every(d => !d.faltante));

  assert.equal(store.notificaciones.contar(), notifsAntes + 1);
  const notif = store.notificaciones.ultimas('aromos', 1)[0];
  assert.equal(notif.condominioId, 'aromos');
  assert.match(notif.texto, /Nocturna completa/);
  assert.doesNotMatch(notif.texto, /ALERTA/);
});

test('CU-05/06/13: escaneos inválidos, duplicado y código manual', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });

  const ini = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: 'ronda-express' } });
  const ejecucionId = ini.datos.id;
  const url = `/api/ejecuciones/${ejecucionId}/escaneos`;

  // Basura
  const basura = await api(url, { metodo: 'POST', token, cuerpo: { codigo: 'hola esto no es un QR' } });
  assert.equal(basura.status, 422);

  // QR de otro condominio (payload real de Mirador)
  const ajeno = await api(url, { metodo: 'POST', token, cuerpo: { codigo: 'RQR:mirador:p-m-acceso:MAP234' } });
  assert.equal(ajeno.status, 422);

  // Punto del condominio pero que no es parte de esta ronda
  const bodega = paquete.rondas.find(r => r.id === 'ronda-nocturna').puntos.find(p => p.nombre === 'Bodega');
  const fuera = await api(url, { metodo: 'POST', token, cuerpo: { codigo: bodega.payload } });
  assert.equal(fuera.status, 422);
  assert.match(fuera.datos.error, /no es parte/);

  // Escaneo válido + duplicado (gana el primero)
  const porteria = payloadDe(paquete, 'ronda-express', 'Portería');
  const ok = await api(url, { metodo: 'POST', token, cuerpo: { codigo: porteria } });
  assert.equal(ok.status, 200);
  assert.equal(ok.datos.duplicado, false);
  const dup = await api(url, { metodo: 'POST', token, cuerpo: { codigo: porteria } });
  assert.equal(dup.status, 200);
  assert.equal(dup.datos.duplicado, true);
  assert.equal(dup.datos.avance.hechos, 1);

  // Código corto tipeado a mano (minúsculas, se normaliza)
  const manual = await api(url, { metodo: 'POST', token, cuerpo: { codigo: 'qch789' } });
  assert.equal(manual.status, 200);
  assert.equal(manual.datos.punto.nombre, 'Quincho');

  // CU-08/10: cierre con 2 de 4 puntos → INCOMPLETA + alerta con los faltantes
  const notifsAntes = store.notificaciones.contar();
  const cierre = await api(`/api/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.datos.estado, 'incompleta');
  assert.equal(cierre.datos.evaluacion.faltantes.length, 2);
  const notif = store.notificaciones.ultimas('aromos', 1)[0];
  assert.equal(store.notificaciones.contar(), notifsAntes + 1);
  assert.match(notif.texto, /ALERTA/);
  assert.match(notif.texto, /Piscina — FALTANTE/);
  assert.match(notif.texto, /Acceso trasero — FALTANTE/);
});

test('CU-07: reenvío offline idempotente con timestamps del teléfono', async () => {
  const { token } = await login('luis', '3333');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');

  const idCliente = 'cli-' + Date.now();
  const hace30 = new Date(Date.now() - 30 * 60000).toISOString();

  // El teléfono reenvía el "iniciar" dos veces (reintento): mismo resultado.
  const uno = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id: idCliente, rondaId: 'ronda-express', inicio: hace30 } });
  assert.equal(uno.status, 201);
  const dos = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id: idCliente, rondaId: 'ronda-express', inicio: hace30 } });
  assert.equal(dos.status, 200);
  assert.equal(dos.datos.id, idCliente);

  // Escaneos hechos sin señal, con hora original del teléfono.
  for (const [i, punto] of express.puntos.entries()) {
    const ts = new Date(Date.now() - (25 - i * 5) * 60000).toISOString();
    const esc = await api(`/api/ejecuciones/${idCliente}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts, offline: true }
    });
    assert.equal(esc.status, 200);
  }

  const cierre = await api(`/api/ejecuciones/${idCliente}/cerrar`, { metodo: 'POST', token, cuerpo: { fin: new Date().toISOString() } });
  assert.equal(cierre.status, 200);
  // Sin faltantes, pero con observaciones: duración excedida (30 > 20 min) y marcas offline.
  assert.equal(cierre.datos.estado, 'completa_obs');
  assert.equal(cierre.datos.evaluacion.faltantes.length, 0);
  // TEMPORAL: mientras OCULTAR_SIN_CONEXION esté activo, lo offline no se muestra.
  const { OCULTAR_SIN_CONEXION } = require('../lib/rondas');
  assert.equal(cierre.datos.evaluacion.observaciones.some(o => /sin conexión/.test(o)), !OCULTAR_SIN_CONEXION);
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /máximo definido: 20/.test(o)));
  assert.ok(cierre.datos.detalle.every(d => d.offline === !OCULTAR_SIN_CONEXION));
});

test('orden estricto: marcar fuera de secuencia queda como observación', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const nocturna = paquete.rondas.find(r => r.id === 'ronda-nocturna');

  const ini = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: 'ronda-nocturna' } });
  const ejecucionId = ini.datos.id;

  // Orden real: 1, 3, 2, 4, 5, 6, 7, 8 → "Estacionamiento A" (índice 2) queda fuera de orden.
  // La hora crece según el orden REAL de marcado (por eso el 3 queda antes que el 2).
  const orden = [0, 2, 1, 3, 4, 5, 6, 7];
  const base = Date.now() - 60 * 60000;
  for (const [paso, i] of orden.entries()) {
    const esc = await api(`/api/ejecuciones/${ejecucionId}/escaneos`, {
      metodo: 'POST', token,
      cuerpo: { codigo: nocturna.puntos[i].payload, ts: new Date(base + paso * 5 * 60000).toISOString() }
    });
    assert.equal(esc.status, 200);
  }

  const cierre = await api(`/api/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.datos.estado, 'completa_obs');
  assert.deepEqual(cierre.datos.evaluacion.fueraDeOrden, ['p-estacionamiento']);
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /Orden de la ronda no respetado/.test(o)));
});

test('CU-11: CRUD de puntos, guardias y rondas del panel admin', async () => {
  const { token } = await login('marta', '1111');

  // Punto nuevo
  const punto = await api('/api/admin/puntos', { metodo: 'POST', token, cuerpo: { nombre: 'Antena' } });
  assert.equal(punto.status, 201);
  assert.match(punto.datos.codigoCorto, /^[A-Z2-9]{6}$/);

  // Guardia nuevo (y validaciones)
  const malPin = await api('/api/admin/guardias', { metodo: 'POST', token, cuerpo: { usuario: 'diego', pin: 'abc' } });
  assert.equal(malPin.status, 422);
  const repetido = await api('/api/admin/guardias', { metodo: 'POST', token, cuerpo: { usuario: 'pedro', pin: '8888' } });
  assert.equal(repetido.status, 409);
  const diego = await api('/api/admin/guardias', { metodo: 'POST', token, cuerpo: { usuario: 'diego', nombre: 'Diego Pérez', pin: '9876' } });
  assert.equal(diego.status, 201);
  await login('diego', '9876'); // puede entrar

  // Ronda nueva con el punto nuevo
  const ronda = await api('/api/admin/rondas', {
    metodo: 'POST', token,
    cuerpo: { nombre: 'Prueba antena', puntoIds: [punto.datos.id, 'p-porteria'], ordenEstricto: false, duracionMaxMin: 10 }
  });
  assert.equal(ronda.status, 201);

  // Ronda con punto ajeno → rechazada
  const ajena = await api('/api/admin/rondas', {
    metodo: 'POST', token,
    cuerpo: { nombre: 'Trampa', puntoIds: ['p-m-acceso'] }
  });
  assert.equal(ajena.status, 422);

  // Al eliminar el punto, sale de la ronda
  await api(`/api/admin/puntos/${punto.datos.id}`, { metodo: 'DELETE', token });
  const rondas = await api('/api/admin/rondas', { token });
  const prueba = rondas.datos.find(r => r.id === ronda.datos.id);
  assert.deepEqual(prueba.puntoIds, ['p-porteria']);

  // Limpieza
  await api(`/api/admin/rondas/${ronda.datos.id}`, { metodo: 'DELETE', token });
  await api(`/api/admin/guardias/${diego.datos.id}`, { metodo: 'DELETE', token });
});

test('registro autoservicio: código del condominio + alta de la cuenta', async () => {
  // La lista de condominios es pública (la usa el selector del formulario)
  // y NUNCA expone el código de registro ni el hash del PIN.
  const condominios = await api('/api/condominios');
  assert.equal(condominios.status, 200);
  assert.ok(condominios.datos.some(c => c.id === 'aromos'));
  assert.ok(condominios.datos.every(c => c.id && c.nombre && c.codigoRegistro === undefined && c.pinHash === undefined));

  // Sin el código correcto → 403, y NO se crea nada (ni siquiera se revela si el usuario existe).
  const malCodigo = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'mirador', usuario: 'rosa', pin: '7788', codigo: 'XXXX' } });
  assert.equal(malCodigo.status, 403);
  assert.ok(!store.db.usuarios.some(u => u.usuario === 'rosa'));

  // Condominio inexistente → 422.
  const sinCondo = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'no-existe', usuario: 'nuevo', pin: '4321', codigo: 'MIRADOR' } });
  assert.equal(sinCondo.status, 422);

  // PIN inválido (con código correcto) → 422.
  const malPin = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'aromos', usuario: 'sofia', pin: '12', codigo: 'AROMOS' } });
  assert.equal(malPin.status, 422);

  // Alta correcta: el código se compara sin distinguir mayúsculas.
  const alta = await api('/api/registro', {
    metodo: 'POST', cuerpo: { condominioId: 'mirador', usuario: 'ROSA', nombre: 'Rosa Vera', pin: '7788', codigo: 'mirador' }
  });
  assert.equal(alta.status, 201);
  assert.equal(alta.datos.usuario, 'rosa'); // usuario se normaliza a minúsculas
  const guardada = store.db.usuarios.find(u => u.id === alta.datos.id);
  assert.equal(guardada.rol, 'guardia');
  assert.equal(guardada.condominioId, 'mirador');

  // Puede entrar de inmediato con lo que definió.
  const sesion = await login('rosa', '7788');
  assert.equal(sesion.rol, 'guardia');
  assert.equal(sesion.condominio.id, 'mirador');

  // Usuario repetido (código correcto) → 409.
  const repetido = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'mirador', usuario: 'rosa', pin: '9999', codigo: 'MIRADOR' } });
  assert.equal(repetido.status, 409);

  // Limpieza: rosa es de Mirador, la borra su admin (carmen).
  const carmen = await login('carmen', '4444');
  await api(`/api/admin/guardias/${alta.datos.id}`, { metodo: 'DELETE', token: carmen.token });
});

test('el administrador ve, cambia y regenera el código de registro', async () => {
  const marta = await login('marta', '1111');

  // Ve el código vigente del condominio (el de la demo).
  const actual = await api('/api/admin/registro', { token: marta.token });
  assert.equal(actual.status, 200);
  assert.equal(actual.datos.codigo, 'AROMOS');

  // Un guardia no puede verlo ni cambiarlo.
  const pedro = await login('pedro', '2222');
  const prohibido = await api('/api/admin/registro', { token: pedro.token });
  assert.equal(prohibido.status, 403);

  // Código con caracteres inválidos → 422.
  const invalido = await api('/api/admin/registro', { metodo: 'PUT', token: marta.token, cuerpo: { codigo: 'los-aromos' } });
  assert.equal(invalido.status, 422);

  // Cambiarlo por uno personalizado (se normaliza a mayúsculas).
  const cambio = await api('/api/admin/registro', { metodo: 'PUT', token: marta.token, cuerpo: { codigo: 'aromos7' } });
  assert.equal(cambio.status, 200);
  assert.equal(cambio.datos.codigo, 'AROMOS7');

  // El código viejo ya no sirve para registrarse; el nuevo sí.
  const conViejo = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'aromos', usuario: 'test1', pin: '1234', codigo: 'AROMOS' } });
  assert.equal(conViejo.status, 403);
  const conNuevo = await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId: 'aromos', usuario: 'test1', pin: '1234', codigo: 'AROMOS7' } });
  assert.equal(conNuevo.status, 201);

  // Generar al azar entrega un código legible y distinto.
  const gen = await api('/api/admin/registro', { metodo: 'PUT', token: marta.token, cuerpo: { generar: true } });
  assert.equal(gen.status, 200);
  assert.match(gen.datos.codigo, /^[A-Z0-9]{4,12}$/);
  assert.notEqual(gen.datos.codigo, 'AROMOS7');

  // Restaurar el código de la demo y limpiar el guardia de prueba.
  await api('/api/admin/registro', { metodo: 'PUT', token: marta.token, cuerpo: { codigo: 'AROMOS' } });
  await api(`/api/admin/guardias/${conNuevo.datos.id}`, { metodo: 'DELETE', token: marta.token });
});

test('CU-12: la hoja de QR trae una imagen por punto', async () => {
  const { token } = await login('marta', '1111');
  const { status, datos } = await api('/api/admin/hoja-qr', { token });
  assert.equal(status, 200);
  assert.equal(datos.puntos.length, 8);
  for (const p of datos.puntos) {
    assert.ok(p.dataUrl.startsWith('data:image/png;base64,'), `QR de ${p.nombre} debería ser un PNG embebido`);
  }
});

test('CU-14: el guardia queda encerrado en su condominio', async () => {
  const jorge = await login('jorge', '5555');

  // Jorge (Mirador) no puede iniciar una ronda de Los Aromos.
  const robo = await api('/api/ejecuciones', { metodo: 'POST', token: jorge.token, cuerpo: { rondaId: 'ronda-nocturna' } });
  assert.equal(robo.status, 403);

  // En su propia ronda, un QR de Los Aromos no vale.
  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: jorge.token, cuerpo: { rondaId: 'ronda-mirador' } });
  const cruzado = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
    metodo: 'POST', token: jorge.token, cuerpo: { codigo: 'RQR:aromos:p-porteria:PRT234' }
  });
  assert.equal(cruzado.status, 422);

  // Y la cabecera con la que el panel cambia de condominio NO le sirve a un
  // guardia: si funcionara, se bajaría los payloads de los QR del vecino.
  const paquete = await api('/api/mi/paquete', { token: jorge.token, condominio: 'aromos' });
  assert.equal(paquete.datos.condominio.id, 'mirador');
  assert.ok(paquete.datos.rondas.every(r => r.id === 'ronda-mirador'));
});

test('CU-22: un administrador normal queda encerrado en su condominio aunque mande x-condominio', async () => {
  const carmen = await login('carmen', '4444'); // admin de Mirador del Valle

  const propios = await api('/api/admin/puntos', { token: carmen.token });
  assert.ok(propios.datos.length && propios.datos.every(p => p.condominioId === 'mirador'));

  // El selector del panel le trae solo el suyo.
  const lista = await api('/api/admin/condominios', { token: carmen.token, condominio: 'aromos' });
  assert.equal(lista.status, 200);
  assert.equal(lista.datos.activo, 'mirador');
  assert.equal(lista.datos.accesoTotal, false);
  assert.deepEqual(lista.datos.condominios.map(c => c.id), ['mirador']);

  // Pidiendo Los Aromos por cabecera sigue viendo y editando Mirador.
  const ajenos = await api('/api/admin/puntos', { token: carmen.token, condominio: 'aromos' });
  assert.ok(ajenos.datos.every(p => p.condominioId === 'mirador'));
  const guardias = await api('/api/admin/guardias', { token: carmen.token, condominio: 'aromos' });
  assert.ok(!guardias.datos.some(g => g.usuario === 'pedro'), 'no ve los guardias de Los Aromos');
  const registro = await api('/api/admin/registro', { token: carmen.token, condominio: 'aromos' });
  assert.notEqual(registro.datos.codigo, store.db.condominios.find(c => c.id === 'aromos').codigoRegistro);

  const creado = await api('/api/admin/puntos', {
    metodo: 'POST', token: carmen.token, condominio: 'aromos', cuerpo: { nombre: 'Bodega prueba' }
  });
  assert.equal(creado.status, 201);
  assert.equal(creado.datos.condominioId, 'mirador', 'el punto nuevo cae en SU condominio');
  await api(`/api/admin/puntos/${creado.datos.id}`, { metodo: 'DELETE', token: carmen.token });

  const puntoAromos = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: carmen.token, condominio: 'aromos', cuerpo: { lat: -33.41, lon: -70.6 }
  });
  assert.equal(puntoAromos.status, 404, 'no puede fijar la ubicación de un punto ajeno');

  // Informes y ejecuciones de Los Aromos: invisibles, y no las puede tocar.
  const pedro = await login('pedro', '2222');
  const ejec = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  assert.equal(ejec.status, 201);
  const informe = await api(`/api/admin/informes/${ejec.datos.id}`, { token: carmen.token, condominio: 'aromos' });
  assert.equal(informe.status, 404);
  const escaneo = await api(`/api/ejecuciones/${ejec.datos.id}/escaneos`, {
    metodo: 'POST', token: carmen.token, condominio: 'aromos', cuerpo: { codigo: 'PRT234' }
  });
  assert.equal(escaneo.status, 403, 'un admin de otro condominio no escanea en una ronda ajena');
  const rechazo = await api(`/api/ejecuciones/${ejec.datos.id}/rechazos`, {
    metodo: 'POST', token: carmen.token, condominio: 'aromos', cuerpo: { puntoId: 'p-porteria', motivo: 'x' }
  });
  assert.equal(rechazo.status, 403);
  const cierre = await api(`/api/ejecuciones/${ejec.datos.id}/cerrar`, { metodo: 'POST', token: carmen.token, condominio: 'aromos' });
  assert.equal(cierre.status, 403, 'ni la cierra por la ruta del guardia');
  const cierreAdmin = await api(`/api/admin/ejecuciones/${ejec.datos.id}/cerrar`, { metodo: 'POST', token: carmen.token, condominio: 'aromos' });
  assert.equal(cierreAdmin.status, 404, 'ni por la ruta del administrador');
  assert.equal(store.ejecuciones.obtener(ejec.datos.id).estado, 'en_curso');

  // Su propio administrador (marta, de Los Aromos) sí la cierra.
  const marta = await login('marta', '1111');
  const propia = await api(`/api/ejecuciones/${ejec.datos.id}/cerrar`, { metodo: 'POST', token: marta.token });
  assert.equal(propia.status, 200);
});

test('CU-22: la cuenta de acceso total (creada desde el entorno) recorre todos los condominios', async () => {
  const cuenta = store.db.usuarios.find(u => u.usuario === 'operacion');
  assert.ok(cuenta, 'se creó al arrancar desde ADMIN_TOTAL_*');
  assert.equal(cuenta.rol, 'admin', 'no es un rol nuevo: es un admin con la marca');
  assert.equal(cuenta.accesoTotal, true);
  assert.equal(cuenta.condominioId, 'aromos', 'condominio de casa');
  assert.equal(cuenta.nombre, 'Operación (test)');

  const op = await login('operacion', PIN_TOTAL);
  const lista = await api('/api/admin/condominios', { token: op.token });
  assert.equal(lista.datos.accesoTotal, true);
  assert.equal(lista.datos.activo, 'aromos');
  assert.ok(['aromos', 'mirador'].every(id => lista.datos.condominios.some(c => c.id === id)));

  const ajenos = await api('/api/admin/puntos', { token: op.token, condominio: 'mirador' });
  assert.ok(ajenos.datos.length && ajenos.datos.every(p => p.condominioId === 'mirador'));
  const creado = await api('/api/admin/puntos', {
    metodo: 'POST', token: op.token, condominio: 'mirador', cuerpo: { nombre: 'Bodega operación' }
  });
  assert.equal(creado.datos.condominioId, 'mirador');
  const ubicado = await api(`/api/admin/puntos/${creado.datos.id}`, {
    metodo: 'PUT', token: op.token, condominio: 'mirador', cuerpo: { lat: -33.41, lon: -70.6 }
  });
  assert.equal(ubicado.status, 200);
  await api(`/api/admin/puntos/${creado.datos.id}`, { metodo: 'DELETE', token: op.token, condominio: 'mirador' });

  // Cierra rondas de otro condominio, pero solo parada en ese condominio.
  const jorge = await login('jorge', '5555');
  const ejec = await api('/api/ejecuciones', { metodo: 'POST', token: jorge.token, cuerpo: { rondaId: 'ronda-mirador' } });
  const desdeCasa = await api(`/api/ejecuciones/${ejec.datos.id}/cerrar`, { metodo: 'POST', token: op.token });
  assert.equal(desdeCasa.status, 403, 'parada en Los Aromos no toca una ronda de Mirador');
  const informe = await api(`/api/admin/informes/${ejec.datos.id}`, { token: op.token, condominio: 'mirador' });
  assert.equal(informe.status, 200);
  const cierre = await api(`/api/admin/ejecuciones/${ejec.datos.id}/cerrar`, { metodo: 'POST', token: op.token, condominio: 'mirador' });
  assert.equal(cierre.status, 200);

  // Un condominio inventado cae al de casa.
  const inventado = await api('/api/admin/puntos', { token: op.token, condominio: 'no-existe' });
  assert.ok(inventado.datos.every(p => p.condominioId === 'aromos'));
});

test('CU-22: la marca de acceso total no se puede poner por la API', async () => {
  const jefe = await login('fabrica', '87654321');
  const creada = await api('/api/fabrica/condominios/mirador/administradores', {
    metodo: 'POST', token: jefe.token, cuerpo: { usuario: 'intruso', pin: 'Intruso2026', accesoTotal: true }
  });
  assert.equal(creada.status, 201);
  const u = store.db.usuarios.find(x => x.usuario === 'intruso');
  assert.ok(!u.accesoTotal, 'la fábrica no regala acceso total');
  const intruso = await login('intruso', 'Intruso2026');
  const lista = await api('/api/admin/condominios', { token: intruso.token, condominio: 'aromos' });
  assert.deepEqual(lista.datos.condominios.map(c => c.id), ['mirador']);
  await api(`/api/fabrica/administradores/${u.id}`, { metodo: 'DELETE', token: jefe.token });
});

test('CU-20: cada admin guarda los correos del informe de SU condominio', async () => {
  const marta = await login('marta', '1111');   // Los Aromos
  const carmen = await login('carmen', '4444'); // Mirador del Valle

  const vacio = await api('/api/admin/correos-informe', { token: marta.token });
  assert.deepEqual(vacio.datos.correos, [], 'de fábrica no hay correos: no se manda nada');

  // Se aceptan varios separados por comas y se normalizan.
  const guardado = await api('/api/admin/correos-informe', {
    metodo: 'PUT', token: marta.token, cuerpo: { correos: 'Ana@Corredora.cl, comite@correo.cl' }
  });
  assert.equal(guardado.status, 200);
  assert.deepEqual(guardado.datos.correos, ['ana@corredora.cl', 'comite@correo.cl']);

  // Lo que no es correo se rechaza sin pisar lo que ya estaba guardado.
  const malo = await api('/api/admin/correos-informe', {
    metodo: 'PUT', token: marta.token, cuerpo: { correos: 'ana@corredora.cl, pegue-aqui-su-correo' }
  });
  assert.equal(malo.status, 422);
  assert.equal(store.db.condominios.find(c => c.id === 'aromos').correosInforme.length, 2);

  // Carmen no ve ni toca los de Los Aromos.
  const suyo = await api('/api/admin/correos-informe', { token: carmen.token });
  assert.deepEqual(suyo.datos.correos, []);
  await api('/api/admin/correos-informe', {
    metodo: 'PUT', token: carmen.token, cuerpo: { correos: 'carmen@corredora.cl' }
  });
  assert.deepEqual(store.db.condominios.find(c => c.id === 'aromos').correosInforme, ['ana@corredora.cl', 'comite@correo.cl']);
  assert.deepEqual(store.db.condominios.find(c => c.id === 'mirador').correosInforme, ['carmen@corredora.cl']);

  // Vaciar el campo apaga el envío de ese condominio.
  const apagado = await api('/api/admin/correos-informe', { metodo: 'PUT', token: carmen.token, cuerpo: { correos: '' } });
  assert.deepEqual(apagado.datos.correos, []);

  // Sin credenciales de Gmail el envío a demanda avisa en vez de fallar en silencio.
  const sinClave = await api('/api/admin/informe-semanal/enviar', { metodo: 'POST', token: marta.token, cuerpo: {} });
  assert.equal(sinClave.status, 422);
  assert.match(sinClave.datos.error, /GMAIL_CLIENT_ID/);
});

test('permisos: la ejecución de un guardia no la toca otro; guardias no entran al panel', async () => {
  const pedro = await login('pedro', '2222');
  const luis = await login('luis', '3333');

  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const intruso = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
    metodo: 'POST', token: luis.token, cuerpo: { codigo: 'PRT234' }
  });
  assert.equal(intruso.status, 403);

  const panel = await api('/api/admin/puntos', { token: pedro.token });
  assert.equal(panel.status, 403);

  // (se deja abierta para el test del cierre administrativo)
  global.__ejecucionOlvidada = ini.datos.id;
});

test('cierre administrativo de una ronda olvidada + cierre repetido inocuo', async () => {
  const marta = await login('marta', '1111');
  const ejecucionId = global.__ejecucionOlvidada;

  const notifsAntes = store.notificaciones.contar();
  const cierre = await api(`/api/admin/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token: marta.token });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.estado, 'incompleta');
  assert.equal(store.notificaciones.contar(), notifsAntes + 1);
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /cerrada por el administrador/);

  // Cerrar de nuevo no duplica notificaciones ni cambia el resultado.
  const repetido = await api(`/api/admin/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token: marta.token });
  assert.equal(repetido.status, 200);
  assert.equal(store.notificaciones.contar(), notifsAntes + 1);

  // Y escanear sobre una ronda cerrada se rechaza.
  const pedro = await login('pedro', '2222');
  const tarde = await api(`/api/ejecuciones/${ejecucionId}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234' }
  });
  assert.equal(tarde.status, 409);
});

test('CU-15/16/18: el GPS BLOQUEA la marca fuera del radio + presupuesto de error', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');

  // La administradora fija la ubicación real de Portería, midiendo con ±5 m.
  const fijar = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 5 }
  });
  assert.equal(fijar.status, 200);
  assert.equal(fijar.datos.precisionM, 5, 'queda registrado con qué precisión se midió');
  const invalida = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: 999, lon: 0 }
  });
  assert.equal(invalida.status, 422);
  const precisionMala = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 900 }
  });
  assert.equal(precisionMala.status, 422);

  // El paquete que baja el teléfono trae ubicación, calidad de la medición y
  // umbrales: la app aplica el mismo criterio que el servidor, también sin señal.
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  assert.equal(paquete.gps.radioOkM, 20);
  assert.equal(paquete.gps.margenMaxM, 40, 'techo de imprecisión perdonada');
  assert.equal(paquete.gps.precisionMaxM, 100);
  assert.equal(paquete.gps.bloquea, true);
  const puntosExpress = paquete.rondas.find(r => r.id === 'ronda-express').puntos;
  assert.equal(puntosExpress.find(p => p.codigoCorto === 'PRT234').lat, -33.45);
  assert.equal(puntosExpress.find(p => p.codigoCorto === 'PRT234').precisionM, 5);
  assert.equal(puntosExpress.find(p => p.codigoCorto === 'QCH789').lat, null, 'punto sin fijar viaja en null');

  async function marcar(gps) {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', gps }
    });
    return { ejecucionId: ini.datos.id, esc };
  }

  // A ~1,1 km (el QR fotografiado, escaneado desde la caseta): RECHAZADA.
  // Tope = radio 20 + (±5 del punto + ±10 del fix) = 35 m.
  const lejos = await marcar({ lat: -33.46, lon: -70.66, acc: 10 });
  assert.equal(lejos.esc.status, 422);
  assert.match(lejos.esc.datos.error, /Estás a 11\d\d m de "Portería"/);
  assert.equal(lejos.esc.datos.presencia.ok, false);
  assert.equal(lejos.esc.datos.presencia.topeM, 35);

  // EL BUG DE v1.12: parado sobre el punto, pero con señal mediocre (±25 m), la
  // distancia medida da 30 m. Antes se rechazaba con un tope de 20 m clavado —
  // matemáticamente imposible de cumplir con dos medidas de esa calidad. Ahora
  // el tope acompaña a la señal: 20 + (5 + 25) = 50 m. ACEPTADA.
  const senalMediocre = await marcar({ lat: -33.45027, lon: -70.66, acc: 25 });
  assert.equal(senalMediocre.esc.status, 200, 'la imprecisión declarada se perdona');

  // Pero el margen no es un cheque en blanco: a ~56 m con la MISMA señal
  // mediocre (tope 50) sigue rechazada.
  const masLejos = await marcar({ lat: -33.4505, lon: -70.66, acc: 25 });
  assert.equal(masLejos.esc.status, 422);
  assert.equal(masLejos.esc.datos.presencia.distanciaM, 56);
  assert.equal(masLejos.esc.datos.presencia.topeM, 50);

  // Un fix de WiFi/antena (±300 m) no sirve para decidir NADA: con esa medida la
  // distancia es ruido. Se rechaza aunque las coordenadas caigan sobre el punto,
  // porque también dejaría pasar una marca hecha a dos cuadras.
  const impreciso = await marcar({ lat: -33.45, lon: -70.66, acc: 300 });
  assert.equal(impreciso.esc.status, 422);
  assert.match(impreciso.esc.datos.error, /demasiado imprecisa \(±300 m\)/);
  assert.equal(impreciso.esc.datos.presencia.impreciso, true);

  // Apagar la ubicación era el atajo obvio para saltarse el control: también se
  // rechaza, igual que un GPS inventado.
  const sinGps = await marcar(null);
  assert.equal(sinGps.esc.status, 422);
  assert.match(sinGps.esc.datos.error, /Sin señal GPS/);
  assert.equal(sinGps.esc.datos.presencia.sinGps, true);
  const basura = await marcar({ lat: 'no', lon: {} });
  assert.equal(basura.esc.status, 422);

  // A ~11 m del punto: ACEPTADA, y el informe sale sin observaciones de GPS.
  const cerca = await marcar({ lat: -33.4501, lon: -70.66, acc: 8 });
  assert.equal(cerca.esc.status, 200);
  const cierre = await api(`/api/ejecuciones/${cerca.ejecucionId}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(cierre.datos.evaluacion.gpsLejos.length, 0);
  assert.equal(cierre.datos.evaluacion.sinGps.length, 0);
  const detalle = cierre.datos.detalle.find(d => d.puntoId === 'p-porteria');
  assert.equal(detalle.lejos, false);
  assert.equal(detalle.distanciaM, 11);

  // Un punto SIN ubicación fijada (los de bajo techo) se marca como siempre,
  // incluso sin GPS: es la válvula de escape para donde la señal no llega.
  const otro = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const quincho = await api(`/api/ejecuciones/${otro.datos.id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'QCH789', gps: null }
  });
  assert.equal(quincho.status, 200, 'sin ubicación fijada no hay nada que verificar');

  // Reintento idempotente de la cola offline: el mismo evento reenviado cuando
  // el guardia ya se alejó NO se re-verifica, sale por duplicado.
  const reenvio = await api(`/api/ejecuciones/${cerca.ejecucionId}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', gps: { lat: -33.46, lon: -70.66 } }
  });
  assert.equal(reenvio.status, 409, 'la ronda ya está cerrada');

  const abierta = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  await api(`/api/ejecuciones/${abierta.datos.id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', gps: { lat: -33.4501, lon: -70.66, acc: 8 } }
  });
  const duplicado = await api(`/api/ejecuciones/${abierta.datos.id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234', gps: { lat: -33.46, lon: -70.66, acc: 8 } }
  });
  assert.equal(duplicado.status, 200, 'reenvío desde lejos del mismo punto ya marcado: idempotente');
  assert.equal(duplicado.datos.duplicado, true);

  // Limpiar: quitar la ubicación para no afectar otros escenarios.
  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
});

test('push: ronda incompleta → notificación al teléfono del admin suscrito', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');

  // Solo administradores; una suscripción malformada se rechaza.
  const comoGuardia = await api('/api/admin/push/clave', { token: pedro.token });
  assert.equal(comoGuardia.status, 403);
  const malformada = await api('/api/admin/push/suscribir', {
    metodo: 'POST', token: marta.token, cuerpo: { suscripcion: { endpoint: 'http://inseguro' } }
  });
  assert.equal(malformada.status, 422);

  // La clave pública VAPID se genera sola y es estable entre llamadas.
  const clave = await api('/api/admin/push/clave', { token: marta.token });
  assert.equal(clave.status, 200);
  assert.ok(clave.datos.clave.length > 20);
  const clave2 = await api('/api/admin/push/clave', { token: marta.token });
  assert.equal(clave2.datos.clave, clave.datos.clave);

  // Marta suscribe su teléfono.
  const suscripcion = { endpoint: 'https://push.ejemplo/marta-1', keys: { p256dh: 'clave-p256', auth: 'clave-auth' } };
  const alta = await api('/api/admin/push/suscribir', { metodo: 'POST', token: marta.token, cuerpo: { suscripcion } });
  assert.equal(alta.status, 201);

  // Pedro cierra la express con 1 de 4 puntos → push con su nombre y los faltantes.
  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, { metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234' } });
  const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(cierre.datos.estado, 'incompleta');

  assert.equal(pushEnviados.length, 1);
  assert.equal(pushEnviados[0].suscripcion.endpoint, suscripcion.endpoint);
  const payload = JSON.parse(pushEnviados[0].payload);
  assert.match(payload.titulo, /Ronda incompleta — Pedro Soto/);
  assert.match(payload.cuerpo, /3 de 4 puntos sin marcar/);
  assert.match(payload.cuerpo, /Quincho/);
  assert.equal(payload.url, `informe.html?id=${ini.datos.id}`);

  // Queda constancia en la pestaña Avisos.
  const registro = store.notificaciones.ultimas('aromos', 1)[0];
  assert.equal(registro.medio, 'push');
  assert.equal(registro.enviada, true);
  assert.deepEqual(registro.dispositivos, { ok: 1, total: 1 });

  // Una ronda completa NO manda push (el informe normal sigue llegando al registro).
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');
  const ini2 = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const baseOk = Date.now() - 20 * 60000;
  for (const [i, punto] of express.puntos.entries()) {
    await api(`/api/ejecuciones/${ini2.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: { codigo: punto.payload, ts: new Date(baseOk + i * 4 * 60000).toISOString() }
    });
  }
  const completa = await api(`/api/ejecuciones/${ini2.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(completa.datos.estado, 'completa');
  assert.equal(pushEnviados.length, 1);

  // Baja del dispositivo: la siguiente incompleta ya no llega.
  await api('/api/admin/push/suscribir', { metodo: 'DELETE', token: marta.token, cuerpo: { endpoint: suscripcion.endpoint } });
  const ini3 = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const cierre3 = await api(`/api/ejecuciones/${ini3.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(cierre3.datos.estado, 'incompleta');
  assert.equal(pushEnviados.length, 1);
});

// ---------- CU-17: antifraude (control de tiempo + GPS fuerte) ----------
// El fraude que ataca: el guardia le saca foto a todos los QR y los escanea
// desde el sillón. Dos capas independientes lo delatan.

// ---------- CU-19: puntos bajo techo (verificación por entrada) ----------
// El problema: el cliente tiene puntos en subterráneos y salas de calderas donde
// el GPS no llega, así que el radio de 20 m es imposible de cumplir. La solución
// no es dejarlos sin verificar: se fija la ENTRADA del recinto y se acepta el fix
// que el teléfono tomó al pasar por ahí, hasta 15 min antes.

test('CU-19: anclaje — acepta el fix tomado en la entrada y rechaza el resto', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');

  // "Sala de bombas" pasa a verificarse por entrada.
  const fijar = await api('/api/admin/puntos/p-bombas', {
    metodo: 'PUT', token: marta.token,
    cuerpo: { lat: -33.45, lon: -70.66, verificacion: 'anclaje' }
  });
  assert.equal(fijar.status, 200);
  assert.equal(fijar.datos.verificacion, 'anclaje');

  // El teléfono recibe el modo y los umbrales del punto, no solo los globales.
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const bombas = paquete.rondas.find(r => r.id === 'ronda-nocturna').puntos.find(p => p.codigoCorto === 'BMB892');
  assert.equal(bombas.verificacion, 'anclaje');
  assert.equal(bombas.radioM, 40, 'radio de ancla más generoso que los 20 m exactos');
  assert.equal(bombas.ventanaMs, 15 * 60000);
  const porteria = paquete.rondas.find(r => r.id === 'ronda-nocturna').puntos.find(p => p.codigoCorto === 'PRT234');
  assert.equal(porteria.verificacion, 'ninguna', 'los demás puntos siguen sin verificación');

  async function marcar(gps) {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-nocturna' } });
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'BMB892', gps }
    });
    return { ejecucionId: ini.datos.id, esc };
  }

  // El caso real: pasó por la entrada, bajó al subterráneo, marcó 4 min después.
  const bajoTecho = await marcar({ lat: -33.4501, lon: -70.66, acc: 12, edadMs: 4 * 60000 });
  assert.equal(bajoTecho.esc.status, 200, 'el fix rezagado de la entrada sirve');

  // A 35 m de la entrada sigue dentro del radio de ancla (40 m).
  const enElPorche = await marcar({ lat: -33.450315, lon: -70.66, acc: 15, edadMs: 60000 });
  assert.equal(enElPorche.esc.status, 200);

  // Pasó por la entrada, pero hace 20 min: fuera de ventana.
  const vencido = await marcar({ lat: -33.4501, lon: -70.66, acc: 12, edadMs: 20 * 60000 });
  assert.equal(vencido.esc.status, 422);
  assert.match(vencido.esc.datos.error, /hace 20 min/);
  assert.equal(vencido.esc.datos.presencia.vencido, true);

  // Nunca pasó por la entrada: marca desde 780 m con señal perfecta.
  const desdeLaCaseta = await marcar({ lat: -33.457, lon: -70.66, acc: 5, edadMs: 2000 });
  assert.equal(desdeLaCaseta.esc.status, 422);
  assert.match(desdeLaCaseta.esc.datos.error, /de la entrada/);
  assert.ok(desdeLaCaseta.esc.datos.presencia.distanciaM > 700);

  // Sin ubicación: no hay nada que respalde la marca.
  const sinGps = await marcar(null);
  assert.equal(sinGps.esc.status, 422);
  assert.equal(sinGps.esc.datos.presencia.sinGps, true);

  // App vieja que no informa la antigüedad del fix: en un punto anclado la edad
  // ES el control, así que no se acepta a ciegas.
  const sinEdad = await marcar({ lat: -33.4501, lon: -70.66, acc: 12 });
  assert.equal(sinEdad.esc.status, 422);
  assert.match(sinEdad.esc.datos.error, /Actualiza la app/);

  // El informe no miente: la distancia es a la entrada y la marca se etiqueta.
  const cierre = await api(`/api/ejecuciones/${bajoTecho.ejecucionId}/cerrar`, { metodo: 'POST', token: pedro.token });
  const detalle = cierre.datos.detalle.find(d => d.puntoId === 'p-bombas');
  assert.equal(detalle.anclado, true);
  assert.equal(detalle.lejos, false);
  assert.equal(detalle.edadGpsMs, 4 * 60000);
  assert.equal(cierre.datos.evaluacion.gpsLejos.length, 0);

  await api('/api/admin/puntos/p-bombas', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
  const limpio = await api('/api/admin/puntos', { token: marta.token });
  const yaNo = limpio.datos.find(p => p.id === 'p-bombas');
  assert.equal(yaNo.lat, null);
  assert.equal(yaNo.verificacion, undefined, 'quitar la ubicación limpia también el modo');
});

test('CU-19: radio y ventana propios del punto mandan sobre los defaults', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  await api('/api/admin/puntos/p-bombas', {
    metodo: 'PUT', token: marta.token,
    cuerpo: { lat: -33.45, lon: -70.66, verificacion: 'anclaje', radioM: 25, ventanaMin: 3 }
  });

  async function marcar(gps) {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-nocturna' } });
    return api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'BMB892', gps }
    });
  }

  // A 62 m: pasaba con el radio por defecto (40 + 30 de margen = 70), no con 25
  // (25 + 30 = 55). El radio propio del punto es el que manda.
  assert.equal((await marcar({ lat: -33.45056, lon: -70.66, acc: 15, edadMs: 60000 })).status, 422);
  // A 11 m y 4 min: pasaba con la ventana por defecto (15 min), no con 3.
  assert.equal((await marcar({ lat: -33.4501, lon: -70.66, acc: 12, edadMs: 4 * 60000 })).status, 422);
  // A 11 m y 2 min: dentro de los dos umbrales apretados.
  assert.equal((await marcar({ lat: -33.4501, lon: -70.66, acc: 12, edadMs: 2 * 60000 })).status, 200);

  // Validaciones del panel.
  const modoMalo = await api('/api/admin/puntos/p-bombas', {
    metodo: 'PUT', token: marta.token, cuerpo: { verificacion: 'magia' }
  });
  assert.equal(modoMalo.status, 422);
  const radioMalo = await api('/api/admin/puntos/p-bombas', {
    metodo: 'PUT', token: marta.token, cuerpo: { radioM: 9000 }
  });
  assert.equal(radioMalo.status, 422);

  // Vaciar el campo vuelve al default del entorno.
  const reset = await api('/api/admin/puntos/p-bombas', {
    metodo: 'PUT', token: marta.token, cuerpo: { radioM: null, ventanaMin: null }
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.datos.radioM, undefined);
  assert.equal((await marcar({ lat: -33.45056, lon: -70.66, acc: 15, edadMs: 60000 })).status, 200);

  await api('/api/admin/puntos/p-bombas', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
});

test('CU-17: marcas en ráfaga → ronda SOSPECHOSA + aviso al admin', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');

  const suscripcion = { endpoint: 'https://push.ejemplo/marta-cu17', keys: { p256dh: 'clave-p256', auth: 'clave-auth' } };
  await api('/api/admin/push/suscribir', { metodo: 'POST', token: marta.token, cuerpo: { suscripcion } });
  const pushAntes = pushEnviados.length;

  // El fraude: los 4 puntos marcados con 3 segundos de diferencia.
  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const base = Date.now();
  for (const [i, punto] of express.puntos.entries()) {
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: { codigo: punto.payload, ts: new Date(base + i * 3000).toISOString() }
    });
    assert.equal(esc.status, 200, 'el control de tiempo nunca bloquea la marca');
  }
  const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });

  // Marcó todos los puntos, pero la ronda no es creíble.
  assert.equal(cierre.datos.evaluacion.faltantes.length, 0);
  assert.equal(cierre.datos.estado, 'sospechosa');
  assert.ok(cierre.datos.evaluacion.rafaga >= 2);
  assert.ok(cierre.datos.evaluacion.sospechas.some(s => /segundos/.test(s)));
  assert.ok(store.notificaciones.ultimas('aromos', 50).some(n => /ALERTA: ronda con datos sospechosos/.test(n.texto)));

  // Y le suena el teléfono al administrador con el motivo.
  assert.equal(pushEnviados.length, pushAntes + 1);
  const payload = JSON.parse(pushEnviados.at(-1).payload);
  assert.match(payload.titulo, /Ronda sospechosa — Pedro Soto/);
  assert.match(payload.cuerpo, /segundos/);
  assert.equal(payload.url, `informe.html?id=${ini.datos.id}`);

  await api('/api/admin/push/suscribir', { metodo: 'DELETE', token: marta.token, cuerpo: { endpoint: suscripcion.endpoint } });
});

test('CU-17: GPS fuerte — la marca que se cuela igual queda SOSPECHOSA en el informe', async () => {
  // Con el bloqueo activo estas marcas ya no entran escaneando. Siguen llegando
  // por un camino real: el administrador fija la ubicación DESPUÉS de que la
  // ronda se caminó (día de la instalación). Ahí la detección sigue siendo la
  // que delata al guardia, así que se mantiene cubierta.
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');

  // Portería arranca SIN ubicación: las marcas pasan sin verificación.
  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });

  // Ronda completa y bien espaciada; solo cambia el GPS de Portería. Se fija la
  // ubicación del punto entre el último escaneo y el cierre.
  async function rondaYLuegoFijar(gpsPorteria) {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    const base = Date.now() - 40 * 60000;
    for (const [i, punto] of express.puntos.entries()) {
      const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
        metodo: 'POST', token: pedro.token,
        cuerpo: {
          codigo: punto.payload,
          ts: new Date(base + i * 4 * 60000).toISOString(),
          gps: punto.nombre === 'Portería' ? gpsPorteria : null
        }
      });
      assert.equal(esc.status, 200, 'sin ubicación fijada la marca entra');
    }
    await api('/api/admin/puntos/p-porteria', {
      metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66 }
    });
    const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
    await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
    return cierre.datos;
  }

  // Marcó con la ubicación apagada justo donde ahora sí se verifica → sospechosa.
  const apagado = await rondaYLuegoFijar(null);
  assert.equal(apagado.evaluacion.faltantes.length, 0);
  assert.equal(apagado.estado, 'sospechosa');
  assert.ok(apagado.evaluacion.sospechas.some(s => /Sin ubicación GPS/.test(s)));

  // Marcó a ~1,1 km del punto → sospechosa, con la distancia.
  const lejos = await rondaYLuegoFijar({ lat: -33.46, lon: -70.66, acc: 10 });
  assert.equal(lejos.estado, 'sospechosa');
  assert.ok(lejos.evaluacion.sospechas.some(s => /lejos del punto/.test(s)));
  assert.ok(lejos.evaluacion.gpsLejos[0].distanciaM > 1000);

  // Estuvo donde tenía que estar → ronda limpia, sin ruido para el admin.
  const cerca = await rondaYLuegoFijar({ lat: -33.4501, lon: -70.66, acc: 10 });
  assert.equal(cerca.estado, 'completa');
  assert.equal(cerca.evaluacion.sospechas.length, 0);
});

test('CU-18: los umbrales de GPS se ajustan por entorno sin tocar código', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66 }
  });

  // Marca a ~30 m con un GPS que declara ±40 m de precisión. El punto se fijó
  // sin registrar la calidad de la medición (como todos los anteriores a v1.13),
  // así que se le asume GPS_PRECISION_SUPUESTA_M = 15.
  async function marcarA30m() {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: { codigo: 'PRT234', gps: { lat: -33.45027, lon: -70.66, acc: 40 } }
    });
    return { ejecucionId: ini.datos.id, esc };
  }

  // Por defecto: 15 + 40 = 55, topado en 40 → tope 60 m. La marca entra, que es
  // exactamente lo que el hardware permite prometer con esa señal.
  assert.equal((await marcarA30m()).esc.status, 200);

  // GPS_MARGEN_MAX_M=0 restaura el radio estricto de v1.9-v1.12 para quien lo
  // quiera: sin perdón de imprecisión, la misma marca se rechaza.
  process.env.GPS_MARGEN_MAX_M = '0';
  try {
    const estricto = await marcarA30m();
    assert.equal(estricto.esc.status, 422, 'sin margen vuelve el radio duro');
    assert.equal(estricto.esc.datos.presencia.topeM, 20);
    const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
    assert.equal(paquete.gps.margenMaxM, 0, 'el teléfono recibe el mismo umbral');
  } finally {
    delete process.env.GPS_MARGEN_MAX_M;
  }

  // GPS_BLOQUEA=0 es la marcha atrás: vuelve a observar en vez de rechazar.
  // Se usa una marca a ~1,1 km, lejos de cualquier margen razonable.
  async function marcarLejos() {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    const esc = await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: { codigo: 'PRT234', gps: { lat: -33.46, lon: -70.66, acc: 40 } }
    });
    return { ejecucionId: ini.datos.id, esc };
  }
  assert.equal((await marcarLejos()).esc.status, 422, 'con el bloqueo puesto, no entra');

  process.env.GPS_BLOQUEA = '0';
  let ejecucionId;
  try {
    const permisivo = await marcarLejos();
    ejecucionId = permisivo.ejecucionId;
    assert.equal(permisivo.esc.status, 200, 'con GPS_BLOQUEA=0 la marca no se rechaza');
  } finally {
    delete process.env.GPS_BLOQUEA;
  }
  // El informe se evalúa con el bloqueo ya restaurado: la marca queda acusada.
  const cierre = await api(`/api/ejecuciones/${ejecucionId}/cerrar`, { metodo: 'POST', token: pedro.token });
  assert.equal(cierre.datos.evaluacion.gpsLejos.length, 1);
  assert.ok(cierre.datos.evaluacion.gpsLejos[0].distanciaM > 1000);
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /LEJOS del punto/.test(o)));

  // Y el bloqueo volvió solo.
  assert.equal((await marcarLejos()).esc.status, 422);

  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
});

// ---------- CU-23: calidad de la medición del punto (v1.13) ----------
// El origen del "acércate al punto" estando encima del punto: el panel fijaba la
// ubicación con UNA lectura de GPS, que en frío viene de WiFi o antena con
// decenas de metros de error, y esa coordenada quedaba como la verdad del punto.
// Ahora el panel mide varios segundos y guarda con qué precisión lo logró.

test('CU-23: la precisión con que se midió el punto entra en el presupuesto', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');

  async function marcarA30m() {
    const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
    return api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: { codigo: 'PRT234', gps: { lat: -33.45027, lon: -70.66, acc: 5 } }
    });
  }

  // Punto medido BIEN (±3 m) + teléfono con buena señal (±5 m): tope 28 m. Una
  // marca a 30 m no tiene excusa y se rechaza. La exigencia sigue existiendo.
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 3 }
  });
  const conBuenPunto = await marcarA30m();
  assert.equal(conBuenPunto.status, 422);
  assert.equal(conBuenPunto.datos.presencia.topeM, 28);

  // El MISMO punto medido mal (±40 m): el sistema sabe que su coordenada es
  // dudosa y afloja el tope a 20 + 40 = 60 m. La misma marca ahora entra: el
  // guardia no puede pagar el error de medición del administrador.
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 40 }
  });
  assert.equal((await marcarA30m()).status, 200);

  // Volver a fijar sin informar precisión NO hereda la anterior: la calidad de
  // la medición vieja no dice nada de la coordenada nueva.
  const reFijado = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66 }
  });
  assert.equal(reFijado.datos.precisionM, undefined);
  // Sin dato se asume ±15 m → tope 20 + 15 + 5 = 40 m: la marca a 30 m entra.
  assert.equal((await marcarA30m()).status, 200);

  // Un 422 de validación no puede dejar el punto a medio escribir.
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 8 }
  });
  const rechazado = await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.44, lon: -70.65, precisionM: -3 }
  });
  assert.equal(rechazado.status, 422);
  const puntos = await api('/api/admin/puntos', { token: marta.token });
  const porteria = puntos.datos.find(p => p.id === 'p-porteria');
  assert.equal(porteria.lat, -33.45, 'la ubicación anterior sigue intacta');
  assert.equal(porteria.precisionM, 8);

  // Quitar la ubicación limpia también la precisión.
  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
  const limpio = await api('/api/admin/puntos', { token: marta.token });
  assert.equal(limpio.datos.find(p => p.id === 'p-porteria').precisionM, undefined);
});

test('CU-23: señal imprecisa se informa, pero no acusa al guardia', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 5 }
  });

  // Con el bloqueo puesto la marca imprecisa ni entra. Llega a la base por el
  // mismo camino que las demás no verificadas: ubicación fijada DESPUÉS de la
  // ronda. Ahí el informe tiene que distinguir "no había señal buena" de "apagó
  // el GPS": lo primero es del edificio, lo segundo huele a fraude.
  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
  const ini = await api('/api/ejecuciones', { metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' } });
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');
  const base = Date.now() - 30 * 60000;
  for (const [i, punto] of express.puntos.entries()) {
    await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, {
      metodo: 'POST', token: pedro.token,
      cuerpo: {
        codigo: punto.payload,
        ts: new Date(base + i * 5 * 60000).toISOString(),
        gps: punto.nombre === 'Portería' ? { lat: -33.45, lon: -70.66, acc: 450 } : null
      }
    });
  }
  await api('/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.45, lon: -70.66, precisionM: 5 }
  });
  const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });

  assert.equal(cierre.datos.evaluacion.gpsImpreciso.length, 1);
  assert.equal(cierre.datos.evaluacion.gpsImpreciso[0].precisionM, 450);
  assert.equal(cierre.datos.evaluacion.sinGps.length, 0, 'hubo ubicación: no es lo mismo que apagarla');
  assert.ok(cierre.datos.evaluacion.observaciones.some(o => /demasiado imprecisa/.test(o)));
  assert.equal(cierre.datos.evaluacion.sospechas.length, 0, 'la señal mala no es una acusación');
  assert.equal(cierre.datos.estado, 'completa_obs');

  await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true } });
});

test('CU-17: duración mínima por ronda — cerrarla muy rápido es SOSPECHOSA', async () => {
  const marta = await login('marta', '1111');
  const pedro = await login('pedro', '2222');
  const puntos = await api('/api/admin/puntos', { token: marta.token });
  const idDe = nombre => puntos.datos.find(p => p.nombre === nombre).id;

  // Validaciones del campo nuevo.
  const negativa = await api('/api/admin/rondas', {
    metodo: 'POST', token: marta.token,
    cuerpo: { nombre: 'Mala', puntoIds: [idDe('Portería')], duracionMinMin: -5 }
  });
  assert.equal(negativa.status, 422);
  const cruzada = await api('/api/admin/rondas', {
    metodo: 'POST', token: marta.token,
    cuerpo: { nombre: 'Cruzada', puntoIds: [idDe('Portería')], duracionMaxMin: 10, duracionMinMin: 20 }
  });
  assert.equal(cruzada.status, 422);
  assert.match(cruzada.datos.error, /mínima debe ser menor/);

  // Ronda de 2 puntos que no puede tomar menos de 30 min.
  const ronda = await api('/api/admin/rondas', {
    metodo: 'POST', token: marta.token,
    cuerpo: { nombre: 'Con mínimo', puntoIds: [idDe('Portería'), idDe('Quincho')], duracionMinMin: 30 }
  });
  assert.equal(ronda.status, 201);
  assert.equal(ronda.datos.duracionMinMin, 30);

  // El guardia la marca completa y la cierra a los 2 minutos.
  const inicio = new Date(Date.now() - 2 * 60000).toISOString();
  const ini = await api('/api/ejecuciones', {
    metodo: 'POST', token: pedro.token, cuerpo: { rondaId: ronda.datos.id, inicio }
  });
  await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, { metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'PRT234' } });
  await api(`/api/ejecuciones/${ini.datos.id}/escaneos`, { metodo: 'POST', token: pedro.token, cuerpo: { codigo: 'QCH789' } });
  const cierre = await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });

  assert.equal(cierre.datos.evaluacion.faltantes.length, 0);
  assert.equal(cierre.datos.evaluacion.duracionMin, 2);
  assert.equal(cierre.datos.estado, 'sospechosa');
  assert.ok(cierre.datos.evaluacion.sospechas.some(s => /demasiado rápida/.test(s)));

  await api(`/api/admin/rondas/${ronda.datos.id}`, { metodo: 'DELETE', token: marta.token });
});

// ---------- CU-21: fábrica (alta de condominios y cuentas de panel) ----------

test('CU-21: el alta no crea cuenta de panel, y el condominio queda operable', async () => {
  const jefe = await login('fabrica', '87654321');

  const alta = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: { nombre: 'Condominio Vista Sur', correos: 'ana@corredora.cl' }
  });
  assert.equal(alta.status, 201);
  assert.equal(alta.datos.admin, null, 'sin cuenta de panel: una por condominio no aporta y abre todo');
  assert.equal(alta.datos.pin, null);
  assert.deepEqual(alta.datos.condominio.correosInforme, ['ana@corredora.cl']);
  assert.ok(!store.db.usuarios.some(u => u.condominioId === alta.datos.condominio.id));

  // Y aun así se puede operar: la cuenta de acceso total lo elige en el selector.
  const op = await login('operacion', PIN_TOTAL);
  const cual = alta.datos.condominio.id;
  const lista = await api('/api/admin/condominios', { token: op.token });
  assert.ok(lista.datos.condominios.some(c => c.id === cual), 'aparece en el selector del panel');
  const punto = await api('/api/admin/puntos', {
    metodo: 'POST', token: op.token, condominio: cual, cuerpo: { nombre: 'Portería Vista Sur' }
  });
  assert.equal(punto.status, 201);
  const suyos = await api('/api/admin/puntos', { token: op.token, condominio: cual });
  assert.equal(suyos.datos.length, 1);

  // Un admin normal no lo ve.
  const marta = await login('marta', '1111');
  const deMarta = await api('/api/admin/condominios', { token: marta.token });
  assert.ok(!deMarta.datos.condominios.some(c => c.id === cual));
});

test('CU-21: la fábrica quita cuentas de panel, pero nunca la última', async () => {
  const jefe = await login('fabrica', '87654321');

  // Una cuenta de más (el caso del cliente que quería su panel y ya no).
  const creada = await api('/api/fabrica/condominios/aromos/administradores', {
    metodo: 'POST', token: jefe.token, cuerpo: { usuario: 'admin-temporal', pin: 'Temporal1357' }
  });
  assert.equal(creada.status, 201);
  const quien = creada.datos.admin.id;

  const fuera = await api(`/api/fabrica/administradores/${quien}`, { metodo: 'DELETE', token: jefe.token });
  assert.equal(fuera.status, 200);
  assert.ok(!store.db.usuarios.some(u => u.id === quien), 'la cuenta ya no existe');
  const yaNoEntra = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin-temporal', pin: 'Temporal1357' } });
  assert.equal(yaNoEntra.status, 401);

  // Los datos del condominio no se tocan al quitar una cuenta.
  assert.ok(store.db.puntos.some(p => p.condominioId === 'aromos'));

  // La de acceso total tampoco: la maneja el entorno.
  const total = store.db.usuarios.find(u => u.accesoTotal);
  const listado = await api('/api/fabrica/condominios', { token: jefe.token });
  const enFicha = listado.datos.condominios.flatMap(c => c.administradores).find(a => a.id === total.id);
  assert.equal(enFicha.accesoTotal, true, 'la fábrica la ve marcada');
  const noTotal = await api(`/api/fabrica/administradores/${total.id}`, { metodo: 'DELETE', token: jefe.token });
  assert.equal(noTotal.status, 409);
  assert.match(noTotal.datos.error, /acceso total/);
  assert.ok(store.db.usuarios.some(u => u.id === total.id));

  // Y la última cuenta de panel no se puede borrar: sería quedarse afuera.
  const idsAdmin = store.db.usuarios.filter(u => u.rol === 'admin').map(u => u.id);
  const respaldo = store.db.usuarios.filter(u => idsAdmin.includes(u.id)).map(u => ({ ...u }));
  store.db.usuarios = store.db.usuarios.filter(u => u.rol !== 'admin' || u.id === idsAdmin[0]);
  const ultima = await api(`/api/fabrica/administradores/${idsAdmin[0]}`, { metodo: 'DELETE', token: jefe.token });
  assert.equal(ultima.status, 409);
  assert.match(ultima.datos.error, /última cuenta de panel/);
  // Se devuelven las cuentas que los otros tests usan.
  for (const u of respaldo) if (!store.db.usuarios.some(x => x.id === u.id)) store.db.usuarios.push(u);
});

test('CU-21: la fábrica da de alta un condominio con cuenta de panel (opcional)', async () => {
  const jefe = await login('fabrica', '87654321');
  assert.equal(jefe.rol, 'fabrica');

  const alta = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: {
      nombre: 'Condominio Portal Ñuñoa',
      adminUsuario: 'ana-portal',
      adminPin: 'Portal4821x',
      correos: 'Ana@Corredora.cl, comite@correo.cl'
    }
  });
  assert.equal(alta.status, 201);
  assert.equal(alta.datos.condominio.id, 'condominio-portal-nunoa', 'el id sale del nombre, sin tildes ni eñes');
  assert.equal(alta.datos.pin, 'Portal4821x', 'devuelve el PIN para dictárselo al administrador');
  assert.match(alta.datos.condominio.codigoRegistro, /^[A-Z2-9]{6}$/, 'código de registro generado solo');
  assert.deepEqual(alta.datos.condominio.correosInforme, ['ana@corredora.cl', 'comite@correo.cl']);

  // La cuenta creada entra al panel y ve su condominio vacío, no el de otros.
  const ana = await login('ana-portal', 'Portal4821x');
  assert.equal(ana.rol, 'admin');
  assert.equal(ana.condominio.nombre, 'Condominio Portal Ñuñoa');
  const puntos = await api('/api/admin/puntos', { token: ana.token });
  assert.deepEqual(puntos.datos, []);
  const correos = await api('/api/admin/correos-informe', { token: ana.token });
  assert.deepEqual(correos.datos.correos, ['ana@corredora.cl', 'comite@correo.cl'], 'ya quedó con su correo cargado');

  // Sus guardias pueden registrarse solos con el código generado.
  const guardia = await api('/api/registro', {
    metodo: 'POST',
    cuerpo: {
      condominioId: alta.datos.condominio.id,
      usuario: 'guardia-portal', pin: '9876', nombre: 'Guardia Portal',
      codigo: alta.datos.condominio.codigoRegistro
    }
  });
  assert.equal(guardia.status, 201);
});

test('CU-21: el alta rechaza duplicados y datos malos sin tocar la base', async () => {
  const jefe = await login('fabrica', '87654321');
  const condominiosAntes = store.db.condominios.length;

  const repetido = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: { nombre: 'Condominio Los Aromos', adminUsuario: 'otro-admin', adminPin: '1234' }
  });
  assert.equal(repetido.status, 409, 'nombre de condominio repetido');

  const usuarioTomado = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: { nombre: 'Condominio Nuevo Uno', adminUsuario: 'marta', adminPin: '1234' }
  });
  assert.equal(usuarioTomado.status, 409, 'usuario ya existente');

  const pinCorto = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: { nombre: 'Condominio Nuevo Dos', adminUsuario: 'admin-dos', adminPin: '12' }
  });
  assert.equal(pinCorto.status, 422);

  const correoMalo = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token,
    cuerpo: { nombre: 'Condominio Nuevo Tres', adminUsuario: 'admin-tres', adminPin: '1234', correos: 'pegue-aqui' }
  });
  assert.equal(correoMalo.status, 422);

  assert.equal(store.db.condominios.length, condominiosAntes, 'ningún alta a medias');
  assert.ok(!store.db.usuarios.some(u => u.usuario === 'admin-dos' || u.usuario === 'admin-tres'));
});

test('CU-21: la fábrica y los administradores no se pisan (roles aislados)', async () => {
  const jefe = await login('fabrica', '87654321');
  const marta = await login('marta', '1111');

  // La fábrica no ve ni toca los datos de ningún condominio.
  for (const ruta of ['/api/admin/puntos', '/api/admin/ejecuciones', '/api/admin/guardias']) {
    const r = await api(ruta, { token: jefe.token });
    assert.equal(r.status, 403, `la fábrica no entra a ${ruta}`);
  }
  // Y un administrador no puede crear condominios ni cuentas.
  const intento = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: marta.token,
    cuerpo: { nombre: 'Condominio Pirata', adminUsuario: 'pirata', adminPin: '1234' }
  });
  assert.equal(intento.status, 403);
  const listar = await api('/api/fabrica/condominios', { token: marta.token });
  assert.equal(listar.status, 403);
  assert.ok(!store.db.condominios.some(c => c.nombre === 'Condominio Pirata'));
});

test('CU-21: la fábrica carga correos y cambia el PIN de un administrador', async () => {
  const jefe = await login('fabrica', '87654321');
  const lista = await api('/api/fabrica/condominios', { token: jefe.token });
  const aromos = lista.datos.condominios.find(c => c.id === 'aromos');
  assert.ok(aromos.administradores.some(a => a.usuario === 'marta'));

  // Carga de correos sin entrar al panel del administrador.
  const correos = await api('/api/fabrica/condominios/aromos/correos', {
    metodo: 'PUT', token: jefe.token, cuerpo: { correos: 'jefe@corredora.cl' }
  });
  assert.deepEqual(correos.datos.correos, ['jefe@corredora.cl']);

  // Cambio de PIN: el viejo deja de servir y la sesión abierta se cierra.
  const marta = await login('marta', '1111');
  const martaId = aromos.administradores.find(a => a.usuario === 'marta').id;
  // PIN de admin solo numérico: ya no sirve (8 a 32 letras y números).
  const soloNumeros = await api(`/api/fabrica/administradores/${martaId}/pin`, {
    metodo: 'PUT', token: jefe.token, cuerpo: { pin: '55667788' }
  });
  assert.equal(soloNumeros.status, 422);
  const cambio = await api(`/api/fabrica/administradores/${martaId}/pin`, {
    metodo: 'PUT', token: jefe.token, cuerpo: { pin: 'Marta5566' }
  });
  assert.equal(cambio.status, 200);

  const sesionVieja = await api('/api/admin/puntos', { token: marta.token });
  assert.equal(sesionVieja.status, 401, 'la sesión abierta con el PIN viejo se cerró');
  const pinViejo = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: '1111' } });
  assert.equal(pinViejo.status, 401);
  const pinNuevo = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: 'Marta5566' } });
  assert.equal(pinNuevo.status, 200);

  // Se deja como estaba, que otros tests entran con marta/1111. Ese PIN ya no
  // lo acepta la fábrica: se repone directo en la base (el login no valida
  // formato, por eso las cuentas viejas siguen entrando).
  store.db.usuarios.find(u => u.id === martaId).pinHash = hashPin('1111');
});

test('seguridad: el login bloquea la fuerza bruta tras 5 intentos fallidos', async () => {
  let ultimo;
  for (let i = 0; i < 5; i++) {
    ultimo = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'ana-portal', pin: '0000' } });
    assert.equal(ultimo.status, 401, `intento ${i + 1}: PIN incorrecto`);
  }
  const bloqueado = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'ana-portal', pin: '0000' } });
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.datos.error, /Demasiados intentos/);

  // El bloqueo es por usuario: los demás siguen entrando normalmente.
  const otro = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'pedro', pin: '2222' } });
  assert.equal(otro.status, 200);

  // Y ni con el PIN correcto entra mientras está bloqueado.
  const conElBueno = await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'ana-portal', pin: 'Portal4821x' } });
  assert.equal(conElBueno.status, 429);
});


test('CU-24: los rechazos por GPS quedan registrados (telemetría, no control)', async () => {
  const pedro = await login('pedro', '2222');
  const ini = await api('/api/ejecuciones', {
    metodo: 'POST', token: pedro.token, cuerpo: { rondaId: 'ronda-express' }
  });
  const url = `/api/ejecuciones/${ini.datos.id}/rechazos`;
  const evento = {
    puntoId: 'p-porteria',
    ts: '2026-08-12T03:00:00.000Z',
    motivo: 'Estás a 90 m de "Portería" y el máximo es 45 m',
    distanciaM: 90, topeM: 45, acc: 25, edadMs: 3000
  };

  const primero = await api(url, { metodo: 'POST', token: pedro.token, cuerpo: evento });
  assert.equal(primero.status, 201);
  const guardado = store.ejecuciones.obtener(ini.datos.id).rechazos;
  assert.equal(guardado.length, 1);
  assert.equal(guardado[0].distanciaM, 90);
  assert.equal(guardado[0].topeM, 45);
  assert.equal(guardado[0].acc, 25);

  // La cola del teléfono reenvía hasta que el servidor conteste: el mismo evento
  // dos veces tiene que ser un solo registro, como todo lo demás de esta API.
  const repetido = await api(url, { metodo: 'POST', token: pedro.token, cuerpo: evento });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.datos.repetido, true);
  assert.equal(store.ejecuciones.obtener(ini.datos.id).rechazos.length, 1);

  // Un punto de otro condominio no entra: el registro no es puerta de atrás.
  const ajeno = await api(url, {
    metodo: 'POST', token: pedro.token, cuerpo: { ...evento, puntoId: 'p-inexistente', ts: 'otro' }
  });
  assert.equal(ajeno.status, 422);

  // Y se acepta con la ronda ya cerrada: el rechazo del último punto llega por la
  // cola después del cierre, y es justo el que más interesa no perder.
  await api(`/api/ejecuciones/${ini.datos.id}/cerrar`, { metodo: 'POST', token: pedro.token });
  const tarde = await api(url, {
    metodo: 'POST', token: pedro.token, cuerpo: { ...evento, ts: '2026-08-12T03:05:00.000Z' }
  });
  assert.equal(tarde.status, 201);
  assert.equal(store.ejecuciones.obtener(ini.datos.id).rechazos.length, 2);
});

test('CU-23: la evidencia de la medición viaja con la coordenada y muere con ella', async () => {
  const marta = await login('marta', '1111');
  const medido = await api('/api/admin/puntos/p-quincho', {
    metodo: 'PUT',
    token: marta.token,
    cuerpo: {
      lat: -33.451, lon: -70.661, precisionM: 7,
      muestras: 34, dispersionM: 6, precisionDeclaradaM: 12, medidoConVersion: 'v1.14.0'
    }
  });
  assert.equal(medido.status, 200);
  assert.equal(medido.datos.muestras, 34);
  assert.equal(medido.datos.dispersionM, 6);
  assert.equal(medido.datos.precisionDeclaradaM, 12);
  assert.equal(medido.datos.medidoConVersion, 'v1.14.0');

  // Una app vieja manda solo lat/lon/precisionM: la evidencia de la medición
  // anterior no puede quedar pegada a una coordenada distinta, igual que
  // precisionM. Sin dispersionM el panel lo marca como "conviene re-medir".
  const conAppVieja = await api('/api/admin/puntos/p-quincho', {
    metodo: 'PUT', token: marta.token, cuerpo: { lat: -33.452, lon: -70.662, precisionM: 9 }
  });
  assert.equal(conAppVieja.datos.precisionM, 9);
  assert.equal(conAppVieja.datos.dispersionM, undefined);
  assert.equal(conAppVieja.datos.muestras, undefined);
  assert.equal(conAppVieja.datos.medidoConVersion, undefined);

  // Y quitar la ubicación se lleva todo: no queda calidad huérfana.
  const sinUbicacion = await api('/api/admin/puntos/p-quincho', {
    metodo: 'PUT', token: marta.token, cuerpo: { quitarUbicacion: true }
  });
  assert.equal(sinUbicacion.datos.lat, null);
  assert.equal(sinUbicacion.datos.precisionM, undefined);
  assert.equal(sinUbicacion.datos.dispersionM, undefined);
});

// ---------- Aislamiento entre administradores, PIN alfanumérico, intentos ----------

test('seguridad: el registro bloquea tras 5 códigos malos del condominio, y un acierto limpia', async () => {
  // Condominio propio del test: el bloqueo es por condominio + IP y no debe
  // dejar sin registro a los condominios que usan los otros tests.
  const jefe = await login('fabrica', '87654321');
  const alta = await api('/api/fabrica/condominios', { metodo: 'POST', token: jefe.token, cuerpo: { nombre: 'Condominio Bloqueo' } });
  const cid = alta.datos.condominio.id;
  const bueno = alta.datos.condominio.codigoRegistro;
  const intento = (codigo, usuario = 'nuevo-bloqueo') => api('/api/registro', {
    metodo: 'POST', cuerpo: { condominioId: cid, usuario, pin: '4321', codigo }
  });

  // 4 malos y un acierto: el acierto limpia la cuenta.
  for (let i = 0; i < 4; i++) assert.equal((await intento('MALO00')).status, 403);
  assert.equal((await intento(bueno, 'guardia-limpia')).status, 201);
  for (let i = 0; i < 4; i++) assert.equal((await intento('MALO00')).status, 403, 'volvió a contar desde cero');

  // El 5º malo bloquea; desde ahí ni el código correcto entra.
  assert.equal((await intento('MALO00')).status, 403);
  const bloqueado = await intento(bueno);
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.datos.error, /Demasiados códigos incorrectos/);
  assert.ok(!store.db.usuarios.some(u => u.usuario === 'nuevo-bloqueo'));

  // Es por condominio: los demás siguen registrando.
  const otro = await api('/api/registro', {
    metodo: 'POST', cuerpo: { condominioId: 'mirador', usuario: 'reg-mirador', pin: '4321', codigo: 'MIRADOR' }
  });
  assert.equal(otro.status, 201);
});

test('PIN de administrador: alfanumérico, 8 a 32, distingue mayúsculas', async () => {
  const jefe = await login('fabrica', '87654321');
  const crear = (usuario, pin) => api('/api/fabrica/condominios/mirador/administradores', {
    metodo: 'POST', token: jefe.token, cuerpo: { usuario, pin }
  });

  for (const [pin, por] of [
    ['1234', 'numérico corto'],
    ['12345678', 'solo dígitos'],
    ['abcdefgh', 'solo letras'],
    ['Abc123', 'menos de 8'],
    ['Abcd 1234', 'con espacio'],
    ['Abcd-1234', 'con símbolo'],
    ['A1' + 'x'.repeat(31), 'más de 32']
  ]) {
    const r = await crear('admin-pin-malo', pin);
    assert.equal(r.status, 422, `se rechaza PIN ${por}`);
  }
  assert.ok(!store.db.usuarios.some(u => u.usuario === 'admin-pin-malo'));

  const ok = await crear('admin-alfa', '  ClaveMirador7  ');
  assert.equal(ok.status, 201);
  assert.equal(ok.datos.pin, 'ClaveMirador7', 'se recortan espacios, no se cambian mayúsculas');
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin-alfa', pin: 'ClaveMirador7' } })).status, 200);
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin-alfa', pin: 'clavemirador7' } })).status, 401);
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin-alfa', pin: 'CLAVEMIRADOR7' } })).status, 401);

  // El cambio de PIN desde la fábrica y el alta con cuenta usan la misma regla.
  const adminId = ok.datos.admin.id;
  const cambioMalo = await api(`/api/fabrica/administradores/${adminId}/pin`, { metodo: 'PUT', token: jefe.token, cuerpo: { pin: '87654321' } });
  assert.equal(cambioMalo.status, 422);
  const altaMala = await api('/api/fabrica/condominios', {
    metodo: 'POST', token: jefe.token, cuerpo: { nombre: 'Condominio Pin Corto', adminUsuario: 'pin-corto', adminPin: '4444' }
  });
  assert.equal(altaMala.status, 422);
  assert.ok(!store.db.condominios.some(c => c.nombre === 'Condominio Pin Corto'));

  // Una cuenta vieja con PIN numérico sigue entrando: el login no valida formato.
  assert.equal((await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'carmen', pin: '4444' } })).status, 200);
  await api(`/api/fabrica/administradores/${adminId}`, { metodo: 'DELETE', token: jefe.token });
});

test('PIN de guardia: sigue siendo de 4 a 8 dígitos', async () => {
  const marta = await login('marta', '1111');
  for (const pin of ['Abcd1234', '123', '123456789']) {
    const r = await api('/api/admin/guardias', { metodo: 'POST', token: marta.token, cuerpo: { usuario: 'guardia-pin', pin } });
    assert.equal(r.status, 422, `PIN de guardia "${pin}" se rechaza`);
  }
  const ok = await api('/api/admin/guardias', { metodo: 'POST', token: marta.token, cuerpo: { usuario: 'guardia-pin', pin: '2468' } });
  assert.equal(ok.status, 201);
  const cambioMalo = await api(`/api/admin/guardias/${ok.datos.id}`, { metodo: 'PUT', token: marta.token, cuerpo: { pin: 'abc12345' } });
  assert.equal(cambioMalo.status, 422);
  await api(`/api/admin/guardias/${ok.datos.id}`, { metodo: 'DELETE', token: marta.token });
});

test('seguridad: cambiarle el PIN a un guardia cierra sus sesiones abiertas', async () => {
  const marta = await login('marta', '1111');
  const alta = await api('/api/admin/guardias', { metodo: 'POST', token: marta.token, cuerpo: { usuario: 'guardia-sesion', pin: '1357' } });
  const g = await login('guardia-sesion', '1357');
  assert.equal((await api('/api/mi/paquete', { token: g.token })).status, 200);

  // Cambiar solo el nombre no lo saca.
  await api(`/api/admin/guardias/${alta.datos.id}`, { metodo: 'PUT', token: marta.token, cuerpo: { nombre: 'Otro nombre' } });
  assert.equal((await api('/api/mi/paquete', { token: g.token })).status, 200);

  await api(`/api/admin/guardias/${alta.datos.id}`, { metodo: 'PUT', token: marta.token, cuerpo: { pin: '8642' } });
  assert.equal((await api('/api/mi/paquete', { token: g.token })).status, 401, 'la sesión con el PIN viejo se cerró');
  assert.equal((await api('/api/mi/paquete', { token: marta.token })).status, 200, 'la del admin sigue viva');
  await login('guardia-sesion', '8642');
  await api(`/api/admin/guardias/${alta.datos.id}`, { metodo: 'DELETE', token: marta.token });
});

test('seguridad: un token con forma rara (Bearer __proto__) es 401 y no escribe la base', async () => {
  const original = store.guardar;
  let escrituras = 0;
  store.guardar = () => { escrituras++; };
  try {
    for (const token of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'ABC', 'g'.repeat(48)]) {
      const r = await api('/api/mi/paquete', { token });
      assert.equal(r.status, 401, `token "${token}"`);
    }
  } finally {
    store.guardar = original;
  }
  assert.equal(escrituras, 0, 'ningún request con token inválido reescribe db.json');
});
