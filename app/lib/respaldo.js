// Respaldo diario de la base. El plan de Railway NO incluye respaldos del
// volumen, así que lo hace la app:
//
//   1. Una foto diaria con `VACUUM INTO` en <carpeta de la base>/respaldos/
//      rondas-AAAA-MM-DD.sqlite (fecha de Chile). Es consistente aunque haya
//      escrituras en curso. Se conservan las últimas RESPALDO_CONSERVAR (14).
//   2. Una copia FUERA de Railway: la foto se comprime (gzip) y sale por correo
//      con la integración de Gmail de lib/correo.js a RESPALDO_TO, cada
//      RESPALDO_CORREO_CADA_DIAS días (1 = diario). Sin RESPALDO_TO o sin
//      credenciales de Gmail, la foto se hace igual y el log lo dice.
//
// El adjunto tiene techo: Gmail rechaza mensajes de más de 25 MB y el adjunto
// viaja en base64 (+33 %). Por eso sobre AVISO_MB se avisa (log y correo) y
// sobre MAX_MB no se adjunta: el correo sale igual, diciendo que toca pasar el
// respaldo externo a almacenamiento de objetos (R2/S3).
//
// El respaldo trae hashes de PIN, correos y GPS: RESPALDO_TO tiene que ser un
// buzón de la operación con verificación en dos pasos.
//
//   RESPALDO_TO                 destinatario(s) del correo (vacío = no se envía)
//   RESPALDO_HORA               hora de Chile desde la que se hace (por defecto 10)
//   RESPALDO_CONSERVAR          fotos que se guardan en el volumen (por defecto 14)
//   RESPALDO_CORREO_CADA_DIAS   cada cuántos días va por correo (por defecto 1)
//   RESPALDO_DIR                carpeta (por defecto <carpeta de la base>/respaldos)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const correo = require('./correo');
const { normalizarCorreos } = require('./destinatarios');
const { sumarDias } = require('./fechas-chile');

const gzip = promisify(zlib.gzip); // en el pool de hilos: no bloquea el event loop
const MB = 1024 * 1024;
const AVISO_MB = 12;
const MAX_MB = 18;
const PATRON = /^rondas-(\d{4}-\d{2}-\d{2})\.sqlite$/;

const numero = (v, porDefecto) => (v == null || v === '' || !Number.isFinite(Number(v)) ? porDefecto : Number(v));

function opcionesDesdeEnv(store, env = process.env) {
  return {
    dir: env.RESPALDO_DIR || path.join(path.dirname(store.ruta), 'respaldos'),
    hora: numero(env.RESPALDO_HORA, 10),
    conservar: Math.max(1, numero(env.RESPALDO_CONSERVAR, 14)),
    cadaDias: Math.max(1, numero(env.RESPALDO_CORREO_CADA_DIAS, 1)),
    to: normalizarCorreos(env.RESPALDO_TO)
  };
}

// Foto del día (si no está ya) y poda de las viejas. Devuelve
// { ruta, nueva, bytes, borrados }.
function fotoDelDia(store, { dir, fecha, conservar }) {
  const ruta = path.join(dir, `rondas-${fecha}.sqlite`);
  let nueva = false;
  if (!fs.existsSync(ruta)) {
    // A un temporal y después rename: una foto a medias (disco lleno, corte)
    // nunca queda con el nombre de una buena.
    const tmp = `${ruta}.tmp`;
    store.respaldar(tmp);
    fs.renameSync(tmp, ruta);
    nueva = true;
  }
  const fotos = fs.readdirSync(dir).filter(f => PATRON.test(f)).sort();
  const borrados = fotos.slice(0, Math.max(0, fotos.length - conservar));
  for (const f of borrados) fs.unlinkSync(path.join(dir, f));
  return { ruta, nueva, bytes: fs.statSync(ruta).size, borrados };
}

function textoCorreo({ fecha, conteos, bytesGz, adjunto, aviso }) {
  const lineas = [
    `Respaldo diario de la base de Rondas QR del ${fecha}.`,
    '',
    `Contenido: ${conteos.condominios} condominios, ${conteos.usuarios} usuarios, ${conteos.puntos} puntos, `
      + `${conteos.ejecuciones} rondas, ${conteos.notificaciones} avisos.`,
    `Tamaño comprimido: ${(bytesGz / MB).toFixed(1)} MB.`,
    ''
  ];
  if (aviso) lineas.push(`⚠️ ${aviso}`, '');
  lineas.push(adjunto
    ? 'Para restaurarlo: node scripts/restaurar-respaldo.js <archivo>.sqlite.gz --aplicar y reiniciar el servicio (ver entrega/OPERACION.md).'
    : 'La foto quedó en el volumen del servidor (/data/respaldos/), pero NO va adjunta por su tamaño.');
  lineas.push('', 'Trae hashes de PIN, correos y ubicaciones GPS: no lo reenvíes ni lo guardes en carpetas compartidas.', '', '— Rondas QR');
  return lineas.join('\n');
}

// Una revisión: se llama cada hora desde lib/programador.js. Idempotente en el
// día (la foto se reconoce por su nombre; el correo, por respaldoEstado).
// `ahora`: { fecha: 'AAAA-MM-DD', hora } en Chile. `forzar`: sin mirar la hora
// ni si el correo ya salió hoy (scripts/respaldo-ahora.js). Nunca lanza.
async function revisar(store, {
  ahora, forzar = false, env = process.env, enviar = correo.enviarCorreo, log = console.log,
  avisoMb = AVISO_MB, maxMb = MAX_MB
} = {}) {
  try {
    const op = opcionesDesdeEnv(store, env);
    if (!forzar && ahora.hora < op.hora) return null;
    fs.mkdirSync(op.dir, { recursive: true });
    const foto = fotoDelDia(store, { dir: op.dir, fecha: ahora.fecha, conservar: op.conservar });
    if (foto.nueva) {
      log(`[respaldo] foto del día: ${foto.ruta} (${(foto.bytes / MB).toFixed(1)} MB)`
        + (foto.borrados.length ? `; se borraron ${foto.borrados.length} viejas` : ''));
    }

    const estado = store.db.respaldoEstado || {};
    const tocaCorreo = forzar || !estado.ultimoCorreo || ahora.fecha >= sumarDias(estado.ultimoCorreo, op.cadaDias);
    if (!tocaCorreo) return { foto, correo: null };
    if (!op.to.length) {
      if (foto.nueva) log('[respaldo] RESPALDO_TO vacío: la foto queda solo en el volumen, NO sale copia fuera de Railway.');
      return { foto, correo: null };
    }
    if (!correo.configurado() && enviar === correo.enviarCorreo) {
      if (foto.nueva) log(`[respaldo] correo sin configurar (falta ${correo.FALTA_CREDENCIALES}): no sale copia fuera de Railway.`);
      return { foto, correo: null };
    }

    const gz = await gzip(fs.readFileSync(foto.ruta));
    const mb = gz.length / MB;
    const adjunto = mb <= maxMb;
    let aviso = null;
    if (!adjunto) aviso = `El respaldo comprimido pesa ${mb.toFixed(1)} MB y supera lo que Gmail acepta: no va adjunto. Hay que pasar el respaldo externo a almacenamiento de objetos (R2/S3).`;
    else if (mb >= avisoMb) aviso = `El respaldo comprimido pesa ${mb.toFixed(1)} MB: se acerca al tope de Gmail (sobre ${maxMb} MB deja de ir adjunto). Toca planificar almacenamiento de objetos (R2/S3).`;
    if (aviso) log(`[respaldo] AVISO: ${aviso}`);

    const conteos = store.conteos();
    const r = await enviar({
      to: op.to,
      subject: `${aviso ? '⚠️ ' : ''}Respaldo Rondas QR — ${ahora.fecha}`,
      texto: textoCorreo({ fecha: ahora.fecha, conteos, bytesGz: gz.length, adjunto, aviso }),
      adjuntos: adjunto ? [{ filename: `rondas-${ahora.fecha}.sqlite.gz`, content: gz, contentType: 'application/gzip' }] : [],
      grande: true
    });
    if (r.enviada) {
      store.db.respaldoEstado = { ...estado, ultimoCorreo: ahora.fecha, bytesGz: gz.length };
      store.guardar();
      log(`[respaldo] enviado a ${op.to.join(', ')} (${mb.toFixed(1)} MB${adjunto ? '' : ', sin adjunto'})`);
    } else {
      log(`[respaldo] FALLÓ el envío a ${op.to.join(', ')}: ${r.error} (se reintenta en la próxima revisión)`);
    }
    return { foto, correo: r, bytesGz: gz.length, adjunto, aviso };
  } catch (err) {
    log(`[respaldo] error: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { revisar, fotoDelDia, opcionesDesdeEnv, AVISO_MB, MAX_MB };
