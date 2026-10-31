// Autenticación: usuario + PIN (hash scrypt con sal), sesiones por token Bearer.
const crypto = require('crypto');

function hashPin(pin) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), sal, 32).toString('hex');
  return `${sal}:${hash}`;
}

function verificarPin(pin, guardado) {
  const [sal, hash] = String(guardado || '').split(':');
  if (!sal || !hash) return false;
  const calculado = crypto.scryptSync(String(pin), sal, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculado, 'hex'));
}

// Cuánto vive una sesión. Hasta acá el campo `creada` se anotaba y no lo leía
// nadie: un token servía para siempre y ninguno se borraba, así que db.json
// juntaba una credencial permanente por cada login —y db.json se reescribe
// ENTERO en cada guardado—. Son las dos caras del mismo olvido: la de seguridad
// (una llave robada no caducaba nunca) y la de peso.
//
// 1:30 h desde el login o desde la última actividad de ronda (v1.25). Hasta la
// v1.24 era absoluto desde el login, y en el teléfono compartido de la garita
// eso cortaba rondas: el guardia entra para una ronda, no sale, y la siguiente
// empieza con la sesión ya gastada; a la hora y media del login el teléfono se
// queda sin sesión a mitad de recorrido y le pide el PIN. Ahora iniciar la
// ronda, marcar y cerrar la renuevan (renovarSesion, desde server.js); la
// consulta de versión de cada minuto NO, para que una sesión olvidada en un
// teléfono prendido siga venciendo sola.
const VIDA_SESION_MS = 90 * 60 * 1000;
// La renovación se anota a lo más cada 5 minutos: escribe la base, y las marcas
// llegan cada uno o dos.
const RENOVAR_CADA_MS = 5 * 60 * 1000;

function desdeCuando(sesion) {
  const creada = Date.parse(sesion && sesion.creada);
  const renovada = Date.parse(sesion && sesion.renovada);
  return Number.isNaN(renovada) ? creada : Math.max(creada, renovada);
}

function vencida(sesion, ahora = Date.now()) {
  const desde = desdeCuando(sesion);
  // Sin fecha entendible se la considera vencida: son las sesiones que quedaron
  // de antes de esta guarda, y dejarlas vivas para siempre es justo el bug.
  if (Number.isNaN(desde)) return true;
  return ahora - desde >= VIDA_SESION_MS;
}

// Devuelve true si anotó la renovación (quien llama guarda).
function renovarSesion(sesion, ahora = Date.now()) {
  if (!sesion || vencida(sesion, ahora)) return false;
  if (ahora - desdeCuando(sesion) < RENOVAR_CADA_MS) return false;
  sesion.renovada = new Date(ahora).toISOString();
  return true;
}

// Saca del mapa todo lo que ya no sirve. Se llama al crear sesión: es el único
// momento en que el mapa crece, y así la poda va al ritmo del crecimiento.
function podarSesiones(db, ahora = Date.now()) {
  let podadas = 0;
  for (const [token, sesion] of Object.entries(db.sesiones)) {
    if (vencida(sesion, ahora)) { delete db.sesiones[token]; podadas++; }
  }
  return podadas;
}

function crearSesion(db, usuario) {
  podarSesiones(db);
  const token = crypto.randomBytes(24).toString('hex');
  db.sesiones[token] = { usuarioId: usuario.id, creada: new Date().toISOString() };
  return token;
}

const TOKEN_VALIDO = /^[0-9a-f]{48}$/;

function autenticar(store) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // Solo tokens con la forma que emite crearSesion (24 bytes en hex) y solo
    // claves PROPIAS del mapa: `Bearer __proto__` encontraba el prototipo de
    // Object, lo tomaba por sesión "vencida" y reescribía db.json en cada request.
    const sesion = TOKEN_VALIDO.test(token) && Object.hasOwn(store.db.sesiones, token)
      ? store.db.sesiones[token]
      : null;
    if (!sesion) return res.status(401).json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' });
    if (vencida(sesion)) {
      delete store.db.sesiones[token];
      store.guardar();
      return res.status(401).json({ error: 'Tu sesión venció. Vuelve a entrar con tu usuario y PIN.' });
    }
    const usuario = store.db.usuarios.find(u => u.id === sesion.usuarioId);
    if (!usuario) return res.status(401).json({ error: 'El usuario ya no existe.' });
    req.usuario = usuario;
    req.token = token;
    next();
  };
}

function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo para administradores.' });
  next();
}

module.exports = {
  hashPin, verificarPin, crearSesion, autenticar, soloAdmin,
  VIDA_SESION_MS, vencida, podarSesiones, renovarSesion
};
