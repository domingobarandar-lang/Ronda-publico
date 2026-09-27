// Store sobre SQLite (v1.17): colecciones chicas en memoria + tabla `estado`,
// ejecuciones y notificaciones en tablas propias. Ver entrega/PLAN-SQLITE.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore, resolverRutas } = require('../lib/store');

const carpeta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-store-'));
const nuevo = (opciones = { sinPuente: true }) => {
  const ruta = path.join(carpeta(), 'rondas.sqlite');
  return { ruta, store: crearStore(ruta, opciones) };
};

const ejec = (id, condominioId, inicio, extra = {}) => ({
  id, rondaId: 'r1', condominioId, guardiaId: 'g1', inicio, fin: null,
  estado: 'en_curso', escaneos: [], evaluacion: null, ...extra
});

test('rutas: un DB_PATH .json usa rondas.sqlite en la misma carpeta y el .json queda de origen', () => {
  const r = resolverRutas(path.join('data', 'db.json'));
  assert.equal(r.sqlite, path.join('data', 'rondas.sqlite'));
  assert.equal(r.json, path.join('data', 'db.json'));
  const s = resolverRutas(path.join('x', 'rondas.sqlite'));
  assert.equal(s.sqlite, path.join('x', 'rondas.sqlite'));
  assert.equal(s.json, path.join('x', 'db.json'));
});

test('la base queda en WAL con el esquema y su versión', () => {
  const { store } = nuevo();
  assert.equal(store.sql.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const tablas = store.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
  for (const t of ['estado', 'ejecuciones', 'notificaciones', 'meta']) assert.ok(tablas.includes(t), t);
  assert.equal(store.sql.prepare("SELECT valor FROM meta WHERE clave = 'version'").get().valor, '1');
  assert.equal(store.db.ejecuciones, undefined, 'sin puente, las ejecuciones no viven en memoria');
  store.cerrar();
});

test('store.db se persiste por clave y sobrevive a reabrir', () => {
  const { ruta, store } = nuevo();
  store.db.condominios.push({ id: 'c1', nombre: 'Uno' });
  store.db.informeEmailEstado = { 'a@b.cl': '2026-09-21' };
  store.guardar();
  store.cerrar();
  const otra = crearStore(ruta, { sinPuente: true });
  assert.deepEqual(otra.db.condominios, [{ id: 'c1', nombre: 'Uno' }]);
  assert.deepEqual(otra.db.informeEmailEstado, { 'a@b.cl': '2026-09-21' });
  otra.cerrar();
});

test('guardar() solo escribe las claves que cambiaron', () => {
  const { store } = nuevo();
  store.guardar(); // base nueva: persiste las colecciones vacías por defecto
  store.db.usuarios.push({ id: 'u1' });
  assert.deepEqual(store.guardar(), ['usuarios'], 'escribe solo lo que cambió');
  assert.deepEqual(store.guardar(), [], 'sin cambios no escribe nada');
  store.db.sesiones.tok = { usuarioId: 'u1' };
  assert.deepEqual(store.guardar(), ['sesiones']);
  delete store.db.sesiones.tok;
  assert.deepEqual(store.guardar(), ['sesiones']);
  store.cerrar();
});

test('una clave que se borra de store.db se borra de la tabla', () => {
  const { ruta, store } = nuevo();
  store.db.temporal = { a: 1 };
  store.guardar();
  delete store.db.temporal;
  assert.deepEqual(store.guardar(), ['temporal']);
  store.cerrar();
  const otra = crearStore(ruta, { sinPuente: true });
  assert.equal(otra.db.temporal, undefined);
  otra.cerrar();
});

test('ejecuciones: guardar es upsert y obtener devuelve una copia idéntica', () => {
  const { store } = nuevo();
  const e = ejec('e1', 'c1', '2026-09-20T10:00:00.000Z', { escaneos: [{ puntoId: 'p1', ts: 'x', gps: { lat: -33.1, lon: -70.2 } }] });
  store.ejecuciones.guardar(e);
  const leida = store.ejecuciones.obtener('e1');
  assert.deepEqual(leida, e);
  assert.notEqual(leida, e, 'cada lectura es un objeto nuevo');
  leida.estado = 'completa';
  leida.escaneos.push({ puntoId: 'p2' });
  store.ejecuciones.guardar(leida);
  assert.equal(store.ejecuciones.obtener('e1').estado, 'completa');
  assert.equal(store.ejecuciones.obtener('e1').escaneos.length, 2);
  assert.equal(store.ejecuciones.contar(), 1);
  assert.equal(store.ejecuciones.obtener('no-existe'), null);
  store.cerrar();
});

test('ejecuciones: listar filtra por condominio, fechas y estado, y ordena de la más reciente', () => {
  const { store } = nuevo();
  store.ejecuciones.guardar(ejec('a', 'c1', '2026-09-20T10:00:00.000Z', { estado: 'completa' }));
  store.ejecuciones.guardar(ejec('b', 'c1', '2026-09-21T10:00:00.000Z'));
  store.ejecuciones.guardar(ejec('c', 'c1', '2026-09-22T10:00:00.000Z', { estado: 'incompleta' }));
  store.ejecuciones.guardar(ejec('d', 'c2', '2026-09-23T10:00:00.000Z'));
  const ids = l => l.map(e => e.id);
  assert.deepEqual(ids(store.ejecuciones.listar({ condominioId: 'c1' })), ['c', 'b', 'a']);
  assert.deepEqual(ids(store.ejecuciones.listar({ condominioId: 'c1', limite: 2 })), ['c', 'b']);
  assert.deepEqual(ids(store.ejecuciones.listar({ condominioId: 'c1', desde: '2026-09-21', hasta: '2026-09-22' })), ['b'],
    'desde inclusive, hasta exclusive');
  assert.deepEqual(ids(store.ejecuciones.listar({ condominioId: 'c1', estadoDistintoDe: 'en_curso' })), ['c', 'a']);
  assert.deepEqual(ids(store.ejecuciones.listar({ condominioId: 'c1', estado: 'en_curso' })), ['b']);
  assert.deepEqual(ids(store.ejecuciones.listar()), ['d', 'c', 'b', 'a']);
  store.cerrar();
});

test('ejecuciones: el orden usa la hora real aunque el teléfono mande otra zona horaria', () => {
  const { store } = nuevo();
  // 21:30 de Chile (-03:00) es 00:30 UTC del día siguiente: más tarde que las 23:00 UTC.
  store.ejecuciones.guardar(ejec('utc', 'c1', '2026-09-20T23:00:00.000Z'));
  store.ejecuciones.guardar(ejec('chile', 'c1', '2026-09-20T21:30:00-03:00'));
  assert.equal(store.ejecuciones.ultimaDe('c1').id, 'chile');
  assert.equal(store.ejecuciones.obtener('chile').inicio, '2026-09-20T21:30:00-03:00', 'el objeto conserva el valor original');
  assert.equal(store.ejecuciones.ultimaDe('sin-rondas'), null);
  store.cerrar();
});

test('notificaciones: agregar y leer las últimas del condominio con LIMIT', () => {
  const { store } = nuevo();
  for (let i = 0; i < 60; i++) {
    store.notificaciones.agregar({ ts: `2026-09-20T10:${String(i).padStart(2, '0')}:00Z`, condominioId: i % 2 ? 'c2' : 'c1', texto: `n${i}` });
  }
  const ultimas = store.notificaciones.ultimas('c1', 5);
  assert.deepEqual(ultimas.map(n => n.texto), ['n58', 'n56', 'n54', 'n52', 'n50']);
  assert.equal(store.notificaciones.ultimas('c2').length, 30);
  assert.equal(store.notificaciones.contar(), 60);
  store.cerrar();
});

test('transacción: si algo falla no queda nada escrito', () => {
  const { store } = nuevo();
  assert.throws(() => store.transaccion(() => {
    store.ejecuciones.guardar(ejec('t1', 'c1', '2026-09-20T10:00:00Z'));
    store.notificaciones.agregar({ condominioId: 'c1', texto: 'x' });
    throw new Error('falla a mitad');
  }), /falla a mitad/);
  assert.equal(store.ejecuciones.obtener('t1'), null);
  assert.equal(store.notificaciones.contar(), 0);
  // Anidada: se suma a la de afuera.
  store.transaccion(() => {
    store.ejecuciones.guardar(ejec('t2', 'c1', '2026-09-20T10:00:00Z'));
    store.transaccion(() => store.notificaciones.agregar({ condominioId: 'c1', texto: 'y' }));
  });
  assert.ok(store.ejecuciones.obtener('t2'));
  assert.equal(store.notificaciones.contar(), 1);
  store.cerrar();
});

test('transacción: no acepta funciones asíncronas', async () => {
  const { store } = nuevo();
  assert.throws(() => store.transaccion(async () => {
    store.ejecuciones.guardar(ejec('t3', 'c1', '2026-09-20T10:00:00Z'));
  }), /asíncronas/);
  assert.equal(store.ejecuciones.obtener('t3'), null, 'se deshizo');
  store.cerrar();
});

test('respaldar() deja una copia consistente que se abre como base', () => {
  const { ruta, store } = nuevo();
  store.db.condominios.push({ id: 'c1' });
  store.guardar();
  store.ejecuciones.guardar(ejec('r1', 'c1', '2026-09-20T10:00:00Z'));
  const destino = path.join(path.dirname(ruta), 'respaldos', 'copia.sqlite');
  store.respaldar(destino);
  store.cerrar();
  const copia = crearStore(destino, { sinPuente: true });
  assert.deepEqual(copia.db.condominios, [{ id: 'c1' }]);
  assert.equal(copia.ejecuciones.obtener('r1').id, 'r1');
  copia.cerrar();
});

test('puente transitorio: store.db.ejecuciones y los repositorios ven lo mismo', () => {
  const { ruta, store } = nuevo({});
  store.db.ejecuciones.push(ejec('p1', 'c1', '2026-09-20T10:00:00Z'));
  store.db.notificaciones.push({ condominioId: 'c1', texto: 'vieja' });
  store.guardar();
  assert.equal(store.ejecuciones.obtener('p1').id, 'p1');
  store.ejecuciones.guardar(ejec('p2', 'c1', '2026-09-21T10:00:00Z'));
  store.notificaciones.agregar({ condominioId: 'c1', texto: 'nueva' });
  assert.ok(store.db.ejecuciones.some(e => e.id === 'p2'));
  store.guardar();
  assert.equal(store.notificaciones.contar(), 2, 'la agregada por el repositorio no se duplica');
  store.cerrar();
  const otra = crearStore(ruta, {});
  assert.deepEqual(otra.db.ejecuciones.map(e => e.id), ['p1', 'p2']);
  assert.deepEqual(otra.db.notificaciones.map(n => n.texto), ['vieja', 'nueva']);
  otra.cerrar();
});
