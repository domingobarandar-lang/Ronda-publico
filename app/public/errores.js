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
// Sentry (v1.20.1): `window.__reportarError(error, origen)` es la entrada única.
// Si public/vendor/sentry.js cargó (window.Sentry) y el servidor entrega un DSN
// (GET /api/config-errores), cada reporte aceptado —tras el tope por sesión y la
// deduplicación de abajo— también va a Sentry. Sin bundle o sin DSN todo sigue
// igual que antes: el reporte al servidor y el aviso no dependen de Sentry.
// Si existe `window.__erroresGancho` (una función), recibe { mensaje, pila,
// origen, pagina } en cada reporte aceptado.
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

  // --- Sentry ---------------------------------------------------------------
  // Texto libre sin datos personales (espejo corto del filtro del servidor).
  function limpiarTexto(t) {
    t = String(t == null ? '' : t);
    t = t.replace(/\bBearer\s+[\w.~+\/=-]+/gi, 'Bearer [oculto]');
    t = t.replace(/(["']?\b(?:pin|clave|password|contrase(?:ñ|n)a|token|authorization)\b["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}&"']+)/gi, '$1[oculto]');
    t = t.replace(/(["']?\b(?:nombre|usuario|name|user)\b["']?\s*[:=]\s*)(["'][^"']*["']|[^,;}&"'\n]+)/gi, '$1[oculto]');
    t = t.replace(/(["']?\b(?:lat(?:itude)?|lng|lon(?:gitude)?|accuracy)\b["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/gi, '$1[oculto]');
    t = t.replace(/-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/g, '[coordenadas]');
    t = t.replace(/(https?:\/\/[^\s?#)"']+|\/[\w.\/-]+)\?[^\s)"']*/g, '$1?[oculto]');
    return t;
  }

  // beforeSend: deja el evento sin URL con query, cabeceras, cookies, cuerpos,
  // breadcrumbs ni usuario. Exportado en window para poder probarlo.
  function filtrarEvento(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.request) ev.request = { url: String(ev.request.url || '').split(/[?#]/)[0] };
    ev.breadcrumbs = [];
    delete ev.user;
    delete ev.extra;
    if (typeof ev.message === 'string') ev.message = limpiarTexto(ev.message);
    if (ev.exception && ev.exception.values) {
      for (var i = 0; i < ev.exception.values.length; i++) {
        var v = ev.exception.values[i];
        if (typeof v.value === 'string') v.value = limpiarTexto(v.value);
        var fr = v.stacktrace && v.stacktrace.frames;
        if (fr) for (var j = 0; j < fr.length; j++) {
          if (fr[j].filename) fr[j].filename = String(fr[j].filename).split(/[?#]/)[0];
        }
      }
    }
    return ev;
  }
  window.__erroresFiltrarEvento = filtrarEvento;

  // El condominio de la página (v1.26), como etiqueta de Sentry: /fabrica
  // separa los errores por condominio con ella. Acá no se lee localStorage
  // (ver arriba): lo dice la página con `window.__erroresCondominio`, una
  // función que app.js y admin.js definen con la sesión que ya tienen.
  function condominioActual() {
    try {
      var id = typeof window.__erroresCondominio === 'function' ? window.__erroresCondominio() : null;
      return id ? recortar(id, 40) : null;
    } catch (e) { return null; }
  }

  // 'esperando' mientras llega la config; 'activo' o 'apagado' después.
  var estadoSentry = 'esperando';
  var pendientes = [];

  function aSentry(error, carga) {
    try {
      if (estadoSentry === 'apagado') return;
      if (estadoSentry === 'esperando') {
        if (pendientes.length < MAX_ENVIOS) pendientes.push([error, carga]);
        return;
      }
      var e = error instanceof Error ? error : new Error(carga.mensaje);
      var etiquetas = { pagina: carga.pagina, origen: carga.origen, version: carga.version };
      var condominio = condominioActual();
      if (condominio) etiquetas.condominio = condominio;
      window.Sentry.captureException(e, { tags: etiquetas });
    } catch (x) { /* Sentry roto no cuenta */ }
  }

  function iniciarSentry() {
    try {
      if (!window.Sentry || typeof fetch !== 'function') { estadoSentry = 'apagado'; return; }
      fetch('/api/config-errores', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (cfg) {
          if (!cfg || !cfg.dsn) { estadoSentry = 'apagado'; pendientes = []; return; }
          window.Sentry.init({
            dsn: cfg.dsn,
            release: cfg.release,
            environment: cfg.entorno,
            // Solo lo que pasa por reportar() (con su tope y deduplicación): sin
            // handlers globales, breadcrumbs de consola/DOM/fetch ni tracing.
            defaultIntegrations: false,
            integrations: [],
            sendDefaultPii: false,
            beforeSend: filtrarEvento,
            beforeBreadcrumb: function () { return null; },
            denyUrls: [/^(chrome|moz|safari|safari-web)-extension:/i]
          });
          estadoSentry = 'activo';
          var p = pendientes; pendientes = [];
          for (var i = 0; i < p.length; i++) aSentry(p[i][0], p[i][1]);
        })
        .catch(function () { estadoSentry = 'apagado'; pendientes = []; });
    } catch (e) { estadoSentry = 'apagado'; }
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
      aSentry(error, carga);
      if (typeof window.__erroresGancho === 'function') {
        try { window.__erroresGancho(carga); } catch (e) { /* un gancho roto no cuenta */ }
      }
    } catch (e) { /* reportar nunca lanza */ }
  }

  window.__reportarError = reportar;
  iniciarSentry();

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
