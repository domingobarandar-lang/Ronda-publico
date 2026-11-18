// Correo semanal de salud para la operación (José), todos los lunes.
//
// Lo mismo que muestra /fabrica por condominio, para no tener que mirar la
// pantalla: cómo terminan las rondas, las rondas con dificultades técnicas
// (fallo de la aplicación o del teléfono, con el GPS aparte, y fallo del
// usuario) y los errores de Sentry sin resolver. Sale SIEMPRE, aunque todo
// esté bien: un lunes sin correo ya es una señal.
//
// No calcula nada propio: los números son los de salud.resumen() (lib/salud.js)
// y los de Sentry los lee el mismo lector de /fabrica (lib/sentry-lectura.js).
// Lo único nuevo es el semáforo de arriba, una línea por condominio:
//
//   🔴 urgente   sin ninguna ronda en 7 días teniendo rondas configuradas (algo
//                se cortó: el teléfono, la sesión, la app), o fallo de la
//                aplicación en URGENTE_PCT % o más de las rondas.
//   🟡 mirar     cualquier fallo de la aplicación, rondas cerradas
//                automáticamente, incompletas o con sospechas, fallo del
//                usuario en MIRAR_USUARIO_PCT % o más, errores de Sentry sin
//                resolver, o Sentry que no se pudo leer. También el condominio
//                sin rondas configuradas todavía.
//   🟢 todo bien lo demás.
//
//   SALUD_TO    destinatario(s), separados por coma. Vacío = no se manda.
//   SALUD_HORA  hora de Chile desde la que sale el lunes, HH:MM (por defecto
//               06:30). También acepta solo la hora ("8" = 08:00).
//
// Se programa en lib/programador.js; scripts/salud-ahora.js lo manda a mano.
// Nunca lanza: devuelve { enviada, error? }.
'use strict';

const correo = require('./correo');
const salud = require('./salud');
const { normalizarCorreos } = require('./destinatarios');
const { TZ, isoChile } = require('./fechas-chile');
const alertas = require('./alertas-rondas');

const DIA_ENVIO = 1; // lunes
const URGENTE_PCT = 20;
const MIRAR_USUARIO_PCT = 20;

const NIVEL = {
  urgente: { orden: 0, icono: '🔴', texto: 'urgente' },
  mirar: { orden: 1, icono: '🟡', texto: 'mirar' },
  bien: { orden: 2, icono: '🟢', texto: 'todo bien' }
};

const HORA_POR_DEFECTO = '06:30';

// "6:30", "06:30" o "8" → minutos desde la medianoche. Mal escrita, la de por
// defecto (y el log de arranque muestra cuál quedó).
function minutosDelDia(texto) {
  const m = String(texto == null ? '' : texto).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2] || 0);
}
const comoHora = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function opcionesDesdeEnv(env = process.env) {
  const minutos = minutosDelDia(env.SALUD_HORA) ?? minutosDelDia(HORA_POR_DEFECTO);
  return { to: normalizarCorreos(env.SALUD_TO), minutos, hora: comoHora(minutos) };
}

// Las mismas etiquetas que /fabrica (CAUSAS en public/fabrica.js).
const CAUSAS = {
  app: {
    gps: 'GPS: sin señal, ubicación vieja o imprecisa',
    sesion: 'Se le cortó la sesión a mitad de ronda',
    telefono: 'El teléfono no terminó la ronda (la cerró el sistema con puntos sin marcar)',
    chapita: 'La chapita no lee'
  },
  usuario: {
    lejos: 'Lejos del punto, con buena señal de GPS',
    medio: 'QR, chapita o código equivocado',
    terminar: 'Marcó todos los puntos y no tocó «Terminar ronda»'
  }
};

const rondas = n => (n === 1 ? '1 ronda' : `${n} rondas`);
const veces = n => (n === 1 ? '1 vez' : `${n} veces`);
const problemas = n => (n === 1 ? '1 error' : `${n} errores`);

// Fecha y hora de Chile, legible, sin depender de la zona del servidor
// (Railway corre en UTC: INC-001 C).
function fechaHora(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CL', {
    timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
}
const fechaCorta = ts => (ts ? isoChile(ts).split('-').reverse().join('-') : '—');

// El semáforo de un condominio y por qué. `s`: salud.resumen(); `sentry`: lo
// que devolvió el lector para ese condominio (o null si no está conectado).
function semaforo({ s, sentry, rondasConfiguradas, ultimaRonda }) {
  const urgente = [];
  const mirar = [];
  const r = s.rondas;
  const d = s.dificultades;

  if (!r.total) {
    if (rondasConfiguradas) urgente.push(`sin ninguna ronda en ${s.dias} días (${ultimaRonda ? `última: ${fechaCorta(ultimaRonda)}` : 'nunca ha tenido una'})`);
    else mirar.push('sin rondas configuradas todavía');
  } else {
    const app = `fallo de la app o del teléfono en ${rondas(d.app.rondas)} (${d.app.porcentaje}%)`
      + (d.gps.rondas ? `, GPS en ${d.gps.rondas}` : '');
    if (d.app.rondas && d.app.porcentaje >= URGENTE_PCT) urgente.push(app);
    else if (d.app.rondas) mirar.push(app);
    if (r.automaticas) mirar.push(`${r.automaticas} cerrada${r.automaticas === 1 ? '' : 's'} automáticamente`);
    if (r.incompletas) mirar.push(`${r.incompletas} incompleta${r.incompletas === 1 ? '' : 's'}`);
    if (r.sospechosas) mirar.push(`${r.sospechosas} con sospechas`);
    if (d.usuario.rondas && d.usuario.porcentaje >= MIRAR_USUARIO_PCT) {
      mirar.push(`fallo del usuario en ${rondas(d.usuario.rondas)} (${d.usuario.porcentaje}%)`);
    }
  }
  if (sentry && sentry.error) mirar.push('no se pudo leer Sentry');
  else if (sentry && sentry.problemas) mirar.push(`${problemas(sentry.problemas)} en Sentry`);

  const nivel = urgente.length ? 'urgente' : mirar.length ? 'mirar' : 'bien';
  return { nivel, motivos: [...urgente, ...mirar] };
}

function lineaResumen(f) {
  const n = NIVEL[f.nivel];
  const detalle = f.motivos.length ? f.motivos.join(' · ') : `${rondas(f.salud.rondas.total)} (${alertas.unaDecimal(f.promedioDia)} por día)`;
  return `${n.icono} ${f.nombre} — ${n.texto}: ${detalle}`;
}

function bloqueSentry(sentry, sangria = '  ') {
  if (!sentry) return [];
  if (sentry.error) return [`${sangria}No se pudo leer Sentry: ${sentry.error}`];
  if (!sentry.problemas) return [`${sangria}Sin errores sin resolver.`];
  const lineas = sentry.lista.map(p => `${sangria}· ${p.titulo}${p.donde ? ` (${p.donde})` : ''} — ${veces(p.eventos)}, última: ${fechaHora(p.ultimaVez)}`
    + (p.enlace ? `\n${sangria}  ${p.enlace}` : ''));
  const resto = sentry.problemas - sentry.lista.length;
  if (resto > 0) lineas.push(`${sangria}…y ${resto} más en Sentry.`);
  return lineas;
}

function detalle(f, { sentryConectado }) {
  const s = f.salud;
  const r = s.rondas;
  const d = s.dificultades;
  const L = [`== ${NIVEL[f.nivel].icono} ${f.nombre} ==`];
  if (!r.total) {
    L.push(f.rondasConfiguradas
      ? `Sin ninguna ronda en ${s.dias} días. ${f.ultimaRonda ? `Última ronda: ${fechaHora(f.ultimaRonda)}.` : 'Nunca ha tenido una.'}`
      : 'Sin rondas configuradas todavía.');
  } else {
    L.push(`Rondas: ${r.total} (${r.cerradas} cerradas${r.enCurso ? `, ${r.enCurso} en curso` : ''})`);
    L.push(`  Promedio: ${alertas.unaDecimal(f.promedioDia)} rondas por día`
      + (f.minimo ? ` · alerta si un día tiene menos de ${f.minimo.minimo}${f.minimo.automatico ? ' (la mitad de su promedio de 4 semanas)' : ''}` : ''));
    L.push(`  Completas ${r.completas} (${r.porcentaje.completas}%) · Incompletas ${r.incompletas} (${r.porcentaje.incompletas}%)`
      + ` · Con sospechas ${r.sospechosas} (${r.porcentaje.sospechosas}%) · Cerradas automáticamente ${r.automaticas} (${r.porcentaje.automaticas}%)`);
    L.push(`Rondas con dificultades técnicas: ${rondas(d.rondas)} (${d.porcentaje}%)`);
    for (const lado of ['app', 'usuario']) {
      const titulo = lado === 'app' ? 'Fallo de la aplicación o del teléfono' : 'Fallo del usuario';
      L.push(`  ${titulo}: ${rondas(d[lado].rondas)} (${d[lado].porcentaje}%)`);
      for (const [clave, etiqueta] of Object.entries(CAUSAS[lado])) {
        const n = d[lado].causas[clave];
        if (!n) continue;
        const extra = clave === 'gps' ? ` (${d.gps.porcentaje}%, ${d.gps.rechazos === 1 ? '1 rechazo' : `${d.gps.rechazos} rechazos`})` : '';
        L.push(`    · ${etiqueta}: ${rondas(n)}${extra}`);
      }
    }
    if (s.registroDesde && Date.parse(s.registroDesde) > Date.parse(s.desde)) {
      L.push(`  (La sesión cortada se cuenta desde el ${fechaCorta(s.registroDesde)}; antes no se anotaba.)`);
    }
  }
  if (sentryConectado) {
    L.push('Errores de Sentry sin resolver:');
    L.push(...bloqueSentry(f.sentry));
  }
  return L.join('\n');
}

// Arma el correo (sin mandarlo). `lectorSentry`: el de lib/sentry-lectura.js.
async function armar(store, { lectorSentry, ahora = Date.now(), env = process.env } = {}) {
  const db = store.db;
  const conectado = Boolean(lectorSentry && lectorSentry.configurado);
  const [sinCondominio, ...porCondominio] = conectado
    ? await Promise.all([lectorSentry.sinCondominio(), ...db.condominios.map(c => lectorSentry.deCondominio(c.id))])
    : [null];

  const filas = db.condominios.map((c, i) => {
    const s = salud.resumen(store, c.id, ahora);
    const sentry = conectado ? porCondominio[i] : null;
    const rondasConfiguradas = db.rondas.filter(x => x.condominioId === c.id).length;
    const ultimaRonda = (store.ejecuciones.ultimaDe(c.id) || {}).inicio || null;
    const promedioDia = s.rondas.total / s.dias;
    // El mínimo con el que alertas-rondas.js avisaría hoy, para que se vea.
    const minimo = alertas.minimoDiario(store, c.id, isoChile(ahora), alertas.opcionesDesdeEnv(env));
    return { id: c.id, nombre: c.nombre, salud: s, sentry, rondasConfiguradas, ultimaRonda, promedioDia, minimo, ...semaforo({ s, sentry, rondasConfiguradas, ultimaRonda }) };
  }).sort((a, b) => NIVEL[a.nivel].orden - NIVEL[b.nivel].orden || a.nombre.localeCompare(b.nombre, 'es'));

  const cuenta = nivel => filas.filter(f => f.nivel === nivel).length;
  const urgentes = cuenta('urgente');
  const aMirar = cuenta('mirar');
  const sinRondas = filas.filter(f => !f.salud.rondas.total);
  const estado = urgentes || aMirar
    ? [urgentes && `${urgentes} urgente${urgentes === 1 ? '' : 's'}`, aMirar && `${aMirar} para mirar`].filter(Boolean).join(', ')
    : 'todo bien';
  const subject = `${urgentes ? '🔴' : aMirar ? '🟡' : '🟢'} Salud Ronda — ${fechaCorta(ahora)}: ${estado}`;

  const L = [
    `Salud de Ronda, últimos 7 días: del ${fechaHora(ahora - salud.DIAS * 86400000)} al ${fechaHora(ahora)} (hora de Chile).`,
    '',
    'RESUMEN'
  ];
  if (!filas.length) L.push('No hay condominios dados de alta.');
  L.push(...filas.map(lineaResumen));
  if (sinRondas.length) {
    L.push('', `Sin ninguna ronda en la semana (algo se cortó o no han empezado): ${sinRondas.map(f => f.nombre).join(', ')}.`);
  }
  if (!conectado) {
    L.push('', `Sentry no está conectado (falta: ${(lectorSentry && lectorSentry.falta) || 'SENTRY_TOKEN_LECTURA'}). Los errores de código no van en este correo.`);
  }
  L.push('', 'DETALLE', '');
  L.push(...filas.map(f => `${detalle(f, { sentryConectado: conectado })}\n`));
  if (conectado) {
    L.push('== Errores de Sentry sin condominio ==', '(Tareas del servidor, pantallas sin sesión y errores anteriores a la v1.26.)');
    L.push(...bloqueSentry(sinCondominio), '');
  }
  L.push('Una ronda puede tener más de una causa. El detalle de cada condominio está en /fabrica.', '', '— Ronda');

  return { subject, texto: L.join('\n'), filas, urgentes, aMirar };
}

// Una revisión: se llama cada 5 minutos desde lib/programador.js. Sale una vez por
// semana, el lunes desde SALUD_HORA (store.db.saludEmailEstado guarda la
// semana ya enviada, así un reinicio no lo repite). `ahora`: ahoraChile()
// ({ dia, hora, minuto }).
// `forzar`: sin mirar día, hora ni si ya salió (scripts/salud-ahora.js).
async function revisar(store, {
  ahora, semana, forzar = false, env = process.env, lectorSentry, enviar = correo.enviarCorreo,
  log = console.log, reloj = Date.now()
} = {}) {
  try {
    const op = opcionesDesdeEnv(env);
    if (!op.to.length) return null; // sin destinatario no se manda, y no es un error
    if (!forzar) {
      if (ahora.dia !== DIA_ENVIO || ahora.hora * 60 + (ahora.minuto || 0) < op.minutos) return null;
      if ((store.db.saludEmailEstado || {}).semana === semana) return null;
    }
    if (!correo.configurado() && enviar === correo.enviarCorreo) {
      return { enviada: false, error: `correo sin configurar (falta ${correo.FALTA_CREDENCIALES})` };
    }
    const c = await armar(store, { lectorSentry, ahora: reloj, env });
    const r = await enviar({ to: op.to, subject: c.subject, texto: c.texto });
    if (r.enviada) {
      // El envío a mano no cuenta como el del lunes: el programado sale igual.
      if (!forzar) {
        store.db.saludEmailEstado = { semana, enviado: new Date(reloj).toISOString() };
        store.guardar();
      }
      log(`[salud-email] enviado a ${op.to.join(', ')}: ${c.subject}`);
    } else {
      log(`[salud-email] FALLÓ el envío a ${op.to.join(', ')}: ${r.error} (se reintenta en la próxima revisión)`);
    }
    return { ...r, subject: c.subject, texto: c.texto };
  } catch (err) {
    log(`[salud-email] error: ${err.message}`);
    return { enviada: false, error: err.message };
  }
}

module.exports = { armar, revisar, semaforo, opcionesDesdeEnv, minutosDelDia, fechaHora, DIA_ENVIO, URGENTE_PCT, MIRAR_USUARIO_PCT };
