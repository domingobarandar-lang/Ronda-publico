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
//
// Desde v1.22 la alarma tiene dos caminos de salida. Web Push (lib/push.js) la
// empuja a los teléfonos suscritos. Los teléfonos con Fully Kiosk no pueden
// recibir push: preguntan cada minuto (lib/alarma-kiosco.js) y alarmaVigente()
// les contesta con lo que revisar() ya anotó. El reloj de intervalos es uno
// solo, el de acá.
//
// Desde v1.26 la alarma que tocaba y no sonó porque había una ronda en curso
// queda anotada (retenidaPorRonda): no es un error, pero una ronda colgada en
// curso calla la alarma de todo el condominio, y eso se mira en /fabrica
// (lib/salud.js).

const errores = require('./errores');
const { ALARMA_RETENIDA } = require('./salud');

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

// Cuánto queda en pie la alarma de prueba del panel para los teléfonos con
// Fully, que la ven recién en su próxima consulta (una por minuto).
const PRUEBA_VIGENTE_MS = 10 * 60000;

// Lo que dice la alarma: lo mismo por Web Push y en Fully.
function textoAlarma(condominio, { prueba = false } = {}) {
  return {
    titulo: prueba ? '⏰ Prueba de alarma de ronda' : '⏰ Hora de hacer la ronda',
    cuerpo: prueba
      ? `${condominio.nombre}: así sonará el aviso de hacer la ronda.`
      : `${condominio.nombre}: toca salir a recorrer los puntos.`,
    url: './',
    tag: `ronda-${condominio.id}`
  };
}

// Desde cuándo cuenta el reloj: la configuración, la alarma anterior o el
// inicio de la última ronda, lo que haya pasado último.
function referencia(store, condominio) {
  const ultima = store.ejecuciones.ultimaDe(condominio.id);
  const ultimaRonda = ultima ? ms(ultima.inicio) : 0;
  const ultimoAviso = ms((condominio.recordatorioUltimo || {}).ts);
  return Math.max(ms(condominio.recordatorioDesde), ultimoAviso, ultimaRonda);
}

const rondaEnCurso = (store, condominio) =>
  store.ejecuciones.listar({ condominioId: condominio.id, estado: 'en_curso', limite: 1 })[0] || null;

// ¿Le toca alarma a este condominio en `ahora`? Solo lee la base: dos
// consultas por índice (¿hay una en curso? ¿cuándo empezó la última?).
function leToca(store, condominio, ahora = Date.now()) {
  const min = Number(condominio.recordatorioMin) || 0;
  if (!min) return false;
  if (rondaEnCurso(store, condominio)) return false;
  return ahora - referencia(store, condominio) >= min * 60000;
}

// La alarma que tocaba en `ahora` y no suena porque hay una ronda en curso:
// devuelve esa ronda, o null. Es el reloj de leToca sin la guarda de la ronda
// en curso, y cuenta también desde la última retenida: así una ronda que queda
// abierta horas suma una por intervalo, no una por minuto.
function retenidaPorRonda(store, condominio, ahora = Date.now()) {
  const min = Number(condominio.recordatorioMin) || 0;
  if (!min) return null;
  const abierta = rondaEnCurso(store, condominio);
  if (!abierta) return null;
  const retenida = store.salud.ultimo(condominio.id, ALARMA_RETENIDA);
  const desde = Math.max(referencia(store, condominio), retenida ? ms(retenida.ts) : 0);
  return ahora - desde >= min * 60000 ? abierta : null;
}

// Anotarla nunca frena la revisión de los demás condominios.
function anotarRetenida(store, condominio, ahora) {
  try {
    const abierta = retenidaPorRonda(store, condominio, ahora);
    if (!abierta) return;
    store.salud.anotar({ condominioId: condominio.id, tipo: ALARMA_RETENIDA, ts: new Date(ahora).toISOString(), ejecucionId: abierta.id });
  } catch (e) {
    errores.reportar('salud', e);
  }
}

// La alarma que un teléfono con Fully tiene que hacer sonar ahora, o null.
// No hay un segundo reloj: sale de lo que anotó revisar() (recordatorioUltimo)
// y de la prueba del panel (alarmaPrueba).
//
// La programada sigue en pie mientras nadie haya salido a la ronda desde que
// sonó y no se haya cumplido el intervalo (para entonces revisar() anotó otra,
// o ya no toca). Así un teléfono que estuvo sin señal o con la pantalla apagada
// la hace sonar al volver, pero no una que ya atendieron desde otro teléfono ni
// una anterior a la última configuración (guardar el intervalo reinicia el
// conteo, ver PUT /api/admin/alarma-ronda).
//
// `ts` es la identidad de la alarma: el teléfono no repite una que ya sonó.
// Si hay dos en pie (la programada y una prueba), va la más nueva.
function alarmaVigente(store, condominio, ahora = Date.now()) {
  const enPie = [];
  const min = Number(condominio.recordatorioMin) || 0;
  const ultima = (condominio.recordatorioUltimo || {}).ts;
  const t = ms(ultima);
  if (min && t && t >= ms(condominio.recordatorioDesde) && ahora - t < min * 60000) {
    const enCurso = store.ejecuciones.listar({ condominioId: condominio.id, estado: 'en_curso', limite: 1 }).length;
    const ronda = store.ejecuciones.ultimaDe(condominio.id);
    if (!enCurso && !(ronda && ms(ronda.inicio) >= t)) enPie.push({ ts: ultima, prueba: false });
  }
  const prueba = (condominio.alarmaPrueba || {}).ts;
  if (prueba && ahora - ms(prueba) < PRUEBA_VIGENTE_MS) enPie.push({ ts: prueba, prueba: true });
  if (!enPie.length) return null;
  const elegida = enPie.reduce((a, b) => (ms(b.ts) > ms(a.ts) ? b : a));
  const { titulo, cuerpo } = textoAlarma(condominio, elegida);
  return { ts: elegida.ts, prueba: elegida.prueba, titulo, cuerpo };
}

async function revisar(store, push, ahora = Date.now()) {
  const db = store.db;
  for (const condominio of db.condominios) {
    if (!leToca(store, condominio, ahora)) {
      anotarRetenida(store, condominio, ahora);
      continue;
    }
    // Se anota ANTES de enviar: si el envío tarda y el siguiente tick llega
    // antes de que termine, no sale una segunda alarma.
    condominio.recordatorioUltimo = { ts: new Date(ahora).toISOString(), ok: 0, total: 0 };
    store.guardar();
    try {
      // Los teléfonos con Fully no cuentan acá: la ven en su próxima consulta.
      const r = await push.recordar(condominio, textoAlarma(condominio));
      condominio.recordatorioUltimo = { ts: condominio.recordatorioUltimo.ts, ok: r.ok, total: r.total };
      if (r.errores.length) condominio.recordatorioUltimo.error = r.errores.join(' · ');
      store.guardar();
      if (r.total) console.log(`[alarma-ronda] ${condominio.nombre}: ${r.ok}/${r.total} teléfonos`);
    } catch (e) {
      console.warn(`[alarma-ronda] ${condominio.nombre}: ${e.message}`);
      errores.reportar('alarma-ronda', e);
    }
  }
}

function iniciar(store, push) {
  const tick = () => revisar(store, push).catch(e => { console.warn('[alarma-ronda] error:', e.message); errores.reportar('alarma-ronda', e); });
  return setInterval(tick, 60000);
}

module.exports = {
  iniciar, revisar, leToca, retenidaPorRonda, alarmaVigente, textoAlarma, validarMinutos, textoIntervalo,
  MIN_PERMITIDO, MAX_PERMITIDO, PRUEBA_VIGENTE_MS
};
