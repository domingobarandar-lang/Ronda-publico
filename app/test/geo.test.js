// public/geo.js es la única copia de la matemática de ubicación: la usan el
// panel al medir un punto y el teléfono al consolidar los fixes del guardia. Un
// error acá no se ve en ninguna pantalla —sale como una coordenada un poco
// corrida o un ± demasiado optimista— y termina en un guardia rechazado estando
// encima del punto. Por eso se prueban también los casos absurdos: acc 0, una
// sola muestra, todas iguales, ninguna.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../public/geo');

// ~11.1 m por cada 0.0001° de latitud en el ecuador; sirve para armar muestras
// con distancias conocidas sin escribir números mágicos.
const LAT = -33.45;
const LON = -70.66;
const m = (dLatM, dLonM, acc) => ({
  lat: LAT + dLatM / 111320,
  lon: LON + dLonM / (111320 * Math.cos((LAT * Math.PI) / 180)),
  acc
});

test('metrosEntre mide sin redondear', () => {
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, m(10, 0));
  assert.ok(Math.abs(d - 10) < 0.5, `esperaba ~10 m, dio ${d}`);
  assert.equal(geo.metrosEntre({ lat: LAT, lon: LON }, { lat: LAT, lon: LON }), 0);
});

test('filtrarOutliers descarta la lectura que se fue lejos del grupo', () => {
  const muestras = [m(0, 0, 5), m(1, 0, 5), m(-1, 0, 5), m(0, 1, 5), m(300, 0, 5)];
  const quedan = geo.filtrarOutliers(muestras);
  assert.equal(quedan.length, 4);
  assert.ok(!quedan.some(x => Math.abs(x.lat - muestras[4].lat) < 1e-12), 'la lectura absurda sigue adentro');
});

test('filtrarOutliers no filtra con menos de 4 muestras', () => {
  const muestras = [m(0, 0, 5), m(300, 0, 5), m(1, 0, 5)];
  assert.equal(geo.filtrarOutliers(muestras).length, 3);
});

test('filtrarOutliers con buffer vacío devuelve []', () => {
  assert.deepEqual(geo.filtrarOutliers([]), []);
  assert.deepEqual(geo.filtrarOutliers(null), []);
  assert.deepEqual(geo.filtrarOutliers(undefined), []);
});

test('filtrarOutliers con todas las muestras iguales (MAD = 0) no descarta ninguna', () => {
  const muestras = [m(0, 0, 5), m(0, 0, 5), m(0, 0, 5), m(0, 0, 5), m(0, 0, 5)];
  assert.equal(geo.filtrarOutliers(muestras).length, 5);
});

test('filtrarOutliers ignora las lecturas sin coordenada', () => {
  const muestras = [m(0, 0, 5), m(1, 0, 5), { lat: null, lon: null, acc: 5 }, m(-1, 0, 5), m(0, 1, 5)];
  const quedan = geo.filtrarOutliers(muestras);
  assert.equal(quedan.length, 4);
  assert.ok(quedan.every(x => Number.isFinite(x.lat)));
});

test('centroidePonderado pondera por 1/acc²: la lectura precisa manda', () => {
  // Una lectura de ±5 m a 0 m y otra de ±50 m a 100 m: la segunda pesa 100 veces
  // menos, así que el centroide tiene que quedar pegado a la primera.
  const centro = geo.centroidePonderado([m(0, 0, 5), m(100, 0, 50)]);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, centro);
  assert.ok(d < 2, `el centroide se fue a ${d} m de la lectura buena`);
});

test('CRÍTICO centroidePonderado con acc 0 aplica el piso y no devuelve NaN', () => {
  // acc 0 → peso 1/0² = Infinity → lat NaN → distanciaM NaN → "NaN <= topeM" es
  // false → guardia bloqueado con un mensaje absurdo. El piso cierra el camino.
  const centro = geo.centroidePonderado([m(0, 0, 0), m(20, 0, 3)]);
  assert.ok(Number.isFinite(centro.lat) && Number.isFinite(centro.lon), 'el centroide salió NaN');
  // Con el piso las dos lecturas pesan igual (0 y 3 caen ambas en PISO_ACC_M),
  // así que el centroide queda a media distancia y no encima de la de acc 0.
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, centro);
  assert.ok(d > 5 && d < 15, `esperaba el punto medio (~10 m), dio ${d}`);
});

test('CRÍTICO centroidePonderado con buffer vacío devuelve null, no {lat: NaN}', () => {
  assert.equal(geo.centroidePonderado([]), null);
  assert.equal(geo.centroidePonderado(null), null);
  assert.equal(geo.centroidePonderado([{ lat: null, lon: null, acc: 5 }]), null);
});

test('centroidePonderado ignora las lecturas sin precisión si otras la declaran', () => {
  // La lectura sin acc está a 100 m. Con Number(null) === 0 pesaría más que
  // ninguna otra y se llevaría el centroide; sin dato con qué ponderarla, no entra.
  const centro = geo.centroidePonderado([m(0, 0, 5), m(0, 0, 5), m(100, 0, null)]);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, centro);
  assert.ok(d < 1, `la lectura sin precisión arrastró el centroide a ${d} m`);
});

test('centroidePonderado sin ninguna precisión declarada promedia parejo', () => {
  const centro = geo.centroidePonderado([m(0, 0, null), m(20, 0, null)]);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, centro);
  assert.ok(Math.abs(d - 10) < 1, `esperaba el punto medio, dio ${d}`);
});

test('dispersion68 devuelve el radio que cubre el 68% de las lecturas', () => {
  // 10 lecturas: 7 dentro de 5 m y 3 a 50 m. El percentil 68 tiene que caer en
  // el grupo apretado, no en la cola.
  const muestras = [];
  for (let i = 0; i < 7; i++) muestras.push(m(i * 0.7, 0, 5));
  for (let i = 0; i < 3; i++) muestras.push(m(50 + i, 0, 5));
  const disp = geo.dispersion68(muestras, { lat: LAT, lon: LON });
  assert.ok(disp > 0 && disp < 10, `esperaba el grupo apretado, dio ${disp}`);
});

test('dispersion68 con una sola muestra da 0 y con centro inválido da null', () => {
  assert.equal(geo.dispersion68([m(0, 0, 5)], { lat: LAT, lon: LON }), 0);
  assert.equal(geo.dispersion68([m(0, 0, 5)], null), null);
  assert.equal(geo.dispersion68([], { lat: LAT, lon: LON }), null);
});

test('precisionHonesta nunca baja del piso físico aunque las lecturas coincidan', () => {
  // 40 lecturas idénticas de ±1 m: dispersión 0 y teórica 1/√40. Prometer ±0 m
  // sería el error de v1.10 con más matemática encima.
  const muestras = Array.from({ length: 40 }, () => m(0, 0, 1));
  const centro = geo.centroidePonderado(muestras);
  assert.equal(geo.precisionHonesta(muestras, centro), geo.PISO_FISICO_M);
});

test('precisionHonesta manda la dispersión observada cuando las lecturas están regadas', () => {
  // Lecturas que DECLARAN ±5 m pero caen repartidas en 40 m: el teléfono está
  // mintiendo y el número que se guarda tiene que decir la verdad.
  const muestras = [];
  for (let i = 0; i < 10; i++) muestras.push(m(i * 8, 0, 5));
  const centro = geo.centroidePonderado(muestras);
  const p = geo.precisionHonesta(muestras, centro);
  assert.ok(p >= 25, `la dispersión real era ~30 m y declaró ±${p} m`);
});

test('precisionHonesta con una sola muestra declara su propia precisión', () => {
  const muestras = [m(0, 0, 30)];
  assert.equal(geo.precisionHonesta(muestras, geo.centroidePonderado(muestras)), 30);
});

test('precisionHonesta sin muestras devuelve null', () => {
  assert.equal(geo.precisionHonesta([], { lat: LAT, lon: LON }), null);
});

test('precisionHonesta mejora con la raíz de N, no linealmente', () => {
  // 16 lecturas de ±20 m superpuestas: el techo teórico es 20/√16 = 5 m, no 1.25.
  const muestras = Array.from({ length: 16 }, () => m(0, 0, 20));
  const p = geo.precisionHonesta(muestras, geo.centroidePonderado(muestras));
  assert.equal(p, 5);
});
