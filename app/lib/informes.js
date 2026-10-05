// Informe de una ejecución: estructura de datos + versión en texto plano
// (para el registro de avisos y la consola). El HTML imprimible lo arma el navegador en
// public/informe.html a partir del JSON.
const { OCULTAR_SIN_CONEXION } = require('./rondas'); // TEMPORAL, ver lib/rondas.js
const { nombreGuardia } = require('./cuenta');

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
      edadGpsMs: esc && esc.edadGpsMs != null ? esc.edadGpsMs : null,
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
    detalle
  };
}

function hora(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-CL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

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
  return lineas.join('\n');
}

module.exports = { armarInforme, informeTexto, ETIQUETAS, hora };
