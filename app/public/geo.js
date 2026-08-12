// Matemática de ubicación compartida por las DOS apps: el panel cuando mide un
// punto (admin.js) y el teléfono cuando consolida los fixes del guardia
// (app.js). Es la misma pregunta en los dos lados —"dado un puñado de lecturas
// del GPS, ¿dónde está esto y con cuánto error?"— y va a seguir en ajuste: dos
// copias divergen en el primer cambio de umbral.
//
// Fijar una posición con UNA lectura era el error de fondo. El primer fix de un
// GPS frío sale de WiFi o de antena, con ±30-100 m, y quedarse con "la mejor de
// N lecturas" no arregla nada: es elegir el error más favorable y llamarlo
// precisión. La estrategia entera cabe en tres pasos:
//
//   1. filtrarOutliers()     cada tanto el GPS suelta una lectura absurda (la
//                            señal rebotó en una pared y llegó tarde). Se
//                            descartan por mediana, no por promedio: el promedio
//                            ya viene contaminado por la lectura que se quiere
//                            botar.
//   2. centroidePonderado()  promedio ponderado por 1/acc². Una lectura de ±5 m
//                            pesa 36 veces más que una de ±30 m. Es el estimador
//                            de mínima varianza cuando los errores son
//                            independientes entre sí.
//   3. precisionHonesta()    el ± que se DECLARA para ese resultado. Promediar
//                            mata el error aleatorio, no el sesgo: bajo techo el
//                            multipath es sistemático y no se cancela con más
//                            muestras. Por eso se declara el MÁXIMO entre la
//                            dispersión observada, lo que promete la teoría y un
//                            piso físico. Declarar ±3 m en un subterráneo porque
//                            40 muestras coincidieron sería mentir con más
//                            matemática encima.
'use strict';

// Piso de la precisión declarada de una lectura, en metros. Un acc de 0 no
// significa "exacto", significa que el teléfono no sabe. Y acá es peor que un
// error de criterio: el peso es 1/acc², así que acc 0 pesa Infinity, el
// centroide sale NaN, distanciaM devuelve NaN, `NaN <= topeM` es false y el
// guardia queda bloqueado con un mensaje sin sentido. Mismo valor que
// GPS_PRECISION_MIN_M en lib/rondas.js: es el mismo piso, a los dos lados.
const PISO_ACC_M = 3;

// Piso del ± que se declara para una posición ya promediada. Con GNSS civil de
// una sola frecuencia no se puede prometer menos, por muchas muestras que
// coincidan: la ionosfera y el multipath desplazan a todas juntas.
const PISO_FISICO_M = 4;

// Metros entre dos {lat, lon}. SIN redondear, a diferencia de distanciaM() de
// lib/rondas.js y app.js: acá el resultado alimenta un percentil, y redondear a
// metros enteros antes de medir dispersión bota justo la resolución que se está
// tratando de medir.
function metrosEntre(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function mediana(numeros) {
  if (!numeros.length) return null;
  const orden = [...numeros].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

// Muestras con coordenada usable. Una lectura sin lat/lon no es "una lectura
// mala": no es una lectura, y colarla haría NaN todo lo que viene después.
function usables(muestras) {
  return (Array.isArray(muestras) ? muestras : [])
    .filter(m => m && Number.isFinite(m.lat) && Number.isFinite(m.lon));
}

// Precisión declarada de una muestra, con el piso aplicado. null = el teléfono
// no la informó: se resuelve en centroidePonderado(), donde sí se sabe contra
// qué compararla.
//
// Ojo con Number(null) === 0, la misma trampa que limpiarGps() en lib/rondas.js:
// una lectura SIN precisión declarada no es una lectura perfecta, y tomarla como
// acc 0 le regalaría el peso máximo justo al dato de calidad desconocida.
function accConPiso(muestra, pisoM) {
  if (muestra.acc == null || muestra.acc === '') return null;
  const acc = Number(muestra.acc);
  return Number.isFinite(acc) && acc >= 0 ? Math.max(acc, pisoM) : null;
}

// Descarta las lecturas que se fueron lejos del grupo: más de 3 desviaciones
// absolutas medianas (MAD) de la mediana, en latitud o en longitud. La mediana y
// el MAD se usan en vez del promedio y la desviación estándar porque el
// estadístico tiene que sobrevivir a la muestra que se quiere botar.
//
// Con menos de 4 lecturas no se filtra nada: el MAD no significa nada ahí, y
// botar una de tres muestras es más peligroso que quedársela.
function filtrarOutliers(muestras) {
  const utiles = usables(muestras);
  if (utiles.length < 4) return utiles;
  const medLat = mediana(utiles.map(m => m.lat));
  const medLon = mediana(utiles.map(m => m.lon));
  const desvLat = utiles.map(m => Math.abs(m.lat - medLat));
  const desvLon = utiles.map(m => Math.abs(m.lon - medLon));
  const madLat = mediana(desvLat);
  const madLon = mediana(desvLon);
  // MAD 0 en un eje = la mitad de las lecturas cayó exactamente en la mediana de
  // ese eje. No hay escala con la cual medir "lejos", así que ese eje no filtra:
  // el criterio queda en manos del otro.
  const pasa = (desv, mad) => mad === 0 || desv <= 3 * mad;
  const quedan = utiles.filter((_, i) => pasa(desvLat[i], madLat) && pasa(desvLon[i], madLon));
  // Imposible con un criterio basado en la mediana, pero si algún día lo fuera:
  // quedarse sin muestras es peor que quedarse con las malas.
  return quedan.length ? quedan : utiles;
}

// Centroide ponderado por varianza inversa: w = 1/acc². null si no queda ninguna
// lectura usable — NUNCA {lat: NaN}, que es el mismo camino silencioso pero
// disfrazado de resultado.
function centroidePonderado(muestras, pisoM = PISO_ACC_M) {
  const piso = Number.isFinite(pisoM) && pisoM > 0 ? pisoM : PISO_ACC_M;
  const utiles = usables(muestras);
  if (!utiles.length) return null;
  // Una lectura que no declara precisión no se puede ponderar contra las que sí:
  // no hay número que ponerle sin inventarlo, y cualquiera que se invente la deja
  // arrastrando el centroide. Mientras haya alguna con dato, las mudas no entran
  // —misma regla que mejorFix() en app.js, donde sin dato pierde siempre—. Si
  // ninguna declaró, todas pesan igual y el resultado es el promedio simple.
  const conDato = utiles.filter(m => accConPiso(m, piso) != null);
  const pesan = conDato.length ? conDato : utiles;
  let sumaW = 0;
  let sumaLat = 0;
  let sumaLon = 0;
  for (const m of pesan) {
    const declarada = accConPiso(m, piso);
    const acc = declarada != null ? declarada : piso;
    const w = 1 / (acc * acc);
    sumaW += w;
    sumaLat += w * m.lat;
    sumaLon += w * m.lon;
  }
  return { lat: sumaLat / sumaW, lon: sumaLon / sumaW };
}

// Radio dentro del cual cae el 68% de las lecturas, medido contra el centro. Es
// la dispersión REAL observada, la única parte de la precisión que no depende de
// creerle al teléfono. Con una sola muestra da 0, y ahí manda el piso físico.
function dispersion68(muestras, centro) {
  const utiles = usables(muestras);
  if (!utiles.length || !centro || !Number.isFinite(centro.lat) || !Number.isFinite(centro.lon)) return null;
  const distancias = utiles.map(m => metrosEntre(centro, m)).sort((a, b) => a - b);
  const indice = Math.min(distancias.length - 1, Math.max(0, Math.ceil(0.68 * distancias.length) - 1));
  return distancias[indice];
}

// El ± que se declara para una posición promediada, en metros enteros:
//
//   max( dispersión observada , precisión declarada / √N , piso físico )
//
// El máximo es deliberado. La dispersión sola miente cuando el teléfono está
// sistemáticamente corrido (todas las muestras coinciden en el lugar
// equivocado); la teórica sola miente cuando el teléfono declara un ± optimista.
// Se redondea hacia ARRIBA: declarar menos precisión de la que se tiene solo
// afloja el control, declarar más de la que se tiene rechaza al guardia honesto.
function precisionHonesta(muestras, centro, pisoM = PISO_FISICO_M) {
  const utiles = usables(muestras);
  if (!utiles.length) return null;
  const piso = Number.isFinite(pisoM) && pisoM > 0 ? pisoM : PISO_FISICO_M;
  const dispersion = dispersion68(utiles, centro) || 0;
  const declaradas = utiles.map(m => accConPiso(m, PISO_ACC_M)).filter(a => a != null);
  // √N: promediar N lecturas independientes reduce el error aleatorio en esa
  // proporción. Es un techo teórico optimista —los errores del GPS no son del
  // todo independientes—, por eso nunca se usa solo.
  const teorica = declaradas.length ? mediana(declaradas) / Math.sqrt(declaradas.length) : 0;
  return Math.max(Math.ceil(Math.max(dispersion, teorica)), piso);
}

// En el navegador estas funciones quedan como globales del documento (geo.js se
// carga con <script> antes de app.js y de admin.js). En node, los tests las
// piden por require.
if (typeof module === 'object' && module.exports) {
  module.exports = {
    PISO_ACC_M, PISO_FISICO_M,
    metrosEntre, mediana, filtrarOutliers, centroidePonderado, dispersion68, precisionHonesta
  };
}
