// Salud del producto (v1.26): lo que falla sin ser un error de código. Cómo
// terminan las rondas y las rondas con dificultades técnicas, separadas en
// fallo de la aplicación (con el GPS aparte) y fallo del usuario. Ver
// lib/salud.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const salud = require('../lib/salud');
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

// La ronda r1 tiene dos puntos.
const RONDA = { id: 'r1', condominioId: 'c1', nombre: 'Perímetro', puntoIds: ['p1', 'p2'] };
const marca = puntoId => ({ puntoId, ts: iso(AHORA - DIA), medio: 'qr' });

// Rechazos como los anota el servidor (anotarRechazo en server.js). Los de GPS
// traen siempre topeM; los del medio, nunca.
const gps = (extra = {}) => ({ puntoId: 'p1', ts: iso(AHORA - DIA), motivo: 'Sin ubicación', topeM: 40, ...extra });
const medio = () => ({ puntoId: 'p1', ts: iso(AHORA - DIA), motivo: 'Este punto tiene chapita: acércala al teléfono.' });

const causas = d => ({ app: [...d.app].sort(), usuario: [...d.usuario].sort(), rechazosGps: d.rechazosGps });

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
    total: 7, cerradas: 6, completas: 2, incompletas: 1, sospechosas: 1, automaticas: 2, enCurso: 1,
    porcentaje: { completas: 33, incompletas: 17, sospechosas: 17, automaticas: 33 }
  });
  store.cerrar();
});

test('un condominio sin rondas da ceros, no NaN', () => {
  const store = nuevo();
  store.ejecuciones.guardar(cerrada('x', 'c1', AHORA - DIA, 'completa', { rechazos: [gps()] }));
  const r = salud.resumen(store, 'vacio', AHORA);
  assert.deepEqual(r.rondas, {
    total: 0, cerradas: 0, completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0, enCurso: 0,
    porcentaje: { completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0 }
  });
  assert.deepEqual(r.dificultades, {
    rondas: 0,
    porcentaje: 0,
    app: { rondas: 0, porcentaje: 0, causas: { gps: 0, sesion: 0, telefono: 0, chapita: 0 } },
    usuario: { rondas: 0, porcentaje: 0, causas: { lejos: 0, medio: 0, terminar: 0 } },
    gps: { rondas: 0, porcentaje: 0, rechazos: 0 }
  });
  store.cerrar();
});

test('GPS: lo que la señal podía arreglar es de la aplicación; lejos con buena señal, del usuario', () => {
  const opciones = { ronda: RONDA, precisionMaxM: 100 };
  // Sin ubicación, ubicación vieja o imprecisa: siempre de la aplicación.
  assert.deepEqual(causas(salud.dificultades({ rechazos: [gps(), gps({ motivo: 'Ubicación vieja', edadMs: 60000 })] }, opciones)),
    { app: ['gps'], usuario: [], rechazosGps: 2 });
  // Lejos pero dentro del error posible (tope 40 + 100 m): también.
  assert.deepEqual(causas(salud.dificultades({ rechazos: [gps({ distanciaM: 140 })] }, opciones)),
    { app: ['gps'], usuario: [], rechazosGps: 1 });
  // Más allá: el guardia no estaba en el punto.
  assert.deepEqual(causas(salud.dificultades({ rechazos: [gps({ distanciaM: 141 })] }, opciones)),
    { app: [], usuario: ['lejos'], rechazosGps: 0 });
  // El margen sale de GPS_PRECISION_MAX_M (configGps) si no se pasa.
  assert.deepEqual(causas(salud.dificultades({ rechazos: [gps({ distanciaM: 120 })] }, { ronda: RONDA })),
    { app: ['gps'], usuario: [], rechazosGps: 1 });
});

test('medio equivocado y chapita que no lee', () => {
  const opciones = { ronda: RONDA };
  assert.deepEqual(causas(salud.dificultades({ rechazos: [medio(), medio()] }, opciones)),
    { app: [], usuario: ['medio'], rechazosGps: 0 });
  // «La chapita no lee» (reporte) y el teléfono que no entregó la serie.
  assert.deepEqual(causas(salud.dificultades({ rechazos: [{ puntoId: 'p1', ts: iso(AHORA), motivo: 'La chapita no lee', reporte: 'chapita' }] }, opciones)),
    { app: ['chapita'], usuario: [], rechazosGps: 0 });
  assert.deepEqual(causas(salud.dificultades({ rechazos: [{ puntoId: 'p1', ts: iso(AHORA), motivo: 'El número de serie de la chapita no es válido.' }] }, opciones)),
    { app: ['chapita'], usuario: [], rechazosGps: 0 });
  // Una ronda sin rechazos ni nada raro no tiene dificultades.
  assert.deepEqual(causas(salud.dificultades({ escaneos: [marca('p1'), marca('p2')] }, opciones)),
    { app: [], usuario: [], rechazosGps: 0 });
});

test('cerrada por el sistema: con todo marcado faltó «Terminar»; con puntos sin marcar, el teléfono', () => {
  const opciones = { ronda: RONDA };
  assert.deepEqual(causas(salud.dificultades({ cierreAutomatico: true, escaneos: [marca('p1'), marca('p2')] }, opciones)),
    { app: [], usuario: ['terminar'], rechazosGps: 0 });
  assert.deepEqual(causas(salud.dificultades({ cierreAutomatico: true, escaneos: [marca('p1')] }, opciones)),
    { app: ['telefono'], usuario: [], rechazosGps: 0 });
  // Sin la ronda (la borraron) no se sabe si estaba todo: cuenta como teléfono.
  assert.deepEqual(causas(salud.dificultades({ cierreAutomatico: true, escaneos: [marca('p1'), marca('p2')] }, { ronda: null })),
    { app: ['telefono'], usuario: [], rechazosGps: 0 });
});

test('resumen: rondas con dificultades por lado y por causa, y el GPS aparte', () => {
  const store = nuevo();
  store.db.rondas.push(RONDA);
  const e = store.ejecuciones;
  // 1: dos rechazos de GPS (una ronda, dos rechazos).
  e.guardar(cerrada('d1', 'c1', AHORA - 1 * DIA, 'completa', { rechazos: [gps(), gps({ distanciaM: 90 })] }));
  // 2: GPS y además lejos: cuenta en los dos lados.
  e.guardar(cerrada('d2', 'c1', AHORA - 2 * DIA, 'completa', { rechazos: [gps(), gps({ distanciaM: 500 })] }));
  // 3: QR en un punto con chapita.
  e.guardar(cerrada('d3', 'c1', AHORA - 3 * DIA, 'completa', { rechazos: [medio()] }));
  // 4: marcó todo y no tocó «Terminar».
  e.guardar(cerrada('d4', 'c1', AHORA - 4 * DIA, 'completa', { cierreAutomatico: true, escaneos: [marca('p1'), marca('p2')] }));
  // 5: el teléfono no la terminó.
  e.guardar(cerrada('d5', 'c1', AHORA - 5 * DIA, 'incompleta', { cierreAutomatico: true, escaneos: [marca('p1')] }));
  // 6 y 7: sin nada raro (una en curso).
  e.guardar(cerrada('d6', 'c1', AHORA - 6 * DIA, 'completa', { escaneos: [marca('p1'), marca('p2')] }));
  e.guardar(ejec('d7', 'c1', AHORA - 10 * MIN));
  // 8: de hace más de 7 días, con GPS: no cuenta.
  e.guardar(cerrada('vieja', 'c1', AHORA - 9 * DIA, 'completa', { rechazos: [gps()] }));

  const d = salud.resumen(store, 'c1', AHORA).dificultades;
  assert.deepEqual(d.app, { rondas: 3, porcentaje: 43, causas: { gps: 2, sesion: 0, telefono: 1, chapita: 0 } });
  assert.deepEqual(d.usuario, { rondas: 3, porcentaje: 43, causas: { lejos: 1, medio: 1, terminar: 1 } });
  assert.deepEqual(d.gps, { rondas: 2, porcentaje: 29, rechazos: 3 });
  assert.equal(d.rondas, 5, 'la ronda con GPS y lejos cuenta una vez');
  assert.equal(d.porcentaje, 71);
  store.cerrar();
});

test('volver a entrar con una ronda en curso se anota como sesión cortada; sin ronda propia en curso, no', () => {
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

  const d = salud.resumen(store, 'c1', AHORA).dificultades;
  assert.equal(d.app.causas.sesion, 1, 'dos inicios de sesión en la misma ronda son una ronda cortada');
  assert.deepEqual(d.app, { rondas: 1, porcentaje: 100, causas: { gps: 0, sesion: 1, telefono: 0, chapita: 0 } });

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
  // La ronda empezó hace 40 días: no es de esta semana, aunque siga abierta.
  assert.equal(salud.resumen(store, 'c1', AHORA).dificultades.app.causas.sesion, 0);
  // Anotar uno nuevo poda los que pasaron de 30 días.
  salud.anotarReingreso(store, pedro, AHORA);
  const ts = store.sql.prepare('SELECT ts FROM eventos_salud ORDER BY ts').all().map(f => f.ts);
  assert.deepEqual(ts, [iso(AHORA - 8 * DIA), iso(AHORA)]);
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

test('borrar la cuenta del guardia suelta su id de los eventos, que siguen contando', () => {
  const store = nuevo();
  const pedro = guardia('g-pedro', 'c1');
  store.db.usuarios.push(pedro);
  store.ejecuciones.guardar(ejec('r1', 'c1', AHORA - 30 * MIN, { guardiaId: pedro.id }));
  salud.anotarReingreso(store, pedro, AHORA - 10 * MIN);
  cuenta.eliminarGuardia(store, pedro);
  assert.equal(store.sql.prepare('SELECT usuario_id FROM eventos_salud').get().usuario_id, null);
  assert.equal(salud.resumen(store, 'c1', AHORA).dificultades.app.causas.sesion, 1);
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
