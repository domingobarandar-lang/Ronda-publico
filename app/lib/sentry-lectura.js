// Errores de Sentry en la pantalla de la operación (v1.26).
//
// /fabrica muestra, junto a la salud del producto de cada condominio, los
// errores de código que juntó Sentry en los últimos 7 días: los de ese
// condominio (etiqueta `condominio`, que ponen lib/sentry.js y
// public/errores.js) y, aparte, los que no tienen condominio (tareas del
// servidor, pantallas sin sesión, y todo lo anterior a la v1.26).
//
// Lee la API de Sentry con un token de SOLO LECTURA (SENTRY_TOKEN_LECTURA,
// permiso event:read). La organización, el proyecto y la región salen del
// SENTRY_DSN que ya está configurado; SENTRY_ORG y SENTRY_API los cambian si
// hace falta (un Sentry propio). Sin token, /fabrica dice qué falta y todo lo
// demás sigue igual.
//
// El token nunca sale del servidor. Cada consulta se guarda 5 minutos en
// memoria: /fabrica hace una por condominio y recargar la pantalla no tiene que
// gastar el límite de la API. Nunca lanza.
'use strict';

const DIAS = 7;
const LIMITE = 3; // problemas que se listan por condominio
const CACHE_MS = 5 * 60000;
const CACHE_ERROR_MS = 60000;
const ESPERA_MS = 8000;

// Qué leer y dónde, o { falta } si no se puede.
//   DSN https://<clave>@o<org>.ingest.<región>.sentry.io/<proyecto>
function configLectura(env = process.env) {
  const token = String(env.SENTRY_TOKEN_LECTURA || '').trim();
  const dsn = String(env.SENTRY_DSN || '').trim();
  if (!dsn) return { falta: 'SENTRY_DSN (Sentry no está configurado en el servidor)' };
  if (!token) return { falta: 'SENTRY_TOKEN_LECTURA (un token de Sentry con permiso event:read)' };
  let url;
  try { url = new URL(dsn); } catch { return { falta: 'un SENTRY_DSN válido' }; }
  const org = String(env.SENTRY_ORG || '').trim() || (url.hostname.match(/^o(\d+)\.ingest\./) || [])[1];
  if (!org) return { falta: 'SENTRY_ORG (el DSN no trae la organización)' };
  const proyecto = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!/^\d+$/.test(proyecto)) return { falta: 'un SENTRY_DSN con el número de proyecto' };
  const region = (url.hostname.match(/\.ingest\.([a-z]{2})\.sentry\.io$/) || [])[1];
  const api = (String(env.SENTRY_API || '').trim() || (region ? `https://${region}.sentry.io` : 'https://sentry.io')).replace(/\/+$/, '');
  return { token, org, proyecto, api };
}

// Lo que /fabrica necesita de un problema (issue) de Sentry. Con una búsqueda
// por etiqueta, `filtered` trae los eventos que la cumplen; si no viene, `count`.
function problema(issue) {
  const filtrado = issue.filtered && issue.filtered.count;
  return {
    titulo: String(issue.title || '(sin título)').slice(0, 200),
    donde: String(issue.culprit || '').slice(0, 200),
    eventos: Number(filtrado != null ? filtrado : issue.count) || 0,
    ultimaVez: issue.lastSeen || null,
    nivel: issue.level || 'error',
    enlace: /^https:\/\//.test(issue.permalink || '') ? issue.permalink : null
  };
}

function crearLectorSentry({ env = process.env, fetch = globalThis.fetch, ahora = () => Date.now() } = {}) {
  const cfg = configLectura(env);
  const cache = new Map(); // clave → { hasta, promesa }

  async function buscar(query) {
    const params = new URLSearchParams({ statsPeriod: `${DIAS}d`, query, sort: 'freq', limit: String(LIMITE), project: cfg.proyecto });
    params.append('collapse', 'stats');
    params.append('collapse', 'lifetime');
    try {
      const resp = await fetch(`${cfg.api}/api/0/organizations/${encodeURIComponent(cfg.org)}/issues/?${params}`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(ESPERA_MS)
      });
      if (!resp.ok) {
        const pista = resp.status === 401 || resp.status === 403 ? ': revisa SENTRY_TOKEN_LECTURA (permiso event:read)' : '';
        return { error: `Sentry respondió ${resp.status}${pista}.` };
      }
      const lista = await resp.json();
      if (!Array.isArray(lista)) return { error: 'Sentry respondió algo que no es una lista de problemas.' };
      // X-Hits: cuántos problemas cumplen la búsqueda, no solo los que vinieron.
      const total = Number(resp.headers.get('x-hits'));
      return { problemas: Number.isFinite(total) && total >= lista.length ? total : lista.length, lista: lista.map(problema) };
    } catch (e) {
      return { error: e && e.name === 'TimeoutError' ? 'Sentry no respondió a tiempo.' : 'No se pudo conectar con Sentry.' };
    }
  }

  // Una consulta por clave cada 5 minutos (1 si falló). Se guarda la promesa:
  // dos cargas de /fabrica al mismo tiempo comparten la misma consulta.
  function consultar(clave, query) {
    const t = ahora();
    const guardada = cache.get(clave);
    if (guardada && t < guardada.hasta) return guardada.promesa;
    const promesa = buscar(query).then(r => {
      cache.set(clave, { hasta: ahora() + (r.error ? CACHE_ERROR_MS : CACHE_MS), promesa: Promise.resolve(r) });
      return r;
    });
    cache.set(clave, { hasta: t + CACHE_MS, promesa });
    return promesa;
  }

  return {
    configurado: !cfg.falta,
    falta: cfg.falta || null,
    dias: DIAS,
    // Los ids de condominio son [a-z0-9-] (idDesdeNombre); igual se limpian
    // antes de ir a la búsqueda.
    deCondominio: id => consultar(`c:${id}`, `is:unresolved condominio:${String(id).replace(/[^\w.-]/g, '')}`),
    sinCondominio: () => consultar('sin', 'is:unresolved !has:condominio')
  };
}

module.exports = { crearLectorSentry, configLectura, problema, DIAS, LIMITE, CACHE_MS };
