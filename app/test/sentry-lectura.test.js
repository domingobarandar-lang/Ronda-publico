// Errores de Sentry en /fabrica (v1.26): lib/sentry-lectura.js lee la API de
// Sentry con un token de solo lectura. NUNCA llama a Sentry de verdad: el fetch
// es de mentira.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crearLectorSentry, configLectura, problema, CACHE_MS } = require('../lib/sentry-lectura');

const DSN = 'https://clave123@o4501234.ingest.us.sentry.io/4505678';
const ENV = { SENTRY_DSN: DSN, SENTRY_TOKEN_LECTURA: 'sntrys_lectura' };

const issue = (titulo, extra = {}) => ({
  title: titulo, culprit: 'POST /api/ejecuciones', count: '40', userCount: 0,
  lastSeen: '2026-10-31T14:00:00Z', level: 'error',
  permalink: 'https://mi-org.sentry.io/issues/1/', ...extra
});

// Un fetch de mentira que anota cada llamada y responde lo que diga `responder`.
function fetchFalso(responder = () => ({ cuerpo: [] })) {
  const llamadas = [];
  const fetch = async (url, opciones) => {
    llamadas.push({ url: new URL(url), opciones });
    const r = responder(new URL(url));
    if (r instanceof Error) throw r;
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      headers: { get: h => (h.toLowerCase() === 'x-hits' && r.hits != null ? String(r.hits) : null) },
      json: async () => r.cuerpo
    };
  };
  return { fetch, llamadas };
}

test('config: organización, proyecto y región salen del DSN', () => {
  assert.deepEqual(configLectura(ENV), { token: 'sntrys_lectura', org: '4501234', proyecto: '4505678', api: 'https://us.sentry.io' });
  // DSN sin región: la API general.
  assert.equal(configLectura({ ...ENV, SENTRY_DSN: 'https://k@o12.ingest.sentry.io/34' }).api, 'https://sentry.io');
  // SENTRY_ORG y SENTRY_API mandan sobre el DSN (un Sentry propio).
  const propio = configLectura({ ...ENV, SENTRY_DSN: 'https://k@sentry.mi-empresa.cl/7', SENTRY_ORG: 'mi-org', SENTRY_API: 'https://sentry.mi-empresa.cl/' });
  assert.deepEqual(propio, { token: 'sntrys_lectura', org: 'mi-org', proyecto: '7', api: 'https://sentry.mi-empresa.cl' });
});

test('config: sin DSN, sin token o con un DSN raro dice qué falta', () => {
  assert.match(configLectura({}).falta, /SENTRY_DSN/);
  assert.match(configLectura({ SENTRY_DSN: DSN }).falta, /SENTRY_TOKEN_LECTURA/);
  assert.match(configLectura({ ...ENV, SENTRY_DSN: 'esto-no-es-un-dsn' }).falta, /SENTRY_DSN válido/);
  assert.match(configLectura({ ...ENV, SENTRY_DSN: 'https://k@sentry.mi-empresa.cl/7' }).falta, /SENTRY_ORG/);
  assert.match(configLectura({ ...ENV, SENTRY_DSN: 'https://k@o1.ingest.sentry.io/' }).falta, /número de proyecto/);

  const { fetch, llamadas } = fetchFalso();
  const lector = crearLectorSentry({ env: { SENTRY_DSN: DSN }, fetch });
  assert.equal(lector.configurado, false);
  assert.match(lector.falta, /SENTRY_TOKEN_LECTURA/);
  assert.equal(llamadas.length, 0);
});

test('pide los problemas sin resolver del condominio, de 7 días, con el token de lectura', async () => {
  const { fetch, llamadas } = fetchFalso(() => ({ cuerpo: [issue('TypeError: x is undefined')], hits: 1 }));
  const lector = crearLectorSentry({ env: ENV, fetch });
  assert.equal(lector.configurado, true);
  const r = await lector.deCondominio('aromos');
  assert.equal(llamadas.length, 1);
  const { url, opciones } = llamadas[0];
  assert.equal(url.origin + url.pathname, 'https://us.sentry.io/api/0/organizations/4501234/issues/');
  assert.equal(url.searchParams.get('statsPeriod'), '7d');
  assert.equal(url.searchParams.get('query'), 'is:unresolved condominio:aromos');
  assert.equal(url.searchParams.get('project'), '4505678');
  assert.equal(url.searchParams.get('sort'), 'freq');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(opciones.headers.authorization, 'Bearer sntrys_lectura');
  assert.deepEqual(r, {
    problemas: 1,
    lista: [{
      titulo: 'TypeError: x is undefined', donde: 'POST /api/ejecuciones', eventos: 40,
      ultimaVez: '2026-10-31T14:00:00Z', nivel: 'error', enlace: 'https://mi-org.sentry.io/issues/1/'
    }]
  });

  // Los que no tienen condominio, aparte.
  await lector.sinCondominio();
  assert.equal(llamadas[1].url.searchParams.get('query'), 'is:unresolved !has:condominio');
});

test('cuenta los eventos de la búsqueda (filtered) y el total de problemas (X-Hits)', async () => {
  const { fetch } = fetchFalso(() => ({ cuerpo: [issue('A', { filtered: { count: '7' } }), issue('B')], hits: 12 }));
  const r = await crearLectorSentry({ env: ENV, fetch }).deCondominio('aromos');
  assert.equal(r.problemas, 12, 'X-Hits: todos los que cumplen, no solo los que vinieron');
  assert.deepEqual(r.lista.map(p => p.eventos), [7, 40]);
  // Sin X-Hits, los que vinieron.
  const sinHits = fetchFalso(() => ({ cuerpo: [issue('A')] }));
  assert.equal((await crearLectorSentry({ env: ENV, fetch: sinHits.fetch }).sinCondominio()).problemas, 1);
});

test('un id de condominio raro no cambia la búsqueda', async () => {
  const { fetch, llamadas } = fetchFalso();
  await crearLectorSentry({ env: ENV, fetch }).deCondominio('aromos is:resolved !x');
  assert.equal(llamadas[0].url.searchParams.get('query'), 'is:unresolved condominio:aromosisresolvedx');
});

test('cada consulta se guarda 5 minutos; dos cargas al mismo tiempo comparten una', async () => {
  let t = 0;
  const { fetch, llamadas } = fetchFalso(() => ({ cuerpo: [] }));
  const lector = crearLectorSentry({ env: ENV, fetch, ahora: () => t });
  await Promise.all([lector.deCondominio('aromos'), lector.deCondominio('aromos')]);
  assert.equal(llamadas.length, 1);
  t = CACHE_MS - 1;
  await lector.deCondominio('aromos');
  assert.equal(llamadas.length, 1);
  await lector.deCondominio('mirador');
  assert.equal(llamadas.length, 2, 'otro condominio es otra consulta');
  t = CACHE_MS + 1;
  await lector.deCondominio('aromos');
  assert.equal(llamadas.length, 3);
});

test('un error de Sentry se dice y nunca lanza; se reintenta al minuto', async () => {
  let t = 0;
  let respuesta = { status: 401, cuerpo: { detail: 'Invalid token' } };
  const { fetch, llamadas } = fetchFalso(() => respuesta);
  const lector = crearLectorSentry({ env: ENV, fetch, ahora: () => t });
  assert.match((await lector.deCondominio('aromos')).error, /401.*SENTRY_TOKEN_LECTURA/);
  t = 30000;
  await lector.deCondominio('aromos');
  assert.equal(llamadas.length, 1, 'el error también se guarda, un minuto');
  t = 61000;
  respuesta = { status: 500, cuerpo: {} };
  assert.equal((await lector.deCondominio('aromos')).error, 'Sentry respondió 500.');

  const casos = [
    [new Error('ECONNREFUSED'), /No se pudo conectar/],
    [Object.assign(new Error('tarde'), { name: 'TimeoutError' }), /no respondió a tiempo/],
    [{ cuerpo: { detail: 'no soy una lista' } }, /no es una lista/]
  ];
  for (const [r, esperado] of casos) {
    const f = fetchFalso(() => r);
    assert.match((await crearLectorSentry({ env: ENV, fetch: f.fetch }).sinCondominio()).error, esperado);
  }
});

test('un problema sin enlace https o sin título no rompe nada', () => {
  const p = problema({ permalink: 'javascript:alert(1)', count: 'x' });
  assert.equal(p.enlace, null);
  assert.equal(p.titulo, '(sin título)');
  assert.equal(p.eventos, 0);
});
