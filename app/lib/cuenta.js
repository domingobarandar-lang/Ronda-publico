// Eliminación de la cuenta del guardia por él mismo (CU-25). Es requisito de
// Google Play: si la cuenta se crea dentro de la app (POST /api/registro),
// tiene que poder borrarse dentro de la app y desde una página web pública.
//
// Qué se BORRA: el usuario (usuario, nombre, hash del PIN), todas sus sesiones
// y sus suscripciones push, también las de la alarma en Fully Kiosk.
//
// Qué se CONSERVA, anonimizado: las rondas que hizo. Son del condominio
// (control laboral del empleador), así que no se borran; pero la ejecución
// pierde el vínculo con la persona (guardiaId pasa a null) y en informes,
// panel e informe semanal aparece como "Guardia eliminado". Las ubicaciones
// GPS de las marcas quedan: son evidencia del punto, no de una persona
// identificada.
//
// Los avisos del panel (store.notificaciones) se escribieron como texto al
// cerrar cada ronda y llevan el nombre del guardia: se reescriben acá.
//
// Los respaldos diarios (lib/respaldo.js) NO se reescriben: lo borrado
// desaparece de ellos cuando rotan (RESPALDO_CONSERVAR días en el volumen; las
// copias por correo dependen del buzón RESPALDO_TO).

const GUARDIA_ELIMINADO = 'Guardia eliminado';

// Cómo se muestra el guardia de una ejecución: su nombre, o "Guardia
// eliminado" si la cuenta ya no existe (la borró él o el administrador).
function nombreGuardia(usuario) {
  return usuario ? (usuario.nombre || usuario.usuario || GUARDIA_ELIMINADO) : GUARDIA_ELIMINADO;
}

const escaparRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Saca el nombre del guardia de un aviso ya escrito. Los avisos tienen dos
// formas fijas (ver cerrarYNotificar en server.js): la línea "Guardia: X" del
// informe en texto y el título del push "… — X". Solo se tocan esas dos, no
// cualquier aparición del nombre: un punto que se llame igual que el guardia
// no es dato del guardia.
function anonimizarTexto(texto, nombres) {
  let salida = String(texto || '');
  for (const nombre of nombres) {
    if (!nombre) continue;
    const n = escaparRegex(nombre);
    salida = salida
      .replace(new RegExp(`^Guardia: ${n}$`, 'gm'), `Guardia: ${GUARDIA_ELIMINADO}`)
      .replace(new RegExp(` — ${n}$`, 'gm'), ` — ${GUARDIA_ELIMINADO}`);
  }
  return salida;
}

// Borra la cuenta y anonimiza lo que queda. Síncrono y en una sola
// transacción: no puede quedar un usuario borrado con rondas que todavía lo
// nombran, ni al revés. Devuelve las ejecuciones que estaban en curso (ya
// anonimizadas) para que quien llama las cierre con el cierre normal.
function eliminarGuardia(store, guardia) {
  const db = store.db;
  const nombres = [...new Set([guardia.nombre, guardia.usuario].filter(Boolean))];
  const enCurso = [];
  let anonimizadas = 0;
  let avisos = 0;
  store.transaccion(() => {
    db.usuarios = db.usuarios.filter(u => u.id !== guardia.id);
    for (const [token, sesion] of Object.entries(db.sesiones)) {
      if (sesion.usuarioId === guardia.id) delete db.sesiones[token];
    }
    db.pushSuscripciones = (db.pushSuscripciones || []).filter(s => s.usuarioId !== guardia.id);
    if (db.alarmaKioscos) db.alarmaKioscos = db.alarmaKioscos.filter(k => k.usuarioId !== guardia.id);
    for (const e of store.ejecuciones.deGuardia(guardia.id)) {
      e.guardiaId = null;
      e.guardiaEliminado = true;
      store.ejecuciones.guardar(e);
      anonimizadas++;
      if (e.estado === 'en_curso') enCurso.push(e);
    }
    avisos = store.notificaciones.reescribirTextos(guardia.condominioId, t => anonimizarTexto(t, nombres));
    // Los eventos de salud del producto (lib/salud.js) llevan solo su id
    // interno; igual se suelta, como en sus rondas.
    store.salud.anonimizarUsuario(guardia.id);
    store.guardar();
  });
  return { anonimizadas, avisos, enCurso };
}

module.exports = { GUARDIA_ELIMINADO, nombreGuardia, anonimizarTexto, eliminarGuardia };
