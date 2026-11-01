// Salud del producto por condominio, para la pantalla de la operación (/fabrica).
//
// Los fallos más caros no son errores de código. El corte de rondas por sesión
// vencida (INC-001) era un 401, comportamiento esperado: ni el registro de
// errores (lib/errores.js) ni Sentry podían verlo. Acá se mide, en los últimos
// 7 días, lo que vive el guardia aunque ningún request falle:
//
//   1. Cómo terminan las rondas: completas, incompletas, con sospechas o
//      cerradas automáticamente por el proceso de rondas abandonadas
//      (estaAbandonada en lib/rondas.js).
//   2. Rondas con dificultades técnicas, separadas en fallo de la aplicación
//      (o del teléfono) y fallo del usuario. El GPS va aparte dentro de la
//      aplicación: es el que más rondas complica (ver dificultades()).
//
// Los errores de código (el tercer indicador de /fabrica) no salen de acá: los
// lee lib/sentry-lectura.js de Sentry.
//
// Casi todo sale de las ejecuciones (sus rechazos y su cierre). Lo único que
// no dejaba rastro es el guardia que tuvo que volver a iniciar sesión a mitad
// de recorrido: se anota desde la v1.26 en store.salud, sin datos personales
// (del guardia, solo el id interno). Antes de `store.salud.desde()` ese número
// no dice nada.
'use strict';

const errores = require('./errores');
const { configGps, rondaDe, todosMarcados } = require('./rondas');

const DIAS = 7;
const REINGRESO = 'reingreso-en-ronda';

// Sin tope: una ronda o un evento con la hora del teléfono un poco adelantada
// también es de esta semana.
const SIN_TOPE = '9999-12-31T23:59:59.999Z';

// En qué fila cae cada estado de una ronda cerrada. La cerrada por el sistema
// va aparte aunque haya quedado completa: el guardia no la terminó.
const CLASE = { completa: 'completas', completa_obs: 'completas', incompleta: 'incompletas', sospechosa: 'sospechosas' };

// Las causas de cada lado, en el orden en que se muestran.
const CAUSAS_APP = ['gps', 'sesion', 'telefono', 'chapita'];
const CAUSAS_USUARIO = ['lejos', 'medio', 'terminar'];

const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);

// Un login con éxito. Si el guardia tenía una ronda en curso, la sesión se le
// cortó a mitad de recorrido (o salió) y tuvo que volver a entrar. Devuelve el
// id de esa ronda, o null. Nunca lanza: medir no puede impedir que el guardia
// entre.
function anotarReingreso(store, usuario, ahora = Date.now()) {
  try {
    if (!usuario || usuario.rol !== 'guardia' || !usuario.condominioId) return null;
    const abierta = store.ejecuciones.listar({ condominioId: usuario.condominioId, estado: 'en_curso' })
      .find(e => e.guardiaId === usuario.id);
    if (!abierta) return null;
    store.salud.anotar({
      condominioId: usuario.condominioId,
      tipo: REINGRESO,
      ts: new Date(ahora).toISOString(),
      usuarioId: usuario.id,
      ejecucionId: abierta.id
    });
    return abierta.id;
  } catch (e) {
    errores.reportar('salud', e, { condominioId: usuario && usuario.condominioId });
    return null;
  }
}

// Las dificultades técnicas de UNA ronda, por lado y por causa. Devuelve
// { app: Set, usuario: Set, rechazosGps }.
//
// Fallo de la aplicación (o del teléfono):
//   gps       un rechazo que la señal podía arreglar: sin ubicación, ubicación
//             vieja, señal imprecisa, o lejos pero dentro del error posible.
//             Es la misma regla con la que la app retiene el QR para
//             reintentar (esperaSirve en public/app.js).
//   sesion    tuvo que volver a iniciar sesión a mitad de recorrido.
//   telefono  la cerró el sistema con puntos sin marcar: el teléfono no la
//             terminó (se apagó, se cerró la app o no volvió la señal).
//   chapita   «La chapita no lee», o el teléfono no entregó su serie.
// Fallo del usuario:
//   lejos     el GPS, con buena señal, lo ubica más allá del error posible.
//   medio     un QR en un punto con chapita, una chapita de otro punto o el
//             código a mano donde no sirve.
//   terminar  marcó todos los puntos pero no tocó «Terminar ronda».
//
// Los rechazos de GPS siempre traen `topeM` (verificarPresencia lo pone en
// todos sus veredictos); los del medio nunca.
function dificultades(ejecucion, { ronda, reingreso = false, precisionMaxM = configGps().precisionMaxM } = {}) {
  const app = new Set();
  const usuario = new Set();
  let rechazosGps = 0;
  for (const r of ejecucion.rechazos || []) {
    if (r.reporte === 'chapita' || /número de serie de la chapita/i.test(r.motivo || '')) { app.add('chapita'); continue; }
    if (r.topeM == null) { usuario.add('medio'); continue; }
    if (r.distanciaM != null && r.distanciaM > r.topeM + precisionMaxM) { usuario.add('lejos'); continue; }
    app.add('gps');
    rechazosGps++;
  }
  if (reingreso) app.add('sesion');
  if (ejecucion.cierreAutomatico) {
    if (todosMarcados(ejecucion, ronda)) usuario.add('terminar');
    else app.add('telefono');
  }
  return { app, usuario, rechazosGps };
}

// Los indicadores de un condominio. Un condominio sin rondas da ceros, nunca
// NaN. Se cuentan las rondas que EMPEZARON en la ventana.
function resumen(store, condominioId, ahora = Date.now()) {
  const desde = new Date(ahora - DIAS * 86400000).toISOString();
  const ejecuciones = store.ejecuciones.listar({ condominioId, desde });
  // Rondas en las que el guardia volvió a entrar a mitad de recorrido. Puede
  // ser de una ronda que empezó justo antes de la ventana: esa no se cuenta,
  // como cualquier otra ronda de antes.
  const conReingreso = new Set(store.salud.listar(condominioId, REINGRESO, desde, SIN_TOPE).map(r => r.ejecucionId));

  const rondas = { total: ejecuciones.length, cerradas: 0, completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0, enCurso: 0 };
  const lado = () => ({ rondas: 0, porcentaje: 0, causas: {} });
  const app = lado();
  const usuario = lado();
  for (const c of CAUSAS_APP) app.causas[c] = 0;
  for (const c of CAUSAS_USUARIO) usuario.causas[c] = 0;
  let conDificultades = 0;
  let rechazosGps = 0;

  for (const e of ejecuciones) {
    if (e.estado === 'en_curso') rondas.enCurso++;
    else {
      const clase = e.cierreAutomatico ? 'automaticas' : CLASE[e.estado];
      if (clase) { rondas[clase]++; rondas.cerradas++; }
    }
    const d = dificultades(e, { ronda: rondaDe(store.db, e), reingreso: conReingreso.has(e.id) });
    for (const c of d.app) app.causas[c]++;
    for (const c of d.usuario) usuario.causas[c]++;
    if (d.app.size) app.rondas++;
    if (d.usuario.size) usuario.rondas++;
    if (d.app.size || d.usuario.size) conDificultades++;
    rechazosGps += d.rechazosGps;
  }

  rondas.porcentaje = {
    completas: pct(rondas.completas, rondas.cerradas),
    incompletas: pct(rondas.incompletas, rondas.cerradas),
    sospechosas: pct(rondas.sospechosas, rondas.cerradas),
    automaticas: pct(rondas.automaticas, rondas.cerradas)
  };
  app.porcentaje = pct(app.rondas, rondas.total);
  usuario.porcentaje = pct(usuario.rondas, rondas.total);

  return {
    dias: DIAS,
    desde,
    // Cuándo se empezó a anotar la sesión cortada. Si es después de `desde`,
    // la semana está incompleta para esa causa.
    registroDesde: store.salud.desde(),
    rondas,
    dificultades: {
      rondas: conDificultades,
      porcentaje: pct(conDificultades, rondas.total),
      app,
      usuario,
      // El GPS aparte: es el fallo de la aplicación al que hay que ponerle ojo.
      gps: { rondas: app.causas.gps, porcentaje: pct(app.causas.gps, rondas.total), rechazos: rechazosGps }
    }
  };
}

module.exports = { anotarReingreso, dificultades, resumen, DIAS, REINGRESO, CAUSAS_APP, CAUSAS_USUARIO };
