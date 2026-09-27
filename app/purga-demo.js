// Purga de las cuentas de demo que quedaron en la base de producción.
//
// POR QUÉ: railway.json arranca con `node seed.js --si-vacio`, así que en el
// primer despliegue (y en cualquier volumen nuevo) se crearon las cuentas de
// prueba con los PIN que están escritos en seed.js y en el README público
// (admin/1234, marta/1111, guardia/5678, pedro/2222, luis/3333). Entre la
// v1.12 y la vuelta del aislamiento entre administradores, CUALQUIER cuenta
// 'admin' veía TODOS los condominios, y admin/1234 abría también Reserva San
// Francisco. Hoy cada una queda en su condominio (solo la cuenta de acceso
// total, ADMIN_TOTAL_*, recorre todos), pero siguen siendo cuentas con PIN
// publicado en git: sobran igual.
//
// CÓMO DECIDE QUÉ BORRAR: no borra por nombre a ciegas. Para cada cuenta de la
// lista comprueba que el PIN siga siendo el publicado. Si alguien ya le cambió
// el PIN, la cuenta se respeta y solo se informa. Así el script no puede borrar
// una cuenta que hoy esté en uso legítimo.
//
// Uso:
//   node purga-demo.js                      → SOLO INFORMA, no toca nada
//   node purga-demo.js --aplicar            → borra las cuentas de demo
//   node purga-demo.js --aplicar --con-condominio
//                                           → además borra el condominio de
//                                             demo "aromos" y todos sus datos
//
// En Railway: DB_PATH ya apunta al volumen persistente. Se corre DENTRO del
// contenedor (la base está en el volumen):
//   railway ssh -- node purga-demo.js            (en seco, para ver qué hay)
//   railway ssh -- node purga-demo.js --aplicar  (para aplicarlo)
// Las rondas y avisos del condominio borrado se eliminan de sus tablas en la
// misma transacción que el resto, así no queda nada a medias.
const { crearStore } = require('./lib/store');
const { verificarPin } = require('./lib/auth');

// Cuentas sembradas por seed.js, con el PIN que quedó publicado en el
// repositorio. Se borran solo si el PIN sigue siendo ese.
const CUENTAS_DEMO = [
  { usuario: 'admin', pin: '1234' },
  { usuario: 'marta', pin: '1111' },
  { usuario: 'guardia', pin: '5678' },
  { usuario: 'pedro', pin: '2222' },
  { usuario: 'luis', pin: '3333' },
  { usuario: 'carmen', pin: '4444' },
  { usuario: 'jorge', pin: '5555' }
];

// Cuentas REALES que nacieron con un PIN publicado en git (migracion-rsf.js
// fija ADMIN_PIN = '1234'). No se borran nunca: solo se avisa para que se les
// cambie el PIN a mano desde /fabrica.
const CUENTAS_A_REVISAR = [
  { usuario: 'admin-piloto', pin: '1234' }
];

const CONDOMINIO_DEMO = 'aromos';

// Trabaja sobre store.db (en memoria). Las ejecuciones y notificaciones viven
// en tablas propias: si `condominioBorrado`, main() las elimina al aplicar.
function purgar(db, { conCondominio = false } = {}) {
  const aBorrar = [];
  const respetadas = [];
  const avisos = [];

  for (const { usuario, pin } of CUENTAS_DEMO) {
    const u = db.usuarios.find(x => x.usuario === usuario);
    if (!u) continue;
    if (verificarPin(pin, u.pinHash)) {
      aBorrar.push(u);
    } else {
      // Alguien ya le cambió el PIN: la cuenta puede estar en uso de verdad.
      respetadas.push(u);
    }
  }

  for (const { usuario, pin } of CUENTAS_A_REVISAR) {
    const u = db.usuarios.find(x => x.usuario === usuario);
    if (u && verificarPin(pin, u.pinHash)) {
      avisos.push(`⚠️  "${u.usuario}" (${u.rol}) TODAVÍA tiene el PIN ${pin} que está escrito en migracion-rsf.js. `
                + `No se borra porque es una cuenta real: cámbiale el PIN desde /fabrica.`);
    }
  }

  // Red de seguridad: nunca dejar la base sin ninguna cuenta de panel. Si al
  // borrar no queda ningún 'admin', no se borra nada y se explica por qué.
  const idsABorrar = new Set(aBorrar.map(u => u.id));
  const adminsQueQuedan = db.usuarios.filter(u => u.rol === 'admin' && !idsABorrar.has(u.id));
  if (aBorrar.length && !adminsQueQuedan.length) {
    return {
      bloqueado: 'Al borrar estas cuentas no quedaría ninguna cuenta de panel y nadie podría entrar. '
               + 'Crea primero un administrador nuevo desde /fabrica y vuelve a correr esto.',
      aBorrar, respetadas, avisos, condominioBorrado: false
    };
  }

  db.usuarios = db.usuarios.filter(u => !idsABorrar.has(u.id));
  // Las sesiones abiertas de esas cuentas se cierran: un token vivo sigue
  // sirviendo aunque el usuario ya no exista... salvo que también se borre.
  for (const [token, sesion] of Object.entries(db.sesiones || {})) {
    if (idsABorrar.has(sesion.usuarioId)) delete db.sesiones[token];
  }

  let condominioBorrado = false;
  if (conCondominio && db.condominios.some(c => c.id === CONDOMINIO_DEMO)) {
    const usuariosFuera = new Set(
      db.usuarios.filter(u => u.condominioId === CONDOMINIO_DEMO).map(u => u.id)
    );
    db.condominios = db.condominios.filter(c => c.id !== CONDOMINIO_DEMO);
    db.usuarios = db.usuarios.filter(u => u.condominioId !== CONDOMINIO_DEMO);
    db.puntos = db.puntos.filter(p => p.condominioId !== CONDOMINIO_DEMO);
    db.rondas = db.rondas.filter(r => r.condominioId !== CONDOMINIO_DEMO);
    db.pushSuscripciones = (db.pushSuscripciones || []).filter(s => s.condominioId !== CONDOMINIO_DEMO);
    for (const [token, sesion] of Object.entries(db.sesiones || {})) {
      if (usuariosFuera.has(sesion.usuarioId)) delete db.sesiones[token];
    }
    condominioBorrado = true;
  }

  return { aBorrar, respetadas, avisos, condominioBorrado };
}

function main() {
  const aplicar = process.argv.includes('--aplicar');
  const conCondominio = process.argv.includes('--con-condominio');
  const store = crearStore(process.env.DB_PATH);

  console.log(`Base: ${store.ruta}`);
  console.log(`Modo: ${aplicar ? 'APLICAR (se escribe la base)' : 'EN SECO (no se toca nada)'}\n`);

  const r = purgar(store.db, { conCondominio });

  if (r.bloqueado) {
    console.error('BLOQUEADO: ' + r.bloqueado);
    process.exitCode = 1;
    return;
  }

  if (!r.aBorrar.length) {
    console.log('✅ No quedan cuentas de demo con el PIN publicado.');
  } else {
    console.log(`${aplicar ? 'Borradas' : 'Se borrarían'} ${r.aBorrar.length} cuenta(s) de demo:`);
    for (const u of r.aBorrar) console.log(`  - ${u.usuario} (${u.rol}, condominio ${u.condominioId})`);
  }

  if (r.respetadas.length) {
    console.log('\nRespetadas (ya les cambiaron el PIN, pueden estar en uso):');
    for (const u of r.respetadas) console.log(`  · ${u.usuario} (${u.rol})`);
  }

  if (r.condominioBorrado) {
    console.log(`\n${aplicar ? 'Borrado' : 'Se borraría'} el condominio de demo "${CONDOMINIO_DEMO}" y todos sus datos `
      + `(${store.ejecuciones.contar(CONDOMINIO_DEMO)} rondas y ${store.notificaciones.contar(CONDOMINIO_DEMO)} avisos).`);
  }

  if (r.avisos.length) {
    console.log('');
    for (const a of r.avisos) console.log(a);
  }

  const quedan = store.db.usuarios.filter(u => u.rol === 'admin').length;
  console.log(`\nCuentas de panel que quedan: ${quedan}`);

  if (aplicar) {
    store.transaccion(() => {
      store.guardar();
      if (r.condominioBorrado) {
        store.ejecuciones.eliminarDeCondominio(CONDOMINIO_DEMO);
        store.notificaciones.eliminarDeCondominio(CONDOMINIO_DEMO);
      }
    });
    console.log('Base guardada.');
  } else {
    console.log('\nNada se escribió. Corre con --aplicar cuando estés conforme.');
  }
  store.cerrar();
}

if (require.main === module) main();

module.exports = { purgar, CUENTAS_DEMO, CONDOMINIO_DEMO };
