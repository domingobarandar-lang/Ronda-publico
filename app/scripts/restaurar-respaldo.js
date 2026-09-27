#!/usr/bin/env node
// Restaura un respaldo de la base (el .sqlite.gz que llega por correo o un
// .sqlite de /data/respaldos/).
//
// No reemplaza la base en caliente: el servidor la tiene abierta. Valida el
// respaldo (que se abra, integrity_check, versión de esquema) y lo deja como
// `<base>.restaurar`; el cambio lo hace el servidor en su próximo arranque
// (lib/store.js), y la base que estaba queda apartada como
// `<base>.antes-restaurar-<fecha>`, sin borrarse.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/restaurar-respaldo.js respaldo.sqlite.gz            → solo valida y muestra qué trae
//   node scripts/restaurar-respaldo.js respaldo.sqlite.gz --aplicar  → lo deja listo para el próximo arranque
// Después: reiniciar el servicio (Railway → Restart, o volver a levantar el
// servidor en local). El log de arranque dice "RESTAURADO" y los conteos.
//
// En Railway el respaldo tiene que estar dentro del volumen: los de
// /data/respaldos/ ya están; uno que llegó por correo se sube antes (ver
// entrega/OPERACION.md, "Restaurar un respaldo").
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { resolverRutas } = require('../lib/store');

// Qué trae un archivo de base. Lanza si no es una base de Rondas QR sana.
function inspeccionar(ruta) {
  let sql;
  try {
    sql = new DatabaseSync(ruta, { readOnly: true });
    const integridad = sql.prepare('PRAGMA integrity_check').get();
    if (Object.values(integridad)[0] !== 'ok') throw new Error(`integrity_check: ${Object.values(integridad)[0]}`);
    const version = sql.prepare("SELECT valor FROM meta WHERE clave = 'version'").get();
    if (!version) throw new Error('no tiene versión de esquema (¿es una base de Rondas QR?)');
    const n = tabla => sql.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n;
    const largo = clave => {
      const fila = sql.prepare('SELECT valor FROM estado WHERE clave = ?').get(clave);
      return fila ? (JSON.parse(fila.valor) || []).length : 0;
    };
    const ultima = sql.prepare('SELECT MAX(inicio) AS m FROM ejecuciones').get().m;
    return {
      version: version.valor,
      ejecuciones: n('ejecuciones'),
      notificaciones: n('notificaciones'),
      condominios: largo('condominios'),
      usuarios: largo('usuarios'),
      puntos: largo('puntos'),
      ultimaRonda: ultima || null
    };
  } catch (err) {
    throw new Error(`El respaldo no sirve: ${err.message}`);
  } finally {
    if (sql && sql.isOpen) sql.close();
  }
}

async function restaurar(origen, { rutaDb = process.env.DB_PATH, aplicar = false, log = console.log } = {}) {
  if (!origen || !fs.existsSync(origen)) throw new Error(`No existe el respaldo ${origen || '(falta la ruta)'}.`);
  const destino = resolverRutas(rutaDb).sqlite;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.restaurar.tmp`;
  try {
    if (/\.gz$/i.test(origen)) {
      await pipeline(fs.createReadStream(origen), zlib.createGunzip(), fs.createWriteStream(tmp));
    } else {
      fs.copyFileSync(origen, tmp);
    }
    const info = inspeccionar(tmp);
    log(`Respaldo ${path.basename(origen)}: ${info.ejecuciones} ejecuciones, ${info.notificaciones} notificaciones, `
      + `${info.condominios} condominios, ${info.usuarios} usuarios, ${info.puntos} puntos; última ronda ${info.ultimaRonda || '—'}.`);
    if (!aplicar) {
      fs.unlinkSync(tmp);
      log(`En seco: no se tocó nada. Con --aplicar queda listo para reemplazar ${destino} en el próximo arranque.`);
      return { info, pendiente: null };
    }
    const pendiente = `${destino}.restaurar`;
    fs.renameSync(tmp, pendiente);
    log(`Listo: ${pendiente}. Reinicia el servidor para que se aplique; la base actual quedará apartada, no se borra.`);
    return { info, pendiente };
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw err;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const origen = args.find(a => !a.startsWith('--'));
  restaurar(origen, { aplicar: args.includes('--aplicar') }).catch(err => {
    console.error(`[restaurar-respaldo] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { restaurar, inspeccionar };
