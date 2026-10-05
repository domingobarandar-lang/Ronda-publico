// Persistencia sobre SQLite (node:sqlite, incluido en Node 24: sin dependencias
// nativas que compilar en Railway). Un solo archivo en el volumen, modo WAL.
//
// Diseño híbrido por tamaño de colección (ver entrega/PLAN-SQLITE.md):
//   - Lo chico y acotado (condominios, usuarios, puntos, rondas, sesiones,
//     pushSuscripciones, vapid, informeEmailEstado…) sigue EN MEMORIA en
//     `store.db`, igual que con db.json. Se persiste en la tabla `estado`, una
//     fila por clave con su JSON, y `guardar()` solo escribe las claves cuyo
//     JSON cambió. Así las lecturas de configuración del resto del código
//     (db.usuarios.find, db.puntos.filter…) no cambian.
//   - Lo que crece sin techo (ejecuciones, notificaciones) vive en tablas
//     propias y se lee y escribe por fila con los repositorios
//     `store.ejecuciones` y `store.notificaciones`.
//
// Todo es SÍNCRONO a propósito: un request no puede quedar a medias entre leer
// una ejecución y guardarla (ver el invariante 1 del plan).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const VERSION_ESQUEMA = '1';

// Colecciones que viven en `store.db`. Cualquier otra clave que el código
// agregue (p. ej. informeEmailEstado) también se persiste en `estado`.
const VACIA = () => ({
  condominios: [],
  usuarios: [],
  puntos: [],
  rondas: [],
  sesiones: {},
  pushSuscripciones: [],
  vapid: null
});

// Las que tienen tabla propia y NUNCA van a `estado`.
const CON_TABLA = ['ejecuciones', 'notificaciones'];

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS estado (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ejecuciones (
    id TEXT PRIMARY KEY,
    condominio_id TEXT NOT NULL,
    ronda_id TEXT,
    guardia_id TEXT,
    inicio TEXT,
    fin TEXT,
    estado TEXT,
    datos TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ejec_condo_inicio ON ejecuciones(condominio_id, inicio);
  CREATE INDEX IF NOT EXISTS ejec_en_curso ON ejecuciones(condominio_id) WHERE estado = 'en_curso';
  CREATE TABLE IF NOT EXISTS notificaciones (
    id INTEGER PRIMARY KEY,
    condominio_id TEXT,
    ts TEXT,
    datos TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notif_condo ON notificaciones(condominio_id, id);
  CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);
`;

// DB_PATH puede apuntar al .sqlite o, como hasta la v1.16, al db.json. En el
// segundo caso se usa `rondas.sqlite` en la misma carpeta y el .json queda como
// origen de la importación: así el día del deploy no hay que tocar Railway.
function resolverRutas(ruta) {
  const pedida = ruta || path.join(__dirname, '..', 'data', 'rondas.sqlite');
  const dir = path.dirname(pedida);
  if (/\.json$/i.test(pedida)) return { sqlite: path.join(dir, 'rondas.sqlite'), json: pedida };
  return { sqlite: pedida, json: path.join(dir, 'db.json') };
}

// La columna `inicio` se guarda normalizada a ISO UTC para que ordenar y
// filtrar por texto sea correcto aunque el teléfono mande otra zona horaria.
// El objeto (columna `datos`) conserva el valor original tal cual.
function isoNormal(ts) {
  if (ts == null || ts === '') return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? String(ts) : new Date(t).toISOString();
}

const sello = () => new Date().toISOString().replace(/[:.]/g, '-');

// Restauración pendiente: scripts/restaurar-respaldo.js deja la base validada
// en `<sqlite>.restaurar` y el cambio se hace acá, al arrancar, cuando nadie
// tiene la base abierta. La actual no se borra: queda como
// `<sqlite>.antes-restaurar-<fecha>` (con su -wal, si lo tiene).
function aplicarRestauracion(rutaSqlite, log) {
  const pendiente = `${rutaSqlite}.restaurar`;
  if (!fs.existsSync(pendiente)) return null;
  let apartada = null;
  if (fs.existsSync(rutaSqlite)) {
    apartada = `${rutaSqlite}.antes-restaurar-${sello()}`;
    fs.renameSync(rutaSqlite, apartada);
    for (const sufijo of ['-wal', '-shm']) {
      if (fs.existsSync(rutaSqlite + sufijo)) fs.renameSync(rutaSqlite + sufijo, apartada + sufijo);
    }
  }
  fs.renameSync(pendiente, rutaSqlite);
  log(`[store] RESTAURADO un respaldo en ${rutaSqlite}`
    + (apartada ? `; la base anterior quedó como ${path.basename(apartada)}` : ''));
  return { apartada };
}

function crearStore(rutaArchivo, opciones = {}) {
  const log = opciones.log || console.log;
  const rutas = resolverRutas(rutaArchivo);
  fs.mkdirSync(path.dirname(rutas.sqlite), { recursive: true });
  const restauracion = aplicarRestauracion(rutas.sqlite, log);
  const sql = new DatabaseSync(rutas.sqlite);
  sql.exec('PRAGMA journal_mode = WAL');
  sql.exec('PRAGMA synchronous = NORMAL');
  sql.exec('PRAGMA busy_timeout = 5000');
  sql.exec(ESQUEMA);

  // ---------- Transacciones ----------
  // Reentrante: una transacción dentro de otra se suma a la de afuera. `fn`
  // tiene que ser síncrona: una promesa en medio dejaría la transacción
  // abierta mientras otros requests escriben.
  let profundidad = 0;
  let alConfirmar = [];
  function transaccion(fn) {
    if (profundidad > 0) return fn();
    sql.exec('BEGIN IMMEDIATE');
    profundidad++;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        throw new Error('store.transaccion() no acepta funciones asíncronas.');
      }
      profundidad--;
      sql.exec('COMMIT');
      const pendientes = alConfirmar;
      alConfirmar = [];
      for (const f of pendientes) f();
      return r;
    } catch (err) {
      profundidad--;
      alConfirmar = [];
      sql.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- Sentencias ----------
  const st = {
    meta: sql.prepare('SELECT valor FROM meta WHERE clave = ?'),
    metaPoner: sql.prepare('INSERT INTO meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'),
    estadoTodo: sql.prepare('SELECT clave, valor FROM estado'),
    estadoUno: sql.prepare('SELECT valor FROM estado WHERE clave = ?'),
    estadoPoner: sql.prepare('INSERT INTO estado (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'),
    estadoQuitar: sql.prepare('DELETE FROM estado WHERE clave = ?'),
    ejecObtener: sql.prepare('SELECT datos FROM ejecuciones WHERE id = ?'),
    ejecPoner: sql.prepare(`
      INSERT INTO ejecuciones (id, condominio_id, ronda_id, guardia_id, inicio, fin, estado, datos)
      VALUES ($id, $condominio, $ronda, $guardia, $inicio, $fin, $estado, $datos)
      ON CONFLICT(id) DO UPDATE SET
        condominio_id = excluded.condominio_id, ronda_id = excluded.ronda_id,
        guardia_id = excluded.guardia_id, inicio = excluded.inicio, fin = excluded.fin,
        estado = excluded.estado, datos = excluded.datos`),
    ejecQuitar: sql.prepare('DELETE FROM ejecuciones WHERE id = ?'),
    ejecQuitarCondo: sql.prepare('DELETE FROM ejecuciones WHERE condominio_id = ?'),
    ejecDeGuardia: sql.prepare('SELECT datos FROM ejecuciones WHERE guardia_id = ? ORDER BY rowid'),
    ejecUltima: sql.prepare('SELECT datos FROM ejecuciones WHERE condominio_id = ? ORDER BY inicio DESC LIMIT 1'),
    ejecContar: sql.prepare('SELECT COUNT(*) AS n FROM ejecuciones'),
    ejecContarCondo: sql.prepare('SELECT COUNT(*) AS n FROM ejecuciones WHERE condominio_id = ?'),
    ejecTodas: sql.prepare('SELECT datos FROM ejecuciones ORDER BY rowid'),
    notifPoner: sql.prepare('INSERT INTO notificaciones (condominio_id, ts, datos) VALUES (?, ?, ?)'),
    notifUltimas: sql.prepare('SELECT datos FROM notificaciones WHERE condominio_id = ? ORDER BY id DESC LIMIT ?'),
    notifQuitarCondo: sql.prepare('DELETE FROM notificaciones WHERE condominio_id = ?'),
    notifContar: sql.prepare('SELECT COUNT(*) AS n FROM notificaciones'),
    notifContarCondo: sql.prepare('SELECT COUNT(*) AS n FROM notificaciones WHERE condominio_id = ?'),
    notifTodas: sql.prepare('SELECT datos FROM notificaciones ORDER BY id'),
    notifDeCondo: sql.prepare('SELECT id, datos FROM notificaciones WHERE condominio_id = ? ORDER BY id'),
    notifReemplazar: sql.prepare('UPDATE notificaciones SET datos = ? WHERE id = ?')
  };

  // ---------- Repositorio de ejecuciones ----------
  // Cada lectura devuelve una COPIA nueva del objeto: quien la modifique tiene
  // que llamar a guardar(e) antes de su primer `await`.
  function filaEjecucion(e) {
    if (!e || !e.id) throw new Error('La ejecución necesita id.');
    return {
      $id: String(e.id),
      $condominio: String(e.condominioId ?? ''),
      $ronda: e.rondaId ?? null,
      $guardia: e.guardiaId ?? null,
      $inicio: isoNormal(e.inicio),
      $fin: isoNormal(e.fin),
      $estado: e.estado ?? null,
      $datos: JSON.stringify(e)
    };
  }

  const ejecuciones = {
    obtener(id) {
      const fila = st.ejecObtener.get(String(id));
      return fila ? JSON.parse(fila.datos) : null;
    },
    // Upsert de UNA ejecución.
    guardar(e) {
      st.ejecPoner.run(filaEjecucion(e));
      return e;
    },
    // Filtros opcionales: condominioId, desde (inclusive) / hasta (exclusive)
    // sobre el inicio en ISO UTC, estado, estadoDistintoDe, limite. Ordena por
    // inicio, la más reciente primero.
    listar({ condominioId, desde, hasta, estado, estadoDistintoDe, limite } = {}) {
      const donde = [];
      const params = {};
      if (condominioId != null) { donde.push('condominio_id = $condominio'); params.$condominio = String(condominioId); }
      if (desde) { donde.push('inicio >= $desde'); params.$desde = String(desde); }
      if (hasta) { donde.push('inicio < $hasta'); params.$hasta = String(hasta); }
      if (estado) { donde.push('estado = $estado'); params.$estado = String(estado); }
      if (estadoDistintoDe) { donde.push('(estado IS NULL OR estado <> $distinto)'); params.$distinto = String(estadoDistintoDe); }
      let consulta = 'SELECT datos FROM ejecuciones';
      if (donde.length) consulta += ' WHERE ' + donde.join(' AND ');
      consulta += ' ORDER BY inicio DESC, id DESC';
      if (limite) { consulta += ' LIMIT $limite'; params.$limite = Math.max(1, Math.floor(Number(limite)) || 1); }
      return sql.prepare(consulta).all(params).map(f => JSON.parse(f.datos));
    },
    ultimaDe(condominioId) {
      const fila = st.ejecUltima.get(String(condominioId));
      return fila ? JSON.parse(fila.datos) : null;
    },
    contar(condominioId) {
      return condominioId == null ? st.ejecContar.get().n : st.ejecContarCondo.get(String(condominioId)).n;
    },
    eliminar(id) {
      return st.ejecQuitar.run(String(id)).changes > 0;
    },
    // Para las purgas de un condominio completo. Devuelve cuántas borró.
    eliminarDeCondominio(condominioId) {
      return Number(st.ejecQuitarCondo.run(String(condominioId)).changes);
    },
    // Todas las de un guardia (para anonimizarlas cuando borra su cuenta). Sin
    // índice por guardia a propósito: pasa una vez por cuenta borrada.
    deGuardia(guardiaId) {
      return st.ejecDeGuardia.all(String(guardiaId)).map(f => JSON.parse(f.datos));
    }
  };

  // ---------- Repositorio de notificaciones ----------
  const notificaciones = {
    agregar(n) {
      st.notifPoner.run(n.condominioId ?? null, n.ts ?? null, JSON.stringify(n));
      return n;
    },
    // Las últimas `limite` del condominio, la más reciente primero.
    ultimas(condominioId, limite = 50) {
      return st.notifUltimas.all(String(condominioId), Math.max(1, Math.floor(Number(limite)) || 1))
        .map(f => JSON.parse(f.datos));
    },
    contar(condominioId) {
      return condominioId == null ? st.notifContar.get().n : st.notifContarCondo.get(String(condominioId)).n;
    },
    eliminarDeCondominio(condominioId) {
      return Number(st.notifQuitarCondo.run(String(condominioId)).changes);
    },
    // Reescribe el texto de los avisos del condominio con `fn(texto)`; guarda
    // solo los que cambiaron y devuelve cuántos fueron.
    reescribirTextos(condominioId, fn) {
      let cambiados = 0;
      for (const fila of st.notifDeCondo.all(String(condominioId))) {
        const n = JSON.parse(fila.datos);
        const nuevo = fn(String(n.texto || ''));
        if (nuevo === n.texto) continue;
        n.texto = nuevo;
        st.notifReemplazar.run(JSON.stringify(n), fila.id);
        cambiados++;
      }
      return cambiados;
    }
  };

  // ---------- Estado en memoria ----------
  const db = VACIA();
  const escrito = new Map(); // clave → último JSON persistido (confirmado)
  for (const { clave, valor } of st.estadoTodo.all()) {
    db[clave] = JSON.parse(valor);
    escrito.set(clave, valor);
  }

  // Persiste solo las claves de `estado` cuyo JSON cambió. Devuelve las claves
  // escritas (vacío si no había nada que guardar). Dentro de una transacción
  // se suma a ella, y lo "ya escrito" recién se anota cuando se confirma: si se
  // deshace, el próximo guardar() lo vuelve a intentar.
  function guardar() {
    const cambios = [];
    for (const clave of Object.keys(db)) {
      if (CON_TABLA.includes(clave) || db[clave] === undefined) continue;
      const valor = JSON.stringify(db[clave]);
      if (escrito.get(clave) !== valor) cambios.push([clave, valor]);
    }
    const quitadas = [...escrito.keys()].filter(c => !(c in db) || db[c] === undefined);
    if (!cambios.length && !quitadas.length) return [];
    const anotar = () => {
      for (const [clave, valor] of cambios) escrito.set(clave, valor);
      for (const clave of quitadas) escrito.delete(clave);
    };
    transaccion(() => {
      for (const [clave, valor] of cambios) st.estadoPoner.run(clave, valor);
      for (const clave of quitadas) st.estadoQuitar.run(clave);
      alConfirmar.push(anotar);
    });
    return [...cambios.map(c => c[0]), ...quitadas];
  }

  // ---------- Esquema e importación desde db.json ----------
  // Base nueva (sin meta.version): se marca con la versión del esquema y, si
  // hay un db.json al lado, se importa TODO en la misma transacción. Si algo
  // falla (JSON roto, conteos que no cuadran) se deshace, el .json queda
  // intacto y crearStore lanza: el servidor no arranca. Mejor caído y con los
  // datos enteros que arriba a medias. El próximo arranque lo vuelve a intentar.
  let importacion = null;
  if (!st.meta.get('version')) {
    const hayJson = fs.existsSync(rutas.json);
    try {
      transaccion(() => {
        if (hayJson) importacion = importarJson(rutas.json);
        st.metaPoner.run('version', VERSION_ESQUEMA);
      });
    } catch (err) {
      sql.close();
      const e = new Error(`No se pudo importar ${rutas.json} a ${rutas.sqlite}: ${err.message}. `
        + 'No se cambió nada: el .json sigue intacto y el servidor no arranca hasta resolverlo.');
      e.cause = err;
      throw e;
    }
    if (importacion) {
      // Recién con la transacción confirmada se aparta el .json (no se borra).
      const destino = `${rutas.json}.migrado-${sello()}`;
      try {
        fs.renameSync(rutas.json, destino);
        importacion.renombradoA = destino;
      } catch (err) {
        // Los datos ya están en SQLite y meta.version impide reimportar: no es
        // motivo para no arrancar, pero hay que saberlo.
        log(`[store] AVISO: importado, pero no se pudo renombrar ${rutas.json}: ${err.message}`);
      }
      const c = importacion.conteos;
      log(`[store] importado ${rutas.json} → ${rutas.sqlite}: ${c.ejecuciones} ejecuciones, `
        + `${c.notificaciones} notificaciones, ${c.usuarios} usuarios, ${c.puntos} puntos`
        + (importacion.renombradoA ? `; el .json quedó como ${path.basename(importacion.renombradoA)}` : ''));
      if (importacion.duplicadas) {
        log(`[store] AVISO: ${importacion.duplicadas} ejecuciones con id repetido en el .json; se conservó la primera (la que leía la versión anterior).`);
      }
    }
  }

  function importarJson(ruta) {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('el .json no es un objeto');
    for (const [clave, valor] of Object.entries(datos)) {
      if (CON_TABLA.includes(clave) || valor === undefined) continue;
      const texto = JSON.stringify(valor);
      st.estadoPoner.run(clave, texto);
      db[clave] = JSON.parse(texto);
      alConfirmar.push(() => escrito.set(clave, texto));
    }
    // Con ids repetidos la versión anterior usaba el primero (Array.find).
    const vistos = new Set();
    let duplicadas = 0;
    for (const e of datos.ejecuciones || []) {
      if (vistos.has(String(e && e.id))) { duplicadas++; continue; }
      st.ejecPoner.run(filaEjecucion(e));
      vistos.add(String(e.id));
    }
    const notifs = datos.notificaciones || [];
    for (const n of notifs) notificaciones.agregar(n);

    // Verificación dentro de la misma transacción: lo que quedó escrito tiene
    // que cuadrar con lo que traía el .json.
    const largoEnTabla = clave => {
      const fila = st.estadoUno.get(clave);
      return fila ? (JSON.parse(fila.valor) || []).length : 0;
    };
    const conteos = {
      ejecuciones: ejecuciones.contar(),
      notificaciones: notificaciones.contar(),
      usuarios: largoEnTabla('usuarios'),
      puntos: largoEnTabla('puntos')
    };
    const esperados = {
      ejecuciones: vistos.size,
      notificaciones: notifs.length,
      usuarios: (datos.usuarios || []).length,
      puntos: (datos.puntos || []).length
    };
    for (const k of Object.keys(esperados)) {
      if (conteos[k] !== esperados[k]) {
        throw new Error(`los conteos no cuadran (${k}: ${esperados[k]} en el .json, ${conteos[k]} en SQLite)`);
      }
    }
    return { conteos, duplicadas };
  }

  // ---------- Exportar, respaldar, cerrar ----------

  // Toda la base con la forma de un db.json (la que lee la v1.16): para volver
  // atrás (scripts/exportar-json.js) y para comparar en los tests. Se lee
  // dentro de una transacción, así es una foto consistente.
  function exportar() {
    return transaccion(() => {
      const salida = {};
      for (const { clave, valor } of st.estadoTodo.all()) salida[clave] = JSON.parse(valor);
      salida.ejecuciones = st.ejecTodas.all().map(f => JSON.parse(f.datos));
      salida.notificaciones = st.notifTodas.all().map(f => JSON.parse(f.datos));
      return salida;
    });
  }

  // Copia consistente de la base aunque haya escrituras en curso.
  function respaldar(destino) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    if (fs.existsSync(destino)) fs.unlinkSync(destino);
    sql.prepare('VACUUM INTO ?').run(destino);
    return destino;
  }

  function conteos() {
    return {
      ejecuciones: ejecuciones.contar(),
      notificaciones: notificaciones.contar(),
      condominios: (db.condominios || []).length,
      usuarios: (db.usuarios || []).length,
      puntos: (db.puntos || []).length,
      rondas: (db.rondas || []).length
    };
  }

  function cerrar() {
    if (sql.isOpen) sql.close();
  }

  return {
    db,
    guardar,
    ejecuciones,
    notificaciones,
    transaccion,
    exportar,
    respaldar,
    conteos,
    cerrar,
    sql,
    ruta: rutas.sqlite,
    rutaJson: rutas.json,
    importacion,
    restauracion
  };
}

module.exports = { crearStore, VACIA, resolverRutas, VERSION_ESQUEMA };
