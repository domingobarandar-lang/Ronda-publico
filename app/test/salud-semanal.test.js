// Correo de salud de los lunes para la operación (lib/salud-semanal.js): los
// números de /fabrica por condominio, un semáforo arriba, los condominios sin
// rondas y los errores de Sentry. Sale siempre, aunque todo esté bien.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crearStore } = require('../lib/store');
const salud = require('../lib/salud');
const saludSemanal = require('../lib/salud-semanal');
const { lunesDeLaSemana } = require('../lib/programador');

const APP = path.join(__dirname, '..');
const MIN = 60000;
const DIA = 24 * 60 * MIN;
// Lunes 16/11/2026 a las 08:30 de Chile (UTC-3 en verano).
const AHORA = Date.parse('2026-11-16T11:30:00Z');
const iso = t => new Date(t).toISOString();
const silencio = () => {};

const ejec = (id, condominioId, inicio, extra = {}) => ({
  id, rondaId: `r-${condominioId}`, condominioId, guardiaId: 'g1', inicio: iso(inicio), fin: iso(inicio + 20 * MIN),
  estado: 'completa', escaneos: [], evaluacion: null, ...extra
});
const sinUbicacion = () => ({ puntoId: 'p1', ts: iso(AHORA - DIA), motivo: '📍 Sin ubicación (permiso denegado).', distanciaM: null, topeM: null, acc: null, edadMs: null });

// Cuatro condominios: uno sano, uno con GPS fallando, uno que se cortó (tiene
// rondas configuradas y ninguna ronda en la semana) y uno recién dado de alta.
function base() {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-salud-semanal-')), 'rondas.sqlite');
  const store = crearStore(ruta, { log: silencio });
  store.db.condominios.push(
    { id: 'sano', nombre: 'Los Aromos' },
    { id: 'gps', nombre: 'Reserva Norte' },
    { id: 'cortado', nombre: 'El Mirador' },
    { id: 'nuevo', nombre: 'Condominio Nuevo' }
  );
  for (const c of ['sano', 'gps', 'cortado']) {
    store.db.rondas.push({ id: `r-${c}`, condominioId: c, nombre: 'Perímetro', puntoIds: ['p1'] });
  }
  store.guardar();
  for (let i = 0; i < 5; i++) store.ejecuciones.guardar(ejec(`s${i}`, 'sano', AHORA - (i + 1) * DIA));
  store.ejecuciones.guardar(ejec('g0', 'gps', AHORA - DIA, { rechazos: [sinUbicacion(), sinUbicacion()] }));
  store.ejecuciones.guardar(ejec('g1', 'gps', AHORA - 2 * DIA));
  store.ejecuciones.guardar(ejec('g2', 'gps', AHORA - 3 * DIA, { estado: 'incompleta', cierreAutomatico: true }));
  // La última ronda de El Mirador fue hace 10 días: fuera de la ventana.
  store.ejecuciones.guardar(ejec('m0', 'cortado', AHORA - 10 * DIA));
  return { store, ruta };
}

function lector({ porCondominio = {}, sinCondominio = { problemas: 0, lista: [] } } = {}) {
  const pedidos = [];
  return {
    pedidos,
    configurado: true,
    dias: 7,
    deCondominio: async id => { pedidos.push(id); return porCondominio[id] || { problemas: 0, lista: [] }; },
    sinCondominio: async () => sinCondominio
  };
}

const ERROR_SENTRY = {
  problemas: 4,
  lista: [{ titulo: 'TypeError: x is undefined', donde: 'app.js', eventos: 12, ultimaVez: '2026-11-15T23:10:00Z', nivel: 'error', enlace: 'https://sentry.io/issues/1/' }]
};

test('el semáforo: sin rondas es urgente; GPS, cerradas automáticamente y Sentry son para mirar', () => {
  const vacio = { dias: 7, desde: iso(AHORA - 7 * DIA), rondas: { total: 0 }, dificultades: {} };
  assert.deepEqual(saludSemanal.semaforo({ s: vacio, sentry: null, rondasConfiguradas: 2, ultimaRonda: iso(AHORA - 10 * DIA) }),
    { nivel: 'urgente', motivos: ['sin ninguna ronda en 7 días (última: 06-11-2026)'] });
  assert.equal(saludSemanal.semaforo({ s: vacio, sentry: null, rondasConfiguradas: 0 }).nivel, 'mirar', 'recién dado de alta: no es urgente');

  const { store } = base();
  const sano = salud.resumen(store, 'sano', AHORA);
  assert.deepEqual(saludSemanal.semaforo({ s: sano, sentry: { problemas: 0, lista: [] }, rondasConfiguradas: 1 }), { nivel: 'bien', motivos: [] });
  assert.equal(saludSemanal.semaforo({ s: sano, sentry: ERROR_SENTRY, rondasConfiguradas: 1 }).nivel, 'mirar');
  assert.equal(saludSemanal.semaforo({ s: sano, sentry: { error: 'Sentry respondió 500.' }, rondasConfiguradas: 1 }).nivel, 'mirar');

  // 2 de 3 rondas con fallo de la app (67 %): urgente.
  const gps = saludSemanal.semaforo({ s: salud.resumen(store, 'gps', AHORA), sentry: null, rondasConfiguradas: 1 });
  assert.equal(gps.nivel, 'urgente');
  assert.match(gps.motivos[0], /fallo de la app o del teléfono en 2 rondas \(67%\), GPS en 1/);
  assert.ok(gps.motivos.includes('1 cerrada automáticamente'));
  store.cerrar();
});

test('el correo trae el resumen ordenado por gravedad, los condominios sin rondas y el detalle de /fabrica', async () => {
  const { store } = base();
  const l = lector({ porCondominio: { gps: ERROR_SENTRY } });
  const c = await saludSemanal.armar(store, { lectorSentry: l, ahora: AHORA });

  assert.deepEqual(l.pedidos.sort(), ['cortado', 'gps', 'nuevo', 'sano'], 'Sentry de cada condominio');
  assert.deepEqual(c.filas.map(f => [f.id, f.nivel]), [['cortado', 'urgente'], ['gps', 'urgente'], ['nuevo', 'mirar'], ['sano', 'bien']]);
  assert.equal(c.subject, '🔴 Salud Ronda — 16-11-2026: 2 urgentes, 1 para mirar');

  const resumen = c.texto.split('DETALLE')[0];
  assert.match(resumen, /🔴 El Mirador — urgente: sin ninguna ronda en 7 días \(última: 06-11-2026\)/);
  assert.match(resumen, /🔴 Reserva Norte — urgente: .*4 errores en Sentry/);
  assert.match(resumen, /🟡 Condominio Nuevo — mirar: sin rondas configuradas todavía/);
  assert.match(resumen, /🟢 Los Aromos — todo bien: 5 rondas \(0,7 por día\)/);
  assert.match(resumen, /Sin ninguna ronda en la semana .*: El Mirador, Condominio Nuevo\./);

  // Los números del detalle son los de salud.resumen(), los mismos de /fabrica.
  const s = salud.resumen(store, 'gps', AHORA);
  assert.equal(s.rondas.total, 3);
  const detalle = c.texto.split('== 🔴 Reserva Norte ==')[1].split('==')[0];
  assert.match(detalle, /Rondas: 3 \(3 cerradas\)/);
  assert.match(detalle, /  Promedio: 0,4 rondas por día/);
  assert.match(detalle, /Completas 2 \(67%\) · Incompletas 0 \(0%\) · Con sospechas 0 \(0%\) · Cerradas automáticamente 1 \(33%\)/);
  assert.match(detalle, /Fallo de la aplicación o del teléfono: 2 rondas \(67%\)/);
  assert.match(detalle, /· GPS: sin señal, ubicación vieja o imprecisa: 1 ronda \(33%, 2 rechazos\)/);
  assert.match(detalle, /· El teléfono no terminó la ronda .*: 1 ronda/);
  assert.match(detalle, /Fallo del usuario: 0 rondas \(0%\)/);
  assert.match(detalle, /· TypeError: x is undefined \(app.js\) — 12 veces, última: dom\.?,? 15-11,? 20:10/);
  assert.match(detalle, /https:\/\/sentry\.io\/issues\/1\//);
  assert.match(detalle, /…y 3 más en Sentry\./);
  assert.match(c.texto, /== Errores de Sentry sin condominio ==\n.*\n  Sin errores sin resolver\./);
  store.cerrar();
});

test('sin Sentry conectado el correo sale igual y dice qué falta', async () => {
  const { store } = base();
  const c = await saludSemanal.armar(store, { lectorSentry: { configurado: false, falta: 'SENTRY_TOKEN_LECTURA (un token)' }, ahora: AHORA });
  assert.match(c.texto, /Sentry no está conectado \(falta: SENTRY_TOKEN_LECTURA \(un token\)\)/);
  assert.doesNotMatch(c.texto, /Errores de Sentry sin resolver/);
  assert.equal(c.filas.find(f => f.id === 'sano').nivel, 'bien');
  store.cerrar();
});

test('todo bien también sale: asunto en verde', async () => {
  const { store } = base();
  store.db.condominios = store.db.condominios.filter(c => c.id === 'sano');
  const c = await saludSemanal.armar(store, { lectorSentry: lector(), ahora: AHORA });
  assert.equal(c.subject, '🟢 Salud Ronda — 16-11-2026: todo bien');
  assert.doesNotMatch(c.texto, /Sin ninguna ronda en la semana/);
  store.cerrar();
});

function buzon({ falla = false } = {}) {
  const enviados = [];
  return {
    enviados,
    enviar: async m => { if (falla) return { enviada: false, error: 'Gmail: 503' }; enviados.push(m); return { enviada: true, to: m.to }; }
  };
}

test('el programador: los lunes desde SALUD_HORA, una vez por semana; sin SALUD_TO no hace nada', async () => {
  const { store } = base();
  const env = { SALUD_TO: 'Jose@Ejemplo.cl', SALUD_HORA: '8' };
  const b = buzon();
  const vuelta = (fecha, hora, dia, extra = {}) => saludSemanal.revisar(store, {
    ahora: { fecha, hora, dia }, semana: lunesDeLaSemana(fecha), env, lectorSentry: lector(), enviar: b.enviar, log: silencio, reloj: AHORA, ...extra
  });

  assert.equal(await vuelta('2026-11-16', 8, 1, { env: { SALUD_HORA: '8' } }), null, 'sin destinatario');
  assert.equal(await vuelta('2026-11-15', 9, 0), null, 'domingo');
  assert.equal(await vuelta('2026-11-16', 7, 1), null, 'antes de la hora');
  assert.equal(b.enviados.length, 0);

  const r = await vuelta('2026-11-16', 8, 1);
  assert.equal(r.enviada, true);
  assert.equal(b.enviados.length, 1);
  assert.deepEqual(b.enviados[0].to, ['jose@ejemplo.cl']);
  assert.match(b.enviados[0].subject, /^🔴 Salud Ronda/);
  assert.deepEqual(store.db.saludEmailEstado, { semana: '2026-11-16', enviado: iso(AHORA) });

  assert.equal(await vuelta('2026-11-16', 9, 1), null, 'ya salió esta semana');
  assert.equal(b.enviados.length, 1);

  await vuelta('2026-11-23', 8, 1);
  assert.equal(b.enviados.length, 2, 'el lunes siguiente sale de nuevo');
  store.cerrar();
});

test('si Gmail falla no se marca enviado y se reintenta; el envío a mano no cuenta como el del lunes', async () => {
  const { store } = base();
  const env = { SALUD_TO: 'jose@ejemplo.cl' };
  const ahora = { fecha: '2026-11-16', hora: 10, dia: 1 };
  const semana = '2026-11-16';
  const logs = [];

  const malo = buzon({ falla: true });
  const r = await saludSemanal.revisar(store, { ahora, semana, env, lectorSentry: lector(), enviar: malo.enviar, log: m => logs.push(m), reloj: AHORA });
  assert.equal(r.enviada, false);
  assert.equal(store.db.saludEmailEstado, undefined);
  assert.match(logs.join('\n'), /FALLÓ .*se reintenta/);

  // A mano, un miércoles: sale, pero el del lunes sigue pendiente.
  const b = buzon();
  const aMano = await saludSemanal.revisar(store, { forzar: true, env, lectorSentry: lector(), enviar: b.enviar, log: silencio, reloj: AHORA });
  assert.equal(aMano.enviada, true);
  assert.equal(store.db.saludEmailEstado, undefined);

  await saludSemanal.revisar(store, { ahora, semana, env, lectorSentry: lector(), enviar: b.enviar, log: silencio, reloj: AHORA });
  assert.equal(b.enviados.length, 2);
  assert.equal(store.db.saludEmailEstado.semana, semana);
  store.cerrar();
});

test('si algo revienta al armar el correo, revisar no lanza: lo anota y se reintenta', async () => {
  const { store } = base();
  const roto = { configurado: true, dias: 7, deCondominio: async () => { throw new Error('boom'); }, sinCondominio: async () => ({ problemas: 0, lista: [] }) };
  const logs = [];
  const r = await saludSemanal.revisar(store, { forzar: true, env: { SALUD_TO: 'jose@ejemplo.cl' }, lectorSentry: roto, enviar: buzon().enviar, log: m => logs.push(m) });
  assert.equal(r.enviada, false);
  assert.match(r.error, /boom/);
  assert.match(logs.join('\n'), /\[salud-email\] error: boom/);
  store.cerrar();
});

// Railway corre en UTC (INC-001 C): las horas del correo tienen que salir en
// hora de Chile igual. Se corre el script de verdad con TZ=UTC.
test('con TZ=UTC, como Railway, las horas salen en hora de Chile (scripts/salud-ahora.js --mostrar)', () => {
  const { store, ruta } = base();
  store.cerrar();

  const r = spawnSync(process.execPath, ['scripts/salud-ahora.js', '--mostrar'], {
    cwd: APP, encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', DB_PATH: ruta, SENTRY_DSN: '', SENTRY_TOKEN_LECTURA: '', SALUD_TO: '' }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Asunto: 🔴 Salud Ronda/);
  // El Mirador: su última ronda empezó el 06-11 a las 11:30 UTC, 08:30 en Chile.
  const mirador = r.stdout.split('== 🔴 El Mirador ==')[1];
  assert.match(mirador, /Última ronda: .*06-11,? 08:30\./);

  // Las 02:30 UTC del lunes son las 23:30 del domingo en Chile.
  const { fechaHora } = saludSemanal;
  const enUtc = spawnSync(process.execPath, ['-e', `process.stdout.write(require('./lib/salud-semanal').fechaHora('2026-11-16T02:30:00Z'))`], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }
  });
  assert.equal(enUtc.status, 0, enUtc.stderr);
  assert.match(enUtc.stdout, /15-11,? 23:30/);
  assert.equal(enUtc.stdout, fechaHora('2026-11-16T02:30:00Z'), 'misma salida con la zona del computador');
});

test('sin SALUD_TO el script a mano lo dice y termina con error, sin mandar nada', () => {
  const { store, ruta } = base();
  store.cerrar();
  const r = spawnSync(process.execPath, ['scripts/salud-ahora.js'], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, DB_PATH: ruta, SALUD_TO: '' }
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SALUD_TO está vacío/);
});

test('por defecto sale el lunes a las 06:30 de Chile; SALUD_HORA acepta HH:MM o solo la hora', async () => {
  assert.equal(saludSemanal.minutosDelDia('06:30'), 390);
  assert.equal(saludSemanal.minutosDelDia('6:30'), 390);
  assert.equal(saludSemanal.minutosDelDia('8'), 480);
  for (const malo of ['', '24:00', '6:60', '6.30', 'seis']) assert.equal(saludSemanal.minutosDelDia(malo), null, malo);
  assert.equal(saludSemanal.opcionesDesdeEnv({}).hora, '06:30');
  assert.equal(saludSemanal.opcionesDesdeEnv({ SALUD_HORA: 'seis' }).hora, '06:30', 'mal escrita: la de por defecto');
  assert.equal(saludSemanal.opcionesDesdeEnv({ SALUD_HORA: '7:15' }).hora, '07:15');

  const { store } = base();
  const b = buzon();
  const vuelta = (hora, minuto) => saludSemanal.revisar(store, {
    ahora: { fecha: '2026-11-16', hora, minuto, dia: 1 }, semana: '2026-11-16', env: { SALUD_TO: 'jose@ejemplo.cl' },
    lectorSentry: lector(), enviar: b.enviar, log: silencio, reloj: AHORA
  });
  assert.equal(await vuelta(6, 29), null, '06:29 todavía no');
  assert.equal((await vuelta(6, 30)).enviada, true, '06:30 sale');
  assert.equal(b.enviados.length, 1);
  store.cerrar();
});

test('ahoraChile trae el minuto, en hora de Chile también con TZ=UTC', () => {
  const r = spawnSync(process.execPath, ['-e', `
    const real = Date; const fijo = Date.parse('2026-11-16T09:30:00Z');
    global.Date = class extends real { constructor(...a) { super(...(a.length ? a : [fijo])); } static now() { return fijo; } };
    process.stdout.write(JSON.stringify(require('./lib/programador').ahoraChile()));`], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { fecha: '2026-11-16', hora: 6, minuto: 30, dia: 1 });
});
