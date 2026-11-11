// Scripts de operación sobre la base SQLite (v1.17): exportar de vuelta a
// db.json, restaurar un respaldo, sembrar, purgar la demo y la migración RSF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { crearStore } = require('../lib/store');
const { datosSemilla } = require('../seed');
const { exportarJson } = require('../scripts/exportar-json');
const { restaurar } = require('../scripts/restaurar-respaldo');
const { hashPin } = require('../lib/auth');

const APP = path.join(__dirname, '..');
const silencio = { log: () => {} };
const carpeta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-scripts-'));

// Una base sembrada con rondas y avisos en los dos condominios de la demo.
function baseConHistorial(dir) {
  const ruta = path.join(dir, 'rondas.sqlite');
  const store = crearStore(ruta, silencio);
  Object.assign(store.db, datosSemilla());
  store.guardar();
  for (const [i, condominioId] of ['aromos', 'aromos', 'mirador'].entries()) {
    store.ejecuciones.guardar({ id: `e-${i}`, rondaId: 'r', condominioId, guardiaId: 'u-pedro', inicio: `2026-09-2${i}T03:00:00.000Z`,
      fin: null, estado: 'completa', escaneos: [{ puntoId: 'p', ts: 'x', gps: { lat: -33, lon: -70 } }], evaluacion: null });
    store.notificaciones.agregar({ ts: `2026-09-2${i}T04:00:00.000Z`, condominioId, texto: `aviso ${i}`, medio: 'registro', enviada: true });
  }
  return { ruta, store };
}

const correr = (script, args, env) => spawnSync(process.execPath, [script, ...args], {
  cwd: APP, env: { ...process.env, ...env }, encoding: 'utf8'
});

test('exportar-json: la vuelta atrás regenera un db.json que se reimporta idéntico', () => {
  const dir = carpeta();
  const { ruta, store } = baseConHistorial(dir);
  const esperado = store.exportar();
  store.cerrar();

  const { destino, conteos } = exportarJson({ rutaDb: ruta, ...silencio });
  assert.equal(destino, path.join(dir, 'db.json'));
  assert.deepEqual(conteos, { ejecuciones: 3, notificaciones: 3, usuarios: esperado.usuarios.length, puntos: esperado.puntos.length });
  const json = JSON.parse(fs.readFileSync(destino, 'utf8'));
  assert.deepEqual(json, esperado);
  for (const clave of ['condominios', 'usuarios', 'puntos', 'rondas', 'ejecuciones', 'sesiones', 'notificaciones', 'pushSuscripciones']) {
    assert.ok(clave in json, `la v1.16 espera la clave "${clave}"`);
  }

  // No pisa un .json que ya esté, salvo que se pida.
  assert.throws(() => exportarJson({ rutaDb: ruta, ...silencio }), /Ya existe/);
  exportarJson({ rutaDb: ruta, forzar: true, ...silencio });

  // Y ese .json, en una carpeta nueva, se importa idéntico (ida y vuelta).
  const otra = carpeta();
  fs.copyFileSync(destino, path.join(otra, 'db.json'));
  const reimportada = crearStore(path.join(otra, 'db.json'), silencio);
  assert.deepEqual(reimportada.exportar(), esperado);
  reimportada.cerrar();
});

test('exportar-json: sin base no crea una vacía', () => {
  const dir = carpeta();
  assert.throws(() => exportarJson({ rutaDb: path.join(dir, 'rondas.sqlite'), ...silencio }), /No existe la base/);
  assert.ok(!fs.existsSync(path.join(dir, 'rondas.sqlite')));
  const r = correr('scripts/exportar-json.js', [], { DB_PATH: path.join(dir, 'rondas.sqlite') });
  assert.equal(r.status, 1);
});

test('restaurar-respaldo: valida el .gz, en seco no toca nada, y con --aplicar se aplica al arrancar', async () => {
  const dir = carpeta();
  const { ruta, store } = baseConHistorial(dir);
  const respaldo = path.join(dir, 'respaldos', 'rondas-2026-09-26.sqlite');
  store.respaldar(respaldo);
  fs.writeFileSync(`${respaldo}.gz`, zlib.gzipSync(fs.readFileSync(respaldo)));
  // Después del respaldo pasan cosas que la restauración va a deshacer.
  store.ejecuciones.guardar({ id: 'posterior', condominioId: 'aromos', inicio: '2026-09-27T03:00:00.000Z', estado: 'en_curso', escaneos: [] });
  store.cerrar();

  const seco = await restaurar(`${respaldo}.gz`, { rutaDb: ruta, ...silencio });
  assert.equal(seco.info.ejecuciones, 3);
  assert.equal(seco.pendiente, null);
  assert.ok(!fs.existsSync(`${ruta}.restaurar`) && !fs.existsSync(`${ruta}.restaurar.tmp`));

  const r = await restaurar(`${respaldo}.gz`, { rutaDb: ruta, aplicar: true, ...silencio });
  assert.equal(r.pendiente, `${ruta}.restaurar`);
  const abierta = crearStore(ruta, silencio);
  assert.equal(abierta.ejecuciones.contar(), 3);
  assert.equal(abierta.ejecuciones.obtener('posterior'), null);
  assert.ok(fs.existsSync(abierta.restauracion.apartada), 'la base que estaba queda apartada');
  abierta.cerrar();

  // Un .sqlite sin comprimir (los de /data/respaldos/) también sirve.
  assert.equal((await restaurar(respaldo, { rutaDb: ruta, ...silencio })).info.ejecuciones, 3);
});

test('restaurar-respaldo: un archivo roto se rechaza sin dejar nada pendiente', async () => {
  const dir = carpeta();
  const ruta = path.join(dir, 'rondas.sqlite');
  const roto = path.join(dir, 'roto.sqlite.gz');
  fs.writeFileSync(roto, zlib.gzipSync(Buffer.from('esto no es una base')));
  await assert.rejects(restaurar(roto, { rutaDb: ruta, aplicar: true, ...silencio }), /El respaldo no sirve/);
  const noGz = path.join(dir, 'no-gz.sqlite.gz');
  fs.writeFileSync(noGz, 'tampoco gzip');
  await assert.rejects(restaurar(noGz, { rutaDb: ruta, aplicar: true, ...silencio }));
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('restaurar')), []);
  const r = correr('scripts/restaurar-respaldo.js', [roto, '--aplicar'], { DB_PATH: ruta });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /El respaldo no sirve/);
});

test('seed sin --si-vacio resiembra desde cero, historial incluido', () => {
  const dir = carpeta();
  const { ruta, store } = baseConHistorial(dir);
  store.cerrar();
  execFileSync(process.execPath, ['seed.js'], { cwd: APP, env: { ...process.env, DB_PATH: ruta }, encoding: 'utf8' });
  const despues = crearStore(ruta, silencio);
  assert.equal(despues.ejecuciones.contar(), 0);
  assert.equal(despues.notificaciones.contar(), 0);
  assert.ok(despues.db.usuarios.some(u => u.usuario === 'admin'));
  despues.cerrar();
});

test('purga-demo --con-condominio borra también las rondas y avisos del condominio demo', () => {
  const dir = carpeta();
  const { ruta, store } = baseConHistorial(dir);
  // Una cuenta de panel real, para que la purga no quede bloqueada.
  store.db.usuarios.push({ id: 'u-real', condominioId: 'mirador', usuario: 'real', nombre: 'Real', rol: 'admin', pinHash: hashPin('90817263') });
  store.guardar();
  store.cerrar();

  const seco = correr('purga-demo.js', ['--con-condominio'], { DB_PATH: ruta });
  assert.equal(seco.status, 0, seco.stderr);
  assert.match(seco.stdout, /Se borraría el condominio de demo "aromos" y todos sus datos \(2 rondas y 2 avisos\)/);
  let s = crearStore(ruta, silencio);
  assert.equal(s.ejecuciones.contar(), 3, 'en seco no se tocó nada');
  s.cerrar();

  const r = correr('purga-demo.js', ['--aplicar', '--con-condominio'], { DB_PATH: ruta });
  assert.equal(r.status, 0, r.stderr);
  s = crearStore(ruta, silencio);
  assert.equal(s.ejecuciones.contar('aromos'), 0);
  assert.equal(s.notificaciones.contar('aromos'), 0);
  assert.equal(s.ejecuciones.contar('mirador'), 1, 'lo de otros condominios queda');
  assert.ok(!s.db.condominios.some(c => c.id === 'aromos'));
  assert.ok(s.db.usuarios.some(u => u.id === 'u-real'));
  s.cerrar();
});

test('prueba-carga en miniatura: guardias a la vez sobre una base con historial, sin marcas perdidas', async () => {
  const { pruebaCarga } = require('../scripts/prueba-carga');
  const log = console.log;
  console.log = () => {};
  let r;
  try {
    r = await pruebaCarga({ guardias: 6, rondas: 600, log: () => {} });
  } finally {
    console.log = log;
  }
  assert.equal(r.marcasPerdidas, 0);
  assert.equal(r.totalEjecuciones, 606);
  assert.equal(r.tiempos.escanear.n, 60);
});

test('migracion-rsf borra las rondas y avisos de mirador y es idempotente', () => {
  const { aplicar, CONDOMINIO_A_ELIMINAR } = require('../migracion-rsf');
  const dir = carpeta();
  const { store } = baseConHistorial(dir);
  const cambios = aplicar(store);
  assert.ok(cambios.some(c => c.includes(`1 rondas y 1 avisos de "${CONDOMINIO_A_ELIMINAR}"`)));
  assert.equal(store.ejecuciones.contar(CONDOMINIO_A_ELIMINAR), 0);
  assert.equal(store.ejecuciones.contar('aromos'), 2);
  assert.ok(store.db.condominios.some(c => c.id === 'piloto-sf'));
  assert.deepEqual(aplicar(store), [], 'la segunda vez no hace nada');
  store.cerrar();
});

test('diagnostico-gps: cuenta por punto sin escribir nada en la base', () => {
  const { diagnosticar, formatear } = require('../scripts/diagnostico-gps');
  const dir = carpeta();
  const ruta = path.join(dir, 'rondas.sqlite');
  const store = crearStore(ruta, silencio);
  Object.assign(store.db, datosSemilla());
  const bombas = store.db.puntos.find(p => p.id === 'p-bombas');
  Object.assign(bombas, { lat: -33.45, lon: -70.66, precisionM: 6, dispersionM: 3, verificacion: 'anclaje' });
  store.guardar();
  const ahora = Date.parse('2026-10-20T12:00:00.000Z');
  const lectura = acc => ({ lat: -33.45, lon: -70.66, acc, edadMs: 2000 });
  store.ejecuciones.guardar({
    id: 'e-1', rondaId: 'ronda-nocturna', condominioId: 'aromos', guardiaId: 'u-pedro',
    inicio: '2026-10-15T03:00:00.000Z', fin: null, estado: 'completa', evaluacion: null,
    escaneos: [1, 2, 3].map(i => ({ puntoId: 'p-bombas', ts: `2026-10-15T03:0${i}:00.000Z`, gps: lectura(60) })),
    rechazos: [{ puntoId: 'p-bombas', ts: '2026-10-15T03:00:30.000Z', motivo: '📍 Señal demasiado imprecisa (±150 m)…', acc: 150, edadMs: 3000 }]
  });
  // Fuera del período: no cuenta.
  store.ejecuciones.guardar({
    id: 'e-vieja', rondaId: 'ronda-nocturna', condominioId: 'aromos', guardiaId: 'u-pedro',
    inicio: '2026-08-01T03:00:00.000Z', fin: null, estado: 'completa', evaluacion: null,
    escaneos: [{ puntoId: 'p-bombas', ts: '2026-08-01T03:01:00.000Z', gps: lectura(6) }]
  });
  store.cerrar();
  const antes = fs.readFileSync(ruta);

  const d = diagnosticar({ rutaDb: ruta, dias: 30, condominioId: 'aromos', ahora });
  assert.equal(d.condominios.length, 1);
  assert.equal(d.condominios[0].ejecuciones, 1);
  const s = d.condominios[0].puntos.find(p => p.puntoId === 'p-bombas');
  assert.equal(s.marcas, 3);
  assert.equal(s.accMediana, 60);
  assert.equal(s.rechazos.imprecisa, 1);
  assert.equal(s.anclaPerdida, 1);
  assert.equal(s.nivel, 'mala');
  assert.deepEqual(s.clases, ['ancla perdida', 'bajo losa']);
  assert.equal(s.fijado, 'promediado (v1.14+)');
  const texto = formatear(d);
  assert.match(texto, /🔴 Sala de bombas · 🏠 entrada/);
  assert.match(texto, /1 con la entrada perdida/);

  assert.ok(antes.equals(fs.readFileSync(ruta)), 'la base no cambió');
  assert.ok(!fs.existsSync(`${ruta}.restaurar`));

  // Por línea de comandos, con DB_PATH como el servidor.
  const r = correr('scripts/diagnostico-gps.js', ['--json', '--dias', '3650'], { DB_PATH: ruta });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).condominios.length, 2);
  // Sin base no crea una vacía.
  const vacia = path.join(carpeta(), 'rondas.sqlite');
  assert.equal(correr('scripts/diagnostico-gps.js', [], { DB_PATH: vacia }).status, 1);
  assert.ok(!fs.existsSync(vacia));
});

// Números de Condominio Piloto (noviembre 2026): un punto exterior 🟢 con 5
// rechazos en 250 intentos salía «semi-techado», y una torre con 1 «imprecisa» en
// 290, «bajo losa».
test('diagnostico-gps: la clase del punto sale de la proporción, no de un rechazo suelto', () => {
  const { clasificar } = require('../scripts/diagnostico-gps');
  const cfg = require('../lib/rondas').configGps();
  const p = { lat: -33.45, lon: -70.66, precisionM: 4, dispersionM: 2 };
  const jardin = { anclaPerdida: 0, nivel: 'buena', marcas: 245, rechazosGps: 5, accP90: 9, rechazos: { imprecisa: 0, distancia: 5 } };
  assert.deepEqual(clasificar(jardin, p, cfg), []);
  const torre = { anclaPerdida: 0, nivel: 'regular', marcas: 271, rechazosGps: 19, accP90: 38, rechazos: { imprecisa: 1, distancia: 16 } };
  assert.deepEqual(clasificar(torre, p, cfg), ['semi-techado']);
  const losa = { ...torre, nivel: 'mala', rechazosGps: 50, rechazos: { imprecisa: 34, distancia: 16 } };
  assert.deepEqual(clasificar(losa, p, cfg), ['bajo losa']);
  // Fijado sin promediar, en un punto con problemas: también se dice.
  assert.deepEqual(clasificar(torre, { ...p, dispersionM: null }, cfg), ['semi-techado', 'mal fijado']);
  // Con chapita el GPS no decide: no hay techo que clasificar.
  assert.deepEqual(clasificar({ ...torre, modo: 'nfc' }, p, cfg), []);
});
