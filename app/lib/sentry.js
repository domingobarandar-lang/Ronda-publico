// Sentry del servidor (v1.20.1). Se enchufa en `errores.alReportar`: todo lo que
// pasa por `reportar()` (manejador de Express, programador, recordatorios,
// abandonadas, process.on) llega acá sin tocar a quien reporta.
//
// Con SENTRY_DSN vacío o ausente NO se carga ni el SDK: la app corre igual.
// Un fallo de Sentry nunca puede propagarse al servidor (todo va en try/catch).
//
// Datos personales: `filtrarEvento` (beforeSend) deja el evento sin cabeceras,
// cookies, cuerpo, query string, coordenadas, PIN ni nombres. Al guardia solo se
// lo identifica por su id interno. Además se apagan los breadcrumbs y las
// integraciones que capturan peticiones.
'use strict';

const errores = require('./errores');

let sdk = null;
let activo = false;

// Quita datos personales de un evento de Sentry. Exportada para los tests.
function filtrarEvento(evento) {
  if (!evento || typeof evento !== 'object') return null;
  const e = evento;
  // Nada de la petición: cabeceras (authorization, cookie), cuerpo, query, IP.
  if (e.request) {
    e.request = e.request.url ? { url: String(e.request.url).split(/[?#]/)[0], method: e.request.method } : undefined;
  }
  delete e.breadcrumbs;
  delete e.server_name;
  delete e.extra;
  // Solo el id interno; nunca nombre, usuario, correo ni IP.
  e.user = e.user && e.user.id ? { id: String(e.user.id) } : undefined;
  if (e.contexts) {
    delete e.contexts.device;
    delete e.contexts.culture;
  }
  if (typeof e.message === 'string') e.message = errores.limpiar(e.message, errores.MAX_MENSAJE);
  if (e.logentry && typeof e.logentry.message === 'string') {
    e.logentry = { message: errores.limpiar(e.logentry.message, errores.MAX_MENSAJE) };
  }
  if (e.exception && Array.isArray(e.exception.values)) {
    for (const v of e.exception.values) {
      if (typeof v.value === 'string') v.value = errores.limpiar(v.value, errores.MAX_MENSAJE);
      if (v.stacktrace && Array.isArray(v.stacktrace.frames)) {
        for (const f of v.stacktrace.frames) { delete f.vars; delete f.pre_context; delete f.context_line; delete f.post_context; }
      }
    }
  }
  return e;
}

function entornoActual() {
  return process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT
    ? 'production' : 'development';
}

function dsnConfigurado() {
  return String(process.env.SENTRY_DSN || '').trim();
}

// Datos que el navegador necesita para iniciar su propio Sentry (GET /api/config-errores).
function configCliente() {
  const dsn = dsnConfigurado();
  if (!dsn) return {};
  return { dsn, release: 'rondas-qr@' + require('../package.json').version, entorno: entornoActual() };
}

// Inicia Sentry si hay DSN. Devuelve true si quedó activo. Nunca lanza.
function iniciar() {
  const dsn = dsnConfigurado();
  if (!dsn || activo) return activo;
  try {
    sdk = require('@sentry/node');
    sdk.init({
      dsn,
      release: 'rondas-qr@' + require('../package.json').version,
      environment: entornoActual(),
      sendDefaultPii: false,
      tracesSampleRate: 0,
      // process.on lo manejamos nosotros (errores.instalarRedProceso): Sentry no
      // debe registrar los suyos ni decidir si el proceso sale. Tampoco
      // breadcrumbs de consola/HTTP ni captura de peticiones.
      integrations: defaults => defaults.filter(i => ![
        'OnUncaughtException', 'OnUnhandledRejection', 'Console', 'Http', 'NodeFetch', 'RequestData', 'LocalVariables', 'LocalVariablesAsync', 'LocalVariablesSync', 'ContextLines', 'Context'
      ].includes(i.name)),
      beforeBreadcrumb: () => null,
      beforeSend: filtrarEvento
    });
    errores.alReportar(capturar);
    activo = true;
  } catch (err) {
    console.warn('[sentry] no se pudo iniciar, sigue sin Sentry:', errores.limpiar(err && err.message, 200));
    sdk = null;
  }
  return activo;
}

// Gancho de errores.alReportar. Los reportes del navegador se omiten: el
// navegador ya los manda directo a Sentry.
function capturar({ contexto, error, origen }) {
  if (!activo || !sdk || origen === 'cliente') return;
  try {
    sdk.withScope(scope => {
      scope.setTag('contexto', errores.limpiar(contexto, 60));
      sdk.captureException(error);
    });
  } catch { /* Sentry roto no puede tumbar el servidor */ }
}

// Antes de salir (uncaughtException): da un instante para que el evento salga.
function vaciar(ms = 1500) {
  if (!activo || !sdk) return Promise.resolve();
  return sdk.flush(ms).catch(() => {});
}

module.exports = { iniciar, filtrarEvento, configCliente, capturar, vaciar, entornoActual, estaActivo: () => activo };
