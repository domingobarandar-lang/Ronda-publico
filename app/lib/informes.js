// Informe de una ejecución: estructura de datos + versión en texto plano
// (para el registro de avisos y la consola). El HTML imprimible lo arma el navegador en
// public/informe.html a partir del JSON.
const { OCULTAR_SIN_CONEXION } = require('./rondas'); // OCULTAR_SIN_CONEXION: TEMPORAL, ver lib/rondas.js
const { nombreGuardia } = require('./cuenta');
const { TZ } = require('./fechas-chile');

const ETIQUETAS = {
  completa: 'Completa',
  completa_obs: 'Completa con observaciones',
  sospechosa: 'SOSPECHOSA',
  incompleta: 'INCOMPLETA',
  en_curso: 'En curso'
};

function armarInforme(db, ejecucion) {
  const ronda = db.rondas.find(r => r.id === ejecucion.rondaId) || { puntoIds: [] };
  const condominio = db.condominios.find(c => c.id === ejecucion.condominioId) || {};
  // Sin usuario (la cuenta se eliminó): "Guardia eliminado", nunca undefined.
  const guardia = db.usuarios.find(u => u.id === ejecucion.guardiaId);
  const escaneosPorPunto = new Map(ejecucion.escaneos.map(e => [e.puntoId, e]));

  const lejosIds = new Set(((ejecucion.evaluacion || {}).gpsLejos || []).map(l => l.puntoId));
  // Con qué se marcó cada punto (CU-28) solo se muestra cuando la ronda tiene
  // que ver con chapitas: un punto de la ronda la tiene, o alguna marca se hizo
  // con una (el punto pudo volver a QR después). En un condominio de puros QR,
  // el informe y el aviso quedan iguales que antes de la v1.24.
  const conChapitas = (ronda.puntoIds || []).some(pid => (db.puntos.find(p => p.id === pid) || {}).nfcSerie)
    || ejecucion.escaneos.some(e => e.medio === 'nfc' || e.puntoNfc);
  const detalle = (ronda.puntoIds || []).map((pid, i) => {
    const punto = db.puntos.find(p => p.id === pid) || { id: pid, nombre: '(punto eliminado)' };
    const esc = escaneosPorPunto.get(pid);
    return {
      orden: i + 1,
      puntoId: pid,
      nombre: punto.nombre,
      hora: esc ? esc.ts : null,
      offline: esc && !OCULTAR_SIN_CONEXION ? esc.offline : false,
      gps: esc ? esc.gps || null : null,
      distanciaM: esc && esc.distanciaM != null ? esc.distanciaM : null,
      // anclado: la distancia es a la ENTRADA del recinto, no al punto. El
      // informe lo dice explícito para que el administrador sepa que ahí la
      // verificación es "pasó por la entrada", no "estuvo en el punto".
      anclado: Boolean(esc && esc.anclado),
      // porCercania (v1.27): la marca entró con una lectura buena de hace unos
      // minutos cerca del punto, porque la del momento no alcanzaba. Viaja en los
      // datos pero el informe no lo muestra: para el administrador es una marca
      // como cualquier otra. Se cuenta en Panel → Puntos («N por cercanía»).
      porCercania: Boolean(esc && esc.porCercania),
      // En esas marcas distanciaM y edadGpsMs son de la lectura cercana; esta es
      // la del momento de marcar (null si no había). Solo ahí, para que las
      // demás marcas queden con la misma forma de siempre.
      ...(esc && esc.porCercania ? { distanciaAhoraM: esc.distanciaAhoraM != null ? esc.distanciaAhoraM : null } : {}),
      edadGpsMs: esc && esc.edadGpsMs != null ? esc.edadGpsMs : null,
      // Las marcas de antes de la v1.24 no lo guardaban: quedan sin etiqueta.
      medio: conChapitas && esc ? esc.medio || null : null,
      lejos: lejosIds.has(pid),
      faltante: !esc
    };
  });

  return {
    id: ejecucion.id,
    condominio: condominio.nombre,
    ronda: ronda.nombre,
    guardia: nombreGuardia(guardia),
    inicio: ejecucion.inicio,
    fin: ejecucion.fin,
    estado: ejecucion.estado,
    etiqueta: ETIQUETAS[ejecucion.estado] || ejecucion.estado,
    evaluacion: ejecucion.evaluacion,
    // Texto opcional que el guardia escribió al cerrar la ronda.
    comentario: ejecucion.comentario || null,
    detalle
  };
}

// En hora de Chile, no en la del servidor: Railway corre en UTC y los avisos
// salían tres horas adelantados («Inicio 01:02 p. m.» de una ronda de las 10:02).
function hora(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-CL', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

// Cómo se ve el medio de una marca en el informe, el aviso y el panel.
const MEDIOS = { nfc: '📶 NFC', qr: '📷 QR', manual: '⌨️ a mano' };

function informeTexto(inf) {
  const lineas = [];
  lineas.push(`🛡️ Ronda "${inf.ronda}" — ${inf.condominio}`);
  lineas.push(`Guardia: ${inf.guardia}`);
  lineas.push(`Estado: ${inf.etiqueta}`);
  const duracion = inf.evaluacion ? `${inf.evaluacion.duracionMin} min` : '—';
  lineas.push(`Inicio: ${hora(inf.inicio)} · Fin: ${hora(inf.fin)} · Duración: ${duracion}`);
  lineas.push('');
  for (const d of inf.detalle) {
    if (d.faltante) {
      lineas.push(`❌ ${d.orden}. ${d.nombre} — FALTANTE`);
      continue;
    }
    const marcas = [];
    if (MEDIOS[d.medio]) marcas.push(MEDIOS[d.medio]);
    if (d.offline) marcas.push('(offline)');
    if (d.lejos) marcas.push(`⚠️ a ${d.distanciaM} m ${d.anclado ? 'de la entrada' : 'del punto'}`);
    else if (d.anclado) marcas.push('📍 por entrada');
    lineas.push(`✅ ${d.orden}. ${d.nombre} — ${hora(d.hora)}${marcas.length ? ' ' + marcas.join(' ') : ''}`);
  }
  if (inf.evaluacion && inf.evaluacion.observaciones.length) {
    lineas.push('');
    lineas.push('Observaciones:');
    for (const o of inf.evaluacion.observaciones) lineas.push(`• ${o}`);
  }
  if (inf.comentario) {
    lineas.push('');
    lineas.push(`Comentario del guardia: ${inf.comentario}`);
  }
  return lineas.join('\n');
}

module.exports = { armarInforme, informeTexto, ETIQUETAS, MEDIOS, hora };
