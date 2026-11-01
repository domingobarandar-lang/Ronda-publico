// Señal por punto (ADR-001, fases 0 y 2): cómo le va al GPS en cada punto,
// contado con las marcas y los rechazos reales de un período. Lo usan el panel
// (GET /api/admin/puntos/senal, «Señal en este punto») y el diagnóstico de la
// base (scripts/diagnostico-gps.js), con la misma cuenta.
//
// Solo sugiere. La ubicación de un punto nunca se mueve sola con las marcas de
// los guardias: se iría corriendo de a pocos metros hacia donde marcan, que
// puede ser la caseta.
const { verificarPresencia, configGps, modoVerificacion } = require('./rondas');

// Con menos intentos no hay de dónde opinar.
const MIN_INTENTOS = 3;
// 1 de cada 4 intentos rechazado por el GPS: el punto tiene un problema.
const RECHAZOS_MALA = 0.25;
// Menos de 1 de cada 10 rechazado: lo normal de un punto con señal.
const RECHAZOS_BUENA = 0.1;
// Más de 1 de cada 4 marcas por cercanía: la señal del momento casi nunca
// alcanza; la marca entra por la lectura de antes.
const CERCANIA_BUENA = 0.25;
// Una marca aceptada a más del 80 % del tope entró justa (ADR-001, fase 0).
const AL_BORDE = 0.8;
// Un rechazo en un punto anclado con una lectura de menos de 30 s: el teléfono
// no traía la señal de la entrada, traía una de adentro (INC-002).
const ANCLA_PERDIDA_MS = 30000;

const TIPOS_GPS = ['imprecisa', 'distancia', 'vencida', 'sinSenal'];

// De qué fue un rechazo, con lo que guardó anotarRechazo() en server.js. Los
// motivos los escribe el teléfono (empiezan con 📍) o el servidor, así que se
// mira primero lo que viene como número.
function tipoRechazo(r, cfg = configGps()) {
  if (r.reporte === 'chapita') return 'chapita';
  const motivo = String(r.motivo || '');
  if (r.distanciaM != null) return 'distancia';
  if (/imprecisa/.test(motivo) || (r.acc != null && r.acc > cfg.precisionMaxM)) return 'imprecisa';
  if (r.edadMs != null) return 'vencida';
  if (/Sin (señal|ubicación)|antigüedad de la ubicación/.test(motivo)) return 'sinSenal';
  // Un QR en un punto con chapita, o un motivo que no se reconoce: no es del GPS.
  return 'otro';
}

// Percentil por rango más cercano: devuelve una lectura que existió, no un
// promedio entre dos.
function percentil(valores, p) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.max(0, Math.ceil(p * orden.length) - 1)];
}

function accDe(gps, cfg) {
  if (!gps || gps.acc == null || gps.acc === '') return null;
  const n = Number(gps.acc);
  return Number.isFinite(n) && n >= 0 ? Math.max(Math.round(n), cfg.precisionMinM) : null;
}

function cuentaVacia() {
  return {
    marcas: 0,
    sinGps: 0,
    accs: [],
    porCercania: 0,
    alBorde: 0,
    rechazos: { imprecisa: 0, distancia: 0, vencida: 0, sinSenal: 0, chapita: 0, otro: 0 },
    anclaPerdida: 0
  };
}

// Por cada punto, cómo le fue al GPS en `ejecuciones`. El ± que cuenta es el de
// la lectura del momento de marcar —la que dice cómo es la señal ahí—, no el de
// la lectura cercana con que entró una marca por cercanía.
function resumenSenal(puntos, ejecuciones, cfg = configGps()) {
  const porId = new Map(puntos.map(p => [p.id, { punto: p, c: cuentaVacia() }]));
  for (const e of ejecuciones) {
    for (const esc of e.escaneos || []) {
      const fila = porId.get(esc.puntoId);
      if (!fila) continue;
      const { punto, c } = fila;
      c.marcas++;
      const acc = accDe(esc.gps, cfg);
      if (acc != null) c.accs.push(acc);
      else if (!esc.gps) c.sinGps++;
      // Contra la ubicación de HOY del punto: si se re-midió en el período, las
      // marcas de antes se miden contra la nueva. Para opinar de la señal basta.
      const v = verificarPresencia(punto, esc.gps, cfg, esc.cercania);
      if (v && v.porCercania) c.porCercania++;
      else if (v && v.ok && v.distanciaM != null && v.topeM && v.distanciaM > AL_BORDE * v.topeM) c.alBorde++;
    }
    for (const r of e.rechazos || []) {
      const fila = porId.get(r.puntoId);
      if (!fila) continue;
      const tipo = tipoRechazo(r, cfg);
      fila.c.rechazos[tipo]++;
      if ((tipo === 'imprecisa' || tipo === 'distancia') && modoVerificacion(fila.punto) === 'anclaje'
        && r.edadMs != null && r.edadMs < ANCLA_PERDIDA_MS) fila.c.anclaPerdida++;
    }
  }
  return puntos.map(p => resumir(porId.get(p.id), cfg));
}

function resumir({ punto, c }, cfg) {
  const rechazosGps = TIPOS_GPS.reduce((n, t) => n + c.rechazos[t], 0);
  const resumen = {
    puntoId: punto.id,
    nombre: punto.nombre,
    modo: punto.nfcSerie ? 'nfc' : modoVerificacion(punto),
    marcas: c.marcas,
    sinGps: c.sinGps,
    conAcc: c.accs.length,
    accMediana: percentil(c.accs, 0.5),
    accP90: percentil(c.accs, 0.9),
    porCercania: c.porCercania,
    alBorde: c.alBorde,
    rechazos: c.rechazos,
    rechazosGps,
    anclaPerdida: c.anclaPerdida
  };
  resumen.nivel = nivelSenal(resumen, cfg);
  resumen.recomendacion = recomendacion(resumen);
  return resumen;
}

// buena / regular / mala, o null si no hay datos para opinar.
//   mala:    la lectura típica no es buena (± sobre GPS_LECTURA_BUENA_M), o 1 de
//            cada 4 intentos lo rechazó el GPS.
//   buena:   casi todas las lecturas son buenas, casi sin rechazos, y la marca
//            casi nunca necesita la cercanía.
//   regular: lo de en medio. La cercanía es para estos.
function nivelSenal(r, cfg) {
  const intentos = r.marcas + r.rechazosGps;
  if (intentos < MIN_INTENTOS || (!r.conAcc && !r.rechazosGps)) return null;
  const tasaRechazos = r.rechazosGps / intentos;
  if (tasaRechazos >= RECHAZOS_MALA || (r.accMediana != null && r.accMediana > cfg.lecturaBuenaM)) return 'mala';
  const tasaCercania = r.marcas ? r.porCercania / r.marcas : 0;
  if (tasaRechazos < RECHAZOS_BUENA && tasaCercania <= CERCANIA_BUENA
    && r.accP90 != null && r.accP90 <= cfg.lecturaBuenaM) return 'buena';
  return 'regular';
}

// La tabla de decisión de OPERACION.md («Qué prueba usar en cada punto»),
// aplicada a los números. null cuando el punto está bien como está.
function recomendacion(r) {
  if (!r.nivel || r.modo === 'nfc' || r.modo === 'ninguna') return null;
  if (r.modo === 'anclaje') {
    if (r.nivel === 'buena') return 'Hay buena señal en el punto: puede verificarse 📍 exacto, que es una prueba más fuerte.';
    if (r.nivel === 'mala') {
      return 'Siguen los rechazos: revisa que la entrada fijada sea el último lugar con buena señal antes de bajar, '
        + 'o ponle chapita NFC si los teléfonos la leen (Chrome en Android).';
    }
    return null;
  }
  if (r.nivel === 'mala') {
    return 'Mala señal: si el punto está bajo losa, ponle chapita NFC (teléfonos con Chrome en Android) '
      + 'o 🏠 fija la entrada (Fully Kiosk). Si está a 30 m o menos de un lugar con buena señal, la cercanía lo cubre.';
  }
  if (r.nivel === 'regular' && r.rechazosGps) {
    return 'Señal justa: la cercanía cubre al guardia que pasó a 30 m o menos con buena señal. '
      + 'Si los rechazos siguen, fíjalo en el último lugar con buena señal antes del punto.';
  }
  return null;
}

module.exports = { resumenSenal, tipoRechazo, nivelSenal, recomendacion, percentil };
