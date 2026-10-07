// Vigía de arranque. Va ANTES de app.js y no depende de él.
//
// El teléfono de la garita corre en modo kiosco y se actualiza solo, sin nadie
// al lado. Si una versión llega con un error que impide arrancar la app (o
// app.js no alcanzó a bajar por mala señal), app.js no corre y tampoco su
// actualización automática: el teléfono quedaría pegado hasta que alguien
// fuera al condominio. Este archivo es la salida: si la app no avisa que
// arrancó, muestra un aviso y recarga la misma dirección cada minuto hasta que
// arranque (con la señal de vuelta o con la versión corregida ya publicada).
//
// Nunca navega a otra dirección: solo location.reload(). Y solo recarga si el
// servidor contesta, para no cambiar la app por una página de error.
(function () {
  'use strict';
  var ESPERA_ARRANQUE_MS = 30000;
  var CADA_MS = 60000;

  function avisar() {
    if (document.getElementById('vigia-aviso')) return;
    var caja = document.createElement('div');
    caja.id = 'vigia-aviso';
    caja.setAttribute('role', 'status');
    caja.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:16px;'
      + 'background:#3a2a00;color:#ffe9a8;font:16px/1.4 system-ui,sans-serif;text-align:center';
    caja.textContent = 'La app se está actualizando. Deja el teléfono encendido y con señal: vuelve sola en unos minutos.';
    (document.body || document.documentElement).appendChild(caja);
  }

  function reintentar() {
    if (window.__appLista) return;
    avisar();
    // Solo se recarga si el servidor contesta bien la versión y la página.
    Promise.all([
      fetch('/api/version', { cache: 'no-store' }),
      fetch('./', { cache: 'no-store' })
    ]).then(function (r) {
      if (r[0].ok && r[1].ok && !window.__appLista) location.reload();
    }).catch(function () { /* sin señal: se reintenta en el próximo ciclo */ });
  }

  setTimeout(function () {
    if (window.__appLista) return;
    avisar();
    setInterval(reintentar, CADA_MS);
  }, ESPERA_ARRANQUE_MS);
})();
