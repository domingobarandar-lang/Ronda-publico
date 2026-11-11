// Importación automática de db.json a SQLite al arrancar (v1.17).
// Una transacción, conteos verificados, el .json se renombra (no se borra), y
// si algo falla el store lanza —el servidor no arranca— sin tocar el .json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const { datosSemilla, sembrar, estaVacia } = require('../seed');

const silencio = { log: () => {} };
const carpeta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-import-'));

// Un db.json como el de producción: configuración, ejecuciones con escaneos,
// GPS y rechazos, notificaciones de los dos medios, sesiones y claves VAPID.
function jsonDePrueba() {
  const db = datosSemilla();
  db.ejecuciones = [];
  db.notificaciones = [];
  for (let i = 0; i < 40; i++) {
    const condominioId = i % 3 ? 'aromos' : 'mirador';
    db.ejecuciones.push({
      id: `ejec-${String(i).padStart(4, '0')}`,
      rondaId: 'r-nocturna', condominioId, guardiaId: 'u-pedro',
      inicio: new Date(Date.UTC(2026, 8, 1 + (i % 20), 3, i)).toISOString(),
      fin: i % 5 ? new Date(Date.UTC(2026, 8, 1 + (i % 20), 4, i)).toISOString() : null,
      estado: i % 5 ? (i % 7 ? 'completa' : 'incompleta') : 'en_curso',
      escaneos: [{ puntoId: 'p1', ts: '2026-09-01T03:05:00.000Z', offline: i % 2 === 0, gps: { lat: -33.4 - i / 1000, lon: -70.6, acc: 12 } }],
      rechazos: i % 4 ? undefined : [{ puntoId: 'p2', ts: '2026-09-01T03:06:00.000Z', motivo: 'lejos', distanciaM: 80, topeM: 40, acc: 20, edadMs: 1000 }],
      evaluacion: i % 5 ? { faltantes: [], sospechas: [], duracionMin: 60 } : null
    });
  }
  for (let i = 0; i < 25; i++) {
    db.notificaciones.push({ ts: `2026-09-${String(1 + i).padStart(2, '0')}T05:00:00.000Z`, condominioId: i % 2 ? 'aromos' : 'mirador', texto: `aviso ${i}\ncon salto`, medio: i % 3 ? 'registro' : 'push', enviada: true });
  }
  db.sesiones = { ['t'.repeat(48)]: { usuarioId: 'u-pedro', creada: '2026-09-27T10:00:00.000Z' } };
  db.vapid = { publicKey: 'pub', privateKey: 'priv' };
  db.informeEmailEstado = { 'admin@ejemplo.cl': '2026-09-21' };
  return JSON.parse(JSON.stringify(db)); // lo mismo que sale de leer el archivo
}

// Lo que el store tiene, armado con la misma forma que un db.json.
function volcado(store) {
  const salida = {};
  for (const fila of store.sql.prepare('SELECT clave, valor FROM estado').all()) salida[fila.clave] = JSON.parse(fila.valor);
  salida.ejecuciones = store.sql.prepare('SELECT datos FROM ejecuciones ORDER BY rowid').all().map(f => JSON.parse(f.datos));
  salida.notificaciones = store.sql.prepare('SELECT datos FROM notificaciones ORDER BY id').all().map(f => JSON.parse(f.datos));
  return salida;
}

function compararConJson(store, original) {
  const hay = volcado(store);
  for (const clave of Object.keys(original)) {
    assert.deepEqual(hay[clave], original[clave], `la clave "${clave}" no quedó idéntica`);
  }
  for (const e of original.ejecuciones || []) assert.deepEqual(store.ejecuciones.obtener(e.id), e);
}

test('importa un db.json completo: objetos idénticos, conteos y .json renombrado', () => {
  const dir = carpeta();
  const rutaJson = path.join(dir, 'db.json');
  const original = jsonDePrueba();
  fs.writeFileSync(rutaJson, JSON.stringify(original, null, 2));
  const mensajes = [];
  const store = crearStore(rutaJson, { log: m => mensajes.push(m) });

  assert.equal(store.ruta, path.join(dir, 'rondas.sqlite'));
  compararConJson(store, original);
  assert.deepEqual(store.db.usuarios, original.usuarios, 'store.db quedó cargado');
  assert.deepEqual(store.db.vapid, original.vapid);
  assert.equal(store.ejecuciones.contar(), 40);
  assert.equal(store.notificaciones.contar(), 25);

  assert.ok(!fs.existsSync(rutaJson), 'el .json se aparta');
  const apartado = fs.readdirSync(dir).find(f => f.startsWith('db.json.migrado-'));
  assert.ok(apartado, 'y queda como db.json.migrado-<fecha>, no se borra');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, apartado), 'utf8')), original);
  assert.ok(mensajes.some(m => /40 ejecuciones, 25 notificaciones/.test(m)), 'el log dice qué importó');
  store.cerrar();
});

test('idempotente: el segundo arranque no reimporta aunque aparezca otro db.json', () => {
  const dir = carpeta();
  const rutaJson = path.join(dir, 'db.json');
  fs.writeFileSync(rutaJson, JSON.stringify(jsonDePrueba()));
  const primero = crearStore(rutaJson, silencio);
  primero.ejecuciones.guardar({ ...primero.ejecuciones.obtener('ejec-0001'), estado: 'modificada-despues' });
  primero.cerrar();

  // Alguien restaura un db.json viejo a mano: no puede pisar la base.
  fs.writeFileSync(rutaJson, JSON.stringify({ usuarios: [], ejecuciones: [] }));
  const segundo = crearStore(rutaJson, silencio);
  assert.equal(segundo.ejecuciones.contar(), 40);
  assert.equal(segundo.ejecuciones.obtener('ejec-0001').estado, 'modificada-despues');
  assert.ok(segundo.db.usuarios.length > 0);
  assert.ok(fs.existsSync(rutaJson), 'el .json nuevo no se toca');
  segundo.cerrar();
});

for (const [caso, contenido] of [
  ['JSON cortado a la mitad', '{"usuarios": [{"id": "u1"}], "ejecuciones": [{"id": '],
  ['una ejecución sin id', JSON.stringify({ usuarios: [], ejecuciones: [{ condominioId: 'c1' }] })],
  ['un .json que no es un objeto', '[1, 2, 3]']
]) {
  test(`importación fallida (${caso}): lanza, no deja nada a medias y el .json queda intacto`, () => {
    const dir = carpeta();
    const rutaJson = path.join(dir, 'db.json');
    fs.writeFileSync(rutaJson, contenido);
    assert.throws(() => crearStore(rutaJson, silencio), /No se pudo importar .*el servidor no arranca/s);
    assert.equal(fs.readFileSync(rutaJson, 'utf8'), contenido, 'el .json sigue ahí, sin cambios');
    assert.ok(!fs.readdirSync(dir).some(f => f.includes('migrado')));

    // La base quedó sin versión ni datos: el próximo arranque reintenta.
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(path.join(dir, 'rondas.sqlite'));
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM meta WHERE clave = 'version'").get().n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM estado').get().n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM ejecuciones').get().n, 0);
    sql.close();

    // Arreglado el .json, arranca e importa.
    fs.writeFileSync(rutaJson, JSON.stringify(jsonDePrueba()));
    const store = crearStore(rutaJson, silencio);
    assert.equal(store.ejecuciones.contar(), 40);
    store.cerrar();
  });
}

test('ids de ejecución repetidos: se conserva la primera, como leía la versión anterior', () => {
  const dir = carpeta();
  const rutaJson = path.join(dir, 'db.json');
  const datos = jsonDePrueba();
  datos.ejecuciones.push({ ...datos.ejecuciones[0], estado: 'copia-tardia' });
  fs.writeFileSync(rutaJson, JSON.stringify(datos));
  const mensajes = [];
  const store = crearStore(rutaJson, { log: m => mensajes.push(m) });
  assert.equal(store.ejecuciones.contar(), 40);
  assert.equal(store.ejecuciones.obtener(datos.ejecuciones[0].id).estado, datos.ejecuciones[0].estado);
  assert.ok(mensajes.some(m => /1 ejecuciones con id repetido/.test(m)));
  store.cerrar();
});

test('seed --si-vacio mira el contenido: después de importar y renombrar el .json no siembra encima', () => {
  const dir = carpeta();
  const rutaJson = path.join(dir, 'db.json');
  const original = jsonDePrueba();
  original.usuarios = original.usuarios.filter(u => u.id === 'u-pedro');
  fs.writeFileSync(rutaJson, JSON.stringify(original));
  const antes = process.env.DB_PATH;
  process.env.DB_PATH = rutaJson;
  const log = console.log;
  console.log = () => {};
  try {
    // Así arranca Railway: seed --si-vacio y después el servidor. Dos deploys.
    delete require.cache[require.resolve('../seed')];
    const seed = require('../seed');
    assert.equal(seed.sembrar({ soloSiVacio: true }), false, 'primer deploy: importa y no siembra');
    assert.ok(!fs.existsSync(rutaJson));
    assert.equal(seed.sembrar({ soloSiVacio: true }), false, 'segundo deploy: sin db.json, pero la base tiene datos');
  } finally {
    console.log = log;
    if (antes === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = antes;
    delete require.cache[require.resolve('../seed')];
  }
  const store = crearStore(path.join(dir, 'rondas.sqlite'), silencio);
  assert.deepEqual(store.db.usuarios.map(u => u.id), ['u-pedro'], 'los usuarios de producción siguen, sin la demo encima');
  assert.equal(estaVacia(store), false);
  store.cerrar();
  assert.equal(typeof sembrar, 'function');
});

// Con la copia real de producción (app/data/db-produccion.json, fuera de git):
// la importación tiene que dar objetos idénticos. No se imprime nada de su
// contenido: trae hashes de PIN, tokens, claves y GPS.
const rutaReal = process.env.DB_REAL || path.join(__dirname, '..', 'data', 'db-produccion.json');
test('importación de la copia real de producción', { skip: !fs.existsSync(rutaReal) && 'no está app/data/db-produccion.json' }, () => {
  const dir = carpeta();
  const rutaJson = path.join(dir, 'db.json');
  fs.copyFileSync(rutaReal, rutaJson);
  const original = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
  const store = crearStore(rutaJson, silencio);
  try {
    const ids = new Set((original.ejecuciones || []).map(e => e.id));
    assert.equal(store.ejecuciones.contar(), ids.size);
    assert.equal(store.notificaciones.contar(), (original.notificaciones || []).length);
    const hay = volcado(store);
    for (const clave of Object.keys(original).filter(c => c !== 'ejecuciones')) {
      assert.ok(JSON.stringify(hay[clave]) === JSON.stringify(original[clave]), `la clave "${clave}" no quedó idéntica`);
    }
    const vistas = new Set();
    for (const e of original.ejecuciones || []) {
      if (vistas.has(e.id)) continue; // con id repetido vale la primera
      vistas.add(e.id);
      assert.ok(JSON.stringify(store.ejecuciones.obtener(e.id)) === JSON.stringify(e), `la ejecución ${e.id} no quedó idéntica`);
    }
  } finally {
    store.cerrar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
