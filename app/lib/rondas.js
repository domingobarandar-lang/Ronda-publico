// Motor de rondas: iniciar ejecución, registrar escaneos, cerrar y evaluar.
// Todas las operaciones son idempotentes para soportar el reenvío desde la
// cola offline del teléfono (mismo evento dos veces = mismo resultado).
const { id, interpretarCodigo } = require('./codigos');

// Verificación de presencia (CU-16 / CU-18): una marca sobre un punto con
// ubicación fijada solo vale si el teléfono está dentro del radio. Desde v1.9 el
// radio es de 20 m ESTRICTO (sin perdonar imprecisión del GPS) y, además de
// quedar observada, la marca fuera de rango se RECHAZA: no se puede escanear el
// QR desde lejos.
//
// Los cuatro valores se leen del entorno para poder ajustarlos en terreno sin
// tocar código ni volver a desplegar la app del guardia:
//   GPS_RADIO_M      (20)     distancia máxima aceptada, en metros
//   GPS_MARGEN_MAX_M (0)      cuánta imprecisión declarada por el GPS se perdona
//                             (se SUMA al radio; 0 = radio estricto)
//   GPS_FRESCO_MS    (20000)  antigüedad máxima del fix GPS para poder marcar
//   GPS_BLOQUEA      (1)      1 = rechaza la marca lejos/sin GPS
//                             0 = la acepta y solo la deja observada (v1.8)
//
// Y dos más para el modo anclaje (CU-19, abajo):
//   GPS_ANCLA_RADIO_M   (40)  radio por defecto alrededor del ancla
//   GPS_ANCLA_VENTANA_MIN (15) antigüedad máxima del fix en un punto anclado
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
    margenMaxM: numEnv('GPS_MARGEN_MAX_M', 0),
    frescoMs: numEnv('GPS_FRESCO_MS', 20000),
    anclaRadioM: numEnv('GPS_ANCLA_RADIO_M', 40),
    anclaVentanaMin: numEnv('GPS_ANCLA_VENTANA_MIN', 15),
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
function umbralesDe(punto, cfg) {
  const anclado = modoVerificacion(punto) === 'anclaje';
  const radioBase = anclado ? cfg.anclaRadioM : cfg.radioOkM;
  const ventanaBase = anclado ? cfg.anclaVentanaMin * 60000 : cfg.frescoMs;
  const radioM = Number.isFinite(Number(punto.radioM)) && Number(punto.radioM) > 0
    ? Number(punto.radioM) : radioBase;
  const ventanaMs = Number.isFinite(Number(punto.ventanaMin)) && Number(punto.ventanaMin) > 0
    ? Number(punto.ventanaMin) * 60000 : ventanaBase;
  return { anclado, radioM, ventanaMs };
}

// Control de tiempo antifraude (CU-17): el fraude "sacarle foto a los QR y
// escanearlos desde el sillón" deja marcas separadas por segundos. Se considera
// RÁFAGA cuando, habiendo 3+ marcas, al menos la mitad de los saltos entre
// marcas consecutivas fue menor a RAFAGA_SEG. Es tuneable; empieza conservador
// para no castigar puntos legítimamente cercanos (dos puertas contiguas).
const RAFAGA_SEG = 15;

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
function limpiarGps(gps) {
  if (!gps || typeof gps !== 'object') return null;
  const lat = Number(gps.lat);
  const lon = Number(gps.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const acc = Number(gps.acc);
  const edad = Number(gps.edadMs);
  return {
    lat,
    lon,
    acc: Number.isFinite(acc) ? Math.round(acc) : null,
    edadMs: Number.isFinite(edad) && edad >= 0 ? Math.round(edad) : null
  };
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
function verificarPresencia(punto, gps, cfg = configGps()) {
  const modo = modoVerificacion(punto);
  if (modo === 'ninguna') return null;
  const { anclado, radioM, ventanaMs } = umbralesDe(punto, cfg);
  const limpio = limpiarGps(gps);

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

  const d = distanciaM(limpio, { lat: punto.lat, lon: punto.lon });
  const topeM = anclado ? radioM : radioM + Math.min(limpio.acc || 0, cfg.margenMaxM);
  return {
    ok: d <= topeM,
    modo,
    sinGps: false,
    distanciaM: d,
    topeM,
    edadMs: limpio.edadMs,
    motivo: anclado
      ? `Estás a ${d} m de la entrada de "${punto.nombre}" y el máximo son ${topeM} m. Pasa por la entrada del recinto y vuelve a escanear.`
      : `Estás a ${d} m de "${punto.nombre}" y el máximo para marcar es ${topeM} m. Acércate al punto y vuelve a escanear.`
  };
}

function iniciarEjecucion(db, { ejecucionId, rondaId, guardia, inicio, offline }) {
  const ronda = db.rondas.find(r => r.id === rondaId);
  if (!ronda) return { error: 'La ronda no existe.', codigo: 404 };
  if (ronda.condominioId !== guardia.condominioId) {
    return { error: 'Esa ronda no es de tu condominio.', codigo: 403 };
  }
  if (ejecucionId && !/^[0-9a-zA-Z-]{8,40}$/.test(ejecucionId)) {
    return { error: 'Identificador de ejecución inválido.', codigo: 422 };
  }
  if (ejecucionId) {
    const existente = db.ejecuciones.find(e => e.id === ejecucionId);
    if (existente) return { ejecucion: existente, repetida: true };
  }
  const ejecucion = {
    id: ejecucionId || id(),
    rondaId,
    condominioId: ronda.condominioId,
    guardiaId: guardia.id,
    inicio: inicio || new Date().toISOString(),
    fin: null,
    estado: 'en_curso',
    escaneos: [],
    evaluacion: null
  };
  db.ejecuciones.push(ejecucion);
  return { ejecucion };
}

function avance(ejecucion, ronda) {
  return { hechos: ejecucion.escaneos.length, total: ronda.puntoIds.length };
}

function registrarEscaneo(db, ejecucion, { codigo, ts, offline, gps }) {
  if (ejecucion.estado !== 'en_curso') return { error: 'La ronda ya está cerrada.', codigo: 409 };
  const interpretado = interpretarCodigo(codigo);
  if (!interpretado) return { error: 'Código no reconocido.', codigo: 422 };

  const ronda = db.rondas.find(r => r.id === ejecucion.rondaId);
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

  // Verificación de presencia BLOQUEANTE (CU-18). Va después del control de
  // duplicados a propósito: un evento reenviado por la cola offline sale antes
  // por "duplicado" y nunca se re-verifica, así el reintento sigue siendo
  // idempotente aunque el guardia ya se haya alejado del punto.
  const cfg = configGps();
  if (cfg.bloquea) {
    const presencia = verificarPresencia(punto, gps, cfg);
    if (presencia && !presencia.ok) {
      return { error: presencia.motivo, codigo: 422, presencia };
    }
  }

  ejecucion.escaneos.push({
    puntoId: punto.id,
    ts: ts || new Date().toISOString(),
    offline: Boolean(offline),
    gps: limpiarGps(gps)
  });
  return { punto, avance: avance(ejecucion, ronda) };
}

function cerrarEjecucion(db, ejecucion, { fin } = {}) {
  if (ejecucion.estado !== 'en_curso') return { ejecucion, repetida: true };
  const ronda = db.rondas.find(r => r.id === ejecucion.rondaId);
  ejecucion.fin = fin || new Date().toISOString();
  ejecucion.evaluacion = evaluar(db, ejecucion, ronda);
  const ev = ejecucion.evaluacion;
  ejecucion.estado = ev.faltantes.length ? 'incompleta'
    : ev.sospechas.length ? 'sospechosa'
    : ev.observaciones.length ? 'completa_obs'
    : 'completa';
  return { ejecucion };
}

function evaluar(db, ejecucion, ronda) {
  const escaneados = new Set(ejecucion.escaneos.map(e => e.puntoId));
  const faltantes = ronda.puntoIds.filter(pid => !escaneados.has(pid));
  const observaciones = [];
  // Sospechas = subconjunto de observaciones que huelen a datos falsos. Son las
  // que elevan el estado a "sospechosa" y disparan el aviso al administrador.
  const sospechas = [];

  // Orden (solo rondas estrictas): un punto queda "fuera de orden" si se marcó
  // después que otro que venía más adelante en la secuencia definida.
  const fueraDeOrden = [];
  if (ronda.ordenEstricto) {
    let maxIndice = -1;
    const porTs = [...ejecucion.escaneos].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const esc of porTs) {
      const indice = ronda.puntoIds.indexOf(esc.puntoId);
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
  const cfg = configGps();
  for (const esc of ejecucion.escaneos) {
    const punto = db.puntos.find(p => p.id === esc.puntoId);
    const presencia = verificarPresencia(punto, esc.gps, cfg);
    if (!presencia) continue;
    // "anclado" viaja al informe para no mentir: en esos puntos la distancia es
    // a la ENTRADA del recinto, no al punto, y la marca es una prueba más débil.
    esc.anclado = presencia.modo === 'anclaje';
    if (presencia.sinGps) {
      sinGps.push(esc.puntoId);
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

  // Ráfaga: varios puntos marcados en segundos (posible escaneo desde fotos).
  const rafaga = saltosEnRafaga(ejecucion.escaneos);
  if (rafaga) {
    observaciones.push('⚡ Varias marcas hechas en segundos (ráfaga): posible escaneo desde fotos.');
    sospechas.push('Varios puntos marcados en segundos (posible escaneo desde fotos)');
  }

  const duracionMin = Math.max(0, Math.round((new Date(ejecucion.fin) - new Date(ejecucion.inicio)) / 60000));
  if (ronda.duracionMaxMin && duracionMin > ronda.duracionMaxMin) {
    observaciones.push(`La ronda tomó ${duracionMin} min (máximo definido: ${ronda.duracionMaxMin} min).`);
  }
  if (ronda.duracionMinMin && duracionMin < ronda.duracionMinMin) {
    observaciones.push(`⚡ La ronda tomó solo ${duracionMin} min (mínimo definido: ${ronda.duracionMinMin} min).`);
    sospechas.push(`Ronda demasiado rápida: ${duracionMin} min (mínimo ${ronda.duracionMinMin} min)`);
  }
  if (ejecucion.escaneos.some(e => e.offline)) {
    observaciones.push('Incluye marcas hechas sin conexión (hora tomada del teléfono del guardia).');
  }

  return { faltantes, fueraDeOrden, gpsLejos, sinGps, rafaga, duracionMin, observaciones, sospechas };
}

function nombres(db, puntoIds) {
  return puntoIds
    .map(pid => (db.puntos.find(p => p.id === pid) || { nombre: pid }).nombre)
    .join(', ');
}

module.exports = {
  iniciarEjecucion, registrarEscaneo, cerrarEjecucion, puntosDeRonda, nombres,
  distanciaM, verificarPresencia, configGps, modoVerificacion, umbralesDe
};
