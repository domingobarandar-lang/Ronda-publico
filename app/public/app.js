// PWA del guardia — local-first:
// - El paquete de rondas se descarga al entrar y queda en localStorage.
// - Los escaneos se validan localmente contra el paquete y se ENCOLAN.
// - Una cola de eventos idempotentes (iniciar / escaneo / cerrar) se reenvía
//   al servidor cada pocos segundos; si no hay señal, se reintenta después.
'use strict';

const CLAVE = 'rondasqr';

let estado = cargarEstado();
let rolElegido = null;        // 'guardia' cuando ya eligió perfil en esta visita
let promptInstalacion = null; // evento beforeinstallprompt capturado (Chrome/Edge)
let sincronizando = false;
let stream = null;
let escaneando = false;
let ultimoCodigoLeido = { valor: null, ts: 0 };
let gpsWatchId = null;
let gpsActual = null;
let gpsMotivoFalla = null;

// ---------- GPS (CU-15 / CU-18): se observa mientras hay ronda activa ----------
// Desde v1.9 el GPS SÍ bloquea. En un punto al que el administrador le fijó
// ubicación, la app no deja marcar si el teléfono está a más del radio
// configurado (20 m por defecto) o si no hay un fix reciente: la foto del QR
// escaneada desde la caseta ya no entra. Los puntos SIN ubicación fijada —los de
// bajo techo, donde el GPS no llega— se marcan igual que antes.

// Umbrales que manda el servidor en el paquete. Los defaults calzan con
// configGps() de lib/rondas.js para que un paquete viejo en caché no acepte
// marcas que el servidor va a rechazar después.
function cfgGps() {
  const c = (estado.paquete && estado.paquete.gps) || {};
  return {
    radioOkM: Number.isFinite(c.radioOkM) ? c.radioOkM : 20,
    margenMaxM: Number.isFinite(c.margenMaxM) ? c.margenMaxM : 0,
    frescoMs: Number.isFinite(c.frescoMs) ? c.frescoMs : 20000,
    bloquea: c.bloquea !== false
  };
}

// Umbrales del punto (los calcula el servidor y viajan en el paquete). Un
// paquete viejo en caché no los trae: se cae a la config general.
function umbralesDe(punto) {
  const cfg = cfgGps();
  const anclado = punto.verificacion === 'anclaje';
  return {
    anclado,
    radioM: Number.isFinite(punto.radioM) ? punto.radioM : cfg.radioOkM,
    ventanaMs: Number.isFinite(punto.ventanaMs) ? punto.ventanaMs : cfg.frescoMs
  };
}

function iniciarGps() {
  if (!('geolocation' in navigator)) {
    gpsMotivoFalla = 'este teléfono no entrega ubicación';
    return;
  }
  if (gpsWatchId !== null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      gpsActual = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: Math.round(pos.coords.accuracy || 0),
        // pos.timestamp es la hora REAL del fix según el sistema operativo. Usar
        // Date.now() haría pasar por nuevo un fix cacheado que el SO acaba de
        // entregar, y la antigüedad es justo el criterio de un punto anclado.
        // Se acota a "no futuro" por si el reloj del teléfono va adelantado.
        ts: Math.min(pos.timestamp || Date.now(), Date.now())
      };
      gpsMotivoFalla = null;
      pintarGps();
    },
    err => {
      // 1 = PERMISSION_DENIED. Se distingue porque es el único caso que el
      // guardia puede resolver solo (y el que usaría para saltarse el control).
      gpsMotivoFalla = err && err.code === 1
        ? 'falta el permiso de ubicación'
        : 'no hay señal todavía';
      pintarGps();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 }
  );
}

function detenerGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = null;
  gpsActual = null;
  gpsMotivoFalla = null;
}

// Último fix conocido con su antigüedad, sin filtrar. Quién puede usarlo y hasta
// qué edad lo decide cada punto: 20 s en uno exacto, 15 min en uno anclado.
function gpsUltimo() {
  if (!gpsActual) return null;
  return {
    lat: gpsActual.lat,
    lon: gpsActual.lon,
    acc: gpsActual.acc,
    edadMs: Math.max(0, Date.now() - gpsActual.ts)
  };
}

// Fix reciente según la config general. Se usa para lo informativo (marcas en
// puntos sin ubicación fijada) y para la línea de estado.
function gpsFresco() {
  const g = gpsUltimo();
  if (!g || g.edadMs > cfgGps().frescoMs) return null;
  return g;
}

// Haversine en metros. Réplica deliberada de lib/rondas.js: la app tiene que
// poder decidir sin conexión y public/ no comparte módulos con el servidor.
function distanciaM(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function minutos(ms) {
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}

// Qué ubicación se adjunta a la marca. En un punto anclado sirve el último fix
// aunque esté viejo: es precisamente el que tomó al pasar por la entrada, antes
// de que el GPS se cortara adentro. En el resto, solo uno reciente.
// edadMs viaja como duración, así el reenvío desde la cola offline horas después
// sigue informando la misma antigüedad del momento del escaneo.
function gpsParaMarca(punto) {
  if (punto.lat != null && umbralesDe(punto).anclado) return gpsUltimo();
  return gpsFresco();
}

// Espejo de verificarPresencia() de lib/rondas.js. null = el punto no tiene
// ubicación fijada, no hay nada que verificar.
function verificarPresencia(punto) {
  if (punto.lat == null || punto.lon == null) return null;
  const cfg = cfgGps();
  const { anclado, radioM, ventanaMs } = umbralesDe(punto);
  const g = gpsUltimo();
  if (!g) {
    return {
      ok: false,
      motivo: anclado
        ? `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): para "${punto.nombre}" el teléfono tiene que haber tomado señal en la entrada. Actívala antes de iniciar la ronda.`
        : `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): "${punto.nombre}" no se puede marcar hasta confirmar que estás ahí.`
    };
  }
  if (g.edadMs > ventanaMs) {
    return {
      ok: false,
      motivo: anclado
        ? `📍 Tu última ubicación es de hace ${minutos(g.edadMs)} y el máximo para "${punto.nombre}" son ${minutos(ventanaMs)}. Sal a donde haya señal y vuelve a entrar.`
        : `📍 Tu ubicación es de hace ${minutos(g.edadMs)}: hace falta una más reciente para marcar "${punto.nombre}".`
    };
  }
  const d = distanciaM(g, punto);
  const topeM = anclado ? radioM : radioM + Math.min(g.acc || 0, cfg.margenMaxM);
  return {
    ok: d <= topeM,
    motivo: anclado
      ? `📍 Estás a ${d} m de la entrada de "${punto.nombre}" (máximo ${topeM} m). Pasa por la entrada del recinto y vuelve a escanear.`
      : `📍 Estás a ${d} m de "${punto.nombre}". Hay que estar a menos de ${topeM} m para marcar.`
  };
}

// ---------- Estado persistente ----------

function cargarEstado() {
  try {
    return Object.assign(
      { sesion: null, paquete: null, ejecucion: null, cola: [], ultimoInforme: null },
      JSON.parse(localStorage.getItem(CLAVE) || '{}')
    );
  } catch {
    return { sesion: null, paquete: null, ejecucion: null, cola: [], ultimoInforme: null };
  }
}

function guardarEstado() {
  localStorage.setItem(CLAVE, JSON.stringify(estado));
}

// ---------- Utilidades ----------

const $ = id => document.getElementById(id);

function mostrarVista(id) {
  for (const v of document.querySelectorAll('.vista')) v.classList.add('oculta');
  $(id).classList.remove('oculta');
}

let avisoTimer = null;
function aviso(texto, tipo = 'info', ms = 3200) {
  const el = $('aviso');
  el.textContent = texto;
  el.className = `aviso aviso-${tipo}`;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.add('oculta'), ms);
}

function hora(ts) {
  return new Date(ts).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

function rondaActual() {
  if (!estado.ejecucion || !estado.paquete) return null;
  return estado.paquete.rondas.find(r => r.id === estado.ejecucion.rondaId) || null;
}

async function api(ruta, opciones = {}) {
  const cabeceras = { 'content-type': 'application/json' };
  if (estado.sesion) cabeceras.authorization = `Bearer ${estado.sesion.token}`;
  const resp = await fetch(ruta, {
    method: opciones.metodo || 'GET',
    headers: cabeceras,
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined
  });
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(datos.error || `Error HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return datos;
}

// ---------- Conexión ----------

function pintarConexion() {
  const chip = $('chip-conexion');
  if (navigator.onLine) {
    const pendientes = estado.cola.length;
    chip.textContent = pendientes ? `En línea · ${pendientes} por enviar` : 'En línea';
    chip.className = 'chip chip-ok';
  } else {
    chip.textContent = 'Sin conexión · la ronda sigue';
    chip.className = 'chip chip-off';
  }
}

// ---------- Sesión ----------

// Inicia sesión de guardia y descarga sus rondas. Compartido por el login y el
// registro (que entra solo después de crear la cuenta). Lanza si algo falla.
async function iniciarSesionGuardia(usuario, pin) {
  const r = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  if (r.rol === 'admin') {
    location.href = '/admin.html';
    return;
  }
  estado.sesion = r;
  guardarEstado();
  await bajarPaquete(true);
  render();
}

async function entrar() {
  const usuario = $('campo-usuario').value.trim();
  const pin = $('campo-pin').value.trim();
  $('error-login').classList.add('oculta');
  if (!usuario || !pin) return;
  try {
    await iniciarSesionGuardia(usuario, pin);
  } catch (err) {
    const el = $('error-login');
    el.textContent = err.status ? err.message : 'No se pudo conectar al servidor.';
    el.classList.remove('oculta');
  }
}

// ---------- Registro (autoservicio del guardia) ----------

function errorRegistro(texto) {
  const el = $('error-registro');
  el.textContent = texto;
  el.classList.remove('oculta');
}

// Muestra la pantalla de registro y carga la lista de condominios en el selector.
async function irARegistro() {
  $('error-registro').classList.add('oculta');
  const sel = $('registro-condominio');
  sel.innerHTML = '<option value="">Cargando condominios…</option>';
  mostrarVista('vista-registro');
  try {
    const condominios = await api('/api/condominios');
    sel.innerHTML = condominios.length
      ? condominios.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('')
      : '<option value="">(no hay condominios)</option>';
  } catch {
    sel.innerHTML = '<option value="">— sin conexión —</option>';
    errorRegistro('Necesitas conexión para crear tu usuario.');
  }
}

async function registrar() {
  $('error-registro').classList.add('oculta');
  const condominioId = $('registro-condominio').value;
  const codigo = $('registro-codigo').value.trim();
  const nombre = $('registro-nombre').value.trim();
  const usuario = $('registro-usuario').value.trim().toLowerCase();
  const pin = $('registro-pin').value.trim();
  const pin2 = $('registro-pin2').value.trim();
  if (!condominioId) return errorRegistro('Elige tu condominio.');
  if (!codigo) return errorRegistro('Escribe el código del condominio (te lo entrega tu administrador).');
  if (!/^[a-z0-9._-]{3,20}$/.test(usuario)) {
    return errorRegistro('El usuario debe tener 3 a 20 caracteres: letras, números, punto o guión.');
  }
  if (!/^\d{4,8}$/.test(pin)) return errorRegistro('El PIN debe tener entre 4 y 8 números.');
  if (pin !== pin2) return errorRegistro('Los dos PIN no coinciden.');
  try {
    await api('/api/registro', { metodo: 'POST', cuerpo: { condominioId, codigo, usuario, nombre, pin } });
    aviso('Usuario creado. Entrando…', 'ok');
    await iniciarSesionGuardia(usuario, pin);
  } catch (err) {
    errorRegistro(err.status ? err.message : 'No se pudo conectar al servidor.');
  }
}

function salir() {
  if (estado.cola.length && !confirm('Hay marcas sin enviar al servidor. ¿Salir igual?')) return;
  detenerGps();
  api('/api/logout', { metodo: 'POST' }).catch(() => {});
  estado = { sesion: null, paquete: null, ejecucion: null, cola: [], ultimoInforme: null };
  guardarEstado();
  render();
}

async function bajarPaquete(silencioso = false) {
  try {
    estado.paquete = await api('/api/mi/paquete');
    guardarEstado();
    if (!silencioso) aviso('Rondas actualizadas.', 'ok');
  } catch (err) {
    if (!silencioso) aviso('Sin conexión: se usan las rondas ya descargadas.', 'error');
  }
}

// ---------- Ronda ----------

function iniciarRonda(rondaId) {
  const ronda = estado.paquete.rondas.find(r => r.id === rondaId);
  if (!ronda) return;
  if (!ronda.puntos.length) { aviso('Esa ronda no tiene puntos configurados.', 'error'); return; }
  estado.ejecucion = {
    id: crypto.randomUUID(),
    rondaId,
    inicio: new Date().toISOString(),
    escaneos: [],
    cerrada: false
  };
  estado.ultimoInforme = null;
  estado.cola.push({ tipo: 'iniciar', ejecucionId: estado.ejecucion.id, rondaId, inicio: estado.ejecucion.inicio });
  guardarEstado();
  iniciarGps();
  render();
  sincronizar();
}

// Valida un código contra el paquete local y registra la marca.
function procesarCodigo(texto) {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  if (!ejecucion || !ronda || ejecucion.cerrada) return;

  const limpio = String(texto || '').trim();
  let punto = null;
  if (limpio.toUpperCase().startsWith('RQR:')) {
    punto = ronda.puntos.find(p => p.payload === limpio) || null;
    if (!punto) {
      const esDeOtroLado = !estado.paquete.rondas.some(r => r.puntos.some(p => p.payload === limpio));
      aviso(esDeOtroLado ? 'Ese QR no es de este condominio o no existe.' : 'Ese punto no es parte de esta ronda.', 'error');
      navigator.vibrate && navigator.vibrate([80, 60, 80]);
      return;
    }
  } else {
    const codigo = limpio.toUpperCase();
    punto = ronda.puntos.find(p => p.codigoCorto === codigo) || null;
    if (!punto) {
      aviso('Código no reconocido para esta ronda.', 'error');
      navigator.vibrate && navigator.vibrate([80, 60, 80]);
      return;
    }
  }

  if (ejecucion.escaneos.some(e => e.puntoId === punto.id)) {
    aviso(`"${punto.nombre}" ya estaba marcado.`, 'info');
    return;
  }

  // Verificación de presencia BLOQUEANTE (CU-18). Mismo criterio que el servidor,
  // aplicado antes de encolar: el guardia se entera al instante y la marca
  // rechazada nunca entra a la cola offline. Cubre el escaneo por cámara y el
  // código a mano — los dos pasan por acá, así no queda una puerta de atrás.
  if (cfgGps().bloquea) {
    const presencia = verificarPresencia(punto);
    if (presencia && !presencia.ok) {
      aviso(presencia.motivo, 'error', 6000);
      navigator.vibrate && navigator.vibrate([80, 60, 80, 60, 80]);
      pintarGps();
      return;
    }
  }

  const ts = new Date().toISOString();
  const gps = gpsParaMarca(punto);
  ejecucion.escaneos.push({ puntoId: punto.id, ts, offline: !navigator.onLine, gps });
  estado.cola.push({
    tipo: 'escaneo',
    ejecucionId: ejecucion.id,
    codigo: limpio,
    ts,
    offline: !navigator.onLine,
    gps
  });
  guardarEstado();
  navigator.vibrate && navigator.vibrate(120);
  aviso(`✅ ${punto.nombre} (${ejecucion.escaneos.length}/${ronda.puntos.length})`, 'ok');
  render();
  sincronizar();
}

function cerrarRonda() {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  if (!ejecucion || ejecucion.cerrada) return;
  const faltan = ronda.puntos.length - ejecucion.escaneos.length;
  const mensaje = faltan > 0
    ? `Faltan ${faltan} punto(s) por marcar. Si terminas ahora, el informe saldrá INCOMPLETO y se avisará al administrador. ¿Terminar igual?`
    : '¿Terminar la ronda y enviar el informe?';
  if (!confirm(mensaje)) return;
  ejecucion.cerrada = true;
  ejecucion.fin = new Date().toISOString();
  estado.cola.push({ tipo: 'cerrar', ejecucionId: ejecucion.id, fin: ejecucion.fin });
  guardarEstado();
  detenerGps();
  render();
  sincronizar();
}

// ---------- Cola de sincronización ----------

async function sincronizar() {
  if (sincronizando || !estado.sesion || !navigator.onLine) { pintarConexion(); return; }
  sincronizando = true;
  try {
    while (estado.cola.length) {
      const evento = estado.cola[0];
      try {
        if (evento.tipo === 'iniciar') {
          await api('/api/ejecuciones', {
            metodo: 'POST',
            cuerpo: { id: evento.ejecucionId, rondaId: evento.rondaId, inicio: evento.inicio }
          });
        } else if (evento.tipo === 'escaneo') {
          await api(`/api/ejecuciones/${evento.ejecucionId}/escaneos`, {
            metodo: 'POST',
            cuerpo: { codigo: evento.codigo, ts: evento.ts, offline: evento.offline, gps: evento.gps || null }
          });
        } else if (evento.tipo === 'cerrar') {
          const informe = await api(`/api/ejecuciones/${evento.ejecucionId}/cerrar`, {
            metodo: 'POST',
            cuerpo: { fin: evento.fin }
          });
          estado.ultimoInforme = informe;
          if (estado.ejecucion && estado.ejecucion.id === evento.ejecucionId) estado.ejecucion = null;
        }
        estado.cola.shift();
        guardarEstado();
      } catch (err) {
        if (err.status === 401) {
          // Sesión caducada: se conserva la cola y se pide entrar de nuevo.
          estado.sesion = null;
          guardarEstado();
          aviso('La sesión caducó. Entra de nuevo para enviar lo pendiente.', 'error');
          break;
        } else if (err.status) {
          // El servidor rechazó el evento (p. ej. validación): no bloquear la cola.
          console.warn('Evento rechazado por el servidor:', evento, err.message);
          // Una marca rechazada acá ya se le mostró como ✅ al guardia y no va a
          // salir en el informe, así que hay que decírselo. Normalmente no pasa
          // (la app aplica el mismo control antes de encolar); sí ocurre si el
          // administrador movió la ubicación del punto mientras la ronda iba sin
          // señal.
          if (evento.tipo === 'escaneo') {
            aviso(`El servidor rechazó una marca: ${err.message}`, 'error', 7000);
          }
          estado.cola.shift();
          guardarEstado();
        } else {
          break; // sin red: reintentar en el próximo ciclo
        }
      }
    }
  } finally {
    sincronizando = false;
    pintarConexion();
    renderSync();
    if (!document.getElementById('vista-final').classList.contains('oculta')) renderFinal();
  }
}

// ---------- Escáner ----------

async function abrirEscaner() {
  $('modal-escaner').classList.remove('oculta');
  escaneando = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false
    });
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      cicloDetector(detector);
    } else {
      cicloJsqr();
    }
  } catch (err) {
    cerrarEscaner();
    aviso('No se pudo abrir la cámara. Usa el código manual.', 'error');
  }
}

function cerrarEscaner() {
  escaneando = false;
  if (stream) {
    for (const pista of stream.getTracks()) pista.stop();
    stream = null;
  }
  $('modal-escaner').classList.add('oculta');
}

function codigoDetectado(valor) {
  // Evita procesar el mismo QR dos veces seguidas mientras sigue en cámara.
  const ahora = Date.now();
  if (valor === ultimoCodigoLeido.valor && ahora - ultimoCodigoLeido.ts < 2500) return;
  ultimoCodigoLeido = { valor, ts: ahora };
  cerrarEscaner();
  procesarCodigo(valor);
}

function cicloDetector(detector) {
  const video = $('video');
  const paso = async () => {
    if (!escaneando) return;
    try {
      const codigos = await detector.detect(video);
      if (codigos.length && codigos[0].rawValue) return codigoDetectado(codigos[0].rawValue);
    } catch {}
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

function cicloJsqr() {
  const video = $('video');
  const lienzo = $('lienzo');
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  const paso = () => {
    if (!escaneando) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const escala = 480 / video.videoWidth;
      lienzo.width = 480;
      lienzo.height = Math.round(video.videoHeight * escala);
      ctx.drawImage(video, 0, 0, lienzo.width, lienzo.height);
      const imagen = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
      const resultado = window.jsQR && window.jsQR(imagen.data, imagen.width, imagen.height, { inversionAttempts: 'dontInvert' });
      if (resultado && resultado.data) return codigoDetectado(resultado.data);
    }
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- Render ----------

function render() {
  pintarConexion();
  if (!estado.sesion && !estado.paquete) {
    // Sin sesión: primero el selector de rol; el login del guardia después.
    return mostrarVista(rolElegido === 'guardia' ? 'vista-login' : 'vista-rol');
  }
  if (!estado.sesion && estado.cola.length) {
    // Sesión caducada con cola pendiente: pedir login sin perder nada.
    rolElegido = 'guardia';
    mostrarVista('vista-login');
    return;
  }
  if (estado.ejecucion && !estado.ejecucion.cerrada) return renderRonda();
  if (estado.ejecucion && estado.ejecucion.cerrada) return renderFinal();
  if (estado.ultimoInforme) return renderFinal();
  renderInicio();
}

function renderInicio() {
  mostrarVista('vista-inicio');
  $('texto-guardia').textContent = estado.sesion ? estado.sesion.nombre : '';
  $('texto-condominio').textContent = estado.paquete ? estado.paquete.condominio.nombre : '';
  renderSync();

  const contenedor = $('lista-rondas');
  contenedor.innerHTML = '';
  const rondas = estado.paquete ? estado.paquete.rondas : [];
  if (!rondas.length) {
    contenedor.innerHTML = '<p class="nota centrado">No hay rondas configuradas para tu condominio.</p>';
  }
  for (const r of rondas) {
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta';
    const reglas = [
      `${r.puntos.length} puntos`,
      r.ordenEstricto ? 'orden estricto' : 'orden libre',
      r.duracionMaxMin ? `máx ${r.duracionMaxMin} min` : null
    ].filter(Boolean).join(' · ');
    tarjeta.innerHTML = `
      <div class="tarjeta-texto">
        <div class="grande">${r.nombre}</div>
        <div class="nota">${reglas}</div>
      </div>
      <button class="btn btn-principal">Iniciar</button>`;
    tarjeta.querySelector('button').addEventListener('click', () => iniciarRonda(r.id));
    contenedor.appendChild(tarjeta);
  }
  $('texto-paquete').textContent = estado.paquete
    ? `Rondas descargadas: ${new Date(estado.paquete.generado).toLocaleString('es-CL')}`
    : '';
}

function renderSync() {
  const el = $('estado-sync');
  if (!el) return;
  if (estado.cola.length) {
    el.classList.remove('oculta');
    el.textContent = navigator.onLine
      ? `Enviando ${estado.cola.length} registro(s) al servidor…`
      : `${estado.cola.length} registro(s) guardados en el teléfono — se enviarán al volver la señal.`;
  } else {
    el.classList.add('oculta');
  }
}

// Estado del GPS durante la ronda. Con el bloqueo activo el guardia NECESITA
// ver esto: es la diferencia entre "puedo marcar" y "no me va a dejar".
function pintarGps() {
  const el = $('ronda-gps');
  if (!el) return;
  const cfg = cfgGps();
  const ronda = rondaActual();
  const conUbicacion = ronda ? ronda.puntos.filter(p => p.lat != null) : [];
  const anclados = conUbicacion.filter(p => umbralesDe(p).anclado).length;
  if (!cfg.bloquea || !conUbicacion.length) {
    el.textContent = conUbicacion.length
      ? ''
      : 'Ningún punto de esta ronda tiene ubicación fijada: no se verifica por GPS.';
    el.className = 'nota';
    return;
  }
  const ultimo = gpsUltimo();
  const detalleAnclados = anclados
    ? ` · ${anclados} punto(s) bajo techo se marcan con la señal que tomaste en la entrada`
    : '';
  if (!ultimo) {
    el.textContent = `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): ${conUbicacion.length} punto(s) de esta ronda no se podrán marcar hasta que haya señal.`;
    el.className = 'nota nota-alerta';
    return;
  }
  if (ultimo.edadMs <= cfg.frescoMs) {
    el.textContent = `📍 Ubicación activa (±${ultimo.acc != null ? ultimo.acc : '?'} m) · hay que estar a menos de ${cfg.radioOkM} m del punto${detalleAnclados}`;
    el.className = 'nota';
  } else {
    // Señal perdida pero con fix guardado: es la situación normal bajo techo, y
    // el guardia necesita saber cuánto le queda de ventana para los anclados.
    el.textContent = `📍 Sin señal ahora · última ubicación hace ${minutos(ultimo.edadMs)}${anclados ? `, sirve para los ${anclados} punto(s) bajo techo` : ''}. Los puntos a cielo abierto necesitan señal fresca.`;
    el.className = 'nota nota-alerta';
  }
}

function renderRonda() {
  mostrarVista('vista-ronda');
  iniciarGps(); // cubre recarga de página con ronda activa
  const ronda = rondaActual();
  const ejecucion = estado.ejecucion;
  $('ronda-nombre').textContent = ronda.nombre;
  const hechos = ejecucion.escaneos.length;
  $('ronda-avance').textContent = `Iniciada ${hora(ejecucion.inicio)}${ronda.ordenEstricto ? ' · orden estricto' : ''}`;
  $('ronda-progreso').textContent = `${hechos}/${ronda.puntos.length}`;
  pintarGps();

  const lista = $('lista-puntos');
  lista.innerHTML = '';
  const marcados = new Map(ejecucion.escaneos.map(e => [e.puntoId, e]));
  ronda.puntos.forEach((p, i) => {
    const esc = marcados.get(p.id);
    const fila = document.createElement('div');
    fila.className = `punto ${esc ? 'punto-hecho' : ''}`;
    fila.innerHTML = `
      <div class="punto-numero">${i + 1}</div>
      <div class="punto-texto">
        <div>${p.nombre}</div>
        <div class="nota">${esc ? `Marcado ${hora(esc.ts)}${esc.offline ? ' (sin señal)' : ''}` : 'Pendiente'}</div>
      </div>
      <div class="punto-check">${esc ? '✅' : '·'}</div>`;
    lista.appendChild(fila);
  });
}

function renderFinal() {
  mostrarVista('vista-final');
  const informe = estado.ultimoInforme;

  if (informe) {
    const etiquetas = {
      completa: '✅ Ronda completa',
      completa_obs: '🟡 Completa con observaciones',
      sospechosa: '🔴 Ronda con alertas de verificación',
      incompleta: '⚠️ Ronda INCOMPLETA'
    };
    $('final-titulo').textContent = etiquetas[informe.estado] || informe.estado;
    const faltantes = informe.detalle.filter(d => d.faltante);
    let html = `<p class="nota">${informe.ronda} · ${informe.guardia} · ${informe.evaluacion ? informe.evaluacion.duracionMin + ' min' : ''}</p>`;
    if (faltantes.length) {
      html += `<div class="caja caja-alerta"><strong>Puntos sin marcar:</strong><br>${faltantes.map(f => f.nombre).join('<br>')}</div>`;
    }
    if (informe.evaluacion && informe.evaluacion.observaciones.length) {
      html += `<div class="caja">${informe.evaluacion.observaciones.map(o => `• ${o}`).join('<br>')}</div>`;
    }
    html += '<p class="nota centrado">El informe ya le llegó al administrador.</p>';
    $('final-resumen').innerHTML = html;
    $('final-sync').textContent = '';
    return;
  }

  // Cierre aún no sincronizado: resumen local.
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  if (!ejecucion || !ronda) { renderInicio(); return; }
  const marcados = new Set(ejecucion.escaneos.map(e => e.puntoId));
  const faltantes = ronda.puntos.filter(p => !marcados.has(p.id));
  $('final-titulo').textContent = faltantes.length ? '⚠️ Ronda terminada (incompleta)' : '✅ Ronda terminada';
  $('final-resumen').innerHTML = faltantes.length
    ? `<div class="caja caja-alerta"><strong>Puntos sin marcar:</strong><br>${faltantes.map(f => f.nombre).join('<br>')}</div>`
    : '<div class="caja">Todos los puntos quedaron marcados.</div>';
  $('final-sync').textContent = navigator.onLine
    ? 'Enviando el informe al administrador…'
    : 'Sin señal: el informe se enviará automáticamente al volver la conexión.';
}

function volverAlInicio() {
  estado.ultimoInforme = null;
  if (estado.ejecucion && estado.ejecucion.cerrada && !estado.cola.some(e => e.ejecucionId === estado.ejecucion.id)) {
    estado.ejecucion = null;
  }
  guardarEstado();
  bajarPaquete(true).finally(render);
}

// ---------- Arranque ----------

document.addEventListener('DOMContentLoaded', () => {
  $('btn-rol-guardia').addEventListener('click', () => {
    rolElegido = 'guardia';
    render();
    $('campo-usuario').focus();
  });
  $('btn-rol-admin').addEventListener('click', () => { location.href = 'admin.html'; });
  $('btn-volver-rol').addEventListener('click', () => {
    rolElegido = null;
    render();
  });

  // Registro (autoservicio del guardia) — accesible desde la pantalla principal
  $('btn-rol-registro').addEventListener('click', irARegistro);
  $('btn-registrar').addEventListener('click', registrar);
  $('btn-volver-login').addEventListener('click', () => { rolElegido = 'guardia'; render(); });
  $('registro-pin2').addEventListener('keydown', e => { if (e.key === 'Enter') registrar(); });

  // Instalación como app (Chrome/Edge disparan beforeinstallprompt; iOS va a mano).
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    promptInstalacion = e;
    $('btn-instalar').classList.remove('oculta');
  });
  window.addEventListener('appinstalled', () => {
    promptInstalacion = null;
    $('btn-instalar').classList.add('oculta');
    aviso('App instalada: ya la tienes como aplicación propia.', 'ok');
  });
  $('btn-instalar').addEventListener('click', async () => {
    if (!promptInstalacion) return;
    promptInstalacion.prompt();
    await promptInstalacion.userChoice.catch(() => {});
    promptInstalacion = null;
    $('btn-instalar').classList.add('oculta');
  });
  const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const yaInstalada = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (esIos && !yaInstalada) $('nota-instalar-ios').classList.remove('oculta');

  $('btn-login').addEventListener('click', entrar);
  $('campo-pin').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
  $('btn-salir').addEventListener('click', salir);
  $('btn-actualizar').addEventListener('click', () => bajarPaquete().then(render));
  $('btn-escanear').addEventListener('click', abrirEscaner);
  $('btn-cancelar-escaner').addEventListener('click', cerrarEscaner);
  $('btn-manual').addEventListener('click', () => {
    $('campo-codigo').value = '';
    $('modal-manual').classList.remove('oculta');
    $('campo-codigo').focus();
  });
  $('btn-cancelar-manual').addEventListener('click', () => $('modal-manual').classList.add('oculta'));
  $('btn-confirmar-manual').addEventListener('click', () => {
    const codigo = $('campo-codigo').value.trim();
    $('modal-manual').classList.add('oculta');
    if (codigo) procesarCodigo(codigo);
  });
  $('campo-codigo').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-confirmar-manual').click(); });
  $('btn-cerrar-ronda').addEventListener('click', cerrarRonda);
  $('btn-volver').addEventListener('click', volverAlInicio);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('modal-escaner').classList.contains('oculta')) cerrarEscaner();
    if (!$('modal-manual').classList.contains('oculta')) $('modal-manual').classList.add('oculta');
  });

  window.addEventListener('online', () => { pintarConexion(); sincronizar(); });
  window.addEventListener('offline', pintarConexion);
  setInterval(sincronizar, 4000);
  // El fix GPS caduca solo (cfgGps().frescoMs): sin repintar, el guardia
  // seguiría viendo "ubicación activa" cuando ya no le van a aceptar la marca.
  setInterval(pintarGps, 3000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  sincronizar();
});
