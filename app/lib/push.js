// Aviso push al teléfono del administrador cuando una ronda queda INCOMPLETA
// (el guardia la cerró sin escanear todos los puntos). Complementa a
// lib/notificar.js: el informe completo sigue llegando al registro de avisos;
// esto es la alerta inmediata que suena en el teléfono aunque el panel esté
// cerrado.
//
// Sin configuración: las claves VAPID se generan solas la primera vez y quedan
// en data/db.json (fuera de git). El administrador activa los avisos con un
// botón en la pestaña Avisos del panel (requiere HTTPS o localhost).
//
// Nunca lanza: si un envío falla queda registrado y la app sigue. Las
// suscripciones muertas (HTTP 404/410: el admin borró la app o revocó el
// permiso) se limpian solas.
const webpush = require('web-push');

function crearPush(store, { enviar } = {}) {
  const db = store.db;

  function claves() {
    if (!db.vapid) {
      db.vapid = webpush.generateVAPIDKeys();
      store.guardar();
    }
    return db.vapid;
  }

  // Alta (o actualización) de la suscripción de un dispositivo. Devuelve null si viene malformada.
  function suscribir({ condominioId, usuarioId, suscripcion }) {
    const s = suscripcion || {};
    const llaves = s.keys || {};
    if (typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || !llaves.p256dh || !llaves.auth) {
      return null;
    }
    desuscribir(s.endpoint);
    const registro = {
      ts: new Date().toISOString(),
      condominioId,
      usuarioId,
      suscripcion: { endpoint: s.endpoint, keys: { p256dh: String(llaves.p256dh), auth: String(llaves.auth) } }
    };
    db.pushSuscripciones.push(registro);
    store.guardar();
    return registro;
  }

  function desuscribir(endpoint) {
    const antes = db.pushSuscripciones.length;
    db.pushSuscripciones = db.pushSuscripciones.filter(s => s.suscripcion.endpoint !== endpoint);
    if (db.pushSuscripciones.length !== antes) store.guardar();
  }

  function enviarUno(suscripcion, payload) {
    if (enviar) return enviar(suscripcion, payload); // inyectable para tests
    const { publicKey, privateKey } = claves();
    return webpush.sendNotification(suscripcion, payload, {
      TTL: 12 * 3600,
      urgency: 'high',
      vapidDetails: {
        subject: process.env.VAPID_SUBJECT || 'mailto:avisos@rondas-qr.app',
        publicKey,
        privateKey
      }
    });
  }

  // Manda el aviso a todos los dispositivos suscritos del condominio y deja
  // constancia en db.notificaciones. Devuelve el registro (null si no hay
  // ningún dispositivo suscrito).
  async function avisar(condominio, { titulo, cuerpo, url }) {
    const destinos = db.pushSuscripciones.filter(s => s.condominioId === condominio.id);
    if (!destinos.length) return null;

    const payload = JSON.stringify({ titulo, cuerpo, url });
    let ok = 0;
    const errores = [];
    for (const destino of destinos) {
      try {
        await enviarUno(destino.suscripcion, payload);
        ok++;
      } catch (err) {
        const codigo = err.statusCode || 0;
        if (codigo === 404 || codigo === 410) desuscribir(destino.suscripcion.endpoint);
        errores.push(err.message || `HTTP ${codigo}`);
      }
    }

    const registro = {
      ts: new Date().toISOString(),
      condominioId: condominio.id,
      texto: `${titulo}\n${cuerpo}`,
      medio: 'push',
      enviada: ok > 0,
      dispositivos: { ok, total: destinos.length }
    };
    if (errores.length) registro.error = errores.join(' · ');
    db.notificaciones.push(registro);
    store.guardar();
    return registro;
  }

  return { claves, suscribir, desuscribir, avisar };
}

module.exports = { crearPush };
