// Captura de errores de las tres páginas (guardia, panel y fábrica).
//
// Escucha `error` y `unhandledrejection`, muestra un aviso corto que no bloquea
// nada y manda el reporte al servidor (POST /api/errores-cliente) para que
// quede en los logs. Va ANTES de geo.js/app.js para alcanzar errores de arranque.
//
// Reglas, porque corre en el teléfono de la garita:
//  - NUNCA recarga ni navega (eso es solo de vigia.js).
//  - NUNCA toca la ronda en curso ni la cola sin enviar: no lee ni escribe
//    localStorage ni IndexedDB, y no manda nada de lo que hay ahí.
//  - Nunca lanza: todo va envuelto, un fallo acá no puede romper la app.
//  - Tope de envíos por sesión y mensajes repetidos descartados, para que un
//    error en bucle no inunde al servidor ni la pantalla.
//
// Punto de enganche para Sentry (más adelante): `window.__reportarError(error,
// origen)` es la entrada única; si existe `window.__erroresGancho` (una función),
// recibe { mensaje, pila, origen, pagina } en cada reporte aceptado.
(function () {
  'use strict';
  var MAX_ENVIOS = 10;
  var MAX_MENSAJE = 300;
  var MAX_PILA = 1500;
  var AVISO_MS = 6000;

  var enviados = 0;
  var vistos = {};

  // Ruido que no es un fallo de la app: extensiones del navegador, errores
  // cross-origin sin detalle y el aviso inocuo de ResizeObserver.
  function esRuido(mensaje, pila, archivo) {
    var m = String(mensaje || '');
    if (!m || /^script error\.?$/i.test(m)) return true;
    if (/ResizeObserver loop/i.test(m)) return true;
    // Sin señal es la vida normal de la garita, no un fallo de la app.
    if (/^(TypeError: )?(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(m)) return true;
    var donde = String(archivo || '') + ' ' + String(pila || '');
    return /(chrome|moz|safari|safari-web)-extension:\/\//i.test(donde);
  }

  function recortar(texto, max) {
    var t = String(texto == null ? '' : texto);
    return t.length > max ? t.slice(0, max) : t;
  }

  function avisar() {
    if (document.getElementById('errores-aviso')) return;
    var caja = document.createElement('div');
    caja.id = 'errores-aviso';
    caja.setAttribute('role', 'status');
    // Arriba y sin capturar toques: no tapa el botón de la ronda ni el vigía.
    caja.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:9998;padding:8px 12px;'
      + 'background:#3a1a1a;color:#ffd9d9;font:14px/1.3 system-ui,sans-serif;text-align:center;'
      + 'border-radius:8px;pointer-events:none;opacity:.95';
    caja.textContent = 'Ocurrió un problema inesperado. Ya se avisó al equipo.';
    (document.body || document.documentElement).appendChild(caja);
    setTimeout(function () {
      if (caja.parentNode) caja.parentNode.removeChild(caja);
    }, AVISO_MS);
  }

  function versionApp() {
    try {
      // VERSION_APP es un const de app.js: visible por nombre, no por window.
      return typeof VERSION_APP !== 'undefined' ? String(VERSION_APP) : '';
    } catch (e) { return ''; }
  }

  function enviar(carga) {
    try {
      fetch('/api/errores-cliente', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(carga),
        keepalive: true
      }).catch(function () { /* sin señal: el reporte se pierde, no pasa nada */ });
    } catch (e) { /* silencioso */ }
  }

  function reportar(error, origen, archivo) {
    try {
      var esError = error && typeof error === 'object';
      var mensaje = recortar(esError ? (error.message || error) : error, MAX_MENSAJE);
      var pila = recortar(esError && error.stack ? error.stack : '', MAX_PILA);
      if (esRuido(mensaje, pila, archivo)) return;
      // Mismo mensaje en la misma página: se reporta una sola vez por sesión.
      if (vistos[mensaje]) return;
      vistos[mensaje] = true;
      if (enviados >= MAX_ENVIOS) return;
      enviados++;
      var carga = {
        pagina: location.pathname,
        mensaje: mensaje,
        pila: pila,
        version: versionApp(),
        origen: origen || 'error'
      };
      avisar();
      enviar(carga);
      if (typeof window.__erroresGancho === 'function') {
        try { window.__erroresGancho(carga); } catch (e) { /* un gancho roto no cuenta */ }
      }
    } catch (e) { /* reportar nunca lanza */ }
  }

  window.__reportarError = reportar;

  window.addEventListener('error', function (ev) {
    // Los fallos de carga de recursos (img, script) llegan sin message: no son
    // errores de código y el vigía ya cubre el arranque.
    if (!ev || (!ev.message && !ev.error)) return;
    reportar(ev.error || ev.message, 'error', ev.filename);
  });

  window.addEventListener('unhandledrejection', function (ev) {
    reportar(ev && ev.reason !== undefined ? ev.reason : 'Promesa rechazada', 'promesa');
  });
})();
