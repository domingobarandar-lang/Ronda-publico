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
// 1:30 h es vencimiento ABSOLUTO desde el login, no por inactividad: una ronda
// que pase de esa hora y media va a pedir el PIN de nuevo a mitad de recorrido.
// La cola del teléfono se conserva y se envía al volver a entrar (ver el manejo
// de 401 en public/app.js), así que no se pierde ninguna marca; el costo es que
// el guardia tiene que teclear.
const VIDA_SESION_MS = 90 * 60 * 1000;

function vencida(sesion, ahora = Date.now()) {
  const creada = Date.parse(sesion && sesion.creada);
  // Sin fecha entendible se la considera vencida: son las sesiones que quedaron
  // de antes de esta guarda, y dejarlas vivas para siempre es justo el bug.
  if (Number.isNaN(creada)) return true;
  return ahora - creada >= VIDA_SESION_MS;
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

function autenticar(store) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sesion = token && store.db.sesiones[token];
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
  VIDA_SESION_MS, vencida, podarSesiones
};
