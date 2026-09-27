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
const correo = require('./correo');
const respaldo = require('./respaldo');
const { agruparPorDestinatario } = require('./destinatarios');

// Fecha/hora actual en Chile (maneja el cambio de horario solo).
function ahoraChile() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date());
  const val = t => (partes.find(x => x.type === t) || {}).value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hora = Number(val('hour'));
  if (hora === 24) hora = 0; // algunos runtimes devuelven '24' a medianoche
  return { fecha: `${val('year')}-${val('month')}-${val('day')}`, hora, dia: dias[val('weekday')] };
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

function iniciar(store) {
  iniciarRespaldo(store);
  if (!correo.configurado()) {
    console.log(`[informe-email] faltan credenciales de Gmail (${correo.FALTA_CREDENCIALES}) — envío semanal en pausa.`);
    return null;
  }
  console.log(`[informe-email] programador activo (día ${process.env.INFORME_DIA ?? 1}, `
            + `hora ${process.env.INFORME_HORA ?? 8} Chile).`);
  const tick = () => revisar(store).catch(e => console.warn('[informe-email] error:', e.message));
  setTimeout(tick, 30000);            // primera revisión ~30s tras arrancar
  return setInterval(tick, 3600000);  // y luego cada hora
}

module.exports = { iniciar, iniciarRespaldo, revisar, ahoraChile, lunesDeLaSemana };
