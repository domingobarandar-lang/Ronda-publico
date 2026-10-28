// Códigos de punto de control.
// Cada punto tiene un código corto de 6 caracteres (sin 0/O/1/I para que se
// pueda tipear sin ambigüedad) y un payload de QR: RQR:<condominio>:<punto>:<código>.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codigoCorto(largo = 6) {
  const bytes = crypto.randomBytes(largo);
  let s = '';
  for (let i = 0; i < largo; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

function id() {
  return crypto.randomUUID();
}

function payloadQR(punto) {
  return `RQR:${punto.condominioId}:${punto.id}:${punto.codigoCorto}`;
}

// Acepta el payload completo de un QR o el código corto tipeado a mano.
function interpretarCodigo(texto) {
  const limpio = String(texto || '').trim();
  if (limpio.toUpperCase().startsWith('RQR:')) {
    const partes = limpio.split(':');
    if (partes.length !== 4 || !partes[1] || !partes[2] || !partes[3]) return null;
    return { tipo: 'qr', condominioId: partes[1], puntoId: partes[2], codigoCorto: partes[3].toUpperCase() };
  }
  if (/^[A-Za-z0-9]{4,10}$/.test(limpio)) {
    return { tipo: 'manual', codigoCorto: limpio.toUpperCase() };
  }
  return null;
}

// Número de serie de fábrica de una chapita NFC (el UID del tag). Web NFC lo
// entrega como bytes en hexadecimal separados por ":" ("04:a2:3b:…"); acá se
// guarda en mayúsculas y sin separadores, para comparar sin depender de cómo lo
// escribió cada navegador. Un NTAG213 tiene 7 bytes (14 caracteres); se acepta
// de 4 a 10 bytes, que es lo que existe en tags NFC. null = no es una serie.
function normalizarSerie(texto) {
  const limpio = String(texto == null ? '' : texto).replace(/[\s:-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,20}$/.test(limpio) && limpio.length % 2 === 0 ? limpio : null;
}

// Huella de la serie (SHA-256 en hexadecimal) para el paquete del guardia: con
// ella la app valida la chapita sin señal y la serie no queda guardada en el
// teléfono. Ojo: es una traba, no un secreto — una serie tiene pocos bits y
// quien quiera puede leerla igual de la chapita con cualquier teléfono.
function huellaSerie(serie) {
  return serie ? crypto.createHash('sha256').update(String(serie)).digest('hex') : null;
}

module.exports = { ALFABETO, codigoCorto, id, payloadQR, interpretarCodigo, normalizarSerie, huellaSerie };
