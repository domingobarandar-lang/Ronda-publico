// Envío del informe semanal por correo vía Resend (API HTTP sobre HTTPS).
//
// Se usa Resend (no SMTP) porque Railway BLOQUEA la salida SMTP: los puertos
// 465 y 587 dan "Connection timeout". La API de Resend viaja por HTTPS (443),
// que sí está permitido.
//
// Gated por env: si falta la API key o el destinatario, queda inerte y NO
// rompe nada (útil para desplegar antes de tener la clave).
//   RESEND_API_KEY  (obligatoria para enviar)
//   INFORME_FROM    (remitente; por defecto "Rondas QR <onboarding@resend.dev>")
//   INFORME_TO      (destinatario)
const { generarInformeSemanal } = require('./informe-semanal');

function config() {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.INFORME_FROM || 'Rondas QR <onboarding@resend.dev>',
    to: process.env.INFORME_TO
  };
}

function configurado() {
  const c = config();
  return Boolean(c.apiKey && c.from && c.to);
}

// Genera el .docx del informe semanal y lo manda adjunto por Resend.
// No lanza nunca: devuelve { enviada, to, error?, datos? }.
async function enviarInformeSemanal(db, { condominioId, desde, hasta, to } = {}) {
  const c = config();
  const destino = to || c.to;
  try {
    const { buffer, datos } = await generarInformeSemanal(db, { condominioId, desde, hasta });
    if (!c.apiKey || !destino) {
      return { enviada: false, to: destino, error: 'Correo no configurado (falta RESEND_API_KEY o destinatario).', datos };
    }
    const nombreArchivo = `Informe-Semanal-${datos.condominio}-${datos.desde}_a_${datos.hasta}.docx`
      .replace(/[^\w.\-]+/g, '-');
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: c.from,
        to: [destino],
        subject: `Informe semanal — ${datos.condominio} (${datos.rango})`,
        text: `Adjunto el informe semanal de rondas de ${datos.condominio}.\n\n`
            + `Periodo: ${datos.rango}\n\n— Rondas QR`,
        attachments: [{ filename: nombreArchivo, content: buffer.toString('base64') }]
      })
    });
    if (!resp.ok) {
      let detalle = `HTTP ${resp.status}`;
      try { const j = await resp.json(); detalle = (j && (j.message || j.name)) || detalle; } catch (_) {}
      return { enviada: false, to: destino, error: `Resend: ${detalle}`, datos };
    }
    return { enviada: true, to: destino, datos };
  } catch (err) {
    return { enviada: false, to: destino, error: err.message };
  }
}

module.exports = { configurado, enviarInformeSemanal, config };
