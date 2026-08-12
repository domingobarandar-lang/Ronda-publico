// La verificación de presencia está escrita DOS veces a propósito: en
// lib/rondas.js (servidor) y en public/app.js (teléfono, que tiene que decidir
// sin conexión y no comparte módulos con el servidor). Esa duplicación es la
// decisión correcta, pero se paga con el riesgo de que las dos se separen: si la
// app es más dura, el guardia ve rechazos que el servidor habría aceptado; si es
// más blanda, encola marcas que el servidor va a botar después.
//
// Este test barre la grilla completa de escenarios contra las dos y exige que
// coincidan en el veredicto. Ya cazó un caso real: un fix sin precisión
// declarada valía ±0 m en el servidor (Number(null) === 0) y ±15 m en la app.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const motor = require('../lib/rondas');

const fuente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// Extrae "function nombre(...) { ... }" balanceando llaves. Se saca el código
// real del archivo —no una copia— para que el test no pueda quedar desfasado.
function extraer(nombre) {
  const i = fuente.indexOf(`function ${nombre}(`);
  assert.ok(i !== -1, `public/app.js ya no define ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

// Monta las funciones del teléfono en un ámbito con las globales que usan
// (estado, gpsActual, gpsMotivoFalla), sin necesitar DOM ni localStorage.
function montarApp(cfg) {
  const nombres = ['cfgGps', 'umbralesDe', 'margenM', 'distanciaM', 'minutos', 'gpsUltimo', 'verificarPresencia'];
  const codigo = `
    let estado = { paquete: { gps: CFG } };
    let gpsActual = null;
    let gpsMotivoFalla = null;
    ${nombres.map(extraer).join('\n')}
    return { verificarPresencia, gpsUltimo, fijarGps: g => { gpsActual = g; } };
  `;
  return new Function('CFG', codigo)(cfg);
}

test('la app del guardia y el servidor deciden lo mismo en toda la grilla', () => {
  const cfg = motor.configGps();
  const app = montarApp(cfg);

  const base = { nombre: 'Punto', lat: -33.45, lon: -70.66 };
  const puntos = [
    { ...base, precisionM: 5 },                        // bien medido
    { ...base, precisionM: 40 },                       // medido mal
    { ...base },                                       // fijado sin medir (< v1.13)
    { ...base, precisionM: 5, radioM: 35 },            // radio propio
    { ...base, precisionM: 8, verificacion: 'anclaje' },
    { ...base, verificacion: 'anclaje' }
  ];
  const fixes = [];
  for (const dLat of [0, 0.00010, 0.00027, 0.0005, 0.0009, 0.01]) {
    for (const acc of [null, 0, 5, 15, 30, 60, 99, 101, 300]) {
      for (const edadMs of [0, 5000, 19000, 60000, 5 * 60000, 20 * 60000]) {
        fixes.push({ lat: -33.45 + dLat, lon: -70.66, acc, edadMs });
      }
    }
  }

  const divergencias = [];
  for (const punto of puntos) {
    for (const gps of fixes) {
      const servidor = motor.verificarPresencia(punto, gps, cfg);
      // El teléfono recibe los umbrales del punto ya resueltos por el servidor,
      // en el paquete de rondas: se le pasan igual que en /api/mi/paquete.
      const u = motor.umbralesDe(punto, cfg);
      app.fijarGps({ lat: gps.lat, lon: gps.lon, acc: gps.acc, ts: Date.now() - gps.edadMs });
      const enElTelefono = app.verificarPresencia({
        nombre: punto.nombre,
        lat: punto.lat,
        lon: punto.lon,
        verificacion: motor.modoVerificacion(punto),
        radioM: u.radioM,
        ventanaMs: u.ventanaMs,
        precisionM: u.precisionM
      });
      if (Boolean(servidor.ok) !== Boolean(enElTelefono.ok)) {
        divergencias.push(`punto ${JSON.stringify(punto)} + gps ${JSON.stringify(gps)}: `
          + `servidor ${servidor.ok ? 'acepta' : 'rechaza'}, app ${enElTelefono.ok ? 'acepta' : 'rechaza'}`);
      }
    }
  }

  assert.deepEqual(divergencias, [], `${divergencias.length} de ${puntos.length * fixes.length} escenarios divergen`);
});

// El piso de precisión (v1.14) es lo único que protege al servidor de un acc que
// ahora CALCULA la app: desde que el teléfono promedia varias lecturas, un error
// en esa fórmula podría declarar ±1 m donde la realidad es ±40 y aflojar el
// margen de todo el sistema. La grilla de arriba ya prueba acc: 0 y lo cazaría
// como divergencia, pero solo si los dos lados aplican el piso; este test dice en
// voz alta cuál es el número, para que no se arregle "alineando" hacia abajo.
test('acc 0 y acc 1 se tratan como el piso de precisión en los dos lados', () => {
  const cfg = motor.configGps();
  const app = montarApp(cfg);
  const piso = cfg.precisionMinM;
  assert.ok(piso > 0, 'sin piso, acc 0 pesa Infinity en el centroide de geo.js');

  for (const acc of [0, 1, piso]) {
    const enElServidor = motor.verificarPresencia(
      { nombre: 'Punto', lat: -33.45, lon: -70.66, precisionM: 5 },
      { lat: -33.45, lon: -70.66, acc, edadMs: 0 },
      cfg
    );
    assert.equal(enElServidor.precisionM, piso, `el servidor aceptó acc ${acc} sin piso`);

    app.fijarGps({ lat: -33.45, lon: -70.66, acc, ts: Date.now() });
    assert.equal(app.gpsUltimo().acc, piso, `la app aceptó acc ${acc} sin piso`);
  }

  // geo.js afirma en un comentario que su piso es el mismo del servidor. Un
  // comentario no sostiene un invariante: si alguien mueve uno de los dos, el
  // centroide empieza a ponderar con un piso distinto del que valida el motor.
  assert.equal(require('../public/geo').PISO_ACC_M, piso,
    'geo.PISO_ACC_M y GPS_PRECISION_MIN_M se separaron');

  // Y por arriba del piso no se toca nada: sería inventar imprecisión.
  app.fijarGps({ lat: -33.45, lon: -70.66, acc: 12, ts: Date.now() });
  assert.equal(app.gpsUltimo().acc, 12);
  // Sin dato declarado sigue siendo null (desconocida), NO el piso: el piso es
  // para el número malo, no para el número ausente.
  app.fijarGps({ lat: -33.45, lon: -70.66, acc: null, ts: Date.now() });
  assert.equal(app.gpsUltimo().acc, null);
});
