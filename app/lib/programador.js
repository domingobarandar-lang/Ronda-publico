// Programador del envío semanal del informe por correo.
//
// Corre dentro del server web (el servicio de Railway está siempre encendido).
// Revisa cada hora: si es el día/hora configurados (hora de Chile) y no se
// envió esta semana, genera y manda el informe de la SEMANA ANTERIOR a cada
// condominio configurado. Guarda en la base la semana ya enviada para no
// repetir aunque el servidor se reinicie.
//   INFORME_DIA         (0=dom .. 6=sáb; por defecto 1 = lunes)
//   INFORME_HORA        (0-23, hora de Chile; por defecto 8)
//   INFORME_CONDOMINIOS (ids separados por coma; por defecto, todos)
const correo = require('./correo');

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

function condominiosObjetivo(db) {
  const ids = String(process.env.INFORME_CONDOMINIOS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : db.condominios.map(c => c.id);
}

async function revisar(store) {
  if (!correo.configurado()) return;
  const dia = Number(process.env.INFORME_DIA ?? 1);
  const hora = Number(process.env.INFORME_HORA ?? 8);
  const ahora = ahoraChile();
  if (ahora.dia !== dia || ahora.hora < hora) return;

  const db = store.db;
  db.informeEmailEstado = db.informeEmailEstado || {};
  const semana = lunesDeLaSemana(ahora.fecha);
  for (const condominioId of condominiosObjetivo(db)) {
    if (!db.condominios.some(c => c.id === condominioId)) continue;
    if (db.informeEmailEstado[condominioId] === semana) continue; // ya enviado esta semana
    const r = await correo.enviarInformeSemanal(db, { condominioId });
    if (r.enviada) {
      db.informeEmailEstado[condominioId] = semana;
      store.guardar();
      console.log(`[informe-email] enviado ${condominioId} -> ${r.to} (${r.datos.rango})`);
    } else {
      console.warn(`[informe-email] FALLÓ ${condominioId}: ${r.error}`);
    }
  }
}

function iniciar(store) {
  if (!correo.configurado()) {
    console.log('[informe-email] SMTP no configurado — envío semanal en pausa.');
    return null;
  }
  console.log(`[informe-email] programador activo (día ${process.env.INFORME_DIA ?? 1}, `
            + `hora ${process.env.INFORME_HORA ?? 8} Chile).`);
  const tick = () => revisar(store).catch(e => console.warn('[informe-email] error:', e.message));
  setTimeout(tick, 30000);            // primera revisión ~30s tras arrancar
  return setInterval(tick, 3600000);  // y luego cada hora
}

module.exports = { iniciar, revisar, ahoraChile, lunesDeLaSemana };
