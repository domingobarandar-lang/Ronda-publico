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
const { notificarAdmin } = require('./lib/notificar');
const { crearPush } = require('./lib/push');

cargarEnv(__dirname);

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

  // Sobre qué condominio trabaja esta petición.
  //
  // El GUARDIA queda siempre amarrado al suyo, pase lo que pase en la cabecera:
  // su paquete de rondas lleva los payloads de los QR, así que dejarlo pedir
  // otro condominio sería entregarle los códigos del vecino. Ese aislamiento es
  // el que sostiene el antifraude y no se toca.
  //
  // El ADMINISTRADOR, en cambio, puede pararse en cualquier condominio: el panel
  // manda el elegido en `x-condominio`. Es una decisión de producto tomada a
  // sabiendas (v1.12) para que la operación pueda ir condominio por condominio
  // fijando las ubicaciones de los puntos sin cambiar de cuenta. El costo es
  // explícito: entre administradores ya NO hay aislamiento — cualquiera de ellos
  // ve los informes, guardias y códigos de registro de todos. Si algún día vuelve
  // a haber clientes con panel propio, esto se restringe al rol de la operación.
  const miCondominio = req => {
    if (req.usuario.rol !== 'admin') return req.usuario.condominioId;
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

  // Límite de intentos de login. El PIN es de 4 a 8 dígitos y la app está en
  // internet: sin esto, probar 10.000 PIN de 4 dígitos es cuestión de minutos.
  // Se cuenta por usuario + IP; 10 fallos seguidos bloquean 15 minutos y un
  // acierto limpia la cuenta. Vive en memoria: un redespliegue lo reinicia (para
  // fuerza bruta sostenida haría falta llevarlo a la base).
  const MAX_INTENTOS = 10;
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

  app.post('/api/login', (req, res) => {
    const { usuario, pin } = req.body || {};
    const nombreUsuario = String(usuario || '').toLowerCase().trim();
    const clave = `${req.ip}|${nombreUsuario}`;
    const bloqueo = estadoIntentos(clave);
    if (bloqueo && bloqueo.hasta) {
      const minutos = Math.max(1, Math.ceil((bloqueo.hasta - Date.now()) / 60000));
      return res.status(429).json({ error: `Demasiados intentos fallidos. Espera ${minutos} minuto(s) y vuelve a probar.` });
    }
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
    // El código del condominio verifica que quien se registra es un guardia real:
    // lo entrega el administrador. Se compara sin distinguir mayúsculas/espacios.
    const codigoDado = String(codigo || '').trim().toUpperCase();
    if (!condominio.codigoRegistro) {
      return res.status(403).json({ error: 'Este condominio todavía no permite crear cuentas. Pídele el código a tu administrador.' });
    }
    if (codigoDado !== condominio.codigoRegistro) {
      return res.status(403).json({ error: 'El código del condominio no es correcto. Pídeselo a tu administrador.' });
    }
    const r = nuevoGuardia({ condominioId: condominio.id, usuario, nombre, pin });
    if (r.error) return res.status(r.codigo).json({ error: r.error });
    store.guardar();
    res.status(201).json({ id: r.guardia.id, usuario: r.guardia.usuario, nombre: r.guardia.nombre });
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
      rondas
    });
  });

  // Permisos sobre una ejecución: el guardia dueño, o cualquier administrador
  // (desde v1.12 los administradores trabajan sobre todos los condominios; ver
  // miCondominio). Un guardia sigue sin poder tocar la ronda de otro.
  function ejecucionAutorizada(req, res) {
    const ejecucion = db.ejecuciones.find(e => e.id === req.params.id);
    if (!ejecucion) {
      res.status(404).json({ error: 'La ejecución no existe.' });
      return null;
    }
    const esDueno = ejecucion.guardiaId === req.usuario.id;
    const esAdmin = req.usuario.rol === 'admin';
    if (!esDueno && !esAdmin) {
      res.status(403).json({ error: 'Esta ronda no te pertenece.' });
      return null;
    }
    return ejecucion;
  }

  async function cerrarYNotificar(ejecucion, { cerradaPorAdmin = false, fin } = {}) {
    const r = motor.cerrarEjecucion(db, ejecucion, { fin });
    store.guardar();
    const informe = armarInforme(db, ejecucion);
    if (!r.repetida) {
      const condominio = db.condominios.find(c => c.id === ejecucion.condominioId);
      let alerta = '';
      if (informe.estado === 'incompleta') alerta = '⚠️ ALERTA: ronda con puntos sin marcar\n\n';
      else if (informe.estado === 'sospechosa') alerta = '🔴 ALERTA: ronda con datos sospechosos\n\n';
      const nota = cerradaPorAdmin ? '(cerrada por el administrador)\n' : '';
      await notificarAdmin(store, condominio, alerta + nota + informeTexto(informe));
      if (informe.estado === 'incompleta') {
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
    const r = motor.iniciarEjecucion(db, { ejecucionId, rondaId, guardia: req.usuario, inicio });
    if (r.error) return res.status(r.codigo).json({ error: r.error });
    store.guardar();
    res.status(r.repetida ? 200 : 201).json(r.ejecucion);
  });

  app.post('/api/ejecuciones/:id/escaneos', auth, (req, res) => {
    const ejecucion = ejecucionAutorizada(req, res);
    if (!ejecucion) return;
    const { codigo, ts, offline, gps } = req.body || {};
    const r = motor.registrarEscaneo(db, ejecucion, { codigo, ts, offline, gps });
    // presencia: cuando el rechazo es por GPS viaja el detalle (distancia y tope)
    // para que la app pueda explicarle al guardia cuánto le falta acercarse.
    if (r.error) return res.status(r.codigo).json({ error: r.error, presencia: r.presencia || null });
    store.guardar();
    res.json({
      duplicado: Boolean(r.duplicado),
      punto: { id: r.punto.id, nombre: r.punto.nombre },
      avance: r.avance
    });
  });

  app.post('/api/ejecuciones/:id/cerrar', auth, async (req, res) => {
    const ejecucion = ejecucionAutorizada(req, res);
    if (!ejecucion) return;
    res.json(await cerrarYNotificar(ejecucion, { fin: (req.body || {}).fin }));
  });

  // ---------- Admin: en qué condominio se está parado ----------

  // Los condominios entre los que puede moverse el panel, y cuál está activo
  // según la cabecera que mandó. El selector del panel se arma con esto.
  app.get('/api/admin/condominios', ...admin, (req, res) => {
    res.json({
      activo: miCondominio(req),
      condominios: db.condominios
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

  app.put('/api/admin/puntos/:id', ...admin, (req, res) => {
    const punto = db.puntos.find(p => p.id === req.params.id && p.condominioId === miCondominio(req));
    if (!punto) return res.status(404).json({ error: 'El punto no existe.' });
    const { lat, lon, precisionM, quitarUbicacion, verificacion, radioM, ventanaMin } = req.body || {};
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
    }

    // Modo de verificación (CU-19): 'gps' = la ubicación es el punto exacto;
    // 'anclaje' = es la entrada al recinto, para puntos bajo techo. 'gps' no se
    // guarda: es el default deducido de tener lat/lon.
    if (verificacion !== undefined) {
      if (!['gps', 'anclaje'].includes(verificacion)) {
        return res.status(422).json({ error: 'Modo de verificación inválido.' });
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
    const cuerpo = req.body || {};
    let codigo;
    if (cuerpo.generar) {
      codigo = codigoCorto(); // uno al azar, legible (sin 0/O/1/I)
    } else {
      codigo = String(cuerpo.codigo || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(codigo)) {
        return res.status(422).json({ error: 'El código debe tener de 4 a 12 letras o números (sin espacios ni símbolos).' });
      }
    }
    condominio.codigoRegistro = codigo;
    store.guardar();
    res.json({ codigo });
  });

  app.get('/api/admin/guardias', ...admin, (req, res) => {
    res.json(db.usuarios
      .filter(u => u.condominioId === miCondominio(req) && u.rol === 'guardia')
      .map(u => ({ id: u.id, usuario: u.usuario, nombre: u.nombre })));
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
    }
    store.guardar();
    res.json({ id: guardia.id, usuario: guardia.usuario, nombre: guardia.nombre });
  });

  app.delete('/api/admin/guardias/:id', ...admin, (req, res) => {
    const i = db.usuarios.findIndex(u => u.id === req.params.id && u.condominioId === miCondominio(req) && u.rol === 'guardia');
    if (i === -1) return res.status(404).json({ error: 'El guardia no existe.' });
    const [guardia] = db.usuarios.splice(i, 1);
    for (const [token, sesion] of Object.entries(db.sesiones)) {
      if (sesion.usuarioId === guardia.id) delete db.sesiones[token];
    }
    store.guardar();
    res.json({ ok: true });
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

  app.get('/api/admin/ejecuciones', ...admin, (req, res) => {
    const lista = db.ejecuciones
      .filter(e => e.condominioId === miCondominio(req))
      .sort((a, b) => String(b.inicio).localeCompare(String(a.inicio)))
      .map(e => {
        const ronda = db.rondas.find(r => r.id === e.rondaId) || {};
        const guardia = db.usuarios.find(u => u.id === e.guardiaId) || {};
        return {
          id: e.id,
          ronda: ronda.nombre || '(ronda eliminada)',
          guardia: guardia.nombre || guardia.usuario || '(guardia eliminado)',
          inicio: e.inicio,
          fin: e.fin,
          estado: e.estado,
          hechos: e.escaneos.length,
          total: (ronda.puntoIds || []).length,
          faltantes: e.evaluacion ? e.evaluacion.faltantes.length : null
        };
      });
    res.json(lista);
  });

  app.get('/api/admin/informes/:id', ...admin, (req, res) => {
    const ejecucion = db.ejecuciones.find(e => e.id === req.params.id && e.condominioId === miCondominio(req));
    if (!ejecucion) return res.status(404).json({ error: 'El informe no existe.' });
    res.json(armarInforme(db, ejecucion));
  });

  // Informe semanal por condominio en Word (.docx), para enviar por correo al
  // administrador. Rango de fechas por query (?desde=YYYY-MM-DD&hasta=YYYY-MM-DD);
  // por defecto, la semana anterior (lunes a domingo).
  app.get('/api/admin/informe-semanal.docx', ...admin, async (req, res) => {
    try {
      const { desde, hasta } = req.query;
      const { buffer, datos } = await generarInformeSemanal(db, { condominioId: miCondominio(req), desde, hasta });
      const nombre = `Informe-Semanal-${datos.desde}_a_${datos.hasta}.docx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: 'No se pudo generar el informe semanal.' });
    }
  });

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
    condominio.correosInforme = normalizarCorreos(crudos);
    store.guardar();
    res.json({ correos: condominio.correosInforme });
  });

  // Enviar el informe semanal por correo ahora mismo (para probar el envío o
  // mandarlo a demanda). Va a los correos del condominio salvo que se pase otro
  // destino; si el condominio no tiene ninguno, cae al respaldo INFORME_TO.
  app.post('/api/admin/informe-semanal/enviar', ...admin, async (req, res) => {
    if (!correo.configurado()) {
      return res.status(422).json({ error: 'El envío por correo no está configurado en el servidor (falta RESEND_API_KEY).' });
    }
    const { desde, hasta, to } = req.body || {};
    const condominio = db.condominios.find(c => c.id === miCondominio(req)) || {};
    const destinos = to ? normalizarCorreos(to) : correosDelCondominio(condominio, process.env.INFORME_TO);
    if (!destinos.length) {
      return res.status(422).json({ error: 'Todavía no hay correo del administrador: guárdalo acá arriba y vuelve a intentar.' });
    }
    const r = await correo.enviarInforme(db, { condominioIds: [miCondominio(req)], desde, hasta, to: destinos });
    if (!r.enviada) return res.status(502).json({ error: r.error || 'No se pudo enviar el correo.' });
    res.json({ ok: true, to: r.to.join(', '), rango: r.datos.rango });
  });

  // Cierre administrativo de una ronda que quedó abierta.
  app.post('/api/admin/ejecuciones/:id/cerrar', ...admin, async (req, res) => {
    const ejecucion = db.ejecuciones.find(e => e.id === req.params.id && e.condominioId === miCondominio(req));
    if (!ejecucion) return res.status(404).json({ error: 'La ejecución no existe.' });
    res.json(await cerrarYNotificar(ejecucion, { cerradaPorAdmin: true }));
  });

  // ---------- Admin: hoja de QR y notificaciones ----------

  app.get('/api/admin/hoja-qr', ...admin, async (req, res) => {
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
  });

  app.get('/api/admin/notificaciones', ...admin, (req, res) => {
    res.json(db.notificaciones
      .filter(n => n.condominioId === miCondominio(req))
      .slice(-50)
      .reverse());
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
          .map(u => ({ id: u.id, usuario: u.usuario, nombre: u.nombre })),
        guardias: db.usuarios.filter(u => u.condominioId === c.id && u.rol === 'guardia').length,
        puntos: cuenta(db.puntos, c.id),
        rondas: cuenta(db.rondas, c.id),
        // Para ver de un vistazo si el condominio está andando o quedó a medias.
        ultimaRonda: db.ejecuciones.filter(e => e.condominioId === c.id)
          .map(e => e.inicio).sort().slice(-1)[0] || null
      }))
    });
  });

  // Alta de un condominio: nombre, código de registro y correos del informe.
  // Sin cuenta de panel, salvo que se pidan adminUsuario + adminPin: la operación
  // entra con su propia cuenta y lo elige en el selector (v1.12).
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

  // Cuenta de panel para un condominio, para el caso excepcional de un cliente
  // que quiera operar el suyo. Ojo: desde la v1.12 cualquier cuenta de
  // administrador ve TODOS los condominios (ver miCondominio arriba).
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
    const p = fabrica.validarPin((req.body || {}).pin);
    if (p.error) return res.status(422).json({ error: p.error });
    usuario.pinHash = hashPin(p.pin);
    // Las sesiones abiertas con el PIN viejo se cierran.
    for (const [token, sesion] of Object.entries(db.sesiones || {})) {
      if (sesion.usuarioId === usuario.id) delete db.sesiones[token];
    }
    store.guardar();
    res.json({ ok: true, usuario: usuario.usuario, pin: p.pin });
  });

  // Quitar una cuenta de panel. Importa desde la v1.12: como cualquier cuenta
  // 'admin' ve todos los condominios, cada una que sobra (la de una demo, la de
  // un cliente que solo recibe el informe) es otra llave que abre todo. No se
  // deja borrar la última: sin ninguna cuenta 'admin' no se puede entrar al panel.
  app.delete('/api/fabrica/administradores/:id', ...deFabrica, (req, res) => {
    const usuario = db.usuarios.find(u => u.id === req.params.id && u.rol === 'admin');
    if (!usuario) return res.status(404).json({ error: 'Ese administrador no existe.' });
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
  app.post('/api/fabrica/condominios/:id/informe-prueba', ...deFabrica, async (req, res) => {
    const condominio = db.condominios.find(c => c.id === req.params.id);
    if (!condominio) return res.status(404).json({ error: 'El condominio no existe.' });
    if (!correo.configurado()) {
      return res.status(422).json({ error: 'El envío por correo no está configurado en el servidor (falta RESEND_API_KEY).' });
    }
    const destinos = correosDelCondominio(condominio, process.env.INFORME_TO);
    if (!destinos.length) return res.status(422).json({ error: 'Ese condominio no tiene correos cargados.' });
    const r = await correo.enviarInforme(db, { condominioIds: [condominio.id], to: destinos });
    if (!r.enviada) return res.status(502).json({ error: r.error || 'No se pudo enviar el correo.' });
    res.json({ ok: true, to: r.to.join(', '), rango: r.datos.rango });
  });

  // Chat id de Telegram del administrador (para pasar de mock a real).
  app.put('/api/admin/telegram', ...admin, (req, res) => {
    const condominio = db.condominios.find(c => c.id === miCondominio(req));
    condominio.adminTelegramChatId = String((req.body || {}).chatId || '').trim() || null;
    store.guardar();
    res.json({ ok: true, adminTelegramChatId: condominio.adminTelegramChatId });
  });

  return { app, store };
}

if (require.main === module) {
  const puerto = Number(process.env.PORT || 3737);
  const { app, store } = crearApp();
  app.listen(puerto, () => {
    const modo = (process.env.MOCK || 'true') !== 'false' ? 'MOCK (quedan en consola y registro)' : 'REALES (Telegram)';
    console.log(`Rondas QR — servidor en http://localhost:${puerto}`);
    console.log(`  App del guardia:     http://localhost:${puerto}/`);
    console.log(`  Panel administrador: http://localhost:${puerto}/panel`);
    console.log(`  Notificaciones: ${modo}`);
    console.log(`  Base de datos: ${store.ruta}`);
  });
  programador.iniciar(store); // envío semanal del informe por correo (si hay SMTP)
}

module.exports = { crearApp };
