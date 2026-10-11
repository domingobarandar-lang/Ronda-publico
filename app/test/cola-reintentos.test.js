// La cola de sincronización del teléfono (sincronizar() en public/app.js).
//
// Antes de v1.19.2 cualquier respuesta con status distinto de 401 —un 502 del
// proxy de Railway en pleno deploy, un 500, un 429— se tomaba por "el servidor
// rechazó el evento" y se borraba de la cola: la marca que el guardia ya había
// visto como ✅ nunca llegaba al informe. Ahora solo se descarta un 4xx
// definitivo; lo transitorio se reintenta con espera creciente y tope de
// intentos.
//
// Se extrae del fuente real, igual que app-gps.test.js: este test no puede
// quedar desfasado del archivo que se despliega.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fuente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function extraer(nombre) {
  const i = Math.max(fuente.indexOf(`async function ${nombre}(`), fuente.indexOf(`\nfunction ${nombre}(`) + 1);
  assert.ok(i > 0, `public/app.js ya no define ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

function constante(nombre) {
  const m = new RegExp(`const ${nombre} = (\\d+)`).exec(fuente);
  assert.ok(m, `public/app.js ya no define ${nombre}`);
  return Number(m[1]);
}

const MAX = constante('MAX_INTENTOS_EVENTO');
const BASE = constante('ESPERA_REINTENTO_MS');
const TOPE = constante('ESPERA_REINTENTO_MAX_MS');

// Monta sincronizar() con un `api` falso y un estado en memoria. `respuestas`
// decide qué contesta el "servidor" a cada llamada: un objeto vale como éxito,
// un número como error con ese status, null como falla sin respuesta (sin red).
function montar({ cola, respuestas }) {
  const llamadas = [];
  const avisos = [];
  const estado = { sesion: { token: 't' }, cola, ejecucion: null, ultimoInforme: null };
  let reloj = 1_000_000;
  const siguiente = typeof respuestas === 'function' ? respuestas : () => respuestas;

  const codigo = `
    const MAX_INTENTOS_EVENTO = ${MAX};
    const ESPERA_REINTENTO_MS = ${BASE};
    const ESPERA_REINTENTO_MAX_MS = ${TOPE};
    let sincronizando = false;
    ${extraer('decidirFalla')}
    ${extraer('esperaReintentoMs')}
    ${extraer('sincronizar')}
    return { sincronizar, decidirFalla, esperaReintentoMs };
  `;
  const modulo = new Function(
    'estado', 'navigator', 'api', 'guardarEstado', 'aviso', 'pintarConexion', 'renderSync', 'renderFinal',
    'document', 'Date', 'console', codigo
  )(
    estado,
    { onLine: true },
    async (ruta, opciones) => {
      llamadas.push({ ruta, metodo: opciones.metodo });
      const r = siguiente(llamadas.length, ruta);
      if (r === null) throw new TypeError('Failed to fetch'); // sin status: no hubo respuesta
      if (typeof r === 'number') { const e = new Error(`Error HTTP ${r}`); e.status = r; throw e; }
      return r;
    },
    () => {},
    (texto, tipo) => avisos.push({ texto, tipo }),
    () => {},
    () => {},
    () => {},
    { getElementById: () => ({ classList: { contains: () => true } }) },
    { now: () => reloj },
    { warn: () => {} }
  );
  return { ...modulo, estado, llamadas, avisos, avanzar: ms => { reloj += ms; } };
}

const escaneo = n => ({ tipo: 'escaneo', ejecucionId: 'e-1', codigo: `RQR:${n}`, ts: '2026-10-11T10:00:00Z' });

// ---------- decidirFalla ----------

test('un 5xx, 408 o 429 se reintenta; un 4xx definitivo se descarta', () => {
  const app = montar({ cola: [], respuestas: {} });
  for (const status of [500, 502, 503, 504, 408, 429]) {
    assert.equal(app.decidirFalla({}, { status }), 'reintentar', `HTTP ${status}`);
  }
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(app.decidirFalla({}, { status }), 'descartar', `HTTP ${status}`);
  }
  assert.equal(app.decidirFalla({}, { status: 401 }), 'sesion');
});

test('sin respuesta (sin red) siempre se reintenta y nunca agota intentos', () => {
  const app = montar({ cola: [], respuestas: {} });
  assert.equal(app.decidirFalla({ intentos: 9999 }, new TypeError('Failed to fetch')), 'reintentar');
});

test('un 5xx se descarta recién al agotar los intentos', () => {
  const app = montar({ cola: [], respuestas: {} });
  assert.equal(app.decidirFalla({ intentos: MAX - 2 }, { status: 500 }), 'reintentar');
  assert.equal(app.decidirFalla({ intentos: MAX - 1 }, { status: 500 }), 'descartar');
});

test('la espera crece al doble y tiene tope', () => {
  const app = montar({ cola: [], respuestas: {} });
  assert.equal(app.esperaReintentoMs(1), BASE);
  assert.equal(app.esperaReintentoMs(2), BASE * 2);
  assert.equal(app.esperaReintentoMs(3), BASE * 4);
  assert.equal(app.esperaReintentoMs(50), TOPE);
});

// ---------- sincronizar ----------

test('un 502 durante un deploy NO borra la marca: queda en la cola con su espera', async () => {
  const app = montar({ cola: [escaneo(1), escaneo(2)], respuestas: 502 });
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 2, 'ningún evento se perdió');
  assert.equal(app.estado.cola[0].intentos, 1);
  assert.ok(app.estado.cola[0].noAntesDe > 1_000_000, 'quedó con una espera anotada');
  assert.equal(app.llamadas.length, 1, 'no insiste con el resto de la cola en el mismo ciclo');
  assert.equal(app.avisos.length, 0, 'no le dice al guardia que la marca fue rechazada');
});

test('mientras dura la espera no vuelve a pegarle al servidor', async () => {
  const app = montar({ cola: [escaneo(1)], respuestas: 503 });
  await app.sincronizar();
  await app.sincronizar();
  await app.sincronizar();
  assert.equal(app.llamadas.length, 1);
});

test('pasada la espera, reintenta y al volver el servidor entrega todo en orden', async () => {
  let servidorCaido = true;
  const app = montar({
    cola: [escaneo(1), escaneo(2), { tipo: 'cerrar', ejecucionId: 'e-1', fin: '2026-10-11T10:30:00Z' }],
    respuestas: () => (servidorCaido ? 502 : { ok: true })
  });
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 3);

  servidorCaido = false;
  app.avanzar(BASE + 1);
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 0, 'la cola se vació');
  assert.deepEqual(app.llamadas.map(l => l.ruta), [
    '/api/ejecuciones/e-1/escaneos',
    '/api/ejecuciones/e-1/escaneos',
    '/api/ejecuciones/e-1/escaneos',
    '/api/ejecuciones/e-1/cerrar'
  ]);
});

test('un 422 sí se descarta, avisa al guardia y deja pasar lo siguiente', async () => {
  let n = 0;
  const app = montar({
    cola: [escaneo(1), escaneo(2)],
    respuestas: () => (++n === 1 ? 422 : { ok: true })
  });
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 0);
  assert.equal(app.avisos.length, 1);
  assert.match(app.avisos[0].texto, /rechaz/);
});

test('un evento que siempre da 500 se descarta al agotar los intentos y no traba la cola', async () => {
  let n = 0;
  const app = montar({
    cola: [escaneo(1), escaneo(2)],
    respuestas: () => (++n <= MAX ? 500 : { ok: true })
  });
  for (let i = 0; i < MAX; i++) {
    await app.sincronizar();
    app.avanzar(TOPE + 1);
  }
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 0, 'el venenoso salió y el siguiente se envió');
  assert.equal(app.avisos.length, 1, 'el guardia se entera de la marca perdida');
});

test('sin red no anota intentos ni espera', async () => {
  const app = montar({ cola: [escaneo(1)], respuestas: null });
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 1);
  assert.equal(app.estado.cola[0].intentos, undefined);
  assert.equal(app.estado.cola[0].noAntesDe, undefined);
});

test('un 401 conserva la cola y pide entrar de nuevo', async () => {
  const app = montar({ cola: [escaneo(1)], respuestas: 401 });
  await app.sincronizar();
  assert.equal(app.estado.cola.length, 1);
  assert.equal(app.estado.sesion, null);
});
