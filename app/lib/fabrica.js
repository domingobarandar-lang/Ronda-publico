// Fábrica: alta de condominios y de sus cuentas de administrador.
//
// Es la única parte de la app que crea condominios y usuarios con rol 'admin'.
// La usa solo la operación (José), desde /fabrica — los administradores de cada
// condominio no entran acá y, si solo reciben el informe por correo, tampoco
// necesitan entrar al panel.
//
// Este módulo es puro: recibe la base y los ayudantes (hashPin, id, codigoCorto)
// y devuelve { codigo, error } o { condominio, admin }. Nada de HTTP ni de disco,
// así se puede probar el alta sin levantar el servidor.
const { normalizarCorreos, esCorreo } = require('./destinatarios');

const USUARIO_VALIDO = /^[a-z0-9._-]{3,20}$/;
const PIN_VALIDO = /^\d{4,8}$/;
// La cuenta de fábrica puede crear condominios y cuentas: se le exige el PIN
// más largo que permite el login (el resto de las cuentas admite 4).
const PIN_FABRICA_LARGO = 8;

// "Condominio Portal Norte" -> "condominio-portal-norte". Sin tildes ni eñes,
// porque el id viaja dentro del payload de cada QR (RQR:<condominio>:...).
function idDesdeNombre(nombre, idsExistentes = []) {
  const base = String(nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // fuera tildes y diéresis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '') || 'condominio';
  const tomados = new Set(idsExistentes);
  if (!tomados.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const intento = `${base}-${n}`;
    if (!tomados.has(intento)) return intento;
  }
  return `${base}-${Date.now()}`;
}

// Código de registro que el administrador (o José) le entrega a los guardias
// para que creen su cuenta solos. Único entre condominios, para que nadie se
// confunda de condominio al tipearlo.
function nuevoCodigoRegistro(db, codigoCorto) {
  const tomados = new Set(db.condominios.map(c => c.codigoRegistro).filter(Boolean));
  for (let intento = 0; intento < 50; intento++) {
    const codigo = codigoCorto(6);
    if (!tomados.has(codigo)) return codigo;
  }
  return codigoCorto(8);
}

function validarUsuarioNuevo(db, usuario) {
  const nombreUsuario = String(usuario || '').toLowerCase().trim();
  if (!USUARIO_VALIDO.test(nombreUsuario)) {
    return { codigo: 422, error: 'Usuario inválido (3 a 20 caracteres: letras, números, punto o guión).' };
  }
  if (db.usuarios.some(u => u.usuario === nombreUsuario)) {
    return { codigo: 409, error: `El usuario "${nombreUsuario}" ya existe. Elige otro.` };
  }
  return { usuario: nombreUsuario };
}

function validarPin(pin, { largoMinimo = 4 } = {}) {
  const limpio = String(pin || '').trim();
  if (!PIN_VALIDO.test(limpio)) return { error: 'El PIN debe tener entre 4 y 8 dígitos.' };
  if (limpio.length < largoMinimo) return { error: `El PIN debe tener al menos ${largoMinimo} dígitos.` };
  return { pin: limpio };
}

function validarCorreos(valor) {
  const crudos = (Array.isArray(valor) ? valor : String(valor || '').split(/[,;\s]+/))
    .map(t => String(t || '').trim()).filter(Boolean);
  const malos = crudos.filter(t => !esCorreo(t));
  if (malos.length) return { error: `Esto no parece un correo: ${malos.join(', ')}` };
  return { correos: normalizarCorreos(crudos) };
}

// Crea la cuenta de administrador de un condominio que ya existe.
function nuevoAdmin(db, { condominioId, usuario, nombre, pin }, { hashPin, id }) {
  const u = validarUsuarioNuevo(db, usuario);
  if (u.error) return u;
  const p = validarPin(pin);
  if (p.error) return { codigo: 422, error: p.error };
  if (!db.condominios.some(c => c.id === condominioId)) {
    return { codigo: 404, error: 'El condominio no existe.' };
  }
  const admin = {
    id: id(),
    condominioId,
    usuario: u.usuario,
    nombre: String(nombre || '').trim() || u.usuario,
    rol: 'admin',
    pinHash: hashPin(p.pin)
  };
  db.usuarios.push(admin);
  return { admin, pin: p.pin };
}

// Alta de un condominio: nombre, código de registro para sus guardias y a quién
// le llega el informe semanal. Todo o nada: si algo no valida, no toca la base.
//
// La cuenta de panel es OPCIONAL y por defecto NO se crea. Desde la v1.12 un
// administrador trabaja sobre todos los condominios (selector del panel), así
// que la operación entra con SU cuenta y elige el condominio: una cuenta por
// condominio no aporta nada y cada una sería otra llave que abre todo. Se crea
// solo si algún cliente va a operar su propio panel (pasando adminUsuario+adminPin).
function altaCondominio(db, datos, deps) {
  const { hashPin, id, codigoCorto } = deps;
  const nombre = String((datos || {}).nombre || '').trim();
  if (nombre.length < 3 || nombre.length > 60) {
    return { codigo: 422, error: 'El nombre del condominio debe tener entre 3 y 60 caracteres.' };
  }
  if (db.condominios.some(c => c.nombre.toLowerCase() === nombre.toLowerCase())) {
    return { codigo: 409, error: `Ya existe un condominio llamado "${nombre}".` };
  }
  const c = validarCorreos(datos.correos);
  if (c.error) return { codigo: 422, error: c.error };

  // Se valida ANTES de tocar la base: si la cuenta pedida no sirve, no queda un
  // condominio a medias.
  const quiereCuenta = Boolean(String(datos.adminUsuario || '').trim() || String(datos.adminPin || '').trim());
  let u, p;
  if (quiereCuenta) {
    u = validarUsuarioNuevo(db, datos.adminUsuario);
    if (u.error) return u;
    p = validarPin(datos.adminPin);
    if (p.error) return { codigo: 422, error: p.error };
  }

  const condominio = {
    id: idDesdeNombre(nombre, db.condominios.map(x => x.id)),
    nombre,
    codigoRegistro: nuevoCodigoRegistro(db, codigoCorto),
    correosInforme: c.correos
  };
  db.condominios.push(condominio);

  if (!quiereCuenta) return { condominio, admin: null, pin: null };

  const admin = {
    id: id(),
    condominioId: condominio.id,
    usuario: u.usuario,
    nombre: String(datos.adminNombre || '').trim() || `Administrador ${nombre}`,
    rol: 'admin',
    pinHash: hashPin(p.pin)
  };
  db.usuarios.push(admin);

  return { condominio, admin, pin: p.pin };
}

// Cuenta de fábrica desde el entorno, al arrancar. Así no hace falta ningún
// script de alta: se ponen FABRICA_USUARIO y FABRICA_PIN en Railway y la cuenta
// queda creada en el primer arranque. Cambiar el PIN en el entorno lo actualiza.
function asegurarFabrica(db, env, { hashPin, verificarPin, id }) {
  const usuario = String(env.FABRICA_USUARIO || '').toLowerCase().trim();
  const pin = String(env.FABRICA_PIN || '').trim();
  if (!usuario || !pin) return { creada: false, motivo: 'sin configurar' };
  if (!USUARIO_VALIDO.test(usuario)) return { creada: false, motivo: 'FABRICA_USUARIO inválido' };
  const p = validarPin(pin, { largoMinimo: PIN_FABRICA_LARGO });
  if (p.error) return { creada: false, motivo: `FABRICA_PIN: ${p.error}` };

  const existente = db.usuarios.find(u => u.usuario === usuario);
  if (existente) {
    if (existente.rol !== 'fabrica') return { creada: false, motivo: `"${usuario}" ya existe con otro rol` };
    // El entorno manda: cambiar FABRICA_PIN en Railway recupera el acceso. Solo
    // se reescribe si de verdad cambió, para no escribir la base en cada boot.
    if (verificarPin(p.pin, existente.pinHash)) return { creada: false, usuario };
    existente.pinHash = hashPin(p.pin);
    return { creada: false, actualizada: true, usuario };
  }
  db.usuarios.push({
    id: id(),
    condominioId: null, // la fábrica no pertenece a ningún condominio
    usuario,
    nombre: 'Fábrica (operación)',
    rol: 'fabrica',
    pinHash: hashPin(p.pin)
  });
  return { creada: true, usuario };
}

module.exports = {
  USUARIO_VALIDO, PIN_FABRICA_LARGO,
  idDesdeNombre, nuevoCodigoRegistro, validarUsuarioNuevo, validarPin, validarCorreos,
  altaCondominio, nuevoAdmin, asegurarFabrica
};
