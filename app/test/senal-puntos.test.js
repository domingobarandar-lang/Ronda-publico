// Señal por punto (ADR-001, fase 2): la cuenta que ve el administrador en el
// panel y que usa el diagnóstico de la base, con marcas y rechazos de verdad.
process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const motor = require('../lib/rondas');
const { resumenSenal, tipoRechazo, percentil } = require('../lib/senal-puntos');

const LAT = -33.45;
const LON = -70.66;
const lectura = (m, acc, edadMs = 1000) => ({ lat: LAT + m / 111320, lon: LON, acc, edadMs });
const cfg = () => motor.configGps();

const exacto = { id: 'p-x', nombre: 'Portería', lat: LAT, lon: LON, precisionM: 5 };
const anclado = { id: 'p-a', nombre: 'Sala de bombas', lat: LAT, lon: LON, precisionM: 6, verificacion: 'anclaje' };

// Una ejecución con marcas y rechazos de un solo punto.
const ejecucion = (puntoId, marcas, rechazos = []) => ({
  id: `e-${Math.random()}`,
  escaneos: marcas.map((m, i) => ({ puntoId, ts: `2026-10-01T03:0${i}:00.000Z`, ...m })),
  rechazos: rechazos.map((r, i) => ({ puntoId, ts: `2026-10-01T04:0${i}:00.000Z`, ...r }))
});
const varias = (n, marca) => Array.from({ length: n }, () => marca);
const uno = (punto, ejecuciones) => resumenSenal([punto], ejecuciones, cfg())[0];

test('tipoRechazo: lee lo que guardaron el teléfono y el servidor', () => {
  const c = cfg();
  assert.equal(tipoRechazo({ motivo: '📍 Señal demasiado imprecisa (±150 m) para…', acc: 150, edadMs: 2000 }, c), 'imprecisa');
  assert.equal(tipoRechazo({ motivo: 'Estás a 70 m de…', distanciaM: 70, topeM: 45, acc: 15, edadMs: 0 }, c), 'distancia');
  assert.equal(tipoRechazo({ motivo: '📍 Tu ubicación es de hace 2 min…', acc: 8, edadMs: 120000 }, c), 'vencida');
  assert.equal(tipoRechazo({ motivo: '📍 Sin ubicación (buscando señal): …' }, c), 'sinSenal');
  assert.equal(tipoRechazo({ motivo: 'Sin señal GPS: no se puede confirmar…' }, c), 'sinSenal');
  assert.equal(tipoRechazo({ reporte: 'chapita', motivo: 'El guardia reportó que la chapita no leyó.' }, c), 'chapita');
  assert.equal(tipoRechazo({ motivo: 'Este punto se marca con su chapita NFC.' }, c), 'otro');
});

test('percentil: por rango, devuelve una lectura que existió', () => {
  assert.equal(percentil([], 0.5), null);
  assert.equal(percentil([7], 0.9), 7);
  assert.equal(percentil([30, 5, 6, 8], 0.5), 6);
  assert.equal(percentil([30, 5, 6, 8], 0.9), 30);
});

test('un punto a cielo abierto: buena, sin recomendación', () => {
  const s = uno(exacto, [ejecucion('p-x', varias(10, { gps: lectura(4, 6) }))]);
  assert.equal(s.nivel, 'buena');
  assert.equal(s.accMediana, 6);
  assert.equal(s.marcas, 10);
  assert.equal(s.recomendacion, null);
});

test('bajo losa: lecturas de ±40 y rechazos → mala, y sugiere chapita o entrada', () => {
  const s = uno(exacto, [ejecucion('p-x', varias(6, { gps: lectura(10, 40) }), [
    { motivo: '📍 Señal demasiado imprecisa (±180 m)…', acc: 180, edadMs: 1000 },
    { motivo: 'Estás a 90 m…', distanciaM: 90, topeM: 60, acc: 40, edadMs: 0 }
  ])]);
  assert.equal(s.nivel, 'mala');
  assert.deepEqual([s.rechazos.imprecisa, s.rechazos.distancia, s.rechazosGps], [1, 1, 2]);
  assert.match(s.recomendacion, /chapita NFC/);
  assert.match(s.recomendacion, /🏠/);
});

test('buena señal pero 1 de cada 4 intentos rechazado → mala', () => {
  const s = uno(exacto, [ejecucion('p-x', varias(6, { gps: lectura(4, 8) }),
    varias(2, { motivo: 'Estás a 60 m…', distanciaM: 60, topeM: 33, acc: 8, edadMs: 0 }))]);
  assert.equal(s.nivel, 'mala');
});

test('semi-techado: entra por cercanía la mitad de las veces → regular', () => {
  const porCercania = { gps: lectura(45, 15, 0), cercania: lectura(10, 8, 50000) };
  const s = uno(exacto, [ejecucion('p-x', [...varias(4, porCercania), ...varias(4, { gps: lectura(5, 12) })],
    [{ motivo: 'Estás a 80 m…', distanciaM: 80, topeM: 40, acc: 15, edadMs: 0 }])]);
  assert.equal(s.porCercania, 4);
  assert.equal(s.nivel, 'regular');
  assert.match(s.recomendacion, /cercanía/);
  // El ± que cuenta es el de la lectura del momento (±15), no el de la cercana.
  assert.equal(s.accMediana, 12);
  assert.equal(s.accP90, 15);
});

test('con menos de 3 intentos no opina', () => {
  const s = uno(exacto, [ejecucion('p-x', varias(2, { gps: lectura(4, 6) }))]);
  assert.equal(s.nivel, null);
  assert.equal(s.recomendacion, null);
});

test('marcas al borde del tope', () => {
  // Tope con ±10: 20 + min(5 + 10, 40) = 35 m. A 30 m es más del 80 %.
  const s = uno(exacto, [ejecucion('p-x', [{ gps: lectura(30, 10) }, { gps: lectura(5, 10) }])]);
  assert.equal(s.alBorde, 1);
});

test('punto 🏠 con buena señal en el punto: sugiere pasarlo a exacto', () => {
  const s = uno(anclado, [ejecucion('p-a', varias(5, { gps: lectura(3, 7) }))]);
  assert.equal(s.modo, 'anclaje');
  assert.equal(s.nivel, 'buena');
  assert.match(s.recomendacion, /📍 exacto/);
});

test('punto 🏠 con rechazos de lecturas frescas: el ancla perdida (INC-002)', () => {
  const s = uno(anclado, [ejecucion('p-a', varias(3, { gps: lectura(5, 6, 300000) }), [
    { motivo: '📍 Señal demasiado imprecisa (±150 m)…', acc: 150, edadMs: 3000 },
    { motivo: 'Estás a 90 m de la entrada…', distanciaM: 90, topeM: 70, acc: 30, edadMs: 5000 },
    { motivo: '📍 Tu última ubicación es de hace 16 min…', acc: 6, edadMs: 16 * 60000 }
  ])]);
  assert.equal(s.anclaPerdida, 2, 'la vencida no cuenta: esa sí traía la lectura de la entrada');
  assert.equal(s.nivel, 'mala');
  assert.match(s.recomendacion, /entrada fijada/);
});

test('punto con chapita o sin ubicación: cuenta, pero no recomienda', () => {
  const conChapita = { ...exacto, nfcSerie: '04A1B2C3' };
  const s = uno(conChapita, [ejecucion('p-x', varias(5, { gps: lectura(10, 60) }))]);
  assert.equal(s.modo, 'nfc');
  assert.equal(s.recomendacion, null);
  const sinUbicacion = { id: 'p-s', nombre: 'Quincho' };
  const t = uno(sinUbicacion, [ejecucion('p-s', varias(5, { gps: lectura(10, 60) }))]);
  assert.equal(t.modo, 'ninguna');
  assert.equal(t.recomendacion, null);
});

test('marcas sin GPS y rechazos de otros puntos', () => {
  const s = uno(exacto, [
    ejecucion('p-x', [{ gps: null }, {}, { gps: lectura(4, 6) }]),
    ejecucion('p-otro', varias(5, { gps: lectura(4, 6) }), [{ motivo: 'Estás a 90 m…', distanciaM: 90 }])
  ]);
  assert.equal(s.marcas, 3);
  assert.equal(s.sinGps, 2);
  assert.equal(s.rechazosGps, 0);
});

test('API: GET /api/admin/puntos/senal, solo el administrador y solo su condominio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-senal-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const { app, store } = crearApp({ rutaDb, enviarPush: async () => {} });
  const servidor = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const api = async (ruta, { metodo = 'GET', cuerpo, token } = {}) => {
    const resp = await fetch(base + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    return { status: resp.status, datos: await resp.json().catch(() => ({})) };
  };
  try {
    const marta = (await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'marta', pin: '1111' } })).datos;
    const pedro = (await api('/api/login', { metodo: 'POST', cuerpo: { usuario: 'pedro', pin: '2222' } })).datos;
    await api('/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta.token, cuerpo: { lat: LAT, lon: LON, precisionM: 5 } });

    // Una ronda de hoy y una de hace 40 días: la vieja no cuenta.
    const hoy = new Date().toISOString();
    const vieja = new Date(Date.now() - 40 * 86400000).toISOString();
    for (const [id, inicio, acc] of [['e-hoy', hoy, 6], ['e-vieja', vieja, 150]]) {
      store.ejecuciones.guardar({
        id, rondaId: 'ronda-express', condominioId: 'aromos', guardiaId: 'u-pedro', inicio, fin: inicio,
        estado: 'completa', evaluacion: null,
        escaneos: varias(3, { puntoId: 'p-porteria', ts: inicio, gps: lectura(4, acc) })
      });
    }

    const r = await api('/api/admin/puntos/senal', { token: marta.token });
    assert.equal(r.status, 200);
    assert.equal(r.datos.dias, 30);
    assert.equal(r.datos.ejecuciones, 1);
    const porteria = r.datos.puntos.find(s => s.puntoId === 'p-porteria');
    assert.equal(porteria.marcas, 3);
    assert.equal(porteria.nivel, 'buena');
    // Solo los puntos del condominio del administrador.
    const propios = store.db.puntos.filter(p => p.condominioId === 'aromos').map(p => p.id).sort();
    assert.deepEqual(r.datos.puntos.map(s => s.puntoId).sort(), propios);

    const comoGuardia = await api('/api/admin/puntos/senal', { token: pedro.token });
    assert.ok(comoGuardia.status === 401 || comoGuardia.status === 403, `el guardia recibió ${comoGuardia.status}`);
  } finally {
    servidor.close();
  }
});
