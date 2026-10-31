// Salud del producto (v1.26): lo que falla sin ser un error y por eso no ve
// Sentry. Cómo terminan las rondas, las rondas en las que el guardia tuvo que
// volver a entrar a mitad de recorrido y las alarmas que no sonaron porque
// había una ronda en curso. Ver lib/salud.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const salud = require('../lib/salud');
const recordatorios = require('../lib/recordatorios');
const cuenta = require('../lib/cuenta');

const MIN = 60000;
const DIA = 24 * 60 * MIN;
const AHORA = Date.parse('2026-10-31T15:00:00Z');
const iso = t => new Date(t).toISOString();

const nuevo = () => crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-salud-')), 'rondas.sqlite'));

const ejec = (id, condominioId, inicio, extra = {}) => ({
  id, rondaId: 'r1', condominioId, guardiaId: 'g1', inicio: iso(inicio), fin: null,
  estado: 'en_curso', escaneos: [], evaluacion: null, ...extra
});
const cerrada = (id, condominioId, inicio, estado, extra = {}) =>
  ejec(id, condominioId, inicio, { fin: iso(inicio + 20 * MIN), estado, ...extra });

const guardia = (id, condominioId) => ({ id, condominioId, usuario: id, nombre: `Guardia ${id}`, rol: 'guardia' });

// Avisos de la alarma de ronda que salen por Web Push (lib/push.js).
const pushFalso = () => {
  const enviadas = [];
  return { enviadas, recordar: async condominio => { enviadas.push(condominio.id); return { ok: 1, total: 1, errores: [] }; } };
};

test('rondas por estado en los últimos 7 días, con porcentaje sobre las cerradas', () => {
  const store = nuevo();
  const e = store.ejecuciones;
  e.guardar(cerrada('a1', 'c1', AHORA - 1 * DIA, 'completa'));
  e.guardar(cerrada('a2', 'c1', AHORA - 2 * DIA, 'completa_obs'));
  e.guardar(cerrada('a3', 'c1', AHORA - 3 * DIA, 'incompleta'));
  e.guardar(cerrada('a4', 'c1', AHORA - 4 * DIA, 'sospechosa'));
  // Las que cerró el proceso de rondas abandonadas van aparte, aunque hayan
  // quedado completas: el guardia no las terminó.
  e.guardar(cerrada('a5', 'c1', AHORA - 5 * DIA, 'incompleta', { cierreAutomatico: true }));
  e.guardar(cerrada('a6', 'c1', AHORA - 6 * DIA, 'completa', { cierreAutomatico: true }));
  e.guardar(ejec('a7', 'c1', AHORA - 30 * MIN));
  // Fuera de la ventana y de otro condominio: no cuentan.
  e.guardar(cerrada('viejo', 'c1', AHORA - 8 * DIA, 'incompleta', { cierreAutomatico: true }));
  e.guardar(cerrada('otro', 'c2', AHORA - DIA, 'incompleta'));

  const r = salud.resumen(store, 'c1', AHORA);
  assert.equal(r.dias, 7);
  assert.equal(r.desde, iso(AHORA - 7 * DIA));
  assert.deepEqual(r.rondas, {
    cerradas: 6, completas: 2, incompletas: 1, sospechosas: 1, automaticas: 2, enCurso: 1,
    porcentaje: { completas: 33, incompletas: 17, sospechosas: 17, automaticas: 33 }
  });
  store.cerrar();
});

test('un condominio sin rondas da ceros, no NaN', () => {
  const store = nuevo();
  store.ejecuciones.guardar(cerrada('x', 'c1', AHORA - DIA, 'completa'));
  const r = salud.resumen(store, 'vacio', AHORA);
  assert.deepEqual(r.rondas, {
    cerradas: 0, completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0, enCurso: 0,
    porcentaje: { completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0 }
  });
  assert.deepEqual(r.reingresos, { rondas: 0, veces: 0, porcentaje: 0 });
  assert.deepEqual(r.alarmasRetenidas, { veces: 0, rondas: 0 });
  store.cerrar();
});

test('volver a entrar con una ronda en curso se anota; sin ronda propia en curso, no', () => {
  const store = nuevo();
  const pedro = guardia('g-pedro', 'c1');
  const luis = guardia('g-luis', 'c1');
  store.ejecuciones.guardar(ejec('r-pedro', 'c1', AHORA - 100 * MIN, { guardiaId: pedro.id }));

  // Pedro: la sesión se le cortó a mitad de ronda y vuelve a entrar dos veces.
  assert.equal(salud.anotarReingreso(store, pedro, AHORA - 10 * MIN), 'r-pedro');
  assert.equal(salud.anotarReingreso(store, pedro, AHORA - 5 * MIN), 'r-pedro');
  // Luis entra en el mismo teléfono con la ronda de Pedro abierta: él no
  // tenía ninguna, no es un corte.
  assert.equal(salud.anotarReingreso(store, luis, AHORA), null);
  // Ni el administrador ni la fábrica cuentan.
  assert.equal(salud.anotarReingreso(store, { id: 'adm', condominioId: 'c1', rol: 'admin' }, AHORA), null);
  assert.equal(salud.anotarReingreso(store, { id: 'fab', condominioId: null, rol: 'fabrica' }, AHORA), null);

  // La ronda cerrada ya no está en curso: entrar después no es un reingreso.
  const r = store.ejecuciones.obtener('r-pedro');
  store.ejecuciones.guardar({ ...r, estado: 'incompleta', fin: iso(AHORA) });
  assert.equal(salud.anotarReingreso(store, pedro, AHORA), null);

  const res = salud.resumen(store, 'c1', AHORA);
  assert.deepEqual(res.reingresos, { rondas: 1, veces: 2, porcentaje: 100 },
    'dos inicios de sesión en la misma ronda son una ronda cortada');

  // Sin datos personales: del guardia solo queda el id interno.
  const filas = store.sql.prepare('SELECT * FROM eventos_salud').all();
  assert.equal(filas.length, 2);
  assert.deepEqual(Object.keys(filas[0]).sort(), ['condominio_id', 'ejecucion_id', 'id', 'tipo', 'ts', 'usuario_id']);
  assert.equal(filas[0].usuario_id, pedro.id);
  store.cerrar();
});

test('un reingreso de hace más de 7 días no cuenta, y los de más de 30 se podan', () => {
  const store = nuevo();
  const pedro = guardia('g-pedro', 'c1');
  store.ejecuciones.guardar(ejec('r1', 'c1', AHORA - 40 * DIA, { guardiaId: pedro.id }));
  salud.anotarReingreso(store, pedro, AHORA - 40 * DIA);
  salud.anotarReingreso(store, pedro, AHORA - 8 * DIA);
  assert.equal(salud.resumen(store, 'c1', AHORA).reingresos.veces, 0);
  // Anotar uno nuevo poda los que pasaron de 30 días.
  salud.anotarReingreso(store, pedro, AHORA);
  const ts = store.sql.prepare('SELECT ts FROM eventos_salud ORDER BY ts').all().map(f => f.ts);
  assert.deepEqual(ts, [iso(AHORA - 8 * DIA), iso(AHORA)]);
  assert.equal(salud.resumen(store, 'c1', AHORA).reingresos.veces, 1);
  store.cerrar();
});

test('anotar un reingreso nunca hace fallar el login', () => {
  const store = nuevo();
  store.ejecuciones.guardar(ejec('r1', 'c1', AHORA - 10 * MIN, { guardiaId: 'g1' }));
  const roto = { ...store, salud: { anotar() { throw new Error('disco lleno'); } } };
  const consola = console.error;
  console.error = () => {};
  try {
    assert.equal(salud.anotarReingreso(roto, guardia('g1', 'c1'), AHORA), null);
  } finally {
    console.error = consola;
  }
  store.cerrar();
});

test('alarma retenida: una por intervalo mientras la ronda sigue en curso, no una por minuto', async () => {
  const store = nuevo();
  const push = pushFalso();
  const t0 = AHORA - 3 * 60 * MIN;
  const condominio = { id: 'c1', nombre: 'Los Aromos', recordatorioMin: 30, recordatorioDesde: iso(t0 - DIA) };
  store.db.condominios.push(condominio);
  store.ejecuciones.guardar(ejec('colgada', 'c1', t0));

  // Revisa cada minuto durante 75 minutos, como el servidor.
  for (let m = 0; m <= 75; m++) await recordatorios.revisar(store, push, t0 + m * MIN);
  assert.deepEqual(push.enviadas, [], 'con una ronda en curso la alarma no suena');
  const ts = store.salud.listar('c1', salud.ALARMA_RETENIDA, iso(0), iso(AHORA)).map(f => f.ts);
  assert.deepEqual(ts, [iso(t0 + 30 * MIN), iso(t0 + 60 * MIN)]);

  // Se cierra la ronda: la alarma vuelve a sonar y ya no se anota retenida.
  const e = store.ejecuciones.obtener('colgada');
  store.ejecuciones.guardar({ ...e, estado: 'incompleta', fin: iso(t0 + 76 * MIN), cierreAutomatico: true });
  await recordatorios.revisar(store, push, t0 + 77 * MIN);
  assert.deepEqual(push.enviadas, ['c1']);
  assert.equal(store.salud.listar('c1', salud.ALARMA_RETENIDA, iso(0), iso(AHORA)).length, 2);

  const r = salud.resumen(store, 'c1', AHORA);
  assert.deepEqual(r.alarmasRetenidas, { veces: 2, rondas: 1 });
  assert.equal(r.rondas.automaticas, 1);
  store.cerrar();
});

test('alarma retenida: una ronda corta no retiene nada, y con la alarma apagada no se cuenta', async () => {
  const store = nuevo();
  const push = pushFalso();
  const t0 = AHORA - 60 * MIN;
  const corta = { id: 'c1', nombre: 'Corta', recordatorioMin: 30, recordatorioDesde: iso(t0 - DIA) };
  const apagada = { id: 'c2', nombre: 'Apagada', recordatorioMin: 0 };
  store.db.condominios.push(corta, apagada);
  // La ronda empezó hace 10 minutos: la alarma recién toca 30 minutos después
  // de su inicio, así que no se retuvo ninguna.
  store.ejecuciones.guardar(ejec('r1', 'c1', AHORA - 10 * MIN));
  store.ejecuciones.guardar(ejec('r2', 'c2', AHORA - 5 * 60 * MIN));
  await recordatorios.revisar(store, push, AHORA);
  assert.equal(recordatorios.retenidaPorRonda(store, corta, AHORA), null);
  assert.equal(recordatorios.retenidaPorRonda(store, apagada, AHORA), null);
  assert.equal(store.sql.prepare('SELECT COUNT(*) AS n FROM eventos_salud').get().n, 0);
  assert.deepEqual(push.enviadas, []);
  store.cerrar();
});

test('borrar la cuenta del guardia suelta su id de los eventos, que siguen contando', () => {
  const store = nuevo();
  const pedro = guardia('g-pedro', 'c1');
  store.db.usuarios.push(pedro);
  store.ejecuciones.guardar(ejec('r1', 'c1', AHORA - 30 * MIN, { guardiaId: pedro.id }));
  salud.anotarReingreso(store, pedro, AHORA - 10 * MIN);
  cuenta.eliminarGuardia(store, pedro);
  assert.equal(store.sql.prepare('SELECT usuario_id FROM eventos_salud').get().usuario_id, null);
  assert.equal(salud.resumen(store, 'c1', AHORA).reingresos.rondas, 1);
  store.cerrar();
});

test('el registro sabe desde cuándo mide, y reabrir la base no lo reinicia', () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-salud-')), 'rondas.sqlite');
  const store = crearStore(ruta);
  const desde = store.salud.desde();
  assert.ok(!Number.isNaN(Date.parse(desde)), desde);
  assert.equal(salud.resumen(store, 'c1').registroDesde, desde);
  store.cerrar();
  const otra = crearStore(ruta);
  assert.equal(otra.salud.desde(), desde);
  otra.cerrar();
});
