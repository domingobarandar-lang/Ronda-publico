// Envío del informe semanal por correo vía la API de Gmail (OAuth2, HTTPS).
//
// Se usa la API HTTP de Gmail (no SMTP) porque Railway BLOQUEA la salida
// SMTP: los puertos 465 y 587 dan "Connection timeout". La API de Gmail viaja
// por HTTPS (443), que sí está permitido, y manda el correo desde la cuenta
// real del administrador (no desde un tercero como Resend).
//
// Requiere un client OAuth2 de Google Cloud con la Gmail API habilitada y un
// refresh token generado UNA VEZ desde tu compu (ver
// scripts/obtener-refresh-token.js) — no se puede generar dentro de Railway
// porque el flujo pide abrir el navegador y autorizar a mano.
//
// Un correo puede llevar VARIOS condominios adjuntos: así el administrador
// que tiene dos recibe un solo mensaje el lunes (ver destinatarios.js).
//
// enviarCorreo() es el envío genérico: lo usa también el respaldo diario de la
// base (lib/respaldo.js), que manda el .sqlite.gz a RESPALDO_TO.
//
// Gated por env: si falta alguna credencial, queda inerte y NO rompe nada
// (útil para desplegar antes de tener el refresh token listo).
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   GMAIL_REFRESH_TOKEN
//   GMAIL_FROM       (remitente que se muestra; debe ser la cuenta dueña del
//                     refresh token — Gmail rechaza mandar "de" otra cuenta)
//   INFORME_TO       (destinatario de respaldo, para los condominios que
//                     todavía no tengan correos cargados en el panel)
const { generarInformeSemanal } = require('./informe-semanal');
const { normalizarCorreos } = require('./destinatarios');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
// Para mensajes grandes (el respaldo): el mensaje MIME va tal cual como cuerpo
// (message/rfc822), sin envolverlo en JSON. Admite hasta 35 MB por request; el
// tope práctico lo pone Gmail en 25 MB por mensaje.
const UPLOAD_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function config() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    from: process.env.GMAIL_FROM || 'Ronda <tu-cuenta@gmail.com>',
    to: process.env.INFORME_TO
  };
}

const FALTA_CREDENCIALES = 'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN';

// El destinatario ya no es global (vive en cada condominio), así que para estar
// "configurado" basta poder enviar.
function configurado() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken && c.from);
}

function nombreArchivo(datos) {
  return `Informe-Semanal-${datos.condominio}-${datos.desde}_a_${datos.hasta}.docx`
    .replace(/[^\w.\-]+/g, '-');
}

function asunto(informes) {
  const { rango, condominio } = informes[0].datos;
  return informes.length === 1
    ? `Informe semanal — ${condominio} (${rango})`
    : `Informe semanal — ${informes.length} condominios (${rango})`;
}

function texto(informes) {
  const rango = informes[0].datos.rango;
  if (informes.length === 1) {
    return `Adjunto el informe semanal de rondas de ${informes[0].datos.condominio}.\n\n`
         + `Periodo: ${rango}\n\n— Ronda`;
  }
  const lista = informes.map(i => {
    const d = i.datos;
    if (!d.rondasTotal) return `· ${d.condominio}: sin rondas cerradas esta semana`;
    const inc = d.incompletas + d.sospechosas;
    return `· ${d.condominio}: ${d.cumplimiento}% de cumplimiento`
         + (inc ? `, ${inc} incidencia${inc === 1 ? '' : 's'} que revisar` : ', sin incidencias');
  }).join('\n');
  return `Adjunto el informe semanal de rondas de tus ${informes.length} condominios.\n\n`
       + `Periodo: ${rango}\n\n${lista}\n\n— Ronda`;
}

function base64url(texto) {
  return Buffer.from(texto, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cabecera con acentos: RFC 2047 (Gmail no acepta UTF-8 crudo en el Subject).
function cabeceraUtf8(texto) {
  return `=?UTF-8?B?${Buffer.from(texto, 'utf8').toString('base64')}?=`;
}

// Parte multipart/mixed RFC 822, en base64 (formato "raw" que pide la API de
// Gmail). Sin dependencias: es más simple que armar el MIME a mano con una
// librería para un mensaje con texto plano + adjuntos .docx.
function construirMime({ from, to, subject, texto: cuerpo, adjuntos }) {
  const boundary = `ronda_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const partes = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${cabeceraUtf8(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(cuerpo, 'utf8').toString('base64'),
    ''
  ];
  for (const a of adjuntos) {
    partes.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || TIPO_DOCX}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      a.content.replace(/.{76}/g, '$&\n'),
      ''
    );
  }
  partes.push(`--${boundary}--`, '');
  return partes.join('\r\n');
}

// Access token en memoria: se pide uno nuevo solo cuando falta o ya expiró
// (dura ~1h; el refresh token en cambio no vence salvo que se revoque).
let tokenCache = null; // { accessToken, expira }

async function obtenerAccessToken(c) {
  if (tokenCache && tokenCache.expira > Date.now() + 30000) return tokenCache.accessToken;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!resp.ok) {
    let detalle = `HTTP ${resp.status}`;
    try { const j = await resp.json(); detalle = (j && (j.error_description || j.error)) || detalle; } catch (_) {}
    throw new Error(`No se pudo renovar el token de Gmail: ${detalle}`);
  }
  const j = await resp.json();
  tokenCache = { accessToken: j.access_token, expira: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.accessToken;
}

async function detalleError(resp) {
  let detalle = `HTTP ${resp.status}`;
  try { const j = await resp.json(); detalle = (j && j.error && (j.error.message || j.error.status)) || detalle; } catch (_) {}
  return detalle;
}

// Envío genérico. `adjuntos`: [{ filename, content: Buffer, contentType? }].
// `grande`: usa el endpoint de subida (para el respaldo de la base).
// No lanza nunca: devuelve { enviada, to, error? }.
async function enviarCorreo({ to, subject, texto: cuerpo, adjuntos = [], grande = false } = {}) {
  const c = config();
  const destinos = normalizarCorreos(to);
  if (!configurado() || !destinos.length) {
    return { enviada: false, to: destinos, error: `Correo no configurado (falta ${FALTA_CREDENCIALES} o destinatario).` };
  }
  try {
    const accessToken = await obtenerAccessToken(c);
    const raw = construirMime({
      from: c.from,
      to: destinos,
      subject,
      texto: cuerpo,
      adjuntos: adjuntos.map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content.toString('base64') }))
    });
    const resp = grande
      ? await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'message/rfc822' },
        body: raw
      })
      : await fetch(SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: base64url(raw) })
      });
    if (!resp.ok) return { enviada: false, to: destinos, error: `Gmail: ${await detalleError(resp)}` };
    return { enviada: true, to: destinos };
  } catch (err) {
    return { enviada: false, to: destinos, error: err.message };
  }
}

// Un correo con el .docx de cada condominio de `condominioIds` adjunto.
// `to` acepta uno o varios destinatarios; si va vacío, cae a INFORME_TO.
// No lanza nunca: devuelve { enviada, to, condominios, fallidos, error?, datos? }.
async function enviarInforme(store, { condominioIds, desde, hasta, to } = {}) {
  const c = config();
  const destinos = normalizarCorreos(to && to.length ? to : c.to);
  const ids = (condominioIds || []).filter(Boolean);

  // Un condominio con datos rotos no se lleva a los demás del mismo correo.
  const informes = [];
  const fallidos = [];
  for (const condominioId of ids) {
    try {
      informes.push(await generarInformeSemanal(store, { condominioId, desde, hasta }));
    } catch (err) {
      fallidos.push(condominioId);
    }
  }

  const base = { to: destinos, condominios: informes.map(i => i.datos.condominio), fallidos };
  if (!informes.length) {
    return { ...base, enviada: false, error: ids.length ? 'No se pudo generar ningún informe.' : 'No hay condominios que informar.' };
  }
  const datos = informes[0].datos;
  const r = await enviarCorreo({
    to: destinos,
    subject: asunto(informes),
    texto: texto(informes),
    adjuntos: informes.map(i => ({ filename: nombreArchivo(i.datos), content: i.buffer }))
  });
  return r.enviada ? { ...base, enviada: true, datos } : { ...base, enviada: false, datos, error: r.error };
}

// Un condominio, un correo (lo que usa el botón "enviar ahora" del panel).
async function enviarInformeSemanal(store, { condominioId, desde, hasta, to } = {}) {
  return enviarInforme(store, { condominioIds: [condominioId], desde, hasta, to });
}

module.exports = { configurado, enviarCorreo, enviarInforme, enviarInformeSemanal, config, construirMime, FALTA_CREDENCIALES };
