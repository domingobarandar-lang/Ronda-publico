// Alertas inmediatas por correo a la operación: lo que no puede esperar al
// correo de los lunes (lib/salud-semanal.js).
//
//   1. Horas sin rondas: un condominio que lleva ALERTA_SIN_RONDA_HORAS (12)
//      sin empezar ninguna ronda. Se avisa una vez; la siguiente alerta de ese
//      condominio es después de que vuelva a haber una ronda.
//   2. Pocas rondas en el día: cuando termina el día (medianoche de Chile), un
//      condominio que hizo menos rondas que su mínimo diario. El mínimo, si
//      ALERTA_MIN_RONDAS_DIA está vacío, es automático: la mitad de su propio
//      promedio diario de las 4 semanas anteriores (al menos 1). Así un
//      condominio que hace 20 rondas al día avisa con menos de 10, y uno que
//      hace 4, con menos de 2. Con un número, ese mínimo vale para todos.
//      Sin 7 días de historia, el condominio no se revisa: no hay con qué
//      comparar.
//
// No toda alerta es un problema: puede que ese día no hicieran rondas por algo
// del cliente. La alerta es para ir a mirar, no un diagnóstico.
//
//   SALUD_TO                destinatario (el mismo del correo de los lunes).
//                           Vacío = no se manda nada.
//   ALERTA_SIN_RONDA_HORAS  horas sin rondas para avisar (12; 0 = apagada).
//   ALERTA_MIN_RONDAS_DIA   mínimo de rondas por día (vacío = automático; 0 =
//                           apagada).
//
// Solo cuentan los condominios con rondas configuradas y que ya tuvieron
// alguna ronda (el recién dado de alta no alerta). El estado de lo avisado
// vive en store.db.alertasEstado. Se revisa cada 5 min desde
// lib/programador.js. Nunca lanza.
'use strict';

const correo = require('./correo');
const { normalizarCorreos } = require('./destinatarios');
const { isoChile, sumarDias, inicioDiaChile } = require('./fechas-chile');

const HORA = 3600000;
const SEMANAS_PROMEDIO = 4;
const DIAS_HISTORIA_MIN = 7;
const FRACCION_MINIMO = 0.5;

const numero = (v, porDefecto) => (v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? porDefecto : Number(v));

function opcionesDesdeEnv(env = process.env) {
  const min = String(env.ALERTA_MIN_RONDAS_DIA ?? '').trim();
  return {
    to: normalizarCorreos(env.SALUD_TO),
    sinRondaHoras: Math.max(0, numero(env.ALERTA_SIN_RONDA_HORAS, 12)),
    // null = automático; 0 = apagada; n = fijo.
    minRondasDia: min === '' || !Number.isFinite(Number(min)) ? null : Math.max(0, Math.floor(Number(min)))
  };
}

const unaDecimal = n => (Math.round(n * 10) / 10).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const horas = ms => Math.floor(ms / HORA);
const rondas = n => (n === 1 ? '1 ronda' : `${n} rondas`);

// Rondas que empezaron en el día `fecha` de Chile.
function rondasDelDia(store, condominioId, fecha) {
  return store.ejecuciones.listar({ condominioId, desde: inicioDiaChile(fecha), hasta: inicioDiaChile(sumarDias(fecha, 1)) }).length;
}

// Promedio de rondas por día de las 4 semanas ANTERIORES a `fecha` (sin
// incluirla), contando solo los días desde la primera ronda del condominio.
// { promedio, dias } o null si hay menos de 7 días de historia.
function promedioDiario(store, condominioId, fecha) {
  const desdeFecha = sumarDias(fecha, -7 * SEMANAS_PROMEDIO);
  const lista = store.ejecuciones.listar({ condominioId, desde: inicioDiaChile(desdeFecha), hasta: inicioDiaChile(fecha) });
  if (!lista.length) return null;
  const primera = isoChile(lista[lista.length - 1].inicio);
  const dias = Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${primera}T00:00:00Z`)) / 86400000);
  if (dias < DIAS_HISTORIA_MIN) return null;
  return { promedio: lista.length / dias, dias };
}

// El mínimo diario de un condominio para el día `fecha`, o null si no se
// revisa (apagado o sin historia). { minimo, promedio, automatico }.
function minimoDiario(store, condominioId, fecha, op) {
  if (op.minRondasDia === 0) return null;
  const p = promedioDiario(store, condominioId, fecha);
  if (op.minRondasDia != null) return { minimo: op.minRondasDia, promedio: p && p.promedio, automatico: false };
  if (!p) return null;
  return { minimo: Math.max(1, Math.floor(p.promedio * FRACCION_MINIMO)), promedio: p.promedio, automatico: true };
}

const vigilados = (db) => db.condominios.filter(c => db.rondas.some(r => r.condominioId === c.id));

// Lo que hay que avisar ahora (sin mandar ni guardar nada). `estado`: el de
// store.db.alertasEstado. Devuelve { alertas: [texto], estado: nuevo }.
function evaluar(store, { ahora = Date.now(), op, estado = {} } = {}) {
  const sinRonda = { ...(estado.sinRonda || {}) };
  const dia = { ...(estado.dia || {}) };
  const alertas = [];
  const ayer = sumarDias(isoChile(ahora), -1);

  for (const c of vigilados(store.db)) {
    const ultima = store.ejecuciones.ultimaDe(c.id);
    if (!ultima) continue; // nunca ha tenido una: lo dice el correo de los lunes

    // 1. Horas sin rondas. Una ronda en curso cuenta: alguien está rondando.
    if (op.sinRondaHoras) {
      const desde = ahora - Date.parse(ultima.inicio);
      const yaAvisada = sinRonda[c.id] === ultima.id;
      if (ultima.estado !== 'en_curso' && desde >= op.sinRondaHoras * HORA) {
        if (!yaAvisada) {
          alertas.push(`🔴 ${c.nombre}: lleva ${horas(desde)} horas sin rondas. La última empezó el ${fechaHora(ultima.inicio)}.`);
          sinRonda[c.id] = ultima.id;
        }
      } else if (sinRonda[c.id] && !yaAvisada) {
        delete sinRonda[c.id]; // volvió a haber rondas: la próxima vez se avisa de nuevo
      }
    }

    // 2. El día de ayer, una vez, apenas termina.
    if (dia[c.id] !== ayer) {
      const m = minimoDiario(store, c.id, ayer, op);
      if (m) {
        const n = rondasDelDia(store, c.id, ayer);
        if (n < m.minimo) {
          const base = m.automatico
            ? `la mitad de su promedio de ${unaDecimal(m.promedio)} por día`
            : `el mínimo configurado${m.promedio != null ? `; su promedio es ${unaDecimal(m.promedio)} por día` : ''}`;
          alertas.push(`🟡 ${c.nombre}: el ${ayer.split('-').reverse().join('-')} hizo ${rondas(n)}, menos de ${m.minimo} (${base}).`);
        }
      }
      dia[c.id] = ayer;
    }
  }
  return { alertas, estado: { sinRonda, dia } };
}

function fechaHora(ts) {
  return new Date(ts).toLocaleString('es-CL', {
    timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
}

async function revisar(store, { ahora = Date.now(), env = process.env, enviar = correo.enviarCorreo, log = console.log } = {}) {
  try {
    const op = opcionesDesdeEnv(env);
    if (!op.to.length) return null;
    if (!correo.configurado() && enviar === correo.enviarCorreo) return null;
    const { alertas, estado } = evaluar(store, { ahora, op, estado: store.db.alertasEstado });
    if (!alertas.length) {
      // Sin nada que avisar igual se guarda: el día ya revisado no se repite.
      if (JSON.stringify(estado) !== JSON.stringify(store.db.alertasEstado || {})) { store.db.alertasEstado = estado; store.guardar(); }
      return { enviada: false, alertas };
    }
    const urgente = alertas.some(a => a.startsWith('🔴'));
    const subject = `${urgente ? '🔴' : '🟡'} Alerta Ronda — ${alertas.length === 1 ? alertas[0].replace(/^\S+\s/, '').split(':')[0] : `${alertas.length} condominios`}`;
    const texto = [
      ...alertas, '',
      'Puede que no sea un problema (algo del cliente ese día), pero conviene mirarlo: panel, /fabrica o llamar a la garita.',
      'Se avisa una vez por condominio; vuelve a avisar después de que haya otra ronda (o al día siguiente, si es por el mínimo).',
      '', '— Ronda'
    ].join('\n');
    const r = await enviar({ to: op.to, subject, texto });
    if (r.enviada) {
      store.db.alertasEstado = estado;
      store.guardar();
      log(`[alertas] enviado a ${op.to.join(', ')}: ${alertas.length} alerta(s)`);
    } else {
      log(`[alertas] FALLÓ el envío a ${op.to.join(', ')}: ${r.error} (se reintenta en la próxima revisión)`);
    }
    return { ...r, alertas, subject, texto };
  } catch (err) {
    log(`[alertas] error: ${err.message}`);
    return { enviada: false, error: err.message };
  }
}

module.exports = { evaluar, revisar, opcionesDesdeEnv, promedioDiario, minimoDiario, rondasDelDia, unaDecimal };
