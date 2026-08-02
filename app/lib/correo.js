// Envío del informe semanal por correo vía Resend (API HTTP sobre HTTPS).
//
// Se usa Resend (no SMTP) porque Railway BLOQUEA la salida SMTP: los puertos
// 465 y 587 dan "Connection timeout". La API de Resend viaja por HTTPS (443),
// que sí está permitido.
//
// Un correo puede llevar VARIOS condominios adjuntos: así el administrador que
// tiene dos recibe un solo mensaje el lunes (ver destinatarios.js).
//
// Gated por env: si falta la API key, queda inerte y NO rompe nada (útil para
// desplegar antes de tener la clave).
//   RESEND_API_KEY  (obligatoria para enviar)
//   INFORME_FROM    (remitente; con el dominio de prueba de Resend solo se
//                    entrega al correo dueño de la cuenta — para escribirle a
//                    administradores externos hay que verificar un dominio)
//   INFORME_TO      (destinatario de respaldo, para los condominios que todavía
//                    no tengan correos cargados en el panel)
const { generarInformeSemanal } = require('./informe-semanal');
const { normalizarCorreos } = require('./destinatarios');

function config() {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.INFORME_FROM || 'Rondas QR <onboarding@resend.dev>',
    to: process.env.INFORME_TO
  };
}

// El destinatario ya no es global (vive en cada condominio), así que para estar
// "configurado" basta poder enviar.
function configurado() {
  const c = config();
  return Boolean(c.apiKey && c.from);
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
         + `Periodo: ${rango}\n\n— Rondas QR`;
  }
  const lista = informes.map(i => {
    const d = i.datos;
    if (!d.rondasTotal) return `· ${d.condominio}: sin rondas cerradas esta semana`;
    const inc = d.incompletas + d.sospechosas;
    return `· ${d.condominio}: ${d.cumplimiento}% de cumplimiento`
         + (inc ? `, ${inc} incidencia${inc === 1 ? '' : 's'} que revisar` : ', sin incidencias');
  }).join('\n');
  return `Adjunto el informe semanal de rondas de tus ${informes.length} condominios.\n\n`
       + `Periodo: ${rango}\n\n${lista}\n\n— Rondas QR`;
}

// Un correo con el .docx de cada condominio de `condominioIds` adjunto.
// `to` acepta uno o varios destinatarios; si va vacío, cae a INFORME_TO.
// No lanza nunca: devuelve { enviada, to, condominios, fallidos, error?, datos? }.
async function enviarInforme(db, { condominioIds, desde, hasta, to } = {}) {
  const c = config();
  const destinos = normalizarCorreos(to && to.length ? to : c.to);
  const ids = (condominioIds || []).filter(Boolean);

  // Un condominio con datos rotos no se lleva a los demás del mismo correo.
  const informes = [];
  const fallidos = [];
  for (const condominioId of ids) {
    try {
      informes.push(await generarInformeSemanal(db, { condominioId, desde, hasta }));
    } catch (err) {
      fallidos.push(condominioId);
    }
  }

  const base = { to: destinos, condominios: informes.map(i => i.datos.condominio), fallidos };
  if (!informes.length) {
    return { ...base, enviada: false, error: ids.length ? 'No se pudo generar ningún informe.' : 'No hay condominios que informar.' };
  }
  const datos = informes[0].datos;
  if (!c.apiKey || !destinos.length) {
    return { ...base, enviada: false, datos, error: 'Correo no configurado (falta RESEND_API_KEY o destinatario).' };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: c.from,
        to: destinos,
        subject: asunto(informes),
        text: texto(informes),
        attachments: informes.map(i => ({
          filename: nombreArchivo(i.datos),
          content: i.buffer.toString('base64')
        }))
      })
    });
    if (!resp.ok) {
      let detalle = `HTTP ${resp.status}`;
      try { const j = await resp.json(); detalle = (j && (j.message || j.name)) || detalle; } catch (_) {}
      return { ...base, enviada: false, datos, error: `Resend: ${detalle}` };
    }
    return { ...base, enviada: true, datos };
  } catch (err) {
    return { ...base, enviada: false, datos, error: err.message };
  }
}

// Un condominio, un correo (lo que usa el botón "enviar ahora" del panel).
async function enviarInformeSemanal(db, { condominioId, desde, hasta, to } = {}) {
  return enviarInforme(db, { condominioIds: [condominioId], desde, hasta, to });
}

module.exports = { configurado, enviarInforme, enviarInformeSemanal, config };
