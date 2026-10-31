// Salud del producto por condominio, para la pantalla de la operación (/fabrica).
//
// Los fallos más caros no son errores de código. El corte de rondas por sesión
// vencida (v1.24 y anteriores) era un 401, comportamiento esperado: ni el
// registro de errores (lib/errores.js) ni Sentry podían verlo. Acá se mide lo
// que vive el guardia aunque ningún request falle, en los últimos 7 días:
//
//   1. Cómo terminan las rondas: completas, incompletas, con sospechas o
//      cerradas automáticamente por el proceso de rondas abandonadas
//      (estaAbandonada en lib/rondas.js).
//   2. Rondas en las que el guardia tuvo que volver a iniciar sesión a mitad de
//      recorrido: un login de un guardia que ya tenía una ronda en curso
//      (anotarReingreso, desde POST /api/login).
//   3. Alarmas de ronda que tocaban y no sonaron porque había una ronda en
//      curso (lib/recordatorios.js).
//
// La 1 sale de las ejecuciones. La 2 y la 3 no dejaban rastro: se anotan desde
// la v1.26 en store.salud, sin datos personales (del guardia, solo el id
// interno). Antes de `store.salud.desde()` un cero no dice nada.
'use strict';

const errores = require('./errores');

const DIAS = 7;
const REINGRESO = 'reingreso-en-ronda';
const ALARMA_RETENIDA = 'alarma-retenida';

// Sin tope: una ronda o un evento con la hora del teléfono un poco adelantada
// también es de esta semana.
const SIN_TOPE = '9999-12-31T23:59:59.999Z';

// En qué fila cae cada estado de una ronda cerrada. La cerrada por el sistema
// va aparte aunque haya quedado completa: el guardia no la terminó.
const CLASE = { completa: 'completas', completa_obs: 'completas', incompleta: 'incompletas', sospechosa: 'sospechosas' };

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
    errores.reportar('salud', e);
    return null;
  }
}

// Los tres indicadores de un condominio. Un condominio sin rondas da ceros,
// nunca NaN.
function resumen(store, condominioId, ahora = Date.now()) {
  const desde = new Date(ahora - DIAS * 86400000).toISOString();

  const rondas = { cerradas: 0, completas: 0, incompletas: 0, sospechosas: 0, automaticas: 0, enCurso: 0 };
  for (const { estado, automatico, n } of store.ejecuciones.contarEstados(condominioId, desde, SIN_TOPE)) {
    if (estado === 'en_curso') { rondas.enCurso += n; continue; }
    const clase = automatico ? 'automaticas' : CLASE[estado];
    if (!clase) continue;
    rondas[clase] += n;
    rondas.cerradas += n;
  }
  rondas.porcentaje = {
    completas: pct(rondas.completas, rondas.cerradas),
    incompletas: pct(rondas.incompletas, rondas.cerradas),
    sospechosas: pct(rondas.sospechosas, rondas.cerradas),
    automaticas: pct(rondas.automaticas, rondas.cerradas)
  };

  // Rondas distintas: un guardia que entra dos veces en la misma ronda es una
  // ronda cortada, no dos.
  const reingresos = store.salud.listar(condominioId, REINGRESO, desde, SIN_TOPE);
  const conReingreso = new Set(reingresos.map(r => r.ejecucionId)).size;
  const retenidas = store.salud.listar(condominioId, ALARMA_RETENIDA, desde, SIN_TOPE);

  return {
    dias: DIAS,
    desde,
    // Cuándo se empezó a anotar la 2 y la 3. Si es después de `desde`, la
    // semana está incompleta para esos dos.
    registroDesde: store.salud.desde(),
    rondas,
    reingresos: {
      rondas: conReingreso,
      veces: reingresos.length,
      porcentaje: pct(conReingreso, rondas.cerradas + rondas.enCurso)
    },
    alarmasRetenidas: {
      veces: retenidas.length,
      rondas: new Set(retenidas.map(r => r.ejecucionId)).size
    }
  };
}

module.exports = { anotarReingreso, resumen, DIAS, REINGRESO, ALARMA_RETENIDA };
