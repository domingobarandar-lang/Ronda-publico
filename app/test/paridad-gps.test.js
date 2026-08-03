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
    return { verificarPresencia, fijarGps: g => { gpsActual = g; } };
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
