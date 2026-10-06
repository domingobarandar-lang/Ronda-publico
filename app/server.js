// Rondas QR — servidor: API + las dos apps (guardia en / y panel en /panel).
// Arranque: `npm run demo` (siembra datos de prueba si no hay) o `npm start`.
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { cargarEnv } = require('./lib/env');
const { crearStore } = require('./lib/store');
const { hashPin, verificarPin, crearSesion, autenticar, soloAdmin } = require('./lib/auth');
const { codigoCorto, id, payloadQR } = require('./lib/codigos');
const motor = require('./lib/rondas');
const { armarInforme, informeTexto } = require('./lib/informes');
const { generarInformeSemanal } = require('./lib/informe-semanal');
const correo = require('./lib/correo');
const { normalizarCorreos, correosDelCondominio, esCorreo } = require('./lib/destinatarios');
const fabrica = require('./lib/fabrica');
const programador = require('./lib/programador');
const { registrarAviso } = require('./lib/notificar');
const { esFecha, sumarDias, inicioDiaChile } = require('./lib/fechas-chile');
const { crearPush } = require('./lib/push');
const recordatorios = require('./lib/recordatorios');
const cuenta = require('./lib/cuenta');

cargarEnv(__dirname);

// La versión que sirve este servidor. La app del guardia la compara con la
// suya (VERSION_APP en public/app.js) y se recarga sola si no coinciden.
const VERSION_SERVIDOR = 'v' + require('./package.json').version;

function crearApp({ rutaDb, enviarPush } = {}) {
  // DB_PATH: en producción (Railway/VPS) apunta al volumen persistente.
  const store = crearStore(rutaDb || process.env.DB_PATH);
  const db = store.db;
  const push = crearPush(store, { enviar: enviarPush });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/vendor/jsqr.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
  // Dirección corta para el acceso del administrador: es la que se dicta por
  // teléfono y la que el administrador guarda. La app instalada arranca en
  // /admin.html (start_url del panel.webmanifest), así que acá solo se redirige.
  app.get('/panel', (req, res) => res.redirect(302, '/admin.html'));
  // Pantalla de la operación (alta de condominios). No se enlaza desde ninguna
  // parte de la app: se entra por esta dirección y detrás hay login con rol.
  app.get('/fabrica', (req, res) => res.redirect(302, '/fabrica.html'));

  const auth = autenticar(store);
  const admin = [auth, soloAdmin];

  // Express 4 NO atrapa el rechazo de un handler `async`: se vuelve un
  // unhandledRejection y Node mata el proceso. No es un 500 con log feo, es el
  // servicio caído para todos — y como la cola del teléfono reintenta sola,
  // un solo evento malo lo tumba otra vez apenas se levanta.
  //
  // `alerta()` envuelve los handlers asíncronos para que cualquier error termine
  // en el middleware de abajo, y el middleware es la red por si algún día entra
  // un handler sin envolver.
  const alerta = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Sobre qué condominio trabaja esta petición.
  //
  // El GUARDIA queda siempre amarrado al suyo, pase lo que pase en la cabecera:
  // su paquete de rondas lleva los payloads de los QR, así que dejarlo pedir
  // otro condominio sería entregarle los códigos del vecino. Ese aislamiento es
  // el que sostiene el antifraude y no se toca.
  //
  // El ADMINISTRADOR también queda en el suyo. La v1.12 dejó que cualquier
  // admin se parara en cualquier condominio con la cabecera; eso se revirtió:
  // un cliente con panel propio veía los informes, guardias y códigos de
  // registro de todos los demás.
  //
  // La única excepción es la cuenta con `accesoTotal` (la de la operación), que
  // sigue recorriendo condominio por condominio con el selector del panel. Esa
  // marca solo la pone el arranque desde el entorno (ADMIN_TOTAL_*, ver
  // fabrica.asegurarAccesoTotal); ninguna pantalla ni endpoint la escribe.
  // Una cabecera con un condominio que no existe cae al de la cuenta.
  const miCondominio = req => {
    if (req.usuario.rol !== 'admin' || !req.usuario.accesoTotal) return req.usuario.condominioId;
    const pedido = String(req.headers['x-condominio'] || '').trim();
    if (pedido && db.condominios.some(c => c.id === pedido)) return pedido;
    return req.usuario.condominioId;
  };

  // Rol 'fabrica': el único que crea condominios y cuentas de administrador.
  // No pertenece a ningún condominio, así que NO pasa por soloAdmin y no puede
  // tocar los datos de nadie (informes, puntos, rondas, guardias).
  function soloFabrica(req, res, next) {
    if (req.usuario.rol !== 'fabrica') return res.status(403).json({ error: 'Solo para la fábrica.' });
    next();
  }
  const deFabrica = [auth, soloFabrica];
  const ayudantes = { hashPin, verificarPin, id, codigoCorto };

  // La cuenta de fábrica se crea (o se recupera) desde el entorno al arrancar:
  // FABRICA_USUARIO + FABRICA_PIN. Sin script de alta y sin PIN escrito en git.
  const estadoFabrica = fabrica.asegurarFabrica(db, process.env, ayudantes);
  if (estadoFabrica.creada || estadoFabrica.actualizada) store.guardar();
  // Se dice en voz alta: si el PIN no cumple (8 dígitos) o el usuario es
  // inválido, la cuenta no se crea, y sin este aviso el síntoma sería un login
  // que rechaza credenciales "correctas" sin explicar nada.
  if (estadoFabrica.creada) console.log(`[fabrica] cuenta "${estadoFabrica.usuario}" creada desde el entorno.`);
  else if (estadoFabrica.actualizada) console.log(`[fabrica] PIN de "${estadoFabrica.usuario}" actualizado desde el entorno.`);
  else if (estadoFabrica.motivo && estadoFabrica.motivo !== 'sin configurar') {
    console.warn(`[fabrica] la cuenta de fábrica NO quedó disponible — ${estadoFabrica.motivo}`);
  }

  // La cuenta de panel con acceso total, igual: ADMIN_TOTAL_USUARIO/NOMBRE/PIN/
  // CONDOMINIO. Es la ÚNICA forma de marcar `accesoTotal`.
  const estadoTotal = fabrica.asegurarAccesoTotal(db, process.env, ayudantes);
  if (estadoTotal.creada || estadoTotal.actualizada) store.guardar();
  if (estadoTotal.creada) {
    console.log(`[panel] cuenta de acceso total "${estadoTotal.usuario}" creada desde el entorno (condominio "${estadoTotal.condominioId}").`);
    if (estadoTotal.avisoCasa) console.warn(`[panel] ADMIN_TOTAL_CONDOMINIO: ${estadoTotal.avisoCasa}`);
  } else if (estadoTotal.actualizada) {
    console.log(`[panel] cuenta de acceso total "${estadoTotal.usuario}" actualizada desde el entorno (${estadoTotal.cambios.join(', ')}).`);
  } else if (estadoTotal.motivo && estadoTotal.motivo !== 'sin configurar') {
    console.warn(`[panel] la cuenta de acceso total NO quedó disponible — ${estadoTotal.motivo}`);
  }

  // Alta de un guardia con validación de usuario/PIN. Compartido por el panel
  // del administrador y el registro público (autoservicio del guardia).
  // Devuelve { error, codigo } si no valida, o { guardia } si lo crea.
  function nuevoGuardia({ condominioId, usuario, nombre, pin }) {
    const nombreUsuario = String(usuario || '').toLowerCase().trim();
    if (!/^[a-z0-9._-]{3,20}$/.test(nombreUsuario)) {
      return { codigo: 422, error: 'Usuario inválido (3 a 20 caracteres: letras, números, punto o guión).' };
    }
    if (!/^\d{4,8}$/.test(String(pin || ''))) {
      return { codigo: 422, error: 'El PIN debe tener entre 4 y 8 dígitos.' };
    }
    if (db.usuarios.some(u => u.usuario === nombreUsuario)) {
      return { codigo: 409, error: 'Ese usuario ya existe. Elige otro.' };
    }
    const guardia = {
      id: id(),
      condominioId,
      usuario: nombreUsuario,
      nombre: String(nombre || '').trim() || nombreUsuario,
      rol: 'guardia',
      pinHash: hashPin(pin)
    };
    db.usuarios.push(guardia);
    return { guardia };
  }

  // ---------- Sesión ----------

  // Límite de intentos de login. El PIN del guardia es de 4 a 8 dígitos y la app
  // está en internet: sin esto, probar 10.000 PIN de 4 dígitos es cuestión de
  // minutos. Se cuenta por usuario + IP; 5 fallos seguidos bloquean 15 minutos y
  // un acierto limpia la cuenta. Vive en memoria: un redespliegue lo reinicia
  // (para fuerza bruta sostenida haría falta llevarlo a la base). La misma
  // mecánica cuenta los códigos de registro erróneos (/api/registro).
  const MAX_INTENTOS = 5;
  const BLOQUEO_MS = 15 * 60 * 1000;
  const intentos = new Map();

  function estadoIntentos(clave) {
    const registro = intentos.get(clave);
    if (!registro) return null;
    if (registro.hasta && registro.hasta <= Date.now()) { intentos.delete(clave); return null; }
    return registro;
  }

  function anotarFallo(clave) {
    const registro = estadoIntentos(clave) || { fallos: 0, hasta: 0 };
    registro.fallos++;
    if (registro.fallos >= MAX_INTENTOS) registro.hasta = Date.now() + BLOQUEO_MS;
    intentos.set(clave, registro);
    // Poda barata para que el mapa no crezca sin límite con IPs al azar.
    if (intentos.size > 5000) {
      for (const [k, v] of intentos) if (!v.hasta || v.hasta <= Date.now()) intentos.delete(k);
    }
  }

  // Si la clave está bloqueada, responde el 429 y devuelve true.
  function rechazarSiBloqueado(res, clave) {
    const bloqueo = estadoIntentos(clave);
    if (!bloqueo || !bloqueo.hasta) return false;
    const minutos = Math.max(1, Math.ceil((bloqueo.hasta - Date.now()) / 60000));
    res.status(429).json({ error: `Demasiados intentos fallidos. Espera ${minutos} minuto(s) y vuelve a probar.` });
    return true;
  }
  // Login y eliminación de cuenta comparten la clave: si no, borrar la cuenta
  // sería otra puerta para probar PIN sin pasar por el tope del login.
  const claveIntentos = (req, usuario) => `${req.ip}|${String(usuario || '').toLowerCase().trim()}`;

  app.post('/api/login', (req, res) => {
    const { usuario, pin } = req.body || {};
    const nombreUsuario = String(usuario || '').toLowerCase().trim();
    const clave = claveIntentos(req, nombreUsuario);
    if (rechazarSiBloqueado(res, clave)) return;
    const u = db.usuarios.find(x => x.usuario === nombreUsuario);
    if (!u || !verificarPin(pin, u.pinHash)) {
      anotarFallo(clave);
      return res.status(401).json({ error: 'Usuario o PIN incorrectos.' });
    }
    intentos.delete(clave);
    const token = crearSesion(db, u);
    store.guardar();
    const condominio = db.condominios.find(c => c.id === u.condominioId) || {};
    res.json({
      token,
      rol: u.rol,
      nombre: u.nombre,
      usuario: u.usuario,
      condominio: { id: condominio.id, nombre: condominio.nombre }
    });
  });

  app.post('/api/logout', auth, (req, res) => {
    delete db.sesiones[req.token];
    store.guardar();
    res.json({ ok: true });
  });

  // ---------- Registro de guardias (autoservicio, sin administrador) ----------
  // El guardia crea su propia cuenta desde la app: elige su condominio de la
  // lista y define usuario + PIN. Queda guardado en la base como cualquier otro.

  app.get('/api/condominios', (req, res) => {
    res.json(db.condominios.map(c => ({ id: c.id, nombre: c.nombre })));
  });

  app.post('/api/registro', (req, res) => {
    const { condominioId, usuario, nombre, pin, codigo } = req.body || {};
    const condominio = db.condominios.find(c => c.id === condominioId);
    if (!condominio) return res.status(422).json({ error: 'Elige tu condominio de la lista.' });
    // El código de registro es corto: sin tope se adivina probando. 5 códigos
    // malos por condominio + IP bloquean 15 minutos (misma mecánica que el
    // login, con otra clave). Ojo: detrás del proxy de Railway `req.ip` es el
    // mismo para todos, así que en la práctica bloquea el registro de ESE
    // condominio para todos durante 15 minutos. Es aceptado: registrarse es
    // raro y esperar cuesta poco frente a regalar el código.
    const claveRegistro = `registro|${req.ip}|${condominio.id}`;
    const bloqueo = estadoIntentos(claveRegistro);
    if (bloqueo && bloqueo.hasta) {
      const minutos = Math.max(1, Math.ceil((bloqueo.hasta - Date.now()) / 60000));
      return res.status(429).json({ error: `Demasiados códigos incorrectos para este condominio. Espera ${minutos} minuto(s) y vuelve a probar con el código que te dio tu administrador.` });
    }
    // El código del condominio verifica que quien se registra es un guardia real:
    // lo entrega el administrador. Se compara sin distinguir mayúsculas/espacios.
    const codigoDado = String(codigo || '').trim().toUpperCase();
    if (!condominio.codigoRegistro) {
      return res.status(403).json({ error: 'Este condominio todavía no permite crear cuentas. Pídele el código a tu administrador.' });
    }
    if (codigoDado !== condominio.codigoRegistro) {
      anotarFallo(claveRegistro);
      return res.status(403).json({ error: 'El código del condominio no es correcto. Pídeselo a tu administrador.' });
    }
    intentos.delete(claveRegistro);
    const r = nuevoGuardia({ condominioId: condominio.id, usuario, nombre, pin });
    if (r.error) return res.status(r.codigo).json({ error: r.error });
    store.guardar();
    res.status(201).json({ id: r.guardia.id, usuario: r.guardia.usuario, nombre: r.guardia.nombre });
  });

  // ---------- Eliminación de la cuenta del guardia (CU-25) ----------
  // Requisito de Google Play para cuentas creadas dentro de la app: borrarla
  // desde la app (DELETE /api/mi/cuenta) y desde una página web pública sin la
  // app (POST /api/cuenta/eliminar, la usa public/eliminar-cuenta.html). Las
  // dos piden el PIN y cuentan los fallos con la MISMA clave que el login.
  // Qué se borra y qué se conserva: ver lib/cuenta.js.
  //
  // Ronda en curso: se cierra con el cierre normal (queda en el informe y
  // avisa al administrador) en vez de rechazar el borrado. La página pública
  // es justamente para quien ya no tiene el teléfono, y no podría cerrarla de
  // otra forma. La app del guardia, además, no deja borrar con una ronda
  // abierta o marcas sin enviar: esas marcas solo existen en el teléfono.
  //
  // El administrador que borra un guardia desde el panel pasa por lo mismo: la
  // página pública le dice al guardia sin usuario ni PIN que se lo pida a él.
  async function borrarCuentaGuardia(guardia, { porAdmin = false } = {}) {
    const r = cuenta.eliminarGuardia(store, guardia);
    for (const ejecucion of r.enCurso) {
      await cerrarYNotificar(ejecucion, {
        nota: porAdmin ? '(cerrada al eliminar el administrador al guardia)' : '(cerrada al eliminar el guardia su cuenta)'
      });
    }
    console.log(`[cuenta] guardia eliminado ${porAdmin ? 'por el administrador' : 'a pedido propio'} (condominio "${guardia.condominioId}"): `
      + `${r.anonimizadas} ronda(s) anonimizada(s), ${r.enCurso.length} cerrada(s), ${r.avisos} aviso(s) reescrito(s)`);
    return { ok: true, rondasAnonimizadas: r.anonimizadas, rondasCerradas: r.enCurso.length };
  }

  const SOLO_GUARDIAS = 'Solo las cuentas de guardia se eliminan por acá. Las cuentas de administrador las maneja la operación: escribe al contacto de privacidad.';

  app.delete('/api/mi/cuenta', auth, alerta(async (req, res) => {
    if (req.usuario.rol !== 'guardia') return res.status(403).json({ error: SOLO_GUARDIAS });
    const clave = claveIntentos(req, req.usuario.usuario);
    if (rechazarSiBloqueado(res, clave)) return;
    if (!verificarPin((req.body || {}).pin, req.usuario.pinHash)) {
      anotarFallo(clave);
      return res.status(401).json({ error: 'El PIN no es correcto.' });
    }
    intentos.delete(clave);
    res.json(await borrarCuentaGuardia(req.usuario));
  }));

  app.post('/api/cuenta/eliminar', alerta(async (req, res) => {
    const { usuario, pin } = req.body || {};
    const clave = claveIntentos(req, usuario);
    if (rechazarSiBloqueado(res, clave)) return;
    const nombreUsuario = String(usuario || '').toLowerCase().trim();
    const u = db.usuarios.find(x => x.usuario === nombreUsuario);
    // Mismo mensaje que el login para usuario inexistente o PIN malo: la página
    // es pública y no puede servir para averiguar qué usuarios existen.
    if (!u || !verificarPin(pin, u.pinHash)) {
      anotarFallo(clave);
      return res.status(401).json({ error: 'Usuario o PIN incorrectos.' });
    }
    intentos.delete(clave);
    if (u.rol !== 'guardia') return res.status(403).json({ error: SOLO_GUARDIAS });
    res.json(await borrarCuentaGuardia(u));
  }));

  // Contacto para pedir la eliminación sin usuario o sin PIN: un correo o un
  // teléfono (+56…). Viene del entorno (CONTACTO_PRIVACIDAD) para no dejarlo
  // escrito en la página. Lo que no sea ninguno de los dos no se muestra.
  app.get('/api/cuenta/contacto', (req, res) => {
    const contacto = String(process.env.CONTACTO_PRIVACIDAD || '').trim();
    const digitos = contacto.replace(/[\s().-]/g, '');
    res.json({
      correo: esCorreo(contacto) ? contacto : null,
      telefono: /^\+?\d{8,15}$/.test(digitos) ? digitos : null
    });
  });

  // ---------- Versión: actualización remota de la app del guardia ----------
  // El teléfono de la garita corre en modo kiosco y nadie lo recarga a mano:
  // la app pregunta cada minuto qué versión sirve el servidor y, si no es la
  // suya, se recarga cuando no hay ronda en curso. Sin sesión (pantalla de
  // login) pregunta por GET; con sesión, además avisa qué versión corre, y eso
  // es lo que el panel muestra por guardia: la constancia de que el deploy llegó.
  app.get('/api/version', (req, res) => res.json({ version: VERSION_SERVIDOR }));

  app.post('/api/mi/version', auth, (req, res) => {
    const version = String((req.body || {}).version || '').slice(0, 20);
    const u = req.usuario;
    const ahora = Date.now();
    // Llega una vez por minuto por teléfono: solo se escribe si cambió la
    // versión o si la última vez que se vio tiene más de 10 minutos.
    if (version && (u.appVersion !== version || !u.appVista || ahora - Date.parse(u.appVista) > 10 * 60 * 1000)) {
      u.appVersion = version;
      u.appVista = new Date(ahora).toISOString();
      store.guardar();
    }
    res.json({ version: VERSION_SERVIDOR });
  });

  // ---------- Guardia: paquete de rondas descargable ----------

  app.get('/api/mi/paquete', auth, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    const rondas = db.rondas
      .filter(r => r.condominioId === miCondominio(req))
      .map(r => ({
        id: r.id,
        nombre: r.nombre,
        ordenEstricto: Boolean(r.ordenEstricto),
        duracionMaxMin: r.duracionMaxMin || null,
        // lat/lon y los umbrales de cada punto viajan al teléfono para que la app
        // pueda verificar la presencia ANTES de marcar, también sin señal
        // (CU-18/19). lat null = el administrador no fijó ubicación: no se
        // verifica. verificacion 'anclaje' = la ubicación es la entrada.
        puntos: motor.puntosDeRonda(db, r).map(p => {
          const cfg = motor.configGps();
          const { anclado, radioM, ventanaMs, precisionM } = motor.umbralesDe(p, cfg);
          return {
            id: p.id,
            nombre: p.nombre,
            codigoCorto: p.codigoCorto,
            payload: payloadQR(p),
            lat: p.lat != null ? p.lat : null,
            lon: p.lon != null ? p.lon : null,
            verificacion: motor.modoVerificacion(p),
            radioM: p.lat != null ? radioM : null,
            ventanaMs: p.lat != null ? ventanaMs : null,
            // Con qué precisión se fijó la coordenada: entra en el presupuesto
            // de error que la app calcula sin conexión (CU-23).
            precisionM: p.lat != null ? precisionM : null,
            anclado
          };
        })
      }));
    res.json({
      generado: new Date().toISOString(),
      condominio: { id: condominio.id, nombre: condominio.nombre },
      // Mismos umbrales que aplica el servidor: la app no puede quedar
      // desalineada con el motor ni aceptar lo que el servidor va a rechazar.
      gps: motor.configGps(),
      // Cada cuánto suena la alarma de ronda (0 = apagada), para que la app
      // muestre el estado junto al botón que la activa en este teléfono.
      alarmaMin: Number(condominio.recordatorioMin) || 0,
      rondas
    });
  });

  // Permisos sobre una ejecución: el guardia dueño, o un administrador parado en
  // el condominio de esa ejecución (miCondominio: el suyo, o el elegido si es la
  // cuenta de acceso total). Un guardia sigue sin poder tocar la ronda de otro,
  // y un admin de un condominio no puede escanear ni cerrar rondas de otro.
  //
  // Devuelve una COPIA leída de la base. Regla (invariante 1 del plan SQLite):
  // quien la modifique la guarda con store.ejecuciones.guardar() ANTES de su
  // primer `await`. Dos escaneos de la misma ronda llegan juntos cuando la cola
  // offline sincroniza en ráfaga; con un `await` entre leer y guardar, el
  // segundo pisaría al primero y se perdería una marca.
  function ejecucionAutorizada(req, res) {
    const ejecucion = store.ejecuciones.obtener(req.params.id);
    if (!ejecucion) {
      res.status(404).json({ error: 'La ejecución no existe.' });
      return null;
    }
    const esDueno = ejecucion.guardiaId === req.usuario.id;
    const esAdmin = req.usuario.rol === 'admin' && ejecucion.condominioId === miCondominio(req);
    if (!esDueno && !esAdmin) {
      res.status(403).json({ error: 'Esta ronda no te pertenece.' });
      return null;
    }
    return ejecucion;
  }

  // El cierre y su aviso quedan en UNA transacción, y los dos antes del primer
  // `await` (el push, que sale a un servicio externo).
  // `sinPush`: el aviso queda en el panel pero no suena en el teléfono del
  // administrador (rondas abandonadas hace días que se cierran de una vez).
  async function cerrarYNotificar(ejecucion, { cerradaPorAdmin = false, automatico = false, sinPush = false, fin, comentario, nota: notaExtra } = {}) {
    const r = motor.cerrarEjecucion(db, ejecucion, { fin, automatico, comentario });
    const informe = armarInforme(db, ejecucion);
    if (!r.repetida) {
      const condominio = db.condominios.find(c => c.id === ejecucion.condominioId);
      let alerta = '';
      if (informe.estado === 'incompleta') alerta = '⚠️ ALERTA: ronda con puntos sin marcar\n\n';
      else if (informe.estado === 'sospechosa') alerta = '🔴 ALERTA: ronda con datos sospechosos\n\n';
      const nota = notaExtra ? `${notaExtra}\n`
        : cerradaPorAdmin ? '(cerrada por el administrador)\n'
        : automatico ? '(cerrada automáticamente: el teléfono no terminó la ronda)\n'
        : '';
      store.transaccion(() => {
        store.ejecuciones.guardar(ejecucion);
        registrarAviso(store, condominio, alerta + nota + informeTexto(informe));
      });
      if (sinPush) {
        // queda solo en el panel
      } else if (informe.estado === 'incompleta') {
        const faltantes = informe.detalle.filter(d => d.faltante).map(d => d.nombre);
        await push.avisar(condominio, {
          titulo: `⚠️ Ronda incompleta — ${informe.guardia}`,
          cuerpo: `"${informe.ronda}": ${faltantes.length} de ${informe.detalle.length} puntos sin marcar (${faltantes.join(', ')})`,
          url: `informe.html?id=${ejecucion.id}`
        });
      } else if (informe.estado === 'sospechosa') {
        const motivos = (informe.evaluacion.sospechas || []);
        await push.avisar(condominio, {
          titulo: `🔴 Ronda sospechosa — ${informe.guardia}`,
          cuerpo: `"${informe.ronda}": ${motivos.join('; ')}`,
          url: `informe.html?id=${ejecucion.id}`
        });
      }
    }
    return informe;
  }

  // ---------- Guardia: ejecuciones ----------

  app.post('/api/ejecuciones', auth, (req, res) => {
    const { id: ejecucionId, rondaId, inicio } = req.body || {};
    const r = motor.iniciarEjecucion(db, store.ejecuciones, { ejecucionId, rondaId, guardia: req.usuario, inicio });
    if (r.error) return res.status(r.codigo).json({ error: r.error });
    if (!r.repetida) store.ejecuciones.guardar(r.ejecucion);
    res.status(r.repetida ? 200 : 201).json(r.ejecucion);
  });

  app.post('/api/ejecuciones/:id/escaneos', auth, (req, res) => {
    const ejecucion = ejecucionAutorizada(req, res);
    if (!ejecucion) return;
    const { codigo, ts, offline, gps } = req.body || {};
    // Una ronda sin señal que el sistema dio por abandonada: el teléfono del
    // guardia aparece con sus marcas y la ronda se reabre para recibirlas. La
    // reapertura se guarda solo si la marca entra (y no era repetida).
    const reabierta = ejecucion.guardiaId === req.usuario.id && motor.reabrirSiAutomatica(ejecucion);
    const r = motor.registrarEscaneo(db, ejecucion, { codigo, ts, offline, gps });
    // presencia: cuando el rechazo es por GPS viaja el detalle (distancia y tope)
    // para que la app pueda explicarle al guardia cuánto le falta acercarse.
    if (r.error) return res.status(r.codigo).json({ error: r.error, presencia: r.presencia || null });
    if (!(reabierta && r.duplicado)) store.ejecuciones.guardar(ejecucion);
    res.json({
      duplicado: Boolean(r.duplicado),
      punto: { id: r.punto.id, nombre: r.punto.nombre },
      avance: r.avance
    });
  });

  // Telemetría de marcas RECHAZADAS por el GPS (v1.14). Hasta ahora el rechazo
  // se resolvía entero en el teléfono y no dejaba rastro: los umbrales de v1.13
  // se ajustaron a ciegas, sin un solo dato de terreno. Esto es lo que faltaba
  // para que el próximo ajuste sea una decisión con números.
  //
  // NO es un control: es un registro. Por eso se acepta aunque la ronda ya esté
  // cerrada (el rechazo pudo ocurrir en el último punto y llegar por la cola
  // después del cierre) y no cambia la evaluación de nada.
  const MAX_RECHAZOS = 50;
  app.post('/api/ejecuciones/:id/rechazos', auth, (req, res) => {
    const ejecucion = ejecucionAutorizada(req, res);
    if (!ejecucion) return;
    const { puntoId, ts, motivo, distanciaM, topeM, acc, edadMs } = req.body || {};
    const punto = db.puntos.find(p => p.id === puntoId && p.condominioId === ejecucion.condominioId);
    if (!punto) return res.status(422).json({ error: 'Ese punto no es de esta ronda.' });
    // Se acota como el motivo: el cuerpo puede traer hasta 1 MB y esto queda
    // dentro de la ejecución, que se reescribe entera en cada marca. Un ts de
    // 300 KB no es un ataque sofisticado, es un campo sin cota.
    const cuando = String(ts || new Date().toISOString()).slice(0, 40);
    if (!ejecucion.rechazos) ejecucion.rechazos = [];
    // La cola del teléfono reenvía hasta que el servidor conteste: sin esto, un
    // mismo rechazo entraría tantas veces como intentos hubo.
    const repetido = ejecucion.rechazos.some(r => r.puntoId === puntoId && r.ts === cuando);
    if (!repetido) {
      const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
      ejecucion.rechazos.push({
        puntoId,
        ts: cuando,
        motivo: String(motivo || '').slice(0, 300),
        distanciaM: num(distanciaM),
        topeM: num(topeM),
        acc: num(acc),
        edadMs: num(edadMs)
      });
      // Un teléfono con el GPS roto podría encolar cientos: el registro no puede
      // hacer crecer la ejecución sin techo. Se conservan los últimos.
      if (ejecucion.rechazos.length > MAX_RECHAZOS) {
        ejecucion.rechazos.splice(0, ejecucion.rechazos.length - MAX_RECHAZOS);
      }
      store.ejecuciones.guardar(ejecucion);
    }
    res.status(repetido ? 200 : 201).json({ ok: true, repetido });
  });

  app.post('/api/ejecuciones/:id/cerrar', auth, alerta(async (req, res) => {
    const ejecucion = ejecucionAutorizada(req, res);
    if (!ejecucion) return;
    // El cierre de verdad, del teléfono, reemplaza al automático: trae la hora
    // real de término y el informe se rehace con todo lo que llegó.
    if (ejecucion.guardiaId === req.usuario.id) motor.reabrirSiAutomatica(ejecucion);
    const { fin, comentario } = req.body || {};
    res.json(await cerrarYNotificar(ejecucion, { fin, comentario }));
  }));

  // Cierra las rondas que quedaron "en curso" sin que el teléfono vuelva a dar
  // señales (ver estaAbandonada en lib/rondas.js). Corre cada pocos minutos
  // desde el arranque. Las abandonadas hace más de un día —las que ya estaban
  // colgadas antes de esta versión— se cierran sin push: el primer arranque no
  // puede despertar al administrador con veinte avisos viejos.
  async function cerrarAbandonadas(ahora = Date.now()) {
    const cerradas = [];
    for (const ejecucion of store.ejecuciones.listar({ estado: 'en_curso' })) {
      if (!motor.estaAbandonada(db, ejecucion, ahora)) continue;
      const ultima = motor.ultimaActividad(ejecucion);
      await cerrarYNotificar(ejecucion, {
        automatico: true,
        sinPush: ahora - ultima > 24 * 3600 * 1000,
        fin: new Date(ultima || ahora).toISOString()
      });
      cerradas.push(ejecucion.id);
    }
    return cerradas;
  }

  // ---------- Admin: en qué condominio se está parado ----------

  // Los condominios entre los que puede moverse el panel, y cuál está activo
  // según la cabecera que mandó. El selector del panel se arma con esto: un
  // admin normal recibe solo el suyo; la cuenta de acceso total, todos.
  app.get('/api/admin/condominios', ...admin, (req, res) => {
    res.json({
      activo: miCondominio(req),
      accesoTotal: Boolean(req.usuario.accesoTotal),
      condominios: db.condominios
        .filter(c => req.usuario.accesoTotal || c.id === req.usuario.condominioId)
        .map(c => ({ id: c.id, nombre: c.nombre }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    });
  });

  // ---------- Admin: puntos ----------

  app.get('/api/admin/puntos', ...admin, (req, res) => {
    res.json(db.puntos.filter(p => p.condominioId === miCondominio(req)));
  });

  app.post('/api/admin/puntos', ...admin, (req, res) => {
    const nombre = String((req.body || {}).nombre || '').trim();
    if (!nombre) return res.status(422).json({ error: 'El punto necesita un nombre.' });
    let codigo;
    do { codigo = codigoCorto(); } while (db.puntos.some(p => p.codigoCorto === codigo));
    const punto = { id: id(), condominioId: miCondominio(req), nombre, codigoCorto: codigo };
    db.puntos.push(punto);
    store.guardar();
    res.status(201).json(punto);
  });

  // Campos que describen la medición, no la ubicación: viven y mueren con la
  // coordenada que los produjo.
  const EVIDENCIA_MEDICION = ['muestras', 'dispersionM', 'precisionDeclaradaM', 'medidoConVersion'];

  app.put('/api/admin/puntos/:id', ...admin, (req, res) => {
    const punto = db.puntos.find(p => p.id === req.params.id && p.condominioId === miCondominio(req));
    if (!punto) return res.status(404).json({ error: 'El punto no existe.' });
    const { lat, lon, precisionM, quitarUbicacion, verificacion, radioM, ventanaMin } = req.body || {};
    // Evidencia de CÓMO se midió la coordenada (v1.14). No participa de ninguna
    // decisión —el motor solo mira precisionM— pero es lo que va a permitir
    // re-afinar los umbrales con datos reales sin volver a caminar el condominio,
    // y lo que distingue un punto medido promediando de uno fijado a ojo.
    const { muestras, dispersionM, precisionDeclaradaM, medidoConVersion } = req.body || {};
    const nombre = String((req.body || {}).nombre || '').trim();
    if (nombre) punto.nombre = nombre;
    if (quitarUbicacion) {
      punto.lat = null;
      punto.lon = null;
      // Sin ubicación no hay modo ni umbrales que guardar.
      delete punto.verificacion;
      delete punto.radioM;
      delete punto.ventanaMin;
      delete punto.precisionM;
      for (const campo of EVIDENCIA_MEDICION) delete punto[campo];
    } else if (lat !== undefined || lon !== undefined) {
      const la = Number(lat);
      const lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        return res.status(422).json({ error: 'Ubicación inválida.' });
      }
      // Con qué precisión se midió esta coordenada (CU-23). Se valida ANTES de
      // tocar el punto: un 422 no puede dejar la ubicación a medio escribir.
      let pre = null;
      if (precisionM !== undefined && precisionM !== null && precisionM !== '') {
        const n = Number(precisionM);
        if (!Number.isFinite(n) || n < 0 || n > 500) {
          return res.status(422).json({ error: 'Precisión inválida (0 a 500 m).' });
        }
        pre = Math.round(n);
      }
      punto.lat = la;
      punto.lon = lo;
      // La precisión se borra siempre que llega una coordenada nueva: dejar la
      // calidad de la medición anterior pegada a una ubicación distinta es peor
      // que no tenerla. Sin este dato el motor asume GPS_PRECISION_SUPUESTA_M.
      delete punto.precisionM;
      if (pre != null) punto.precisionM = pre;
      // Misma regla para la evidencia: describe la medición que trajo ESTA
      // coordenada. Una app vieja no manda nada y el punto queda sin evidencia,
      // que es exactamente lo que el panel marca como "conviene re-medir".
      for (const campo of EVIDENCIA_MEDICION) delete punto[campo];
      for (const [campo, valor, max] of [
        ['muestras', muestras, 10000],
        ['dispersionM', dispersionM, 500],
        ['precisionDeclaradaM', precisionDeclaradaM, 500]
      ]) {
        const n = Number(valor);
        if (valor == null || valor === '' || !Number.isFinite(n) || n < 0 || n > max) continue;
        punto[campo] = Math.round(n);
      }
      if (medidoConVersion) punto.medidoConVersion = String(medidoConVersion).slice(0, 20);
    }

    // Modo de verificación (CU-19): 'gps' = la ubicación es el punto exacto;
    // 'anclaje' = es la entrada al recinto, para puntos bajo techo. 'gps' no se
    // guarda: es el default deducido de tener lat/lon.
    if (verificacion !== undefined) {
      if (!['gps', 'anclaje'].includes(verificacion)) {
        return res.status(422).json({ error: 'Modo de verificación inválido.' });
      }
      // Los umbrales propios se calibraron contra los defaults del modo ANTERIOR
      // (20 m / 20 s en exacto, 40 m / 15 min en anclaje). Arrastrarlos al modo
      // nuevo es la misma clase de error que dejar pegada la precisión de una
      // medición vieja en una coordenada nueva, unas líneas más arriba — con una
      // consecuencia peor: una ventana de anclaje sobreviviendo en un punto
      // exacto hacía que la app aceptara marcas que el servidor después
      // rechazaba. Si el mismo request trae umbrales explícitos, el bloque de
      // abajo los vuelve a poner: por eso se limpia acá y no después.
      const modoAntes = punto.verificacion === 'anclaje' ? 'anclaje' : 'gps';
      if (verificacion !== modoAntes) {
        delete punto.radioM;
        delete punto.ventanaMin;
      }
      if (verificacion === 'anclaje') punto.verificacion = 'anclaje';
      else delete punto.verificacion;
    }

    // Umbrales propios del punto, para calibrar en terreno. null/0 vuelve al
    // default del entorno.
    for (const [campo, valor, max] of [['radioM', radioM, 500], ['ventanaMin', ventanaMin, 120]]) {
      if (valor === undefined) continue;
      if (valor === null || valor === '' || Number(valor) === 0) {
        delete punto[campo];
        continue;
      }
      const n = Number(valor);
      if (!Number.isFinite(n) || n < 1 || n > max) {
        return res.status(422).json({ error: `Valor inválido para ${campo} (1 a ${max}).` });
      }
      punto[campo] = Math.round(n);
    }

    store.guardar();
    res.json(punto);
  });

  app.delete('/api/admin/puntos/:id', ...admin, (req, res) => {
    const i = db.puntos.findIndex(p => p.id === req.params.id && p.condominioId === miCondominio(req));
    if (i === -1) return res.status(404).json({ error: 'El punto no existe.' });
    const [punto] = db.puntos.splice(i, 1);
    for (const r of db.rondas) r.puntoIds = r.puntoIds.filter(pid => pid !== punto.id);
    store.guardar();
    res.json({ ok: true });
  });

  // ---------- Admin: guardias ----------

  // Código de registro del condominio: el administrador lo ve, lo cambia o lo
  // regenera, y se lo entrega a sus guardias para que creen su cuenta solos.
  app.get('/api/admin/registro', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    res.json({ codigo: condominio.codigoRegistro || null });
  });

  app.put('/api/admin/registro', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    const cuerpo = req.body || {};
    let codigo;
    if (cuerpo.generar) {
      codigo = codigoCorto(); // uno al azar, legible (sin 0/O/1/I)
    } else {
      codigo = String(cuerpo.codigo || '').trim().toUpperCase();
      // Mínimo 6, igual que los que se generan: con 4 se adivina probando.
      if (!/^[A-Z0-9]{6,12}$/.test(codigo)) {
        return res.status(422).json({ error: 'El código debe tener de 6 a 12 letras o números (sin espacios ni símbolos).' });
      }
    }
    condominio.codigoRegistro = codigo;
    store.guardar();
    res.json({ codigo });
  });

  app.get('/api/admin/guardias', ...admin, (req, res) => {
    res.json(db.usuarios
      .filter(u => u.condominioId === miCondominio(req) && u.rol === 'guardia')
      .map(u => ({
        id: u.id, usuario: u.usuario, nombre: u.nombre,
        // Versión de la app con que este guardia se conectó por última vez.
        appVersion: u.appVersion || null, appVista: u.appVista || null,
        appAlDia: u.appVersion === VERSION_SERVIDOR
      })));
  });

  app.post('/api/admin/guardias', ...admin, (req, res) => {
    const { usuario, nombre, pin } = req.body || {};
    const r = nuevoGuardia({ condominioId: miCondominio(req), usuario, nombre, pin });
    if (r.error) return res.status(r.codigo).json({ error: r.error });
    store.guardar();
    res.status(201).json({ id: r.guardia.id, usuario: r.guardia.usuario, nombre: r.guardia.nombre });
  });

  app.put('/api/admin/guardias/:id', ...admin, (req, res) => {
    const guardia = db.usuarios.find(u => u.id === req.params.id && u.condominioId === miCondominio(req) && u.rol === 'guardia');
    if (!guardia) return res.status(404).json({ error: 'El guardia no existe.' });
    const { nombre, pin } = req.body || {};
    if (nombre) guardia.nombre = String(nombre).trim();
    if (pin !== undefined && pin !== '') {
      if (!/^\d{4,8}$/.test(String(pin))) return res.status(422).json({ error: 'El PIN debe tener entre 4 y 8 dígitos.' });
      guardia.pinHash = hashPin(pin);
      // Las sesiones abiertas con el PIN viejo se cierran (como en el DELETE):
      // cambiarle el PIN a un guardia que lo filtró tiene que sacarlo YA.
      for (const [token, sesion] of Object.entries(db.sesiones)) {
        if (sesion.usuarioId === guardia.id) delete db.sesiones[token];
      }
    }
    store.guardar();
    res.json({ id: guardia.id, usuario: guardia.usuario, nombre: guardia.nombre });
  });

  // Mismo borrado que el del propio guardia (CU-25): sesiones, push, y sus
  // rondas quedan anonimizadas como "Guardia eliminado".
  app.delete('/api/admin/guardias/:id', ...admin, alerta(async (req, res) => {
    const guardia = db.usuarios.find(u => u.id === req.params.id && u.condominioId === miCondominio(req) && u.rol === 'guardia');
    if (!guardia) return res.status(404).json({ error: 'El guardia no existe.' });
    res.json(await borrarCuentaGuardia(guardia, { porAdmin: true }));
  }));

  // Borra TODAS las rondas hechas (ejecuciones e informes) por el usuario de
  // pruebas. Solo ese: las rondas de los guardias reales no se pueden borrar
  // por acá. El usuario sigue existiendo. No se puede deshacer.
  const USUARIO_DE_PRUEBAS = 'domingo_baranda';
  app.delete('/api/admin/guardias/:id/ejecuciones', ...admin, (req, res) => {
    const guardia = db.usuarios.find(u => u.id === req.params.id && u.condominioId === miCondominio(req) && u.rol === 'guardia');
    if (!guardia) return res.status(404).json({ error: 'El guardia no existe.' });
    if (guardia.usuario !== USUARIO_DE_PRUEBAS) {
      return res.status(403).json({ error: 'Solo se pueden borrar las rondas del usuario de pruebas.' });
    }
    const propias = store.ejecuciones.listar({ condominioId: miCondominio(req) })
      .filter(e => e.guardiaId === guardia.id);
    if (propias.length) {
      store.transaccion(() => { for (const e of propias) store.ejecuciones.eliminar(e.id); });
    }
    res.json({ ok: true, eliminadas: propias.length });
  });

  // ---------- Admin: rondas ----------

  app.get('/api/admin/rondas', ...admin, (req, res) => {
    res.json(db.rondas.filter(r => r.condominioId === miCondominio(req)));
  });

  function validarRonda(req, res) {
    const { nombre, puntoIds, ordenEstricto, duracionMaxMin, duracionMinMin } = req.body || {};
    const nombreLimpio = String(nombre || '').trim();
    if (!nombreLimpio) { res.status(422).json({ error: 'La ronda necesita un nombre.' }); return null; }
    if (!Array.isArray(puntoIds) || puntoIds.length === 0) {
      res.status(422).json({ error: 'La ronda necesita al menos un punto.' });
      return null;
    }
    const propios = new Set(db.puntos.filter(p => p.condominioId === miCondominio(req)).map(p => p.id));
    if (puntoIds.some(pid => !propios.has(pid))) {
      res.status(422).json({ error: 'Hay puntos que no son de este condominio.' });
      return null;
    }
    if (new Set(puntoIds).size !== puntoIds.length) {
      res.status(422).json({ error: 'Hay puntos repetidos en la ronda.' });
      return null;
    }
    const duracion = duracionMaxMin ? Number(duracionMaxMin) : null;
    if (duracion !== null && (!Number.isFinite(duracion) || duracion <= 0)) {
      res.status(422).json({ error: 'Duración máxima inválida.' });
      return null;
    }
    // Tiempo mínimo antifraude: una ronda que se cierra más rápido que esto es
    // físicamente imposible de recorrer a pie.
    const minima = duracionMinMin ? Number(duracionMinMin) : null;
    if (minima !== null && (!Number.isFinite(minima) || minima <= 0)) {
      res.status(422).json({ error: 'Duración mínima inválida.' });
      return null;
    }
    if (minima !== null && duracion !== null && minima >= duracion) {
      res.status(422).json({ error: 'La duración mínima debe ser menor que la máxima.' });
      return null;
    }
    return {
      nombre: nombreLimpio,
      puntoIds,
      ordenEstricto: Boolean(ordenEstricto),
      duracionMaxMin: duracion,
      duracionMinMin: minima
    };
  }

  app.post('/api/admin/rondas', ...admin, (req, res) => {
    const datos = validarRonda(req, res);
    if (!datos) return;
    const ronda = { id: id(), condominioId: miCondominio(req), ...datos };
    db.rondas.push(ronda);
    store.guardar();
    res.status(201).json(ronda);
  });

  app.put('/api/admin/rondas/:id', ...admin, (req, res) => {
    const ronda = db.rondas.find(r => r.id === req.params.id && r.condominioId === miCondominio(req));
    if (!ronda) return res.status(404).json({ error: 'La ronda no existe.' });
    const datos = validarRonda(req, res);
    if (!datos) return;
    Object.assign(ronda, datos);
    store.guardar();
    res.json(ronda);
  });

  app.delete('/api/admin/rondas/:id', ...admin, (req, res) => {
    const i = db.rondas.findIndex(r => r.id === req.params.id && r.condominioId === miCondominio(req));
    if (i === -1) return res.status(404).json({ error: 'La ronda no existe.' });
    db.rondas.splice(i, 1);
    store.guardar();
    res.json({ ok: true });
  });

  // ---------- Admin: ejecuciones e informes ----------

  // Las últimas LIMITE_LISTADO del condominio, la más reciente primero. Con
  // ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (días de Chile, ambos inclusive) se
  // filtra por el inicio. Antes devolvía TODAS: con miles de rondas por
  // condominio era un JSON de megas en cada carga de la pestaña.
  const LIMITE_LISTADO = 200;
  app.get('/api/admin/ejecuciones', ...admin, (req, res) => {
    const { desde, hasta } = req.query;
    for (const f of [desde, hasta]) {
      if (f && !esFecha(f)) return res.status(422).json({ error: 'Las fechas van como AAAA-MM-DD.' });
    }
    const lista = store.ejecuciones.listar({
      condominioId: miCondominio(req),
      desde: desde ? inicioDiaChile(desde) : undefined,
      hasta: hasta ? inicioDiaChile(sumarDias(hasta, 1)) : undefined,
      limite: LIMITE_LISTADO
    })
      .map(e => {
        const ronda = db.rondas.find(r => r.id === e.rondaId) || {};
        return {
          id: e.id,
          ronda: ronda.nombre || '(ronda eliminada)',
          guardia: cuenta.nombreGuardia(db.usuarios.find(u => u.id === e.guardiaId)),
          inicio: e.inicio,
          fin: e.fin,
          estado: e.estado,
          hechos: e.escaneos.length,
          total: (ronda.puntoIds || []).length,
          faltantes: e.evaluacion ? e.evaluacion.faltantes.length : null
        };
      });
    res.set('X-Limite', String(LIMITE_LISTADO));
    res.json(lista);
  });

  // Una ejecución del condominio en el que está parado el admin (null si no
  // existe o es de otro).
  const ejecucionDelCondominio = req => {
    const e = store.ejecuciones.obtener(req.params.id);
    return e && e.condominioId === miCondominio(req) ? e : null;
  };

  app.get('/api/admin/informes/:id', ...admin, (req, res) => {
    const ejecucion = ejecucionDelCondominio(req);
    if (!ejecucion) return res.status(404).json({ error: 'El informe no existe.' });
    res.json(armarInforme(db, ejecucion));
  });

  // Informe semanal por condominio en Word (.docx), para enviar por correo al
  // administrador. Rango de fechas por query (?desde=YYYY-MM-DD&hasta=YYYY-MM-DD);
  // por defecto, la semana anterior (lunes a domingo).
  // Envuelto igual que el resto aunque tenga su propio try/catch: así la regla
  // "ningún handler async se registra sin alerta()" es verificable de un vistazo
  // (y por un test), en vez de depender de revisar el cuerpo de cada uno.
  app.get('/api/admin/informe-semanal.docx', ...admin, alerta(async (req, res) => {
    try {
      const { desde, hasta } = req.query;
      const { buffer, datos } = await generarInformeSemanal(store, { condominioId: miCondominio(req), desde, hasta });
      const nombre = `Informe-Semanal-${datos.desde}_a_${datos.hasta}.docx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: 'No se pudo generar el informe semanal.' });
    }
  }));

  // Correos a los que se manda el informe semanal de ESTE condominio (el
  // administrador y, si corresponde, el comité). Un administrador con varios
  // condominios pone el mismo correo en cada uno: el lunes recibe un solo
  // mensaje con todos los informes adjuntos (ver lib/destinatarios.js).
  app.get('/api/admin/correos-informe', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    res.json({
      correos: normalizarCorreos(condominio.correosInforme),
      // Sin correos propios el informe igual sale, pero al respaldo del servidor.
      respaldo: normalizarCorreos(process.env.INFORME_TO)[0] || null,
      envioActivo: correo.configurado()
    });
  });

  app.put('/api/admin/correos-informe', ...admin, (req, res) => {
    const cuerpo = req.body || {};
    const crudos = (Array.isArray(cuerpo.correos) ? cuerpo.correos : String(cuerpo.correos || '').split(/[,;\s]+/))
      .map(t => String(t || '').trim()).filter(Boolean);
    const malos = crudos.filter(t => !esCorreo(t));
    if (malos.length) {
      return res.status(422).json({ error: `Esto no parece un correo: ${malos.join(', ')}` });
    }
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    condominio.correosInforme = normalizarCorreos(crudos);
    store.guardar();
    res.json({ correos: condominio.correosInforme });
  });

  // Enviar el informe semanal por correo ahora mismo (para probar el envío o
  // mandarlo a demanda). Va a los correos del condominio salvo que se pase otro
  // destino; si el condominio no tiene ninguno, cae al respaldo INFORME_TO.
  app.post('/api/admin/informe-semanal/enviar', ...admin, alerta(async (req, res) => {
    if (!correo.configurado()) {
      return res.status(422).json({ error: `El envío por correo no está configurado en el servidor (falta ${correo.FALTA_CREDENCIALES}).` });
    }
    const { desde, hasta, to } = req.body || {};
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    const destinos = to ? normalizarCorreos(to) : correosDelCondominio(condominio, process.env.INFORME_TO);
    if (!destinos.length) {
      return res.status(422).json({ error: 'Todavía no hay correo del administrador: guárdalo acá arriba y vuelve a intentar.' });
    }
    const r = await correo.enviarInforme(store, { condominioIds: [miCondominio(req)], desde, hasta, to: destinos });
    if (!r.enviada) return res.status(502).json({ error: r.error || 'No se pudo enviar el correo.' });
    res.json({ ok: true, to: r.to.join(', '), rango: r.datos.rango });
  }));

  // Cierre administrativo de una ronda que quedó abierta.
  app.post('/api/admin/ejecuciones/:id/cerrar', ...admin, alerta(async (req, res) => {
    const ejecucion = ejecucionDelCondominio(req);
    if (!ejecucion) return res.status(404).json({ error: 'La ejecución no existe.' });
    res.json(await cerrarYNotificar(ejecucion, { cerradaPorAdmin: true }));
  }));

  // ---------- Admin: hoja de QR y notificaciones ----------

  app.get('/api/admin/hoja-qr', ...admin, alerta(async (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    const puntos = db.puntos.filter(p => p.condominioId === miCondominio(req));
    const hoja = [];
    for (const p of puntos) {
      hoja.push({
        id: p.id,
        nombre: p.nombre,
        codigoCorto: p.codigoCorto,
        dataUrl: await QRCode.toDataURL(payloadQR(p), { margin: 1, scale: 8, errorCorrectionLevel: 'M' })
      });
    }
    res.json({ condominio: condominio.nombre, puntos: hoja });
  }));

  app.get('/api/admin/notificaciones', ...admin, (req, res) => {
    res.json(store.notificaciones.ultimas(miCondominio(req), 50));
  });

  // Avisos push de rondas incompletas en el teléfono del administrador.

  app.get('/api/admin/push/clave', ...admin, (req, res) => {
    res.json({ clave: push.claves().publicKey });
  });

  app.post('/api/admin/push/suscribir', ...admin, (req, res) => {
    const registro = push.suscribir({
      condominioId: miCondominio(req),
      usuarioId: req.usuario.id,
      suscripcion: (req.body || {}).suscripcion
    });
    if (!registro) return res.status(422).json({ error: 'Suscripción inválida.' });
    res.status(201).json({ ok: true });
  });

  app.delete('/api/admin/push/suscribir', ...admin, (req, res) => {
    push.desuscribir(String((req.body || {}).endpoint || ''));
    res.json({ ok: true });
  });

  // ---------- Alarma de ronda (lib/recordatorios.js) ----------
  // El administrador fija cada cuánto suena; el teléfono designado del
  // condominio (el de la garita) la activa desde la app del guardia.

  function estadoAlarma(condominio) {
    const minutos = Number(condominio.recordatorioMin) || 0;
    return {
      minutos,
      texto: recordatorios.textoIntervalo(minutos),
      telefonos: push.dispositivos(condominio.id, 'guardia').length,
      ultima: condominio.recordatorioUltimo || null
    };
  }

  app.get('/api/admin/alarma-ronda', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    res.json(estadoAlarma(condominio));
  });

  app.put('/api/admin/alarma-ronda', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    const r = recordatorios.validarMinutos((req.body || {}).minutos);
    if (r.error) return res.status(422).json({ error: r.error });
    condominio.recordatorioMin = r.minutos;
    // El conteo arranca de nuevo desde ahora: bajar de 2 h a 30 min no hace
    // sonar de inmediato una alarma "atrasada".
    condominio.recordatorioDesde = new Date().toISOString();
    store.guardar();
    res.json(estadoAlarma(condominio));
  });

  // Hace sonar la alarma ahora en los teléfonos designados, para comprobar que
  // llega. No mueve el reloj de la alarma programada.
  app.post('/api/admin/alarma-ronda/prueba', ...admin, alerta(async (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    const r = await push.recordar(condominio, {
      titulo: '⏰ Prueba de alarma de ronda',
      cuerpo: `${condominio.nombre}: así sonará el aviso de hacer la ronda.`,
      url: './',
      tag: `ronda-${condominio.id}`
    });
    if (!r.total) return res.status(422).json({ error: 'Ningún teléfono del condominio tiene la alarma activada.' });
    res.json({ ok: r.ok, total: r.total });
  }));

  // Lado del guardia: el teléfono de la garita se suscribe a la alarma de su
  // condominio. La suscripción queda del condominio, no de la persona: sigue
  // sonando aunque cambie el turno y otro guardia inicie sesión.
  app.get('/api/push/clave', auth, (req, res) => {
    res.json({ clave: push.claves().publicKey });
  });

  app.post('/api/mi/push/suscribir', auth, (req, res) => {
    const registro = push.suscribir({
      condominioId: miCondominio(req),
      usuarioId: req.usuario.id,
      suscripcion: (req.body || {}).suscripcion,
      destino: 'guardia'
    });
    if (!registro) return res.status(422).json({ error: 'Suscripción inválida.' });
    res.status(201).json({ ok: true });
  });

  app.delete('/api/mi/push/suscribir', auth, (req, res) => {
    const endpoint = String((req.body || {}).endpoint || '');
    const propia = db.pushSuscripciones.some(s => s.suscripcion.endpoint === endpoint
      && s.condominioId === miCondominio(req) && s.destino === 'guardia');
    if (propia) push.desuscribir(endpoint);
    res.json({ ok: true });
  });

  // ---------- Fábrica: alta de condominios y de sus administradores ----------
  // Solo para la operación (rol 'fabrica', pantalla /fabrica). Es el único lugar
  // de la app que crea condominios y cuentas con rol 'admin'.

  app.get('/api/fabrica/condominios', ...deFabrica, (req, res) => {
    const cuenta = (lista, cid) => lista.filter(x => x.condominioId === cid).length;
    res.json({
      envioActivo: correo.configurado(),
      respaldo: normalizarCorreos(process.env.INFORME_TO)[0] || null,
      condominios: db.condominios.map(c => ({
        id: c.id,
        nombre: c.nombre,
        codigoRegistro: c.codigoRegistro || null,
        correosInforme: normalizarCorreos(c.correosInforme),
        administradores: db.usuarios
          .filter(u => u.condominioId === c.id && u.rol === 'admin')
          .map(u => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, accesoTotal: Boolean(u.accesoTotal) })),
        guardias: db.usuarios.filter(u => u.condominioId === c.id && u.rol === 'guardia').length,
        puntos: cuenta(db.puntos, c.id),
        rondas: cuenta(db.rondas, c.id),
        // Para ver de un vistazo si el condominio está andando o quedó a medias.
        ultimaRonda: (store.ejecuciones.ultimaDe(c.id) || {}).inicio || null
      }))
    });
  });

  // Alta de un condominio: nombre, código de registro y correos del informe.
  // Sin cuenta de panel, salvo que se pidan adminUsuario + adminPin: la operación
  // entra con la cuenta de acceso total y lo elige en el selector.
  app.post('/api/fabrica/condominios', ...deFabrica, (req, res) => {
    const r = fabrica.altaCondominio(db, req.body || {}, ayudantes);
    if (r.error) return res.status(r.codigo || 422).json({ error: r.error });
    store.guardar();
    console.log(`[fabrica] alta de "${r.condominio.nombre}" (${r.condominio.id}) por ${req.usuario.usuario}`);
    res.status(201).json({
      condominio: {
        id: r.condominio.id,
        nombre: r.condominio.nombre,
        codigoRegistro: r.condominio.codigoRegistro,
        correosInforme: r.condominio.correosInforme
      },
      admin: r.admin ? { id: r.admin.id, usuario: r.admin.usuario, nombre: r.admin.nombre } : null,
      pin: r.pin
    });
  });

  // Cuenta de panel para un condominio, para un cliente que quiera operar el
  // suyo. Es una cuenta normal: queda encerrada en ESE condominio (ver
  // miCondominio arriba). El acceso total no se da desde acá.
  app.post('/api/fabrica/condominios/:id/administradores', ...deFabrica, (req, res) => {
    const cuerpo = req.body || {};
    const r = fabrica.nuevoAdmin(db, {
      condominioId: req.params.id,
      usuario: cuerpo.usuario,
      nombre: cuerpo.nombre,
      pin: cuerpo.pin
    }, ayudantes);
    if (r.error) return res.status(r.codigo || 422).json({ error: r.error });
    store.guardar();
    res.status(201).json({ admin: { id: r.admin.id, usuario: r.admin.usuario, nombre: r.admin.nombre }, pin: r.pin });
  });

  // Correos del informe de cualquier condominio: si el administrador solo recibe
  // el correo y no entra al panel, los carga la fábrica.
  app.put('/api/fabrica/condominios/:id/correos', ...deFabrica, (req, res) => {
    const condominio = db.condominios.find(c => c.id === req.params.id);
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    const r = fabrica.validarCorreos((req.body || {}).correos);
    if (r.error) return res.status(422).json({ error: r.error });
    condominio.correosInforme = r.correos;
    store.guardar();
    res.json({ correos: condominio.correosInforme });
  });

  // Cambiar el PIN de un administrador (el admin no puede cambiarse el suyo).
  app.put('/api/fabrica/administradores/:id/pin', ...deFabrica, (req, res) => {
    const usuario = db.usuarios.find(u => u.id === req.params.id && u.rol === 'admin');
    if (!usuario) return res.status(404).json({ error: 'Ese administrador no existe.' });
    const p = fabrica.validarPinAdmin((req.body || {}).pin);
    if (p.error) return res.status(422).json({ error: p.error });
    usuario.pinHash = hashPin(p.pin);
    // Las sesiones abiertas con el PIN viejo se cierran.
    for (const [token, sesion] of Object.entries(db.sesiones || {})) {
      if (sesion.usuarioId === usuario.id) delete db.sesiones[token];
    }
    store.guardar();
    res.json({ ok: true, usuario: usuario.usuario, pin: p.pin });
  });

  // Quitar una cuenta de panel (la de una demo, la de un cliente que ya no
  // opera). No se deja borrar la última: sin ninguna cuenta 'admin' no se puede
  // entrar al panel. Tampoco la de acceso total: la maneja el entorno
  // (ADMIN_TOTAL_*) y se volvería a crear en el siguiente arranque.
  app.delete('/api/fabrica/administradores/:id', ...deFabrica, (req, res) => {
    const usuario = db.usuarios.find(u => u.id === req.params.id && u.rol === 'admin');
    if (!usuario) return res.status(404).json({ error: 'Ese administrador no existe.' });
    if (usuario.accesoTotal) {
      return res.status(409).json({ error: 'Es la cuenta de acceso total: se maneja desde el entorno del servidor (ADMIN_TOTAL_*), no desde acá.' });
    }
    if (db.usuarios.filter(u => u.rol === 'admin').length <= 1) {
      return res.status(409).json({ error: 'Es la última cuenta de panel: si la borras, nadie puede entrar al panel. Crea otra primero.' });
    }
    db.usuarios = db.usuarios.filter(u => u.id !== usuario.id);
    for (const [token, sesion] of Object.entries(db.sesiones || {})) {
      if (sesion.usuarioId === usuario.id) delete db.sesiones[token];
    }
    store.guardar();
    console.log(`[fabrica] cuenta de panel "${usuario.usuario}" eliminada por ${req.usuario.usuario}`);
    res.json({ ok: true, usuario: usuario.usuario });
  });

  // Enviar el informe de un condominio ahora mismo, para probar que el correo
  // llega antes de esperar al lunes.
  app.post('/api/fabrica/condominios/:id/informe-prueba', ...deFabrica, alerta(async (req, res) => {
    const condominio = db.condominios.find(c => c.id === req.params.id);
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    if (!correo.configurado()) {
      return res.status(422).json({ error: `El envío por correo no está configurado en el servidor (falta ${correo.FALTA_CREDENCIALES}).` });
    }
    const destinos = correosDelCondominio(condominio, process.env.INFORME_TO);
    if (!destinos.length) return res.status(422).json({ error: 'Ese condominio no tiene correos cargados.' });
    const r = await correo.enviarInforme(store, { condominioIds: [condominio.id], to: destinos });
    if (!r.enviada) return res.status(502).json({ error: r.error || 'No se pudo enviar el correo.' });
    res.json({ ok: true, to: r.to.join(', '), rango: r.datos.rango });
  }));

  // Última red: cualquier error que se escape de un handler termina acá y sale
  // como 500, en vez de matar el proceso. Se registra entero en consola porque
  // un 500 sin rastro en el log es un bug que no se puede perseguir.
  app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  return { app, store, push, cerrarAbandonadas };
}

if (require.main === module) {
  const puerto = Number(process.env.PORT || 3737);
  let creado;
  try {
    creado = crearApp();
  } catch (err) {
    // Típicamente, una importación de db.json que no cuadró: el store ya dejó
    // todo como estaba. Se sale con error para que Railway lo muestre.
    console.error(`[arranque] el servidor NO arranca: ${err.message}`);
    if (err.cause) console.error(err.cause);
    process.exit(1);
  }
  const { app, store, push, cerrarAbandonadas } = creado;
  app.listen(puerto, () => {
    console.log(`Rondas QR — servidor en http://localhost:${puerto}`);
    console.log(`  App del guardia:     http://localhost:${puerto}/`);
    console.log(`  Panel administrador: http://localhost:${puerto}/panel`);
    console.log('  Avisos de ronda: panel (pestaña Avisos) y consola');
    console.log('  Alarma de ronda: se configura por condominio en el panel (pestaña Avisos)');
    console.log(`  Correo semanal: ${correo.configurado() ? 'activo' : `sin configurar (falta ${correo.FALTA_CREDENCIALES})`}`);
    const c = store.conteos();
    console.log(`  Base de datos: ${store.ruta} (SQLite, Node ${process.version})`);
    console.log(`    ${c.condominios} condominios, ${c.usuarios} usuarios, ${c.puntos} puntos, ${c.rondas} rondas configuradas, `
              + `${c.ejecuciones} ejecuciones, ${c.notificaciones} avisos`);
  });
  programador.iniciar(store); // respaldo diario de la base y envío semanal del informe por correo
  recordatorios.iniciar(store, push); // alarma de ronda a los teléfonos de cada condominio
  // Rondas abandonadas: al arrancar y cada 5 min (lib/rondas.js, estaAbandonada).
  const abandonadas = () => cerrarAbandonadas()
    .then(ids => { if (ids.length) console.log(`[abandonadas] ${ids.length} ronda(s) cerrada(s) automáticamente`); })
    .catch(e => console.warn('[abandonadas] error:', e.message));
  abandonadas();
  setInterval(abandonadas, 5 * 60000);
}

module.exports = { crearApp };
