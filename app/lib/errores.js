// Registro único de errores del servidor y de los reportes que mandan las apps.
//
// Todo error que merezca rastro pasa por `reportar(contexto, error)`: la
// consola (los logs de Railway) y, más adelante, Sentry se enchufan acá y en
// ningún otro lado (ver `alReportar`).
//
// Filtro de datos personales: lo que sale a los logs NUNCA lleva el token de
// sesión, el PIN, el cuerpo de una petición, coordenadas GPS ni el nombre de un
// guardia. Un mensaje de error puede traer cualquiera de esas cosas pegada
// (p. ej. un JSON.parse que cita el cuerpo, o un fetch con la URL), así que el
// texto se redacta antes de escribirse, venga del servidor o del cliente.
'use strict';

const MAX_MENSAJE = 300;
const MAX_PILA = 1500;
const MAX_CAMPO = 120;

// Caracteres de control (incluye \r y \n): un cliente no puede fabricar líneas
// falsas en el log.
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]+', 'g');

// Redacta datos personales dentro de un texto libre.
function redactar(texto) {
  let t = String(texto == null ? '' : texto);
  // Token de sesión: "Bearer xxx", "authorization: xxx".
  t = t.replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [oculto]');
  t = t.replace(/(["']?\bauthorization\b["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}&]+(?:\s+[\w.~+/=-]+)?)/gi, '$1[oculto]');
  // PIN, contraseñas, tokens y nombres, en JSON, query string o "clave: valor".
  t = t.replace(/(["']?\b(?:pin|clave|password|contrase(?:ñ|n)a|token)\b["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}&"']+)/gi, '$1[oculto]');
  // Un nombre tiene espacios ("Juan Pérez"): se oculta hasta el próximo separador.
  t = t.replace(/(["']?\b(?:nombre|usuario|name|user)\b["']?\s*[:=]\s*)(["'][^"']*["']|[^,;}&"'\n]+)/gi, '$1[oculto]');
  // Coordenadas: lat/lng/accuracy con su valor, y pares "-33.4489, -70.6693".
  t = t.replace(/(["']?\b(?:lat(?:itude)?|lng|lon(?:gitude)?|accuracy|precision)\b["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/gi, '$1[oculto]');
  t = t.replace(/-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/g, '[coordenadas]');
  // En las direcciones solo importa dónde ocurrió, no los parámetros.
  t = t.replace(/(https?:\/\/[^\s?#)"']+|\/[\w./-]+)\?[^\s)"']*/g, '$1?[oculto]');
  return t;
}

// Texto seguro para una línea de log: una sola línea, redactado y acotado.
function limpiar(valor, max = MAX_CAMPO) {
  const t = redactar(String(valor == null ? '' : valor)).replace(CONTROL, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// La pila conserva sus saltos de línea como " | " para que siga siendo UNA línea.
function limpiarPila(valor) {
  const t = redactar(String(valor == null ? '' : valor)).replace(/[\r\n]+/g, ' | ').replace(CONTROL, ' ').trim();
  return t.length > MAX_PILA ? t.slice(0, MAX_PILA) + '…' : t;
}

// Ganchos (Sentry, más adelante): reciben { contexto, error, origen }.
const ganchos = [];
function alReportar(fn) {
  if (typeof fn === 'function') ganchos.push(fn);
}

function emitir(linea) {
  console.error(linea);
}

function avisarGanchos(datos) {
  for (const g of ganchos) {
    try { g(datos); } catch { /* un gancho roto no puede tumbar el registro */ }
  }
}

// Registra un error del servidor. `contexto` dice dónde ("abandonadas",
// "alarma-ronda"…); `error` es lo que se atrapó (Error u otra cosa).
// `condominioId`, si se sabe, viaja a Sentry como etiqueta: es lo que deja a
// /fabrica mostrar los errores de cada condominio (lib/sentry-lectura.js). El
// id de un condominio no es un dato personal.
function reportar(contexto, error, { condominioId } = {}) {
  try {
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    emitir(`[error] [${limpiar(contexto, 60)}] ${limpiar(e.message, MAX_MENSAJE)}`
      + (condominioId ? ` condominio=${limpiar(condominioId, 40)}` : '')
      + (e.stack ? ` :: ${limpiarPila(e.stack)}` : ''));
    avisarGanchos({ contexto, error: e, origen: 'servidor', condominioId: condominioId ? limpiar(condominioId, 40) : null });
  } catch { /* reportar nunca lanza: lo usan los manejadores de último recurso */ }
}

// Reportes de las apps (POST /api/errores-cliente). `datos` es entrada NO
// confiable. `meta` trae lo que sabe el servidor: ua, id (solo el id interno).
// Devuelve la línea registrada o null si se descartó por repetida.
const recientes = new Map(); // firma → última vez, para no repetir en el log
const VENTANA_REPETIDOS_MS = 60000;

function reportarCliente(datos, meta = {}, ahora = Date.now()) {
  const d = datos && typeof datos === 'object' ? datos : {};
  const pagina = limpiar(String(d.pagina || '').split(/[?#]/)[0], 60);
  const mensaje = limpiar(d.mensaje, MAX_MENSAJE);
  const pila = limpiarPila(d.pila);
  const version = limpiar(d.version, 20);
  const ua = limpiar(meta.ua, 160);

  const firma = `${pagina}|${mensaje}`;
  const ultima = recientes.get(firma);
  if (ultima !== undefined && ahora - ultima < VENTANA_REPETIDOS_MS) return null;
  if (recientes.size > 500) {
    for (const [k, t] of recientes) if (ahora - t >= VENTANA_REPETIDOS_MS) recientes.delete(k);
    if (recientes.size > 500) recientes.clear();
  }
  recientes.set(firma, ahora);

  const linea = `[error-cliente] pagina=${pagina || '?'} version=${version || '?'}`
    + (meta.id ? ` usuario=${limpiar(meta.id, 40)}` : '')
    + ` mensaje="${mensaje}"` + (pila ? ` pila="${pila}"` : '') + ` ua="${ua}"`;
  emitir(linea);
  avisarGanchos({ contexto: 'cliente', error: new Error(mensaje), origen: 'cliente', datos: { pagina, version, pila, ua } });
  return linea;
}

// Limitador por clave (IP) para la ruta pública: ventana fija. Detrás del proxy
// de Railway `req.ip` puede ser el mismo para todos, así que el tope es
// generoso y actúa como freno global, no como castigo por teléfono.
function crearLimitador({ max = 60, ventanaMs = 60000 } = {}) {
  const cuentas = new Map();
  return function permitir(clave, ahora = Date.now()) {
    const c = cuentas.get(clave);
    if (!c || ahora - c.desde >= ventanaMs) {
      if (cuentas.size > 2000) cuentas.clear();
      cuentas.set(clave, { desde: ahora, n: 1 });
      return true;
    }
    c.n += 1;
    return c.n <= max;
  };
}

// Red de último recurso del proceso.
//
// unhandledRejection: se registra y el proceso SIGUE. Una promesa suelta no
// deja el estado a medias (el store es SQLite síncrono) y tumbar el servicio
// por eso dejaría la garita sin app; además la cola del teléfono reintentaría
// el mismo evento malo apenas se levante.
//
// uncaughtException: se registra y el proceso SALE con código 1. Node documenta
// que, tras una excepción no atrapada, el estado del proceso es indefinido;
// seguir "a ver si anda" puede dejar timers o sockets rotos sin que nadie lo
// note. Railway reinicia con restartPolicyType ON_FAILURE y el estado vive en
// SQLite, así que salir limpio es más seguro que quedar medio vivo. Se espera
// un instante para que el log alcance a salir.
function instalarRedProceso(proc = process, salir = code => process.exit(code)) {
  proc.on('unhandledRejection', razon => reportar('rechazo-sin-atrapar', razon));
  proc.on('uncaughtException', err => {
    reportar('excepcion-sin-atrapar', err);
    setTimeout(() => salir(1), 200).unref?.();
  });
}

module.exports = {
  reportar, reportarCliente, redactar, limpiar, limpiarPila, crearLimitador,
  alReportar, instalarRedProceso, MAX_MENSAJE, MAX_PILA
};
