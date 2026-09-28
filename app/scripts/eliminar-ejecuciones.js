#!/usr/bin/env node
// Borra ejecuciones de ronda (las que salen en la pestaña de rondas hechas del
// panel) que quedaron mal: "En curso" colgadas o pruebas. No hay botón en el
// panel a propósito; esto se hace a mano y con cuidado.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/eliminar-ejecuciones.js                 → solo LISTA candidatas
//   node scripts/eliminar-ejecuciones.js --borrar ID...  → borra esas IDs
// En Railway (la base está en el volumen):
//   railway ssh -- node scripts/eliminar-ejecuciones.js
//   railway ssh -- node scripts/eliminar-ejecuciones.js --borrar abc123 def456
//
// Lista todas las "en curso" y las incompletas de los últimos 3 días. Antes de
// borrar deja una foto de la base en <dir de la base>/respaldos/. No hace falta
// reiniciar: el servidor lee las ejecuciones de la base en cada consulta.
const fs = require('fs');
const path = require('path');
const { cargarEnv } = require('../lib/env');
const { crearStore, resolverRutas } = require('../lib/store');
const { TZ, isoChile, sumarDias, inicioDiaChile } = require('../lib/fechas-chile');

cargarEnv(path.join(__dirname, '..'));

const horaLocal = ts => ts
  ? new Date(ts).toLocaleString('es-CL', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })
  : '—';

function describir(store, e) {
  const { db } = store;
  const ronda = db.rondas.find(r => r.id === e.rondaId) || {};
  const guardia = db.usuarios.find(u => u.id === e.guardiaId) || {};
  const condo = (db.condominios || []).find(c => c.id === e.condominioId) || {};
  const minutos = Math.round((Date.now() - Date.parse(e.inicio)) / 60000);
  const aviso = e.estado === 'en_curso' && minutos < 120 ? '  ⚠️ empezó hace menos de 2 h, puede estar activa' : '';
  return `  ${e.id}  ${e.estado.padEnd(10)} ${horaLocal(e.inicio).padEnd(18)} `
    + `${guardia.nombre || guardia.usuario || '(guardia eliminado)'} · ${ronda.nombre || '(ronda eliminada)'} · `
    + `${condo.nombre || e.condominioId} · ${(e.escaneos || []).length}/${(ronda.puntoIds || []).length} puntos${aviso}`;
}

function main() {
  const rutas = resolverRutas(process.env.DB_PATH);
  if (!fs.existsSync(rutas.sqlite)) throw new Error(`No existe la base ${rutas.sqlite}. Revisa DB_PATH.`);
  const store = crearStore(rutas.sqlite);
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--borrar') {
      const enCurso = store.ejecuciones.listar({ estado: 'en_curso' });
      const desde = inicioDiaChile(sumarDias(isoChile(Date.now()), -2));
      const incompletas = store.ejecuciones.listar({ estado: 'incompleta', desde });
      console.log(`En curso (${enCurso.length}):`);
      enCurso.forEach(e => console.log(describir(store, e)));
      console.log(`\nIncompletas de los últimos 3 días (${incompletas.length}):`);
      incompletas.forEach(e => console.log(describir(store, e)));
      console.log('\nNo se borró nada. Para borrar: --borrar ID1 ID2 ...');
      return;
    }

    const ids = args.slice(1);
    if (!ids.length) throw new Error('Faltan las IDs a borrar.');
    const encontradas = ids.map(id => store.ejecuciones.obtener(id));
    const faltan = ids.filter((id, i) => !encontradas[i]);
    if (faltan.length) throw new Error(`No existen: ${faltan.join(', ')}. No se borró nada.`);

    const sello = new Date().toISOString().replace(/[:.]/g, '-');
    const foto = store.respaldar(path.join(path.dirname(rutas.sqlite), 'respaldos', `antes-de-borrar-${sello}.sqlite`));
    console.log(`Foto de la base antes de borrar: ${foto}\n`);

    store.transaccion(() => {
      for (const e of encontradas) {
        store.ejecuciones.eliminar(e.id);
        console.log(`Borrada:${describir(store, e).replace(/^ +/, ' ')}`);
      }
    });
    console.log(`\n${encontradas.length} ejecución(es) borrada(s).`);
  } finally {
    store.cerrar();
  }
}

try {
  main();
} catch (err) {
  console.error(`[eliminar-ejecuciones] ${err.message}`);
  process.exitCode = 1;
}
