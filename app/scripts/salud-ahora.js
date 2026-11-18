#!/usr/bin/env node
// Manda AHORA el correo de salud de los lunes (lib/salud-semanal.js) a
// SALUD_TO, sin esperar el lunes. Sirve para comprobar el día del deploy, o
// después de cambiar SALUD_TO, que el correo llega y se lee bien.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/salud-ahora.js            # lo manda a SALUD_TO
//   node scripts/salud-ahora.js --mostrar  # solo lo muestra en la consola
// En Railway (la base está en el volumen):
//   railway ssh -- node scripts/salud-ahora.js
//
// No cuenta como el envío del lunes: el programado sale igual.
const fs = require('fs');
const path = require('path');
const { cargarEnv } = require('../lib/env');
const { crearStore, resolverRutas } = require('../lib/store');
const { crearLectorSentry } = require('../lib/sentry-lectura');
const saludSemanal = require('../lib/salud-semanal');

cargarEnv(path.join(__dirname, '..'));

async function main() {
  const rutas = resolverRutas(process.env.DB_PATH);
  if (!fs.existsSync(rutas.sqlite)) throw new Error(`No existe la base ${rutas.sqlite}. Revisa DB_PATH.`);
  const store = crearStore(rutas.sqlite);
  try {
    const lectorSentry = crearLectorSentry();
    if (process.argv.includes('--mostrar')) {
      const c = await saludSemanal.armar(store, { lectorSentry });
      console.log(`Asunto: ${c.subject}\n\n${c.texto}`);
      return;
    }
    const r = await saludSemanal.revisar(store, { forzar: true, lectorSentry });
    if (!r) throw new Error('SALUD_TO está vacío: no hay a quién mandarlo.');
    if (!r.enviada) throw new Error(r.error || 'no se pudo mandar');
  } finally {
    store.cerrar();
  }
}

main().catch(err => {
  console.error(`[salud-ahora] ${err.message}`);
  process.exitCode = 1;
});
