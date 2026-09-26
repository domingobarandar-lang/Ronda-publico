// PWA del guardia — local-first:
// - El paquete de rondas se descarga al entrar y queda en localStorage.
// - Los escaneos se validan localmente contra el paquete y se ENCOLAN.
// - Una cola de eventos idempotentes (iniciar / escaneo / rechazo / cerrar) se
//   reenvía al servidor cada pocos segundos; si no hay señal, se reintenta
//   después. Un evento de tipo desconocido cae por todas las ramas y se
//   descarta, así que un teléfono con la app vieja nunca traba la cola.
'use strict';

const CLAVE = 'rondasqr';

let estado = cargarEstado();
let promptInstalacion = null; // evento beforeinstallprompt capturado (Chrome/Edge)
let sincronizando = false;
let stream = null;
let escaneando = false;
let ultimoCodigoLeido = { valor: null, ts: 0 };
let gpsWatchId = null;
let gpsActual = null;
let gpsMotivoFalla = null;
let wakeLock = null;
let wakeLockPidiendo = false;
let wakeLockMotivo = null;
// El buffer de fixes y la marca en espera van como variables de módulo sueltas,
// NO dentro de `estado`: guardarEstado() serializa `estado` entero a
// localStorage en cada marca, y meter ahí veinte lecturas de GPS por segundo
// sería escribir el disco del teléfono a ese ritmo. Mismo precedente que
// gpsActual. Se pierden al recargar, que es lo correcto: son datos del momento.
let bufferFixes = [];
let marcaPendiente = null;
let pendienteTimer = null;

// ---------- GPS (CU-15 / CU-18): se observa desde que hay sesión ----------
// Desde v1.9 el GPS SÍ bloquea. En un punto al que el administrador le fijó
// ubicación, la app no deja marcar si el teléfono está a más del radio
// configurado o si no hay un fix reciente: la foto del QR escaneada desde la
// caseta ya no entra. Los puntos SIN ubicación fijada —los de bajo techo, donde
// el GPS no llega— se marcan igual que antes.
//
// Desde v1.13 el radio no es un número fijo: se le SUMA la imprecisión de las
// dos medidas que se comparan (con qué precisión midió el admin el punto, y con
// qué precisión ve el teléfono ahora). Ver el bloque largo de lib/rondas.js: acá
// va el espejo exacto de ese cálculo, porque la app decide sin conexión.
//
// Desde v1.14 el fix que entra a ese cálculo ya no es UNA lectura del navegador
// sino el promedio de las últimas. El camino completo:
//
//   watchPosition ─▶ bufferFixes[]          lecturas crudas, variable de módulo
//                         │                 (poda al insertar; nunca en `estado`)
//                         ▼
//                  consolidarFixes()        centroide ponderado 1/acc² + ± honesto
//                         │                 (matemática en public/geo.js)
//                         ▼
//                     gpsActual ─▶ gpsUltimo() ─▶ verificarPresencia()
//                                       │              │
//                              piso de precisión       ▼
//                              (espejo del servidor)  ¿ok?  ──sí──▶ registrarMarca()
//                                                      │
//                                                      no
//                                                      ▼
//                                              ¿la espera sirve?
//                                          sí ──▶ marcaPendiente ──▶ evaluarPendiente()
//                                                  (15 s, se acepta sola si entra)
//                                          no ──▶ rechazarMarca() + telemetría
//
// El buffer y la espera viven FUERA del espejo cliente/servidor a propósito:
// verificarPresencia() sigue recibiendo UN fix y devolviendo un veredicto,
// exactamente igual que lib/rondas.js, y paridad-gps.test.js los sigue barriendo
// a los dos con la misma grilla.

// Umbrales que manda el servidor en el paquete. Los defaults calzan con
// configGps() de lib/rondas.js para que un paquete viejo en caché no acepte
// marcas que el servidor va a rechazar después.
function cfgGps() {
  const c = (estado.paquete && estado.paquete.gps) || {};
  return {
    radioOkM: Number.isFinite(c.radioOkM) ? c.radioOkM : 20,
    margenMaxM: Number.isFinite(c.margenMaxM) ? c.margenMaxM : 40,
    precisionMaxM: Number.isFinite(c.precisionMaxM) ? c.precisionMaxM : 100,
    precisionSupuestaM: Number.isFinite(c.precisionSupuestaM) ? c.precisionSupuestaM : 15,
    precisionMinM: Number.isFinite(c.precisionMinM) ? c.precisionMinM : 3,
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
    ventanaMs: Number.isFinite(punto.ventanaMs) ? punto.ventanaMs : cfg.frescoMs,
    // Con qué precisión midió el administrador este punto. null = lo fijó antes
    // de v1.13, sin registrar la calidad: se le asume precisionSupuestaM.
    precisionM: Number.isFinite(punto.precisionM) ? punto.precisionM : null
  };
}

// Espejo de margenM() de lib/rondas.js: la imprecisión perdonada es la del punto
// más la del fix actual, con techo. Ver la explicación larga allá.
function margenM(precisionPuntoM, accFixM) {
  const cfg = cfgGps();
  // Sin dato = precisión DESCONOCIDA, no perfecta: se asume precisionSupuestaM.
  const conocida = v => (Number.isFinite(v) && v >= 0 ? v : cfg.precisionSupuestaM);
  return Math.round(Math.min(conocida(precisionPuntoM) + conocida(accFixM), cfg.margenMaxM));
}

function iniciarGps() {
  if (!('geolocation' in navigator)) {
    gpsMotivoFalla = 'este teléfono no entrega ubicación';
    return;
  }
  if (gpsWatchId !== null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        // null = el teléfono no declaró precisión. NO es lo mismo que 0: se
        // trata como desconocida y el margen cae en precisionSupuestaM.
        acc: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        // pos.timestamp es la hora REAL del fix según el sistema operativo. Usar
        // Date.now() haría pasar por nuevo un fix cacheado que el SO acaba de
        // entregar, y la antigüedad es justo el criterio de un punto anclado.
        // Se acota a "no futuro" por si el reloj del teléfono va adelantado.
        ts: Math.min(pos.timestamp || Date.now(), Date.now())
      };
      // El fix crudo entra al buffer; lo que se usa para decidir es el
      // consolidado. consolidarFixes() nunca devuelve null con el buffer recién
      // alimentado, pero si algún día lo hiciera, perder el fix anterior sería
      // perder el ancla de un punto bajo techo.
      agregarFix(fix);
      const consolidado = consolidarFixes(bufferFixes, Date.now());
      if (consolidado) gpsActual = consolidado;
      gpsMotivoFalla = null;
      // Una marca esperando señal se resuelve con el fix nuevo, no en el próximo
      // tick: si ya alcanza, el guardia no tiene que esperar el segundo entero.
      if (marcaPendiente) revisarPendiente();
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
    // maximumAge: 0 — no se acepta el fix cacheado del sistema. El GPS converge
    // de a poco (el primero suele ser de WiFi o antena, con ±50-500 m) y acá el
    // dato barato es justo el que arruina la verificación.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

// Cuántas lecturas se guardan como mucho. A un fix por segundo la ventana de
// frescura se llena con ~20; el techo es para el teléfono que dispara más rápido
// y para que un watch olvidado no crezca sin fin.
const BUFFER_MAX = 60;

// Poda al insertar: se conservan solo las lecturas contemporáneas de la más
// nueva. Se poda acá y no al consolidar porque el buffer se lee muchas más veces
// de las que se escribe.
function agregarFix(fix) {
  bufferFixes.push(fix);
  const tsMax = bufferFixes.reduce((max, f) => Math.max(max, f.ts), 0);
  bufferFixes = bufferFixes.filter(f => tsMax - f.ts <= cfgGps().frescoMs);
  if (bufferFixes.length > BUFFER_MAX) bufferFixes = bufferFixes.slice(-BUFFER_MAX);
}

// Convierte el buffer en UN fix, que es lo único que ve el resto de la app —y el
// servidor—. Vive río arriba del espejo: verificarPresencia() sigue recibiendo un
// fix y devolviendo un veredicto, igual que lib/rondas.js.
//
// Hasta v1.13 acá había un mejorFix() que conservaba la mejor lectura única. La
// razón de existir de esa función se conserva entera: el GPS no mejora
// monótonamente —después de un fix de satélite de ±6 m puede llegar uno de red
// de ±300 m— y quedarse con el ÚLTIMO haría que la app pase sola de "puedes
// marcar" a "estás a 200 m". Ahora eso lo hace el peso 1/acc²: la lectura de
// ±300 m pesa 2.500 veces menos que la de ±6 y no mueve el centroide. Y la
// ventana es la misma: pasada la frescura, las lecturas viejas salen del buffer
// y el fix nuevo manda aunque sea peor, porque después de eso el guardia
// probablemente ya se movió.
//
// Devuelve null con el buffer vacío. NUNCA {lat: NaN}: eso haría NaN la
// distancia, `NaN <= topeM` sería false, y el guardia quedaría bloqueado sin
// entender por qué.
function consolidarFixes(buffer, ahora) {
  if (!Array.isArray(buffer) || !buffer.length) return null;
  const cfg = cfgGps();
  const tsMax = buffer.reduce((max, f) => Math.max(max, f.ts), 0);
  const muestras = geo.filtrarOutliers(buffer.filter(f => tsMax - f.ts <= cfg.frescoMs));
  const centro = geo.centroidePonderado(muestras, cfg.precisionMinM);
  if (!centro) return null;
  // Si NINGUNA lectura declaró precisión, la del conjunto sigue siendo
  // desconocida: declararla por la dispersión sería inventar confianza sobre
  // datos de calidad ignorada. null hace que margenM() asuma precisionSupuestaM,
  // que es exactamente lo que corresponde.
  const declaradas = muestras.some(m => Number.isFinite(m.acc));
  return {
    lat: centro.lat,
    lon: centro.lon,
    acc: declaradas ? geo.precisionHonesta(muestras, centro) : null,
    // La edad del conjunto es la de la lectura más nueva; el error que agrega
    // promediar sobre la ventana ya está pagado en el ± de precisionHonesta,
    // que sube cuando el guardia venía caminando. Se acota a "no futuro" por si
    // el reloj del teléfono va adelantado.
    ts: Math.min(tsMax, ahora)
  };
}

function detenerGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = null;
  gpsActual = null;
  gpsMotivoFalla = null;
  bufferFixes = [];
  liberarWakeLock();
}

// Vuelve a enganchar el watch SIN borrar lo que ya se sabe. Es la diferencia con
// detenerGps(): en un punto anclado el fix tomado en la entrada es la prueba, y
// tirarlo porque el navegador mató el watch en segundo plano dejaría al guardia
// sin poder marcar el subterráneo al que acaba de bajar.
function reiniciarGps() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = null;
  iniciarGps();
}

// ---------- Wake Lock (v1.14) ----------
// Con la pantalla apagada el navegador estrangula o mata el watch de ubicación,
// y el guardia camina media ronda sin que nadie le siga la pista. El Wake Lock
// mantiene la pantalla encendida mientras hay ronda activa.
//
// Lo que NO hace, para que quede escrito: no da ubicación en segundo plano, y si
// el guardia bloquea el teléfono a mano el lock se libera igual. Ayuda mucho, no
// resuelve el 100%. Y cuesta batería: es el precio de no perder la ronda.
async function pedirWakeLock() {
  if (wakeLock || wakeLockPidiendo) return;
  if (!('wakeLock' in navigator)) {
    wakeLockMotivo = 'este teléfono no lo permite';
    return;
  }
  // request() es asíncrono: sin esta bandera, el repintado de en medio le
  // mostraría al guardia la advertencia de "la pantalla se puede apagar" en cada
  // arranque de ronda, un segundo antes de que el lock quede concedido.
  wakeLockPidiendo = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLockMotivo = null;
    // El sistema lo suelta solo (pantalla apagada a mano, batería baja): sin
    // esto la app seguiría creyendo que lo tiene.
    wakeLock.addEventListener('release', () => { wakeLock = null; pintarGps(); });
  } catch {
    wakeLock = null;
    wakeLockMotivo = 'el sistema no lo permitió';
  }
  wakeLockPidiendo = false;
  pintarGps();
}

function liberarWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch { /* ya estaba suelto */ } }
  wakeLock = null;
  wakeLockPidiendo = false;
  wakeLockMotivo = null;
}

// Último fix conocido con su antigüedad, sin filtrar. Quién puede usarlo y hasta
// qué edad lo decide cada punto: 20 s en uno exacto, 15 min en uno anclado.
//
// Espejo de limpiarGps() de lib/rondas.js, incluido su piso de precisión: es el
// punto por donde el fix sale hacia la decisión y hacia el servidor, así que el
// número que se declara acá tiene que ser el mismo que el servidor va a usar.
// Un acc de 0 no es un fix perfecto, es un teléfono que no sabe.
function gpsUltimo() {
  if (!gpsActual) return null;
  const cfg = cfgGps();
  return {
    lat: gpsActual.lat,
    lon: gpsActual.lon,
    acc: Number.isFinite(gpsActual.acc) && gpsActual.acc >= 0
      ? Math.max(Math.round(gpsActual.acc), cfg.precisionMinM)
      : null,
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

// Qué ubicación se adjunta a la marca: EXACTAMENTE la misma con la que
// verificarPresencia() dio el veredicto. Que estas dos funciones usaran
// criterios distintos era un bug silencioso y del peor tipo — la app aceptaba
// (mirando la ventana del punto) y adjuntaba `null` (mirando solo `anclado`),
// así que el guardia veía el ✅ y el servidor rechazaba la marca después: punto
// hecho que no salía en el informe. Pasaba en cualquier punto EXACTO con ventana
// propia mayor que frescoMs, y el test de paridad no podía verlo porque esta
// función queda fuera del par espejado.
//
// La regla es una sola: si el fix sirvió para decidir, sirve para viajar.
// edadMs viaja como duración, así el reenvío desde la cola offline horas después
// sigue informando la misma antigüedad del momento del escaneo.
function gpsParaMarca(punto) {
  // Punto sin ubicación fijada: no hay nada que verificar y el fix va solo como
  // dato informativo, si es reciente.
  if (punto.lat == null || punto.lon == null) return gpsFresco();
  const g = gpsUltimo();
  if (!g) return null;
  return g.edadMs <= umbralesDe(punto).ventanaMs ? g : null;
}

// Espejo de verificarPresencia() de lib/rondas.js. null = el punto no tiene
// ubicación fijada, no hay nada que verificar.
//
// El fix llega por parámetro —igual que en el servidor— para poder re-evaluar
// una marca en espera con la señal nueva sin depender de cuándo se pintó la
// pantalla. Sin argumento usa el último conocido, que es el caso normal.
// Los campos del veredicto (distancia, tope, señal) alimentan la decisión de
// reintentar y el registro de rechazos: sin ellos el motivo es solo un texto.
function verificarPresencia(punto, fix = gpsUltimo()) {
  if (punto.lat == null || punto.lon == null) return null;
  const cfg = cfgGps();
  const { anclado, radioM, ventanaMs, precisionM } = umbralesDe(punto);
  const g = fix;
  if (!g) {
    return {
      ok: false,
      sinGps: true,
      motivo: anclado
        ? `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): para "${punto.nombre}" el teléfono tiene que haber tomado señal en la entrada. Actívala antes de iniciar la ronda.`
        : `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): "${punto.nombre}" no se puede marcar hasta confirmar que estás ahí.`
    };
  }
  if (g.edadMs > ventanaMs) {
    return {
      ok: false,
      vencido: true,
      anclado,
      acc: g.acc,
      edadMs: g.edadMs,
      motivo: anclado
        ? `📍 Tu última ubicación es de hace ${minutos(g.edadMs)} y el máximo para "${punto.nombre}" son ${minutos(ventanaMs)}. Sal a donde haya señal y vuelve a entrar.`
        : `📍 Tu ubicación es de hace ${minutos(g.edadMs)}: hace falta una más reciente para marcar "${punto.nombre}".`
    };
  }
  // Fix de WiFi o antena: la distancia calculada con eso es ruido. Se dice qué
  // pasa en vez de mandar a "acercarse" a alguien que ya está encima del punto.
  if (g.acc != null && g.acc > cfg.precisionMaxM) {
    return {
      ok: false,
      impreciso: true,
      acc: g.acc,
      edadMs: g.edadMs,
      motivo: `📍 Señal demasiado imprecisa (±${g.acc} m) para confirmar que estás en "${punto.nombre}". Espera unos segundos a que el GPS afine y vuelve a escanear.`
    };
  }
  const d = distanciaM(g, punto);
  const topeM = radioM + margenM(precisionM, g.acc);
  const senal = g.acc != null ? ` (señal ±${g.acc} m)` : '';
  return {
    ok: d <= topeM,
    distanciaM: d,
    topeM,
    acc: g.acc,
    edadMs: g.edadMs,
    motivo: anclado
      ? `📍 Estás a ${d} m de la entrada de "${punto.nombre}" y el máximo es ${topeM} m${senal}. Pasa por la entrada del recinto y vuelve a escanear.`
      : `📍 Estás a ${d} m de "${punto.nombre}" y el máximo es ${topeM} m${senal}. Acércate, o espera unos segundos a que mejore la señal.`
  };
}

// ---------- Marca en espera de señal (v1.14) ----------
// Hasta v1.13 un rechazo era seco: aviso y a escanear de nuevo. Pero la causa
// más común no es que el guardia esté lejos, es que el GPS todavía no converge —
// y en 10 segundos más habría alcanzado. El escaneo queda PENDIENTE, se
// re-evalúa con cada fix nuevo y se acepta solo si el criterio se cumple dentro
// de la ventana.
//
// El criterio NO se afloja: se le da tiempo a cumplirse. La espera solo puede
// favorecer a quien está caminando HACIA el punto.
const VENTANA_PENDIENTE_MS = 15000;

// Reducer puro: sin DOM, sin timers, sin tocar `estado`. Es el único camino nuevo
// que decide si una marca cuenta o no, así que tiene que poder probarse entero.
//   { accion: 'aceptar' }              el criterio se cumplió a tiempo
//   { accion: 'esperar', restanteMs }  todavía no, pero queda plazo
//   { accion: 'rechazar', motivo }     se acabó el plazo (o no hay qué evaluar)
function evaluarPendiente(pendiente, fixNuevo, ahora) {
  if (!pendiente || !pendiente.punto) {
    // Sin marca en espera no hay nada que aceptar. Pasa cuando el guardia cierra
    // la ronda con una marca afinando señal: el pendiente se borra y lo que
    // quede en vuelo tiene que morir acá, nunca colarse como aceptado.
    return { accion: 'rechazar', motivo: 'La marca quedó sin confirmar: vuelve a escanear el QR.' };
  }
  const veredicto = verificarPresencia(pendiente.punto, fixNuevo);
  const restanteMs = pendiente.desde + VENTANA_PENDIENTE_MS - ahora;
  // El plazo se mira ANTES que el veredicto, a propósito: una señal que recién
  // entra pasado el plazo no rescata la marca. Si no, la ventana no sería una
  // ventana sino una espera indefinida disfrazada.
  if (restanteMs <= 0) {
    return { accion: 'rechazar', motivo: (veredicto && veredicto.motivo) || pendiente.motivo, veredicto };
  }
  if (!veredicto || veredicto.ok) return { accion: 'aceptar', veredicto };
  return { accion: 'esperar', restanteMs, motivo: veredicto.motivo, veredicto };
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

// Escapa texto que va a parar a innerHTML. Mismo helper que admin.js y
// fabrica.js: esta app era la única de las tres sin él, y es la que muestra
// nombres que NO controla —el condominio en la pantalla de registro (que es
// pública y sin sesión), y los nombres de ronda, punto y observación que
// escribe el administrador—. Un nombre con `<` rompía el HTML en el mejor caso.
function esc(texto) {
  const div = document.createElement('div');
  div.textContent = String(texto == null ? '' : texto);
  return div.innerHTML;
}

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
  // Esta app es solo del guardia. El administrador tiene la suya (/panel): acá
  // no se le redirige solo, se le dice dónde entrar para que guarde ESE acceso.
  if (r.rol !== 'guardia') {
    const err = new Error('Ese usuario es de administrador: el panel se abre aparte.');
    err.status = 403;
    err.esAdmin = true;
    throw err;
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
    el.textContent = err.esAdmin
      ? 'Ese usuario es de administrador: entra con el botón «Soy administrador» de abajo.'
      : err.status ? err.message : 'No se pudo conectar al servidor.';
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
      ? condominios.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('')
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
  olvidarPendiente();
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
  pedirWakeLock();
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

  // Ese punto ya está esperando señal: volver a escanearlo no la mejora, y
  // reiniciar el plazo sería regalar tiempo infinito escaneando en loop.
  if (marcaPendiente && marcaPendiente.punto.id === punto.id) {
    aviso(`📍 "${punto.nombre}" ya está esperando señal. Quédate quieto unos segundos.`, 'info');
    return;
  }

  // Verificación de presencia BLOQUEANTE (CU-18). Mismo criterio que el servidor,
  // aplicado antes de encolar: el guardia se entera al instante y la marca
  // rechazada nunca entra a la cola offline. Cubre el escaneo por cámara y el
  // código a mano — los dos pasan por acá, así no queda una puerta de atrás.
  if (cfgGps().bloquea) {
    const presencia = verificarPresencia(punto);
    if (presencia && !presencia.ok) {
      if (esperaSirve(presencia)) return dejarPendiente(punto, limpio, presencia);
      return rechazarMarca(punto, presencia);
    }
  }

  registrarMarca(punto, limpio);
}

// ¿Esperar unos segundos puede cambiar este veredicto? Sí cuando el problema es
// la señal (no hay, es vieja, es de antena) y cuando la distancia está dentro de
// lo que un fix malo puede estar equivocado. Más allá de eso la distancia no es
// error de medición, es distancia real: hacer esperar a alguien que está a tres
// cuadras solo le hace perder tiempo antes del mismo "no".
function esperaSirve(presencia) {
  // Excepción: en un punto ANCLADO "vencido" significa que el fix de la entrada
  // tiene más de 15 minutos. Quince segundos quietos no arreglan eso, y mientras
  // tanto la pantalla le diría "quédate quieto" cuando el veredicto le está
  // diciendo "sal a donde haya señal". Se le da el mensaje correcto de una vez.
  if (presencia.vencido) return !presencia.anclado;
  if (presencia.sinGps || presencia.impreciso) return true;
  if (presencia.distanciaM == null) return false;
  return presencia.distanciaM <= presencia.topeM + cfgGps().precisionMaxM;
}

function dejarPendiente(punto, codigo, presencia) {
  // Solo una marca en espera a la vez. Si había otra, el guardia ya se movió
  // hasta este punto: la anterior no va a mejorar. Se cierra como rechazo —con
  // su registro— y se le dice, en vez de dejarla morir en silencio.
  const desplazada = marcaPendiente;
  if (desplazada) registrarRechazo(desplazada.punto, desplazada.ultimo || { motivo: desplazada.motivo });
  marcaPendiente = { punto, codigo, desde: Date.now(), motivo: presencia.motivo, ultimo: presencia };
  clearInterval(pendienteTimer);
  // También corre sin fixes nuevos: si el GPS se calló del todo, el plazo tiene
  // que vencer igual y decírselo al guardia.
  pendienteTimer = setInterval(revisarPendiente, 1000);
  navigator.vibrate && navigator.vibrate(60);
  aviso(`📍 Afinando señal para "${punto.nombre}"… ${VENTANA_PENDIENTE_MS / 1000} s`
    + (desplazada ? ` · "${desplazada.punto.nombre}" quedó SIN marcar, vuelve a escanearlo` : ''),
    desplazada ? 'error' : 'info', desplazada ? 6000 : 1500);
  pintarGps();
}

function olvidarPendiente() {
  clearInterval(pendienteTimer);
  pendienteTimer = null;
  marcaPendiente = null;
}

function pintarPendiente(restanteMs) {
  const punto = marcaPendiente ? marcaPendiente.punto.nombre : '';
  aviso(`📍 Afinando señal para "${punto}"… ${Math.ceil(restanteMs / 1000)} s`, 'info', 1500);
}

// Corre con cada fix nuevo y una vez por segundo. Solo llama al reducer y pinta.
function revisarPendiente() {
  if (!marcaPendiente) { olvidarPendiente(); return; }
  const pendiente = marcaPendiente;
  const r = evaluarPendiente(pendiente, gpsUltimo(), Date.now());
  if (r.veredicto) pendiente.ultimo = r.veredicto;
  if (r.accion === 'esperar') { pintarPendiente(r.restanteMs); return; }
  olvidarPendiente();
  if (r.accion === 'aceptar') registrarMarca(pendiente.punto, pendiente.codigo);
  else rechazarMarca(pendiente.punto, pendiente.ultimo || { motivo: r.motivo });
}

// Encola la marca. Es el único camino por el que un escaneo entra a la ronda:
// llegue directo o después de esperar señal, el estado queda igual.
function registrarMarca(punto, codigo) {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  // Entre el escaneo y la aceptación pasaron segundos: la ronda pudo cerrarse y
  // el punto pudo marcarse por otra vía.
  if (!ejecucion || !ronda || ejecucion.cerrada) return;
  if (ejecucion.escaneos.some(e => e.puntoId === punto.id)) return;

  const ts = new Date().toISOString();
  const gps = gpsParaMarca(punto);
  ejecucion.escaneos.push({ puntoId: punto.id, ts, offline: !navigator.onLine, gps });
  estado.cola.push({
    tipo: 'escaneo',
    ejecucionId: ejecucion.id,
    codigo,
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

// Rechazo definitivo: se le dice al guardia y queda el registro.
function rechazarMarca(punto, presencia) {
  aviso(presencia.motivo || 'No se pudo confirmar tu ubicación.', 'error', 6000);
  navigator.vibrate && navigator.vibrate([80, 60, 80, 60, 80]);
  registrarRechazo(punto, presencia);
  pintarGps();
}

// La telemetría del rechazo, aparte del aviso porque no siempre hay a quién
// avisarle (una marca desplazada por otra ya perdió la pantalla). Este dato no
// existía —el rechazo moría en el teléfono— y es el que faltaba para que el
// próximo ajuste de umbrales no sea otra corrección a ciegas como la de v1.13.
function registrarRechazo(punto, presencia) {
  if (estado.ejecucion && !estado.ejecucion.cerrada) {
    estado.cola.push({
      tipo: 'rechazo',
      ejecucionId: estado.ejecucion.id,
      puntoId: punto.id,
      ts: new Date().toISOString(),
      motivo: presencia.motivo || null,
      distanciaM: presencia.distanciaM != null ? presencia.distanciaM : null,
      topeM: presencia.topeM != null ? presencia.topeM : null,
      acc: presencia.acc != null ? presencia.acc : null,
      edadMs: presencia.edadMs != null ? presencia.edadMs : null
    });
    guardarEstado();
    sincronizar();
  }
  pintarGps();
}

function cerrarRonda() {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  if (!ejecucion || ejecucion.cerrada) return;
  const faltan = ronda.puntos.length - ejecucion.escaneos.length;
  // Cerrar con una marca esperando señal es perderla. Se dice ANTES, con nombre
  // y apellido: son diez segundos de espera contra un punto menos en el informe.
  const enEspera = marcaPendiente
    ? `"${marcaPendiente.punto.nombre}" todavía está esperando señal y NO va a quedar marcado.\n\n`
    : '';
  const mensaje = faltan > 0
    ? `${enEspera}Faltan ${faltan} punto(s) por marcar. Si terminas ahora, el informe saldrá INCOMPLETO y se avisará al administrador. ¿Terminar igual?`
    : `${enEspera}¿Terminar la ronda y enviar el informe?`;
  if (!confirm(mensaje)) return;
  // Se registra como rechazo antes de soltarlo: una marca que el guardia
  // intentó y el sistema no aceptó es justo el dato que hay que contar.
  if (marcaPendiente) {
    const perdida = marcaPendiente;
    olvidarPendiente();
    rechazarMarca(perdida.punto, perdida.ultimo || { motivo: perdida.motivo });
  }
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
        } else if (evento.tipo === 'rechazo') {
          await api(`/api/ejecuciones/${evento.ejecucionId}/rechazos`, {
            metodo: 'POST',
            cuerpo: {
              puntoId: evento.puntoId,
              ts: evento.ts,
              motivo: evento.motivo,
              distanciaM: evento.distanciaM,
              topeM: evento.topeM,
              acc: evento.acc,
              edadMs: evento.edadMs
            }
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
  // Sin sesión se entra por el login (la app es solo del guardia, ya no hay
  // selector de perfil). Con la sesión caducada y cola pendiente también: la
  // cola se conserva y se envía apenas vuelve a entrar.
  if (!estado.sesion && (!estado.paquete || estado.cola.length)) return mostrarVista('vista-login');
  if (estado.ejecucion && !estado.ejecucion.cerrada) return renderRonda();
  if (estado.ejecucion && estado.ejecucion.cerrada) return renderFinal();
  if (estado.ultimoInforme) return renderFinal();
  renderInicio();
}

function renderInicio() {
  mostrarVista('vista-inicio');
  // El GPS se enciende con la sesión, no con la ronda (decisión 5A): el primer
  // punto es el que más se marca en todo el sistema y era el que siempre se
  // escaneaba con el receptor recién despertado. El costo asumido es batería —
  // si duele en terreno, acá es donde se acota.
  iniciarGps();
  $('texto-guardia').textContent = estado.sesion ? estado.sesion.nombre : '';
  $('texto-condominio').textContent = estado.paquete ? estado.paquete.condominio.nombre : '';
  renderSync();
  pintarGpsInicio();

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
        <div class="grande">${esc(r.nombre)}</div>
        <div class="nota">${esc(reglas)}</div>
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

// Estado del GPS ANTES de iniciar la ronda. Sin esto, encender el receptor al
// entrar sería una batería que se gasta sin que nadie sepa por qué, y el guardia
// no tendría cómo saber que le conviene esperar unos segundos antes de partir.
function pintarGpsInicio() {
  const el = $('inicio-gps');
  if (!el) return;
  if (!estado.sesion || !cfgGps().bloquea) { el.textContent = ''; return; }
  // gpsFresco() y no gpsUltimo(): un fix de hace diez minutos no es "señal
  // lista". Decirle al guardia que el GPS está caliente cuando está frío es
  // exactamente el engaño que este release vino a sacar.
  const fresco = gpsFresco();
  if (!fresco) {
    const viejo = gpsUltimo();
    el.textContent = viejo
      ? `📍 Buscando señal · la última ubicación es de hace ${minutos(viejo.edadMs)}.`
      : `📍 Buscando señal (${gpsMotivoFalla || 'el GPS está despertando'}).`;
    el.className = 'nota nota-alerta';
    return;
  }
  el.textContent = fresco.acc != null
    ? `📍 Señal lista (±${fresco.acc} m): el GPS ya está caliente para el primer punto.`
    : '📍 Señal lista.';
  el.className = 'nota';
}

// Cuánto le queda de vida útil al Wake Lock, dicho para el guardia. Si falla
// tiene que enterarse: la degradación silenciosa acá significa que camina media
// ronda con la pantalla apagada y el watch muerto, y se entera al final.
function textoWakeLock() {
  const enRonda = estado.ejecucion && !estado.ejecucion.cerrada;
  if (!enRonda || wakeLock || wakeLockPidiendo) return '';
  return ` · ⚠️ la pantalla se puede apagar sola${wakeLockMotivo ? ` (${wakeLockMotivo})` : ''}`
    + ': déjala encendida o el GPS deja de seguirte';
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
  const pantalla = textoWakeLock();
  // Una marca esperando señal manda sobre todo lo demás: es lo único que el
  // guardia tiene que mirar en ese momento.
  if (marcaPendiente) {
    const restanteS = Math.max(0, Math.ceil((marcaPendiente.desde + VENTANA_PENDIENTE_MS - Date.now()) / 1000));
    el.textContent = `📍 Afinando señal para "${marcaPendiente.punto.nombre}"… ${restanteS} s.`
      + ' Quédate quieto: si la señal entra, la marca se registra sola.' + pantalla;
    el.className = 'nota nota-alerta';
    return;
  }
  if (!ultimo) {
    el.textContent = `📍 Sin ubicación (${gpsMotivoFalla || 'buscando señal'}): ${conUbicacion.length} punto(s) de esta ronda no se podrán marcar hasta que haya señal.${pantalla}`;
    el.className = 'nota nota-alerta';
    return;
  }
  if (ultimo.acc != null && ultimo.acc > cfg.precisionMaxM) {
    // Hay ubicación, pero es de WiFi/antena: no sirve para verificar nada. Vale
    // decirlo antes de que el guardia camine hasta el punto y no pueda marcar.
    el.textContent = `📍 Señal imprecisa (±${ultimo.acc} m): todavía no alcanza para marcar. Espera unos segundos a que el GPS afine, mejor a cielo abierto.${pantalla}`;
    el.className = 'nota nota-alerta';
  } else if (ultimo.edadMs <= cfg.frescoMs) {
    // El tope real depende de la señal del momento y de cómo se midió cada
    // punto, así que se muestra el del punto más exigente de la ronda: es el
    // número con el que el guardia se va a topar primero.
    const topes = conUbicacion
      .filter(p => !umbralesDe(p).anclado)
      .map(p => umbralesDe(p).radioM + margenM(umbralesDe(p).precisionM, ultimo.acc));
    const tope = topes.length ? Math.min(...topes) : null;
    el.textContent = `📍 Ubicación activa (±${ultimo.acc != null ? ultimo.acc : '?'} m)`
      + (tope != null ? ` · con esta señal hay que estar a menos de ${tope} m del punto` : '')
      + detalleAnclados + pantalla;
    el.className = pantalla ? 'nota nota-alerta' : 'nota';
  } else {
    // Señal perdida pero con fix guardado: es la situación normal bajo techo, y
    // el guardia necesita saber cuánto le queda de ventana para los anclados.
    el.textContent = `📍 Sin señal ahora · última ubicación hace ${minutos(ultimo.edadMs)}${anclados ? `, sirve para los ${anclados} punto(s) bajo techo` : ''}. Los puntos a cielo abierto necesitan señal fresca.${pantalla}`;
    el.className = 'nota nota-alerta';
  }
}

function renderRonda() {
  mostrarVista('vista-ronda');
  iniciarGps();     // cubre recarga de página con ronda activa
  pedirWakeLock();  // ídem: el lock no sobrevive a una recarga
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
    // `marca`, no `esc`: esta variable se llamaba igual que el helper de
    // escapado y lo dejaba tapado justo donde hace falta.
    const marca = marcados.get(p.id);
    const fila = document.createElement('div');
    fila.className = `punto ${marca ? 'punto-hecho' : ''}`;
    fila.innerHTML = `
      <div class="punto-numero">${i + 1}</div>
      <div class="punto-texto">
        <div>${esc(p.nombre)}</div>
        <div class="nota">${marca ? `Marcado ${esc(hora(marca.ts))}${marca.offline ? ' (sin señal)' : ''}` : 'Pendiente'}</div>
      </div>
      <div class="punto-check">${marca ? '✅' : '·'}</div>`;
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
    let html = `<p class="nota">${esc(informe.ronda)} · ${esc(informe.guardia)} · ${informe.evaluacion ? esc(informe.evaluacion.duracionMin + ' min') : ''}</p>`;
    if (faltantes.length) {
      html += `<div class="caja caja-alerta"><strong>Puntos sin marcar:</strong><br>${faltantes.map(f => esc(f.nombre)).join('<br>')}</div>`;
    }
    if (informe.evaluacion && informe.evaluacion.observaciones.length) {
      html += `<div class="caja">${informe.evaluacion.observaciones.map(o => `• ${esc(o)}`).join('<br>')}</div>`;
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
    ? `<div class="caja caja-alerta"><strong>Puntos sin marcar:</strong><br>${faltantes.map(f => esc(f.nombre)).join('<br>')}</div>`
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
  // Registro (autoservicio del guardia) — accesible desde la pantalla de entrada
  $('btn-ir-registro').addEventListener('click', irARegistro);
  $('btn-registrar').addEventListener('click', registrar);
  $('btn-volver-login').addEventListener('click', render);
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

  // Volver del segundo plano. El navegador estrangula —o mata— el watch de
  // ubicación con la pantalla apagada, y hasta v1.13 nadie lo revivía: el
  // guardia desbloqueaba el teléfono, escaneaba, y la app le decía "sin señal"
  // con el GPS técnicamente encendido. También se re-pide el Wake Lock, que el
  // sistema libera solo al ocultarse la página.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !estado.sesion) return;
    if (gpsWatchId === null || !gpsFresco()) reiniciarGps();
    if (estado.ejecucion && !estado.ejecucion.cerrada) pedirWakeLock();
    pintarGps();
    pintarGpsInicio();
  });

  window.addEventListener('online', () => { pintarConexion(); sincronizar(); });
  window.addEventListener('offline', pintarConexion);
  setInterval(sincronizar, 4000);
  // El fix GPS caduca solo (cfgGps().frescoMs): sin repintar, el guardia
  // seguiría viendo "ubicación activa" cuando ya no le van a aceptar la marca.
  setInterval(() => { pintarGps(); pintarGpsInicio(); }, 3000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  sincronizar();
});
