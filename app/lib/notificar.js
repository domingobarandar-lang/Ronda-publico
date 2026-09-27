// Aviso al administrador al cierre de cada ronda.
//
// El aviso queda en store.notificaciones (lo lee el panel, pestaña Avisos) y en la
// consola del servidor. Los canales que SALEN del servidor son dos y viven en
// otros módulos: el correo semanal (lib/correo.js) y el push al teléfono del
// administrador (lib/push.js).
//
// Telegram se sacó en v1.15. Era el único canal que hablaba con un servicio
// externo desde el cierre de ronda, nunca se usó en producción, y el `fetch` no
// tenía timeout: si la API no contestaba, la petición del guardia —la de
// terminar la ronda— quedaba colgada esperando a un tercero. Se prefiere no
// tener el canal a tener uno que puede colgar el cierre.
//
// Síncrono: el cierre de la ronda lo llama dentro de la misma transacción que
// guarda la ejecución (store.transaccion), así no queda una ronda cerrada sin
// su aviso ni un aviso de una ronda que no se cerró.
function registrarAviso(store, condominio, texto) {
  const registro = {
    ts: new Date().toISOString(),
    condominioId: condominio.id,
    texto,
    medio: 'registro',
    enviada: true
  };

  console.log(`[aviso → admin de ${condominio.nombre}]\n${texto}\n`);

  store.notificaciones.agregar(registro);
  return registro;
}

async function notificarAdmin(store, condominio, texto) {
  return registrarAviso(store, condominio, texto);
}

module.exports = { notificarAdmin, registrarAviso };
