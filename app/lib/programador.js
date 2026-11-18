// Programador del envío semanal del informe por correo.
//
// Corre dentro del server web (el servicio de Railway está siempre encendido).
// Revisa cada hora: si es el día/hora configurados (hora de Chile) y no se
// envió esta semana, manda el informe de la SEMANA ANTERIOR a cada
// DESTINATARIO — un correo por administrador, con el .docx de cada uno de sus
// condominios adjunto, saliendo desde la cuenta de Gmail configurada (ver
// lib/correo.js). Guarda en la base la semana ya enviada para no repetir
// aunque el servidor se reinicie.
//   INFORME_DIA         (0=dom .. 6=sáb; por defecto 1 = lunes)
//   INFORME_HORA        (0-23, hora de Chile; por defecto 8)
//   INFORME_CONDOMINIOS (ids separados por coma; vacío = todos los que tengan
//                        correo cargado. Es una lista blanca opcional.)
//
// También programa el respaldo diario de la base (lib/respaldo.js), que corre
// SIEMPRE: la foto en el volumen no depende de tener Gmail configurado.
//
// Y el correo de salud de los lunes para la operación (lib/salud-semanal.js),
// a SALUD_TO desde SALUD_HORA (HH:MM de Chile, por defecto 06:30). Sin
// SALUD_TO no hace nada.
const correo = require('./correo');
const respaldo = require('./respaldo');
const saludSemanal = require('./salud-semanal');
const alertasRondas = require('./alertas-rondas');
const { crearLectorSentry } = require('./sentry-lectura');
const errores = require('./errores');
const { agruparPorDestinatario } = require('./destinatarios');

// Fecha/hora actual en Chile (maneja el cambio de horario solo).
function ahoraChile() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date());
  const val = t => (partes.find(x => x.type === t) || {}).value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hora = Number(val('hour'));
  if (hora === 24) hora = 0; // algunos runtimes devuelven '24' a medianoche
  return { fecha: `${val('year')}-${val('month')}-${val('day')}`, hora, minuto: Number(val('minute')), dia: dias[val('weekday')] };
}

// Lunes de la semana de esa fecha: clave estable que cambia una vez por semana.
function lunesDeLaSemana(fechaISO) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay(); // 0=dom .. 6=sáb
  const desdeLunes = (dow + 6) % 7;
  return new Date(t - desdeLunes * 86400000).toISOString().slice(0, 10);
}

// Lista blanca opcional. Vacía = todos los condominios (el filtro real lo hace
// el destinatario: sin correo cargado no se manda nada).
function condominiosObjetivo(db) {
  const ids = String(process.env.INFORME_CONDOMINIOS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? db.condominios.filter(c => ids.includes(c.id)) : db.condominios;
}

async function revisar(store) {
  if (!correo.configurado()) return;
  const dia = Number(process.env.INFORME_DIA ?? 1);
  const hora = Number(process.env.INFORME_HORA ?? 8);
  const ahora = ahoraChile();
  if (ahora.dia !== dia || ahora.hora < hora) return;

  const db = store.db;
  // Se lleva por DESTINATARIO, no por condominio: un administrador con dos
  // condominios recibe un correo, no dos. (Las claves viejas de esta tabla eran
  // ids de condominio; quedan ahí sin molestar y nadie las vuelve a leer.)
  db.informeEmailEstado = db.informeEmailEstado || {};
  const semana = lunesDeLaSemana(ahora.fecha);
  const grupos = agruparPorDestinatario(condominiosObjetivo(db), { respaldo: process.env.INFORME_TO });
  for (const { correo: destino, condominioIds } of grupos) {
    if (db.informeEmailEstado[destino] === semana) continue; // ya enviado esta semana
    const r = await correo.enviarInforme(store, { condominioIds, to: [destino] });
    if (r.enviada) {
      db.informeEmailEstado[destino] = semana;
      store.guardar();
      console.log(`[informe-email] enviado a ${destino}: ${r.condominios.join(', ')} (${r.datos.rango})`);
      if (r.fallidos.length) console.warn(`[informe-email] sin adjuntar para ${destino}: ${r.fallidos.join(', ')}`);
    } else {
      console.warn(`[informe-email] FALLÓ ${destino} (${condominioIds.join(', ')}): ${r.error}`);
    }
  }
}

function iniciarRespaldo(store) {
  const op = respaldo.opcionesDesdeEnv(store);
  console.log(`[respaldo] foto diaria desde las ${op.hora}:00 Chile en ${op.dir} (se guardan ${op.conservar}); `
            + (op.to.length ? `copia por correo a ${op.to.join(', ')} cada ${op.cadaDias} día(s).` : 'SIN copia por correo (falta RESPALDO_TO).'));
  const tick = () => respaldo.revisar(store, { ahora: ahoraChile() });
  setTimeout(tick, 60000);            // primera revisión ~1 min tras arrancar
  return setInterval(tick, 3600000);  // y luego cada hora
}

// El correo de salud: se revisa cada 5 minutos (tiene hora y minuto); sale el lunes desde
// SALUD_HORA, una vez por semana (saludEmailEstado). `lectorSentry`: el mismo
// de /fabrica (comparte su caché).
function iniciarSalud(store, { lectorSentry = crearLectorSentry() } = {}) {
  const op = saludSemanal.opcionesDesdeEnv();
  if (!op.to.length) {
    console.log('[salud-email] SALUD_TO vacío: el correo de salud de los lunes no se manda.');
    return null;
  }
  console.log(`[salud-email] correo de salud los lunes desde las ${op.hora} Chile a ${op.to.join(', ')}`
            + (correo.configurado() ? '.' : ` (en pausa: falta ${correo.FALTA_CREDENCIALES}).`));
  const tick = () => {
    const ahora = ahoraChile();
    return saludSemanal.revisar(store, { ahora, semana: lunesDeLaSemana(ahora.fecha), lectorSentry })
      .catch(e => { console.warn('[salud-email] error:', e.message); errores.reportar('salud-email', e); });
  };
  setTimeout(tick, 90000);            // primera revisión ~1,5 min tras arrancar
  return setInterval(tick, 5 * 60000); // y luego cada 5 min: sale a las 06:30, no a las 07:xx
}

// Alertas inmediatas (lib/alertas-rondas.js): horas sin rondas y pocas rondas
// en el día, a SALUD_TO. Cada 5 min.
function iniciarAlertas(store) {
  const op = alertasRondas.opcionesDesdeEnv();
  if (!op.to.length) {
    console.log('[alertas] SALUD_TO vacío: las alertas de rondas no se mandan.');
    return null;
  }
  const min = op.minRondasDia == null ? 'la mitad del promedio de cada condominio' : op.minRondasDia || 'apagado';
  console.log(`[alertas] a ${op.to.join(', ')}: sin rondas en ${op.sinRondaHoras || '(apagado)'} h; mínimo diario: ${min}.`);
  const tick = () => alertasRondas.revisar(store)
    .catch(e => { console.warn('[alertas] error:', e.message); errores.reportar('alertas', e); });
  setTimeout(tick, 120000);
  return setInterval(tick, 5 * 60000);
}

function iniciar(store, { lectorSentry } = {}) {
  iniciarRespaldo(store);
  iniciarSalud(store, { lectorSentry });
  iniciarAlertas(store);
  if (!correo.configurado()) {
    console.log(`[informe-email] faltan credenciales de Gmail (${correo.FALTA_CREDENCIALES}) — envío semanal en pausa.`);
    return null;
  }
  console.log(`[informe-email] programador activo (día ${process.env.INFORME_DIA ?? 1}, `
            + `hora ${process.env.INFORME_HORA ?? 8} Chile).`);
  const tick = () => revisar(store).catch(e => { console.warn('[informe-email] error:', e.message); errores.reportar('informe-email', e); });
  setTimeout(tick, 30000);            // primera revisión ~30s tras arrancar
  return setInterval(tick, 3600000);  // y luego cada hora
}

module.exports = { iniciar, iniciarRespaldo, iniciarSalud, iniciarAlertas, revisar, ahoraChile, lunesDeLaSemana };
