#!/usr/bin/env node
// Hace el respaldo del día AHORA (foto en el volumen + correo a RESPALDO_TO),
// sin esperar la hora programada. Sirve para comprobar, el día del deploy o
// después de cambiar RESPALDO_TO, que el correo con el .sqlite.gz llega.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/respaldo-ahora.js
// En Railway (la base está en el volumen):
//   railway ssh -- node scripts/respaldo-ahora.js
//
// Si la foto de hoy ya existe no se rehace (VACUUM INTO es una foto
// consistente; la del día ya sirve), pero el correo sale de nuevo.
const fs = require('fs');
const { cargarEnv } = require('../lib/env');
const { crearStore, resolverRutas } = require('../lib/store');
const { ahoraChile } = require('../lib/programador');
const respaldo = require('../lib/respaldo');

cargarEnv(require('path').join(__dirname, '..'));

async function main() {
  const rutas = resolverRutas(process.env.DB_PATH);
  if (!fs.existsSync(rutas.sqlite)) throw new Error(`No existe la base ${rutas.sqlite}. Revisa DB_PATH.`);
  const store = crearStore(rutas.sqlite);
  try {
    const r = await respaldo.revisar(store, { ahora: ahoraChile(), forzar: true });
    if (!r || r.error) throw new Error(r ? r.error : 'no se hizo el respaldo');
    if (r.correo && !r.correo.enviada) process.exitCode = 1;
  } finally {
    store.cerrar();
  }
}

main().catch(err => {
  console.error(`[respaldo-ahora] ${err.message}`);
  process.exitCode = 1;
});
