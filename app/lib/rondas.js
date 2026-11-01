// Motor de rondas: iniciar ejecución, registrar escaneos, cerrar y evaluar.
// Todas las operaciones son idempotentes para soportar el reenvío desde la
// cola offline del teléfono (mismo evento dos veces = mismo resultado).
const { id, interpretarCodigo, normalizarSerie } = require('./codigos');
const { TZ } = require('./fechas-chile');

// Verificación de presencia (CU-16 / CU-18): una marca sobre un punto con
// ubicación fijada solo vale si el teléfono está dentro del radio. Además de
// quedar observada, la marca fuera de rango se RECHAZA: no se puede escanear el
// QR desde lejos.
//
// PRESUPUESTO DE ERROR (v1.13). Acá se comparan DOS medidas de GPS, no una: la
// que tomó el administrador al fijar el punto y la que toma el guardia al
// escanear. Cada una trae su propia incertidumbre y los errores se SUMAN. Exigir
// 20 m clavados entre dos fixes de ±20 m es pedir algo que el hardware no puede
// cumplir, y era la causa del "acércate al punto" estando encima del punto. Por
// eso el tope efectivo es el radio MÁS la imprecisión declarada de ambas
// medidas, con un techo (margenMaxM) para que un GPS que declara ±900 m no
// compre permiso ilimitado. El control sigue en pie: el margen lo pone el
// sensor, no el guardia, y escanear la foto del QR desde la caseta —decenas o
// cientos de metros— sigue rechazado.
//
// DE DÓNDE SALEN ESAS DOS MEDIDAS (v1.14). Hasta v1.13 las dos eran "la mejor de
// N lecturas", que es elegir el error más favorable y llamarlo precisión: el
// presupuesto de arriba estaba bien planteado y mal alimentado. Ahora las dos se
// promedian —el punto en el panel, el fix en el teléfono— y declaran el ± que
// corresponde: el máximo entre la dispersión observada y el techo teórico. Los
// números que entran acá subieron en el papel y bajaron en la realidad.
//
// La consecuencia para ESTE archivo: `acc` ya no es un dato de la plataforma,
// es un número que calcula la app. Por eso limpiarGps() le aplica un piso
// (precisionMinM) antes de creerle. La decisión, en cambio, no cambió:
// verificarPresencia() sigue recibiendo UN fix consolidado y devolviendo un
// veredicto, y public/app.js sigue siendo su espejo exacto.
//
// Los valores se leen del entorno para poder ajustarlos en terreno sin tocar
// código ni volver a desplegar la app del guardia:
//   GPS_RADIO_M      (20)     distancia máxima aceptada, en metros
//   GPS_MARGEN_MAX_M (40)     techo de la imprecisión perdonada (punto + fix),
//                             en metros; se SUMA al radio. 0 = radio estricto
//   GPS_PRECISION_MAX_M (100) peor precisión de fix que sirve para decidir. Un
//                             fix de WiFi/antena declara ±300 m o más: con eso
//                             la distancia es ruido y no se usa
//   GPS_PRECISION_SUPUESTA_M (15) precisión que se asume cuando la medida no la
//                             informó (puntos fijados antes de v1.13)
//   GPS_PRECISION_MIN_M (3)   piso de la precisión declarada de un fix. Desde
//                             v1.14 el acc que llega ya NO es el que dio el
//                             navegador: lo calcula la app promediando varias
//                             lecturas. Un error en esa fórmula que devuelva
//                             ±2 m donde la realidad es ±40 aflojaría el margen
//                             en cada marca del sistema, y el test de paridad no
//                             lo vería (verifica que los dos lados coincidan, y
//                             coincidirían en el número equivocado)
//   GPS_FRESCO_MS    (20000)  antigüedad máxima del fix GPS para poder marcar
//   GPS_BLOQUEA      (1)      1 = rechaza la marca lejos/sin GPS
//                             0 = la acepta y solo la deja observada (v1.8)
//
// Y dos más para el modo anclaje (CU-19, abajo):
//   GPS_ANCLA_RADIO_M   (40)  radio por defecto alrededor del ancla
//   GPS_ANCLA_VENTANA_MIN (15) antigüedad máxima del fix en un punto anclado
//
// Y cuatro para la cercanía reciente (CU-29, ver presenciaPorCercania):
//   GPS_LECTURA_BUENA_M (20)  peor ± de una lectura que sirve de prueba de que
//                             el guardia estuvo cerca
//   GPS_CERCANIA_M      (30)  a cuánto del punto tuvo que estar esa lectura
//   GPS_CERCANIA_MIN    (5)   cuánto vale esa lectura. 0 = sin cercanía (v1.25)
//   GPS_ERROR_EXTRA_M   (20)  cuánto se puede equivocar el GPS MÁS de lo que
//                             declara, por el rebote en muros y losas
//
// Se leen en cada llamada a propósito: lib/env.js carga el .env DESPUÉS de que
// este módulo se requiere, así que cachearlos al importar tomaría los defaults.
function numEnv(nombre, porDefecto) {
  const v = Number(process.env[nombre]);
  return Number.isFinite(v) && v >= 0 ? v : porDefecto;
}

function configGps() {
  const apagado = ['0', 'false', 'no'].includes(String(process.env.GPS_BLOQUEA || '').toLowerCase());
  return {
    radioOkM: numEnv('GPS_RADIO_M', 20),
    margenMaxM: numEnv('GPS_MARGEN_MAX_M', 40),
    precisionMaxM: numEnv('GPS_PRECISION_MAX_M', 100),
    precisionSupuestaM: numEnv('GPS_PRECISION_SUPUESTA_M', 15),
    precisionMinM: numEnv('GPS_PRECISION_MIN_M', 3),
    frescoMs: numEnv('GPS_FRESCO_MS', 20000),
    anclaRadioM: numEnv('GPS_ANCLA_RADIO_M', 40),
    anclaVentanaMin: numEnv('GPS_ANCLA_VENTANA_MIN', 15),
    lecturaBuenaM: numEnv('GPS_LECTURA_BUENA_M', 20),
    cercaniaM: numEnv('GPS_CERCANIA_M', 30),
    cercaniaMin: numEnv('GPS_CERCANIA_MIN', 5),
    errorExtraM: numEnv('GPS_ERROR_EXTRA_M', 20),
    bloquea: !apagado
  };
}

// Modo de verificación de un punto (CU-19). No se guarda como campo obligatorio:
// se deduce, para que los puntos que ya existen sigan funcionando igual.
//   'ninguna'  sin ubicación fijada → no se verifica (comportamiento histórico)
//   'gps'      ubicación exacta del punto → radio estricto y fix reciente
//   'anclaje'  la ubicación fijada es la ENTRADA al recinto (o el último lugar
//              del recorrido con señal). Sirve para subterráneos, salas de
//              calderas e interiores donde el GPS no llega: se acepta un fix
//              rezagado —hasta ventanaMin— tomado dentro de radioM del ancla.
//              Prueba que el guardia pasó físicamente por ahí hace poco, no que
//              esté parado en el punto. Es un control más débil que 'gps' a
//              propósito: la alternativa real es no verificar nada.
function modoVerificacion(punto) {
  if (!punto || punto.lat == null || punto.lon == null) return 'ninguna';
  return punto.verificacion === 'anclaje' ? 'anclaje' : 'gps';
}

// Umbrales efectivos de un punto: lo que definió el administrador para ese punto
// manda; si no definió nada, el default del entorno.
//
// precisionM es la calidad de la medición con la que se fijó el punto: desde
// v1.14 el panel muestrea 45 s y guarda el ± honesto del promedio (en v1.13
// guardaba la mejor lectura de 12 s, que era el mismo dato mentido a la baja).
// null = punto fijado antes de v1.13, con una sola lectura y sin registrar qué
// tan buena era; se le asume precisionSupuestaM.
function umbralesDe(punto, cfg) {
  const anclado = modoVerificacion(punto) === 'anclaje';
  const radioBase = anclado ? cfg.anclaRadioM : cfg.radioOkM;
  const ventanaBase = anclado ? cfg.anclaVentanaMin * 60000 : cfg.frescoMs;
  const radioM = Number.isFinite(Number(punto.radioM)) && Number(punto.radioM) > 0
    ? Number(punto.radioM) : radioBase;
  const ventanaMs = Number.isFinite(Number(punto.ventanaMin)) && Number(punto.ventanaMin) > 0
    ? Number(punto.ventanaMin) * 60000 : ventanaBase;
  // Ojo con Number(null) === 0: un punto sin medir tiene precisión DESCONOCIDA,
  // no precisión perfecta. Confundirlos le quitaba el margen justo a los puntos
  // que más lo necesitan (los fijados a ciegas antes de v1.13).
  const pre = Number(punto.precisionM);
  const medido = punto.precisionM != null && punto.precisionM !== '' && Number.isFinite(pre) && pre >= 0;
  return { anclado, radioM, ventanaMs, precisionM: medido ? pre : null };
}

// Cuánta imprecisión se le perdona a esta comparación, en metros: la del punto
// más la del fix, tope margenMaxM. Cuando la medida no informó su precisión se
// asume precisionSupuestaM — ni 0 (que sería mentir a favor del rechazo) ni el
// techo (que sería regalar el control).
function margenM(precisionPuntoM, accFixM, cfg) {
  const conocida = v => {
    if (v == null || v === '') return cfg.precisionSupuestaM;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : cfg.precisionSupuestaM;
  };
  return Math.round(Math.min(conocida(precisionPuntoM) + conocida(accFixM), cfg.margenMaxM));
}

// Control de tiempo antifraude (CU-17): el fraude "sacarle foto a los QR y
// escanearlos desde el sillón" deja marcas separadas por segundos. Se considera
// RÁFAGA cuando, habiendo 3+ marcas, al menos la mitad de los saltos entre
// marcas consecutivas fue menor a RAFAGA_SEG. Es tuneable; empieza conservador
// para no castigar puntos legítimamente cercanos (dos puertas contiguas).
const RAFAGA_SEG = 15;

// TEMPORAL (sep-2026): el teléfono de la portería queda sin internet un par de
// semanas, pero las rondas se hacen normal y el informe se envía al volver la
// señal. Mientras dure, las marcas sin conexión NO se muestran como tales en el
// panel ni en el informe. El dato `offline` se sigue guardando igual en cada
// escaneo. Para volver a como era: borrar esta constante y sus dos usos
// (acá en evaluar() y en lib/informes.js).
const OCULTAR_SIN_CONEXION = true;

function puntosDeRonda(db, ronda) {
  return ronda.puntoIds
    .map(pid => db.puntos.find(p => p.id === pid))
    .filter(Boolean);
}

// Distancia haversine en metros entre {lat, lon}.
function distanciaM(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// Cuenta los saltos "en ráfaga" entre marcas consecutivas. Devuelve 0 si el
// patrón no califica como ráfaga; si califica, devuelve cuántos saltos fueron
// menores a RAFAGA_SEG (para poder describir la sospecha).
function saltosEnRafaga(escaneos) {
  if (escaneos.length < 3) return 0;
  const porTs = [...escaneos].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  let rapidas = 0;
  for (let i = 1; i < porTs.length; i++) {
    const saltoS = (new Date(porTs[i].ts) - new Date(porTs[i - 1].ts)) / 1000;
    if (saltoS >= 0 && saltoS < RAFAGA_SEG) rapidas++;
  }
  const saltos = porTs.length - 1;
  return (rapidas >= 2 && rapidas >= Math.ceil(saltos / 2)) ? rapidas : 0;
}

// Normaliza el GPS que manda el teléfono; null si no viene o viene inválido.
//
// edadMs: cuánto tiempo pasó entre el fix del GPS y la marca. Viaja como
// DURACIÓN, no como hora absoluta, para que el reloj desajustado de un teléfono
// no invalide el control (la hora del teléfono ya es sospechosa por diseño).
// Puede faltar: la mandan las apps desde v1.10 en adelante.
// El piso de precisionMinM se aplica acá, en el borde: desde v1.14 el acc que
// manda el teléfono ya no lo dio el navegador —lo calcula la app promediando
// varias lecturas—, así que el servidor no puede seguir creyéndole cualquier
// número. Un acc de 0 o de 1 no significa "exacto": significa que alguien se
// equivocó. Y el mismo piso cubre la división por cero de public/geo.js, donde el
// peso es 1/acc².
function limpiarGps(gps, cfg = configGps()) {
  if (!gps || typeof gps !== 'object') return null;
  const lat = Number(gps.lat);
  const lon = Number(gps.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Ojo de nuevo con Number(null) === 0: un fix que NO declara precisión tiene
  // precisión desconocida, no perfecta. Tomarlo como 0 le daba margen cero justo
  // al dato de peor calidad, y desalineaba al servidor con la app del guardia.
  const acc = gps.acc == null || gps.acc === '' ? NaN : Number(gps.acc);
  const edad = gps.edadMs == null || gps.edadMs === '' ? NaN : Number(gps.edadMs);
  return {
    lat,
    lon,
    acc: Number.isFinite(acc) && acc >= 0 ? Math.max(Math.round(acc), cfg.precisionMinM) : null,
    edadMs: Number.isFinite(edad) && edad >= 0 ? Math.round(edad) : null
  };
}

// "21:05", en hora de Chile. Un ts que no se entiende sale como "—".
function horaCorta(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function minutos(ms) {
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}

// Contrasta una marca con la ubicación fijada del punto. Única fuente de verdad:
// la usan el bloqueo del escaneo (registrarEscaneo) y el informe (evaluar), así
// que nunca pueden discrepar.
//
// Devuelve null si no hay nada que verificar — el punto no tiene ubicación
// fijada. Sigue siendo la salida para donde no hay señal Y tampoco se puede
// anclar; para el resto de los puntos bajo techo está el modo 'anclaje'.
//
// `cercania` (v1.27) es la lectura buena que el teléfono tomó cerca del punto
// hace poco. Solo se mira cuando la lectura del momento no alcanza: antes de
// rechazar. Ver presenciaPorCercania().
function verificarPresencia(punto, gps, cfg = configGps(), cercania = null) {
  const directa = presenciaDirecta(punto, gps, cfg);
  if (!directa || directa.ok || !cercania) return directa;
  return presenciaPorCercania(punto, gps, cercania, cfg) || directa;
}

// ---------- Cercanía reciente (CU-29, v1.27) ----------
// Bajo un alero o en un subterráneo el GPS falla justo cuando el guardia llega:
// lo ubica a 45 m estando encima, o pasa a WiFi y antena con ±150 m. Pero un
// minuto antes, caminando hacia el punto, el teléfono sí tenía buena señal. La
// cercanía usa esa lectura ANTES de rechazar, y la marca entra si se cumplen
// las dos:
//
//   1. Estuvo cerca hace poco: una lectura buena (±lecturaBuenaM o mejor) a
//      cercaniaM o menos del punto, de hace cercaniaMin o menos.
//   2. Nada lo ubica más lejos de lo que el GPS se puede equivocar: la lectura
//      del momento —buena o mala— no está a más de cercaniaM + errorExtraM del
//      punto, descontando su propio ±. Las lecturas malas no sirven para
//      aprobar, pero sí para desmentir.
//
// La condición 2 separa "el GPS está fallando" de "el guardia se fue": el
// rebote corre una lectura que se ve buena decenas de metros, no cientos. Quien
// pasa cerca y vuelve a la caseta a escanear la foto deja una lectura que
// ninguna falla explica. Las lecturas INTERMEDIAS, entre la cercana y la del
// momento, solo las ve el teléfono, que es el que guarda el rastro: la app
// revisa que ninguna lo desmienta antes de mandar la cercana (cercaniaPara en
// public/app.js).
//
// Es un control más débil que el exacto, a propósito: prueba que el guardia
// estuvo a cercaniaM hace minutos, no que está parado en el punto. La
// alternativa bajo techo es rechazar a quien sí fue.
//
// En un punto anclado es el mismo mecanismo con los números del anclaje: la
// lectura cercana es la de la ENTRADA, vale ventanaMs y se mide con el tope de
// siempre (radioM + margen). Es lo que CU-19 prometía y no cumplía: la app
// guardaba un solo fix, y un teléfono que seguía entregando lecturas adentro
// pisaba el de la entrada a los 20 s (INC-002).
//
// Devuelve el veredicto aprobado, o null si la cercanía no alcanza: quien llama
// se queda con el rechazo directo, que es el que explica qué pasó.
function presenciaPorCercania(punto, gps, cercania, cfg) {
  if (!(cfg.cercaniaMin > 0)) return null;
  const cercana = limpiarGps(cercania, cfg);
  // Sin ± declarado no es una lectura buena: es una de calidad desconocida.
  if (!cercana || cercana.acc == null || cercana.acc > cfg.lecturaBuenaM || cercana.edadMs == null) return null;
  const { anclado, radioM, ventanaMs, precisionM } = umbralesDe(punto, cfg);
  if (cercana.edadMs > (anclado ? ventanaMs : cfg.cercaniaMin * 60000)) return null;
  const lugar = { lat: punto.lat, lon: punto.lon };
  const d = distanciaM(cercana, lugar);
  const topeM = topeCercaniaM(anclado, radioM, precisionM, cercana.acc, cfg);
  if (d > topeM) return null;
  const ahora = limpiarGps(gps, cfg);
  const distanciaAhoraM = ahora ? distanciaM(ahora, lugar) : null;
  if (ahora && !lecturaCompatible(distanciaAhoraM, ahora.acc, limiteCercaniaM(anclado, radioM, cfg), cfg)) return null;
  return {
    ok: true,
    modo: modoVerificacion(punto),
    sinGps: false,
    porCercania: true,
    distanciaM: d,
    topeM,
    edadMs: cercana.edadMs,
    precisionM: cercana.acc,
    distanciaAhoraM,
    motivo: `Marcado por cercanía: a ${d} m ${anclado ? 'de la entrada' : 'del punto'} hace ${minutos(cercana.edadMs)}.`
  };
}

// A cuánto del punto tiene que estar la lectura cercana. En un punto exacto,
// cercaniaM: la lectura ya es buena, no se le suma margen. En uno anclado, el
// tope de siempre alrededor de la entrada (CU-19).
function topeCercaniaM(anclado, radioM, precisionM, acc, cfg) {
  return anclado ? radioM + margenM(precisionM, acc, cfg) : cfg.cercaniaM;
}

// Hasta dónde puede ubicarlo una lectura posterior a la cercana sin desmentirla:
// el radio de la cercanía más lo que el GPS se equivoca de más.
function limiteCercaniaM(anclado, radioM, cfg) {
  return (anclado ? radioM : cfg.cercaniaM) + cfg.errorExtraM;
}

// ¿Esta lectura es compatible con que el guardia siga cerca? Sin ± declarado se
// asume precisionSupuestaM, como en margenM(): ni 0 ni infinito.
function lecturaCompatible(distancia, acc, limiteM, cfg) {
  return distancia - (acc != null ? acc : cfg.precisionSupuestaM) <= limiteM;
}

// La verificación de siempre (v1.9-v1.25): la lectura del momento contra el
// punto, con el presupuesto de error de CU-23.
function presenciaDirecta(punto, gps, cfg) {
  const modo = modoVerificacion(punto);
  if (modo === 'ninguna') return null;
  const { anclado, radioM, ventanaMs, precisionM } = umbralesDe(punto, cfg);
  const limpio = limpiarGps(gps, cfg);

  if (!limpio) {
    return {
      ok: false,
      modo,
      sinGps: true,
      distanciaM: null,
      topeM: radioM,
      motivo: anclado
        ? `Sin ubicación: para marcar "${punto.nombre}" el teléfono tiene que haber tomado señal en la entrada. Activa la ubicación ANTES de iniciar la ronda.`
        : `Sin señal GPS: no se puede confirmar que estás en "${punto.nombre}". Activa la ubicación del teléfono, espera unos segundos a cielo abierto y vuelve a escanear.`
    };
  }

  // Antigüedad del fix. En 'gps' es la frescura normal (20 s); en 'anclaje' es la
  // ventana ancha que da sentido al modo. Un punto anclado EXIGE saber la edad:
  // sin ese dato el control se reduce a un radio de 40 m, que es justo lo que no
  // queremos regalar.
  if (limpio.edadMs == null && anclado) {
    return {
      ok: false,
      modo,
      sinGps: true,
      distanciaM: null,
      topeM: radioM,
      motivo: `La app no informó la antigüedad de la ubicación y "${punto.nombre}" se verifica por entrada. Actualiza la app del guardia.`
    };
  }
  if (limpio.edadMs != null && limpio.edadMs > ventanaMs) {
    return {
      ok: false,
      modo,
      sinGps: false,
      vencido: true,
      distanciaM: null,
      topeM: radioM,
      edadMs: limpio.edadMs,
      motivo: anclado
        ? `Tu última ubicación es de hace ${minutos(limpio.edadMs)} y para "${punto.nombre}" el máximo son ${minutos(ventanaMs)}. Sal a donde haya señal y vuelve a entrar.`
        : `Tu ubicación es de hace ${minutos(limpio.edadMs)}: hace falta una más reciente para marcar "${punto.nombre}".`
    };
  }

  // Un fix de WiFi o de antena celular declara ±300 m o más. Con esa medida la
  // distancia al punto es ruido: puede rechazar a quien está encima y aceptar a
  // quien está a dos cuadras. No sirve para decidir en ninguna de las dos
  // direcciones, así que se descarta en vez de perdonarla con más margen.
  if (limpio.acc != null && limpio.acc > cfg.precisionMaxM) {
    return {
      ok: false,
      modo,
      sinGps: true,
      impreciso: true,
      distanciaM: null,
      topeM: radioM,
      edadMs: limpio.edadMs,
      precisionM: limpio.acc,
      motivo: `La señal es demasiado imprecisa (±${limpio.acc} m) para confirmar que estás en "${punto.nombre}". Espera unos segundos a que el GPS afine —mejor a cielo abierto— y vuelve a escanear.`
    };
  }

  const d = distanciaM(limpio, { lat: punto.lat, lon: punto.lon });
  const margen = margenM(precisionM, limpio.acc, cfg);
  const topeM = radioM + margen;
  const senal = limpio.acc != null ? ` (señal ±${limpio.acc} m)` : '';
  return {
    ok: d <= topeM,
    modo,
    sinGps: false,
    distanciaM: d,
    topeM,
    margenM: margen,
    edadMs: limpio.edadMs,
    precisionM: limpio.acc,
    motivo: anclado
      ? `Estás a ${d} m de la entrada de "${punto.nombre}" y el máximo son ${topeM} m${senal}. Pasa por la entrada del recinto y vuelve a escanear.`
      : `Estás a ${d} m de "${punto.nombre}" y el máximo para marcar es ${topeM} m${senal}. Acércate al punto y vuelve a escanear.`
  };
}

// `ejecuciones` es el repositorio del store (solo se usa `obtener`). No guarda:
// devuelve la ejecución nueva y quien llama la persiste con
// store.ejecuciones.guardar(). Con `repetida` (la cola offline reenvió el
// inicio) la ejecución ya estaba guardada y no hay nada que escribir.
function iniciarEjecucion(db, ejecuciones, { ejecucionId, rondaId, guardia, inicio, offline }) {
  const ronda = db.rondas.find(r => r.id === rondaId);
  if (!ronda) return { error: 'La ronda no existe.', codigo: 404 };
  if (ronda.condominioId !== guardia.condominioId) {
    return { error: 'Esa ronda no es de tu condominio.', codigo: 403 };
  }
  if (ejecucionId && !/^[0-9a-zA-Z-]{8,40}$/.test(ejecucionId)) {
    return { error: 'Identificador de ejecución inválido.', codigo: 422 };
  }
  if (ejecucionId) {
    const existente = ejecuciones.obtener(ejecucionId);
    if (existente) return { ejecucion: existente, repetida: true };
  }
  const ejecucion = {
    id: ejecucionId || id(),
    rondaId,
    condominioId: ronda.condominioId,
    guardiaId: guardia.id,
    inicio: limpiarTs(inicio),
    fin: null,
    estado: 'en_curso',
    escaneos: [],
    evaluacion: null
  };
  return { ejecucion };
}

// La ronda de una ejecución puede haber sido ELIMINADA desde el panel mientras
// el guardia la caminaba: la ejecución guarda el rondaId, no la ronda. Todo lo
// que la busque tiene que sobrevivir a que no esté — el informe ya lo hace
// (armarInforme cae a `{ puntoIds: [] }`) y la lista del panel también, que
// muestra "(ronda eliminada)". El motor era el único que la daba por segura, y
// desreferenciarla mataba el proceso entero en el cierre.
function rondaDe(db, ejecucion) {
  return db.rondas.find(r => r.id === ejecucion.rondaId) || null;
}

function avance(ejecucion, ronda) {
  return { hechos: ejecucion.escaneos.length, total: ronda ? ronda.puntoIds.length : 0 };
}

// La hora de la marca la manda el teléfono y es texto libre: se acota igual que
// el ts de los rechazos. Sin esto un cliente podía guardar 200 KB en este campo
// —db.json se reserializa ENTERO en cada guardado, así que engordarlo es
// impuesto sobre todas las peticiones— y un ts que no fuera string reventaba
// después en el `localeCompare` del orden estricto, tres funciones más allá.
// Y además tiene que ser una fecha entendible: un ts que no se puede parsear
// sale impreso como "Invalid Date" en el informe y en el correo del
// administrador. La hora del servidor es peor dato que la del teléfono (por eso
// se prefiere la del teléfono cuando sirve), pero es infinitamente mejor que
// una fecha rota en el único documento que el administrador va a leer.
// Comentario libre del guardia al cerrar la ronda: espacios compactados y con
// tope (el mismo maxlength del campo en la app).
const MAX_COMENTARIO = 280;
function limpiarComentario(texto) {
  return String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim().slice(0, MAX_COMENTARIO);
}

function limpiarTs(ts) {
  const texto = String(ts == null ? '' : ts).slice(0, 40);
  if (!texto || Number.isNaN(Date.parse(texto))) return new Date().toISOString();
  return texto;
}

// ---------- Puntos con chapita NFC (CU-28) ----------
//
// Un punto es NFC cuando tiene una chapita registrada (`nfcSerie`, el número de
// serie de fábrica del tag). La chapita lleva grabado el mismo texto del QR
// (payloadQR), así que el contenido solo no prueba nada: se copia de una foto
// del QR o de otra chapita en un minuto. Lo que prueba que el guardia tuvo ESA
// chapita en la mano es la serie, que viene de fábrica y un tag común no deja
// cambiar. Por eso en un punto NFC la marca solo entra con la serie que
// coincide. Un punto sin chapita funciona exactamente como antes.

// Qué pasa con el código a mano en un punto con chapita. Decisión de José: NO
// entra. El código a mano no prueba nada —se aprende una vez y se tipea desde
// la caseta— y en los puntos bajo techo, que son justo los de chapita, tampoco
// hay GPS que lo frene. Si la chapita no lee, el guardia toca "La chapita no
// lee": el punto queda sin marcar y el informe le avisa al administrador.
// Una sola regla para cambiarlo:
//   'rechazo'      no entra: en un punto NFC solo vale la chapita (la de hoy)
//   'observacion'  entra, y el informe lo anota sin acusar
//   'sospecha'     entra, y la ronda queda SOSPECHOSA con aviso al administrador
// Viaja en el paquete del guardia para que la app aplique la misma regla sin señal.
const MANUAL_EN_PUNTO_NFC = 'rechazo';

function esPuntoNfc(punto) {
  return Boolean(punto && punto.nfcSerie);
}

// Con qué se hizo la marca: 'qr' | 'nfc' | 'manual'. En un punto NFC devuelve
// { error } si el medio no sirve. `nfc` es lo que mandó el teléfono: { serie }.
function medioDeLaMarca(punto, interpretado, nfc) {
  if (interpretado.tipo === 'manual') {
    if (esPuntoNfc(punto) && MANUAL_EN_PUNTO_NFC === 'rechazo') {
      return { error: `En "${punto.nombre}" el código a mano no sirve: se marca con la chapita NFC. Si no lee, toca «La chapita no lee» para avisar al administrador.` };
    }
    return { medio: 'manual' };
  }
  const serie = nfc && typeof nfc === 'object' ? normalizarSerie(nfc.serie) : null;
  if (!esPuntoNfc(punto)) {
    // Punto sin chapita: idéntico a antes. Si igual llegó por NFC (alguien grabó
    // el texto del QR en un tag, o el administrador acaba de volver a QR), lo
    // que valida es el payload, como con el QR.
    return { medio: 'qr' };
  }
  if (!serie) {
    return { error: `Este punto se marca con la chapita NFC: acerca la parte trasera del teléfono a la chapita de "${punto.nombre}".` };
  }
  if (serie !== punto.nfcSerie) {
    return { error: `Esta chapita no es la registrada para "${punto.nombre}". Si la cambiaron, avisa al administrador.` };
  }
  return { medio: 'nfc' };
}

function registrarEscaneo(db, ejecucion, { codigo, ts, offline, gps, nfc, cercania }) {
  if (ejecucion.estado !== 'en_curso') return { error: 'La ronda ya está cerrada.', codigo: 409 };
  const interpretado = interpretarCodigo(codigo);
  if (!interpretado) return { error: 'Código no reconocido.', codigo: 422 };

  const ronda = rondaDe(db, ejecucion);
  if (!ronda) {
    return { error: 'Esta ronda ya no existe: fue eliminada desde el panel. Cierra y avisa al administrador.', codigo: 409 };
  }
  let punto = null;
  if (interpretado.tipo === 'qr') {
    // El payload debe calzar completo (id + código corto): un QR forjado con
    // un id real pero código incorrecto no pasa.
    punto = db.puntos.find(p => p.id === interpretado.puntoId && p.codigoCorto === interpretado.codigoCorto);
  } else {
    // Entrada manual: el código corto se busca solo dentro del condominio de la ronda.
    punto = db.puntos.find(p => p.condominioId === ejecucion.condominioId && p.codigoCorto === interpretado.codigoCorto);
  }
  if (!punto) return { error: 'Ese código no corresponde a ningún punto de control.', codigo: 422 };
  if (punto.condominioId !== ejecucion.condominioId) {
    return { error: 'Ese punto es de otro condominio.', codigo: 422 };
  }
  if (!ronda.puntoIds.includes(punto.id)) {
    return { error: `"${punto.nombre}" no es parte de esta ronda.`, codigo: 422 };
  }
  const previo = ejecucion.escaneos.find(e => e.puntoId === punto.id);
  if (previo) return { duplicado: true, punto, avance: avance(ejecucion, ronda) };

  // El medio se revisa después del duplicado por lo mismo que el GPS: la cola
  // offline puede reenviar una marca que ya entró, y si entretanto le cambiaron
  // la chapita al punto, el reenvío no tiene que convertirse en rechazo.
  // `rechazoMedio`: quien llama lo deja registrado como los rechazos por GPS.
  const medio = medioDeLaMarca(punto, interpretado, nfc);
  if (medio.error) return { error: medio.error, codigo: 422, punto, rechazoMedio: true };

  // Verificación de presencia BLOQUEANTE (CU-18). Va después del control de
  // duplicados a propósito: un evento reenviado por la cola offline sale antes
  // por "duplicado" y nunca se re-verifica, así el reintento sigue siendo
  // idempotente aunque el guardia ya se haya alejado del punto.
  const cfg = configGps();
  if (cfg.bloquea) {
    const presencia = verificarPresencia(punto, gps, cfg, cercania);
    if (presencia && !presencia.ok) {
      return { error: presencia.motivo, codigo: 422, presencia };
    }
  }

  const marca = {
    puntoId: punto.id,
    ts: limpiarTs(ts),
    offline: Boolean(offline),
    gps: limpiarGps(gps, cfg),
    medio: medio.medio
  };
  // La lectura cercana (v1.27) se guarda junto a la del momento: es la prueba
  // con que entró la marca, y evaluar() la necesita para no informarla como
  // "lejos del punto" al cerrar. Solo viene cuando la app la usó.
  const cercana = limpiarGps(cercania, cfg);
  if (cercana) marca.cercania = cercana;
  // Se anota en la marca, no se deduce después: si mañana el punto vuelve a QR,
  // el informe de hoy tiene que seguir diciendo que esta marca fue a mano en un
  // punto que tenía chapita.
  if (medio.medio === 'manual' && esPuntoNfc(punto)) marca.puntoNfc = true;
  ejecucion.escaneos.push(marca);
  return { punto, avance: avance(ejecucion, ronda) };
}

// `automatico`: la cerró el servidor porque el teléfono dejó de reportar
// (ver cerrarAbandonadas en server.js). Queda marcada para poder reabrirla si
// el teléfono aparece después con marcas que traía sin señal.
function cerrarEjecucion(db, ejecucion, { fin, automatico = false, comentario } = {}) {
  if (ejecucion.estado !== 'en_curso') return { ejecucion, repetida: true };
  const ronda = rondaDe(db, ejecucion);
  ejecucion.fin = limpiarTs(fin);
  // Comentario opcional del guardia. Solo se escribe si viene texto: un cierre
  // automático (sin comentario) no borra el que ya hubiera.
  const texto = limpiarComentario(comentario);
  if (texto) ejecucion.comentario = texto;
  ejecucion.evaluacion = evaluar(db, ejecucion, ronda);
  const ev = ejecucion.evaluacion;
  if (automatico) {
    ejecucion.cierreAutomatico = true;
    ev.observaciones.unshift(ronda && !ev.faltantes.length
      ? 'Cerrada automáticamente por el sistema: el guardia marcó todos los puntos pero no tocó «Terminar ronda».'
      : 'Cerrada automáticamente por el sistema: el teléfono no terminó la ronda '
        + '(se apagó, se cerró la app o nunca volvió a tener señal). Muestra solo lo que alcanzó a llegar.');
  } else {
    delete ejecucion.cierreAutomatico;
  }
  ejecucion.estado = ev.faltantes.length ? 'incompleta'
    : ev.sospechas.length ? 'sospechosa'
    : ev.observaciones.length ? 'completa_obs'
    : 'completa';
  return { ejecucion };
}

// ---------- Rondas abandonadas ----------
//
// Una ronda que el teléfono inició y nunca cerró quedaba "en curso" para
// siempre: el informe no salía y, peor, la alarma de ronda de TODO el
// condominio se callaba (lib/recordatorios.js no suena mientras haya una en
// curso). Pasaba sobre todo con la ronda hecha sin señal: al servidor solo le
// llegaba el inicio, y si el teléfono se apagaba y perdía la ronda, nadie la
// cerraba nunca.
//
// Se da por abandonada cuando pasó el umbral desde la ÚLTIMA actividad que
// llegó (inicio o última marca): RONDA_ABANDONO_MIN (120 por defecto), o el
// doble de la duración máxima de la ronda si es más. Es generoso a propósito:
// una ronda sin señal no manda nada hasta el final y no hay que confundirla
// con una abandonada. Y si igual se confunde, se reabre (reabrirSiAutomatica).
function umbralAbandonoMs(ronda) {
  // 0 no es un umbral: cerraría toda ronda apenas empieza.
  const base = numEnv('RONDA_ABANDONO_MIN', 120) || 120;
  const porDuracion = ronda && ronda.duracionMaxMin ? 2 * Number(ronda.duracionMaxMin) : 0;
  return Math.max(base, porDuracion || 0) * 60000;
}

// Ronda con TODOS los puntos marcados que nadie terminó (v1.25). Ya no le queda
// nada por hacer al guardia salvo tocar «Terminar ronda», así que no hay que
// esperarla dos horas: pasaba en el teléfono compartido de la garita, donde la
// ronda quedaba abierta hasta que el siguiente guardia tomaba el teléfono, el
// informe no salía y la alarma de ronda del condominio quedaba callada.
// RONDA_COMPLETA_CIERRE_MIN (15 por defecto) desde la última marca.
function umbralCompletaMs() {
  return (numEnv('RONDA_COMPLETA_CIERRE_MIN', 15) || 15) * 60000;
}

// Todos los puntos de la ronda tienen marca. Sin ronda (la eliminaron) no se
// puede saber: cuenta como que faltan.
function todosMarcados(ejecucion, ronda) {
  if (!ronda || !ronda.puntoIds.length) return false;
  const marcados = new Set((ejecucion.escaneos || []).map(e => e.puntoId));
  return ronda.puntoIds.every(pid => marcados.has(pid));
}

// Lo último que el servidor supo de esta ronda. Las horas vienen del teléfono:
// una que no se entienda no cuenta.
function ultimaActividad(ejecucion) {
  let ultima = Date.parse(ejecucion.inicio) || 0;
  for (const e of ejecucion.escaneos || []) {
    const t = Date.parse(e.ts);
    if (t > ultima) ultima = t;
  }
  return ultima;
}

function estaAbandonada(db, ejecucion, ahora = Date.now()) {
  if (ejecucion.estado !== 'en_curso') return false;
  const ronda = rondaDe(db, ejecucion);
  const umbral = todosMarcados(ejecucion, ronda) ? umbralCompletaMs() : umbralAbandonoMs(ronda);
  return ahora - ultimaActividad(ejecucion) >= umbral;
}

// El teléfono apareció con datos de una ronda que el sistema cerró solo: era
// una ronda sin señal, no una abandonada. Se vuelve a abrir para que entren
// sus marcas y su cierre de verdad. Solo las que cerró el sistema: un cierre
// del administrador es una decisión y no se deshace desde el teléfono.
function reabrirSiAutomatica(ejecucion) {
  if (ejecucion.estado === 'en_curso' || !ejecucion.cierreAutomatico) return false;
  ejecucion.estado = 'en_curso';
  ejecucion.fin = null;
  ejecucion.evaluacion = null;
  delete ejecucion.cierreAutomatico;
  return true;
}

// `ronda` puede venir null: la eliminaron mientras la ejecución estaba abierta.
// La ronda se evalúa igual con lo que el guardia alcanzó a marcar —sus marcas no
// dejan de ser válidas porque el administrador borró la definición— pero sin
// puntos esperados no se puede hablar de faltantes ni de orden.
function evaluar(db, ejecucion, ronda) {
  const escaneados = new Set(ejecucion.escaneos.map(e => e.puntoId));
  const puntoIds = ronda ? ronda.puntoIds : [];
  const faltantes = puntoIds.filter(pid => !escaneados.has(pid));
  const observaciones = [];
  if (!ronda) {
    observaciones.push('La ronda fue eliminada del panel mientras esta ejecución estaba abierta: no se puede saber qué puntos faltaron.');
  }
  // Sospechas = subconjunto de observaciones que huelen a datos falsos. Son las
  // que elevan el estado a "sospechosa" y disparan el aviso al administrador.
  const sospechas = [];

  // Orden (solo rondas estrictas): un punto queda "fuera de orden" si se marcó
  // después que otro que venía más adelante en la secuencia definida.
  const fueraDeOrden = [];
  if (ronda && ronda.ordenEstricto) {
    let maxIndice = -1;
    // String(): el ts lo manda el teléfono. limpiarTs() ya lo normaliza al
    // entrar, pero las ejecuciones guardadas antes de esa guarda siguen en la
    // base, y acá un ts que no sea texto mata el proceso entero.
    const porTs = [...ejecucion.escaneos].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const esc of porTs) {
      const indice = puntoIds.indexOf(esc.puntoId);
      if (indice < maxIndice) fueraDeOrden.push(esc.puntoId);
      else maxIndice = indice;
    }
    if (fueraDeOrden.length) {
      observaciones.push(`Orden de la ronda no respetado en: ${nombres(db, fueraDeOrden)}.`);
    }
  }

  // Verificación de presencia (solo puntos con ubicación fijada por el admin).
  // Con GPS_BLOQUEA activo estas marcas ya se rechazaron al escanear, así que en
  // condiciones normales ambas listas quedan vacías. Se sigue evaluando porque
  // hay tres caminos por los que una marca sin verificar entra a la base:
  // rondas históricas, ubicaciones fijadas DESPUÉS de la ronda, y GPS_BLOQUEA=0.
  const gpsLejos = [];
  const sinGps = [];
  const gpsImpreciso = [];
  const cfg = configGps();
  for (const esc of ejecucion.escaneos) {
    const punto = db.puntos.find(p => p.id === esc.puntoId);
    const presencia = verificarPresencia(punto, esc.gps, cfg, esc.cercania);
    if (!presencia) continue;
    // "anclado" viaja al informe para no mentir: en esos puntos la distancia es
    // a la ENTRADA del recinto, no al punto, y la marca es una prueba más débil.
    esc.anclado = presencia.modo === 'anclaje';
    // Igual con la cercanía (v1.27): la distancia que queda en la marca es la de
    // la lectura cercana, y el informe dice "por cercanía". Se borra si al
    // reevaluar ya no aplica, para que una reapertura no deje la etiqueta vieja.
    if (presencia.porCercania) {
      esc.porCercania = true;
      esc.distanciaAhoraM = presencia.distanciaAhoraM;
    } else {
      delete esc.porCercania;
      delete esc.distanciaAhoraM;
    }
    if (presencia.sinGps) {
      // Señal demasiado imprecisa no es lo mismo que ubicación apagada: hubo
      // ubicación, no alcanzó para verificar. Se informa aparte para no acusar
      // de fraude a un guardia que estaba en un subterráneo.
      if (presencia.impreciso) gpsImpreciso.push({ puntoId: esc.puntoId, precisionM: presencia.precisionM });
      else sinGps.push(esc.puntoId);
      continue;
    }
    esc.distanciaM = presencia.distanciaM;
    if (presencia.edadMs != null) esc.edadGpsMs = presencia.edadMs;
    if (!presencia.ok) {
      gpsLejos.push({
        puntoId: esc.puntoId,
        distanciaM: presencia.distanciaM,
        anclado: esc.anclado,
        vencido: Boolean(presencia.vencido),
        edadMs: presencia.edadMs != null ? presencia.edadMs : null
      });
    }
  }
  // Se informan por separado porque no son lo mismo: en un punto exacto la marca
  // se hizo lejos del punto; en un punto anclado, el guardia no pasó por la
  // entrada (o pasó hace demasiado).
  const listar = grupo => grupo
    .map(l => {
      const que = l.vencido
        ? `ubicación de hace ${minutos(l.edadMs)}`
        : `a ${l.distanciaM} m${l.anclado ? ' de la entrada' : ''}`;
      return `${nombres(db, [l.puntoId])} (${que})`;
    })
    .join(', ');
  const lejosExactos = gpsLejos.filter(l => !l.anclado);
  const lejosAnclados = gpsLejos.filter(l => l.anclado);
  if (lejosExactos.length) {
    const detalle = listar(lejosExactos);
    observaciones.push(`📍 Marcas LEJOS del punto: ${detalle}.`);
    sospechas.push(`Marcas lejos del punto por GPS: ${detalle}`);
  }
  if (lejosAnclados.length) {
    const detalle = listar(lejosAnclados);
    observaciones.push(`📍 Marcas sin paso verificado por la entrada: ${detalle}.`);
    sospechas.push(`Marcas lejos del punto por GPS (verificación por entrada): ${detalle}`);
  }
  if (sinGps.length) {
    // Sin GPS en un punto que el admin fijó (o sea, verificable) = sospechoso:
    // es justo lo que pasa si el guardia niega el permiso de ubicación para
    // escanear sin moverse. Los puntos sin ubicación ni entran acá.
    observaciones.push(`Marcas sin ubicación GPS en puntos verificables: ${nombres(db, sinGps)}.`);
    sospechas.push(`Sin ubicación GPS donde debía verificarse: ${nombres(db, sinGps)}`);
  }
  if (gpsImpreciso.length) {
    // Solo observación, NO sospecha: la señal mala es del edificio, no del
    // guardia. Si se repite en el mismo punto, ahí hay que anclarlo (CU-19).
    const detalle = gpsImpreciso
      .map(i => `${nombres(db, [i.puntoId])} (±${i.precisionM} m)`)
      .join(', ');
    observaciones.push(`Marcas con señal GPS demasiado imprecisa para verificar: ${detalle}.`);
  }

  // Código a mano en un punto con chapita (CU-28): la chapita pudo estar rota o
  // el teléfono no leer NFC, así que por defecto se anota sin acusar. Ver
  // MANUAL_EN_PUNTO_NFC.
  const manualEnNfc = ejecucion.escaneos.filter(e => e.medio === 'manual' && e.puntoNfc).map(e => e.puntoId);
  if (manualEnNfc.length) {
    observaciones.push(`⌨️ Marcados con el código a mano en puntos con chapita NFC: ${nombres(db, manualEnNfc)} (¿chapita dañada o teléfono sin NFC?).`);
    if (MANUAL_EN_PUNTO_NFC === 'sospecha') {
      sospechas.push(`Código a mano en vez de la chapita NFC: ${nombres(db, manualEnNfc)}`);
    }
  }

  // "La chapita no lee" (CU-28): el guardia avisó desde el punto que no pudo
  // marcarlo. El punto ya sale como faltante; esto dice por qué, para que el
  // administrador revise o reemplace la chapita. Llega como rechazo con
  // `reporte: 'chapita'`, antes del cierre en la cola del teléfono.
  // Una vez por punto, y no si al final el guardia sí lo pudo marcar.
  const reportadas = (ejecucion.rechazos || [])
    .filter(r => r.reporte === 'chapita' && !escaneados.has(r.puntoId))
    .filter((r, i, todas) => todas.findIndex(x => x.puntoId === r.puntoId) === i);
  if (reportadas.length) {
    const detalle = reportadas.map(r => {
      const sinNfc = /no lee chapitas/.test(r.motivo || '') ? ', teléfono sin lector NFC' : '';
      return `${nombres(db, [r.puntoId])} (${horaCorta(r.ts)}${sinNfc})`;
    }).join(', ');
    observaciones.push(`📶 El guardia avisó que la chapita no leyó en: ${detalle}. Revisar o reemplazar la chapita.`);
  }

  // Ráfaga: varios puntos marcados en segundos (posible escaneo desde fotos).
  const rafaga = saltosEnRafaga(ejecucion.escaneos);
  if (rafaga) {
    observaciones.push('⚡ Varias marcas hechas en segundos (ráfaga): posible escaneo desde fotos.');
    sospechas.push('Varios puntos marcados en segundos (posible escaneo desde fotos)');
  }

  // Las dos horas las manda el teléfono: si alguna no es una fecha entendible,
  // la resta da NaN y el NaN se propaga al informe y al correo. 0 es una
  // duración inútil pero honesta; NaN es un dato roto disfrazado de número.
  const transcurrido = new Date(ejecucion.fin) - new Date(ejecucion.inicio);
  const duracionMin = Number.isFinite(transcurrido) ? Math.max(0, Math.round(transcurrido / 60000)) : 0;
  if (ronda && ronda.duracionMaxMin && duracionMin > ronda.duracionMaxMin) {
    observaciones.push(`La ronda tomó ${duracionMin} min (máximo definido: ${ronda.duracionMaxMin} min).`);
  }
  if (ronda && ronda.duracionMinMin && duracionMin < ronda.duracionMinMin) {
    observaciones.push(`⚡ La ronda tomó solo ${duracionMin} min (mínimo definido: ${ronda.duracionMinMin} min).`);
    sospechas.push(`Ronda demasiado rápida: ${duracionMin} min (mínimo ${ronda.duracionMinMin} min)`);
  }
  if (!OCULTAR_SIN_CONEXION && ejecucion.escaneos.some(e => e.offline)) {
    observaciones.push('Incluye marcas hechas sin conexión (hora tomada del teléfono del guardia).');
  }

  return { faltantes, fueraDeOrden, gpsLejos, sinGps, gpsImpreciso, rafaga, duracionMin, observaciones, sospechas };
}

function nombres(db, puntoIds) {
  return puntoIds
    .map(pid => (db.puntos.find(p => p.id === pid) || { nombre: pid }).nombre)
    .join(', ');
}

module.exports = {
  iniciarEjecucion, registrarEscaneo, cerrarEjecucion, puntosDeRonda, nombres,
  estaAbandonada, ultimaActividad, umbralAbandonoMs, umbralCompletaMs, todosMarcados, rondaDe, reabrirSiAutomatica,
  distanciaM, verificarPresencia, configGps, modoVerificacion, umbralesDe, margenM, minutos,
  OCULTAR_SIN_CONEXION, MAX_COMENTARIO, MANUAL_EN_PUNTO_NFC, esPuntoNfc, limpiarComentario
};
