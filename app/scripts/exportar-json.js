#!/usr/bin/env node
// Vuelta atrás: regenera un db.json desde la base SQLite, con la forma exacta
// que lee la v1.16 (la última que guardaba en db.json). Así, si la v1.17 falla
// en producción, se exporta, se redespliega la versión anterior y esta lo lee
// tal cual.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/exportar-json.js                    → escribe db.json al lado de la base
//   node scripts/exportar-json.js --salida otra.json → en otra ruta
//   node scripts/exportar-json.js --forzar           → pisa un db.json que ya exista
// En Railway (la base está en el volumen, se corre dentro del contenedor):
//   railway ssh -- node scripts/exportar-json.js
//
// Con el servidor andando también sirve: se lee en una transacción, así que es
// una foto consistente. Pero lo que se escriba DESPUÉS de exportar no queda en
// el .json: exportar justo antes de redesplegar.
//
// OJO al volver a la v1.17 más adelante: la base SQLite ya tiene versión, así
// que NO reimporta el db.json por su cuenta. Si la v1.16 anduvo un tiempo y
// escribió rondas en el .json, hay que apartar rondas.sqlite antes del deploy
// (mv rondas.sqlite rondas.sqlite.viejo) para que la v1.17 importe ese .json.
//
// El .json trae hashes de PIN, tokens de sesión, la clave VAPID, correos y
// GPS: no se sube a git ni se manda por canales abiertos.
const fs = require('fs');
const path = require('path');
const { crearStore, resolverRutas } = require('../lib/store');

function exportarJson({ rutaDb = process.env.DB_PATH, salida, forzar = false, log = console.log } = {}) {
  const rutas = resolverRutas(rutaDb);
  if (!fs.existsSync(rutas.sqlite)) {
    // Abrir el store crearía una base nueva (e importaría un db.json si lo
    // hay): justo lo contrario de lo que se quiere acá.
    throw new Error(`No existe la base ${rutas.sqlite}. Revisa DB_PATH.`);
  }
  const destino = path.resolve(salida || rutas.json);
  if (fs.existsSync(destino) && !forzar) {
    throw new Error(`Ya existe ${destino}. Usa --forzar para reemplazarlo o --salida para elegir otra ruta.`);
  }
  const store = crearStore(rutas.sqlite, { log });
  let datos;
  try {
    datos = store.exportar();
  } finally {
    store.cerrar();
  }
  const tmp = `${destino}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, destino);
  const conteos = {
    ejecuciones: datos.ejecuciones.length,
    notificaciones: datos.notificaciones.length,
    usuarios: (datos.usuarios || []).length,
    puntos: (datos.puntos || []).length
  };
  log(`Exportado ${rutas.sqlite} → ${destino}: ${conteos.ejecuciones} ejecuciones, `
    + `${conteos.notificaciones} notificaciones, ${conteos.usuarios} usuarios, ${conteos.puntos} puntos.`);
  return { destino, conteos };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--salida');
  try {
    exportarJson({ salida: i >= 0 ? args[i + 1] : undefined, forzar: args.includes('--forzar') });
    console.log('Para volver a la v1.16: redespliega esa versión con DB_PATH apuntando a este .json.');
    console.log('Antes de volver a la v1.17: aparta rondas.sqlite para que importe lo que la v1.16 haya escrito.');
  } catch (err) {
    console.error(`[exportar-json] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { exportarJson };
