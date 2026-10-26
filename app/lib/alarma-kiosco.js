// Alarma de ronda en los teléfonos con Fully Kiosk Browser (v1.22).
//
// La alarma normal es Web Push (lib/push.js): el servidor la empuja y el
// teléfono suena aunque la app esté cerrada. Dentro de Fully eso no existe: el
// Android WebView no trae Push API ni Notification. Ahí el camino va al revés:
// la página, que en la garita queda siempre abierta, le pregunta al servidor una
// vez por minuto si toca la alarma y, si toca, la hace sonar con las funciones
// propias de Fully (interfaz JavaScript, PLUS). Ver entrega/FULLY-KIOSK.md.
//
// CUÁNDO toca no se decide acá ni en el teléfono: lo sigue decidiendo
// lib/recordatorios.js (revisar() anota cada alarma y alarmaVigente() la
// contesta). Este módulo solo lleva el registro de esos teléfonos:
//
//   db.alarmaKioscos: [{ token, condominioId, usuarioId, dispositivo, nombre,
//                        alta, visto, interfaz, sonada }]
//
//   dispositivo  fully.getDeviceId(): el mismo teléfono que vuelve a activar
//                la alarma reemplaza su registro en vez de duplicarlo
//   visto        última consulta (se anota cada pocos minutos, no en cada una)
//   interfaz     si en esa consulta la interfaz JavaScript de Fully estaba activa
//   sonada       la última alarma que el teléfono dice haber hecho sonar
//
// La credencial (token) es del TELÉFONO y del condominio, no del guardia, igual
// que una suscripción push: las sesiones vencen a la hora y media y cambian con
// el turno, y la alarma tiene que seguir sonando con la pantalla de login. El
// token solo sirve para preguntar si toca la alarma; no abre nada más.
const crypto = require('crypto');

// Un teléfono que consultó hace menos que esto está "conectado" en el panel.
const CONECTADO_MS = 5 * 60000;
// Cada cuánto se anota `visto` (el teléfono consulta cada minuto).
const ANOTAR_VISTO_MS = 2 * 60000;
// Un teléfono que no consulta en esta cantidad de días se borra del registro.
const OLVIDAR_MS = 7 * 86400000;

const TOKEN_VALIDO = /^[0-9a-f]{64}$/;

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ms = ts => (ts ? Date.parse(ts) || 0 : 0);

function crearAlarmaKiosco(store) {
  const db = store.db;
  const lista = () => (db.alarmaKioscos = db.alarmaKioscos || []);

  // Saca los teléfonos que dejaron de consultar hace días y los de condominios
  // que ya no existen. Se llama al activar (único momento en que la lista
  // crece) y al leer el panel. Devuelve cuántos sacó.
  function podar(ahora = Date.now()) {
    const antes = lista().length;
    db.alarmaKioscos = lista().filter(k => ahora - ms(k.visto || k.alta) < OLVIDAR_MS
      && db.condominios.some(c => c.id === k.condominioId));
    const sacados = antes - db.alarmaKioscos.length;
    if (sacados) store.guardar();
    return sacados;
  }

  function activar({ condominioId, usuarioId, dispositivo, nombre }, ahora = Date.now()) {
    podar(ahora);
    const id = texto(dispositivo, 64);
    if (id) db.alarmaKioscos = lista().filter(k => k.dispositivo !== id);
    const ts = new Date(ahora).toISOString();
    const registro = {
      token: crypto.randomBytes(32).toString('hex'),
      condominioId,
      usuarioId,
      dispositivo: id || null,
      nombre: texto(nombre, 60) || null,
      alta: ts,
      visto: ts,
      interfaz: true,
      sonada: null
    };
    lista().push(registro);
    store.guardar();
    return registro;
  }

  function buscar(token) {
    return TOKEN_VALIDO.test(String(token || '')) ? lista().find(k => k.token === token) || null : null;
  }

  // Solo el guardia de ese condominio puede dar de baja el teléfono.
  function desactivar(token, condominioId) {
    const registro = buscar(token);
    if (!registro || registro.condominioId !== condominioId) return false;
    db.alarmaKioscos = lista().filter(k => k !== registro);
    store.guardar();
    return true;
  }

  // La consulta de cada minuto. Devuelve el registro, o null si el token ya no
  // existe (lo dieron de baja, se olvidó o se borró la cuenta que lo activó).
  function latido(token, { interfaz, sonada } = {}, ahora = Date.now()) {
    const registro = buscar(token);
    if (!registro) return null;
    const conInterfaz = interfaz !== false;
    const ultimaSonada = typeof sonada === 'string' && ms(sonada) ? sonada.slice(0, 40) : registro.sonada;
    if (ahora - ms(registro.visto) >= ANOTAR_VISTO_MS || registro.interfaz !== conInterfaz || registro.sonada !== ultimaSonada) {
      registro.visto = new Date(ahora).toISOString();
      registro.interfaz = conInterfaz;
      registro.sonada = ultimaSonada;
      store.guardar();
    }
    return registro;
  }

  // Lo que el panel muestra de cada teléfono con Fully del condominio.
  function deCondominio(condominioId, ahora = Date.now()) {
    return lista()
      .filter(k => k.condominioId === condominioId)
      .map(k => {
        const guardia = db.usuarios.find(u => u.id === k.usuarioId);
        return {
          nombre: k.nombre || 'Teléfono con Fully',
          guardia: guardia ? guardia.nombre || guardia.usuario : null,
          visto: k.visto,
          conectado: ahora - ms(k.visto) < CONECTADO_MS,
          interfaz: k.interfaz !== false,
          sonada: k.sonada || null
        };
      });
  }

  return { activar, desactivar, latido, deCondominio, podar };
}

module.exports = { crearAlarmaKiosco, CONECTADO_MS, ANOTAR_VISTO_MS, OLVIDAR_MS };
