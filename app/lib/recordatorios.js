// Alarma de ronda: cada X tiempo suena una notificación en el teléfono
// designado del condominio (el de la garita) para que el guardia salga a hacer
// la ronda.
//
// El intervalo lo fija el administrador en el panel (pestaña Avisos → "Enviar
// alarma cada…") y vive en el condominio:
//   condominio.recordatorioMin    minutos entre alarmas (0 o ausente = apagada)
//   condominio.recordatorioDesde  cuándo se configuró (ancla del primer conteo)
//   condominio.recordatorioUltimo { ts, ok, total } de la última alarma
//
// El reloj cuenta desde lo último que pasó: la configuración, la alarma
// anterior o el INICIO de la última ronda del condominio. Así, si el guardia
// salió a hacer la ronda por su cuenta, la alarma no le suena encima: vuelve a
// sonar X tiempo después de que empezó. Mientras hay una ronda en curso no suena.
//
// Corre dentro del server (igual que lib/programador.js): revisa cada minuto.
// Nunca lanza: una alarma que falla no puede tumbar el servidor.

const MIN_PERMITIDO = 5;
const MAX_PERMITIDO = 24 * 60;

// Valida el intervalo que manda el panel. 0 = apagada.
function validarMinutos(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || (n !== 0 && (n < MIN_PERMITIDO || n > MAX_PERMITIDO))) {
    return { error: `El intervalo debe ser de ${MIN_PERMITIDO} minutos a 24 horas (o 0 para apagar la alarma).` };
  }
  return { minutos: n };
}

// "30 minutos", "1 hora", "1 hora y media", "2 horas", "2 horas 15 min".
function textoIntervalo(min) {
  if (!min) return 'apagada';
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  const horas = h === 1 ? '1 hora' : `${h} horas`;
  if (!resto) return horas;
  if (resto === 30) return `${horas} y media`;
  return `${horas} ${resto} min`;
}

const ms = ts => (ts ? Date.parse(ts) || 0 : 0);

// ¿Le toca alarma a este condominio en `ahora`? Puro: no toca la base.
function leToca(db, condominio, ahora = Date.now()) {
  const min = Number(condominio.recordatorioMin) || 0;
  if (!min) return false;
  const deEste = db.ejecuciones.filter(e => e.condominioId === condominio.id);
  if (deEste.some(e => e.estado === 'en_curso')) return false;
  const ultimaRonda = Math.max(0, ...deEste.map(e => ms(e.inicio)));
  const ultimoAviso = ms((condominio.recordatorioUltimo || {}).ts);
  const referencia = Math.max(ms(condominio.recordatorioDesde), ultimoAviso, ultimaRonda);
  return ahora - referencia >= min * 60000;
}

async function revisar(store, push, ahora = Date.now()) {
  const db = store.db;
  for (const condominio of db.condominios) {
    if (!leToca(db, condominio, ahora)) continue;
    // Se anota ANTES de enviar: si el envío tarda y el siguiente tick llega
    // antes de que termine, no sale una segunda alarma.
    condominio.recordatorioUltimo = { ts: new Date(ahora).toISOString(), ok: 0, total: 0 };
    store.guardar();
    try {
      const r = await push.recordar(condominio, {
        titulo: '⏰ Hora de hacer la ronda',
        cuerpo: `${condominio.nombre}: toca salir a recorrer los puntos.`,
        url: './',
        tag: `ronda-${condominio.id}`
      });
      condominio.recordatorioUltimo = { ts: condominio.recordatorioUltimo.ts, ok: r.ok, total: r.total };
      if (r.errores.length) condominio.recordatorioUltimo.error = r.errores.join(' · ');
      store.guardar();
      if (r.total) console.log(`[alarma-ronda] ${condominio.nombre}: ${r.ok}/${r.total} teléfonos`);
    } catch (e) {
      console.warn(`[alarma-ronda] ${condominio.nombre}: ${e.message}`);
    }
  }
}

function iniciar(store, push) {
  const tick = () => revisar(store, push).catch(e => console.warn('[alarma-ronda] error:', e.message));
  return setInterval(tick, 60000);
}

module.exports = { iniciar, revisar, leToca, validarMinutos, textoIntervalo, MIN_PERMITIDO, MAX_PERMITIDO };
