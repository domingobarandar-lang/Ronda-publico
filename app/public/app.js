// PWA del guardia — local-first:
// - El paquete de rondas se descarga al entrar y queda en localStorage.
// - Los escaneos se validan localmente contra el paquete y se ENCOLAN.
// - Una cola de eventos idempotentes (iniciar / escaneo / rechazo / cerrar) se
//   reenvía al servidor cada pocos segundos; si no hay señal, se reintenta
//   después. Un evento de tipo desconocido cae por todas las ramas y se
//   descarta, así que un teléfono con la app vieja nunca traba la cola.
'use strict';

const CLAVE = 'rondasqr';
// VERSION_APP: subirla en cada release junto con package.json, sw.js, el
// <meta name="version-app"> de index.html y --version-app de estilos.css (los
// fija sw-shell.test.js). Es lo que la app compara con el servidor para
// recargarse sola (revisarVersion) y con la página y los estilos para saber si
// el service worker le sirvió una mezcla de versiones (shellMixto).
const VERSION_APP = 'v1.26.0';

let estado = cargarEstado();
let promptInstalacion = null; // evento beforeinstallprompt capturado (Chrome/Edge)
let sincronizando = false;
let stream = null;
let escaneando = false;
let ultimoCodigoLeido = { valor: null, ts: 0 };
let lectorNfc = null;  // AbortController del lector de chapitas en curso (CU-28)
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
// QR ya leído cuya marca no se pudo confirmar por señal (v1.21). Mismo criterio
// que marcaPendiente: variable de módulo, nunca dentro de `estado`.
let marcaRetenida = null;
// Cuándo LLEGÓ la última lectura del watch y cuándo se enganchó, en reloj del
// teléfono. No es el ts del fix: acá se mide si el watch sigue hablando.
let gpsUltimaLecturaMs = 0;
let gpsEnganchadoMs = 0;
let gpsPermisoNegado = false;

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
  gpsEnganchadoMs = Date.now();
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      gpsUltimaLecturaMs = Date.now();
      gpsPermisoNegado = false;
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        // null = el teléfono no declaró precisión. NO es lo mismo que 0: se
        // trata como desconocida y el margen cae en precisionSupuestaM.
        acc: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        // pos.timestamp es la hora REAL del fix según el sistema operativo. Usar
        // Date.now() haría pasar por nuevo un fix cacheado que el SO acaba de
        // entregar, y la antigüedad es justo el criterio de un punto anclado.
        // Se acota a "no futuro" por si el reloj del teléfono va ATRASADO
        // respecto del que estampó el fix. Con el reloj adelantado el fix nace
        // viejo y esto no lo corrige: ahí los rechazos traen un edadMs casi fijo.
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
      gpsPermisoNegado = Boolean(err && err.code === 1);
      gpsMotivoFalla = gpsPermisoNegado
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
    // el reloj del teléfono va atrasado respecto del fix.
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
  gpsUltimaLecturaMs = 0;
  gpsPermisoNegado = false;
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

// ---------- Vigía del watch (v1.21) ----------
// watchPosition avisa cuando la posición CAMBIA, y hay teléfonos que con el
// guardia parado frente al punto dejan de avisar. Mientras tanto el fix
// envejece, pasa la frescura y la marca se rechaza por "ubicación de hace 25 s"
// a alguien que no se movió del QR. Si el watch habló y se calló la mitad de la
// frescura, se vuelve a enganchar: con maximumAge 0 el enganche entrega una
// lectura nueva, y alcanza a llegar antes de que la anterior venza.
//
// Dos cuidados, los dos aprendidos en la revisión de esta versión:
//   · Un watch que TODAVÍA NO habló desde que se enganchó no está callado, está
//     adquiriendo. Cortarlo a los 10 s reinicia la búsqueda, y un GPS que
//     necesita 20 s seguidos (cielo parcial, salida de un subterráneo) no
//     llegaría nunca. A ese se le da más que su propio timeout de 15 s.
//   · Solo se reengancha cuando hay una marca en juego (lector abierto, marca
//     esperando señal o QR retenido). En un navegador kiosco (Fully corre sobre
//     Android WebView) cada watchPosition nuevo vuelve a pedirle el permiso a la
//     app anfitriona: hacerlo cada 12 s todo el turno en la garita es buscarse
//     un diálogo o un rechazo, y gastar batería sin que nadie esté marcando.
//
// No toca el criterio: sigue haciendo falta un fix fresco y dentro del radio.
// Lo único que cambia es que el teléfono no deja de preguntar cuando importa.
const SILENCIO_WATCH_MS = 10000;
const SIN_PRIMERA_LECTURA_MS = 60000;

// Puro, para poder probarlo.
function watchCallado(ultimaLecturaMs, enganchadoMs, ahora) {
  const ultima = ultimaLecturaMs || 0;
  const enganche = enganchadoMs || 0;
  // Habló después del último enganche y se calló.
  if (ultima > 0 && ultima >= enganche) return ahora - ultima > SILENCIO_WATCH_MS;
  // Todavía no dijo nada desde que se enganchó: está adquiriendo.
  return ahora - enganche > SIN_PRIMERA_LECTURA_MS;
}

function marcaEnJuego() {
  const lectorAbierto = Boolean($('modal-escaner') && !$('modal-escaner').classList.contains('oculta'));
  return Boolean(marcaPendiente || retencionVigente(marcaRetenida, Date.now()) || lectorAbierto);
}

function vigilarGps() {
  if (gpsWatchId === null || !estado.sesion) return;
  // Con la pantalla apagada el navegador calla el watch a propósito y al volver
  // ya lo revive visibilitychange. Y sin permiso, reenganchar solo no arregla
  // nada: eso lo hace un toque del guardia (reengancharSiNegado).
  if (document.visibilityState !== 'visible' || gpsPermisoNegado) return;
  if (!marcaEnJuego()) return;
  if (watchCallado(gpsUltimaLecturaMs, gpsEnganchadoMs, Date.now())) reiniciarGps();
}

// Con permiso denegado (code 1) el navegador ya borró el watch y nada lo revive
// hasta que la página pase por segundo plano, cosa que en un kiosco no ocurre
// nunca. Se llama SOLO desde toques del guardia (iniciar ronda, abrir el lector,
// Reintentar): es una solicitud por toque, nunca un diálogo en bucle, y lleva el
// gesto del usuario, que Chrome exige para ofrecer encender la ubicación.
function reengancharSiNegado() {
  if (gpsPermisoNegado) reiniciarGps();
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

// Hasta cuándo puede esperar señal una marca: 15 s desde que empezó a esperar,
// pero nunca más allá del plazo del QR retenido del que vino (v1.21). Sin ese
// tope, un Reintentar a los 119 s abría 15 s más y la marca entraba a los 134 s
// de la lectura. Una marca sin `hasta` (las de antes) usa solo los 15 s.
function limitePendiente(pendiente) {
  return Number.isFinite(pendiente.hasta) ? pendiente.hasta : pendiente.desde + VENTANA_PENDIENTE_MS;
}

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
  const restanteMs = limitePendiente(pendiente) - ahora;
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
//
// El estado vive en DOS lugares del teléfono:
//   · localStorage: síncrono, es el que lee el arranque de un tirón.
//   · IndexedDB (respaldo): con durabilidad ESTRICTA, o sea escrito al disco
//     antes de darse por guardado.
// ¿Por qué dos? Chrome no escribe localStorage al disco en el momento: junta
// los cambios y los baja cada tanto. Con la app instalada (PWA), si el teléfono
// se apagaba a mitad de ronda lo último guardado no alcanzaba a llegar al disco
// y al volver a abrir la ronda ya no existía. Con la ronda hecha sin señal era
// la ronda ENTERA: el servidor solo había recibido el inicio, así que quedaba
// "en curso" para siempre y el guardia empezaba otra. (En Kiosk Browser no
// pasaba porque la app nunca sale de primer plano.)
//
// Cada guardado sube `rev`; al arrancar gana la copia con el rev más alto. La
// ronda terminada se va sola del respaldo: cuando el servidor confirma el
// cierre, `ejecucion` queda en null y ese es el estado que se respalda.

function estadoVacio() {
  return { sesion: null, paquete: null, ejecucion: null, cola: [], ultimoInforme: null };
}

function cargarEstado() {
  try {
    return Object.assign(estadoVacio(), JSON.parse(localStorage.getItem(CLAVE) || '{}'));
  } catch {
    return estadoVacio();
  }
}

function guardarEstado() {
  estado.rev = (estado.rev || 0) + 1;
  const texto = JSON.stringify(estado);
  // Si localStorage falla (sin espacio, bloqueado) igual queda el respaldo: no
  // puede reventar una marca a mitad de camino.
  try { localStorage.setItem(CLAVE, texto); } catch (err) { console.warn('localStorage:', err.message); }
  respaldar(texto);
}

let respaldoDb = null;         // Promise<IDBDatabase|null>
let respaldoPendiente = null;  // último texto por escribir (los intermedios sobran)
let respaldoEscribiendo = false;

function abrirRespaldo() {
  if (!respaldoDb) {
    respaldoDb = new Promise(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const pedido = indexedDB.open(CLAVE, 1);
        pedido.onupgradeneeded = () => pedido.result.createObjectStore('estado');
        pedido.onsuccess = () => resolve(pedido.result);
        pedido.onerror = () => resolve(null);
        pedido.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return respaldoDb;
}

// Escribe el último estado al respaldo. Si llegan varios guardados mientras se
// escribe uno, solo se escribe el más nuevo: cada escritura estricta espera al
// disco y no hay que encolarlas.
async function respaldar(texto) {
  respaldoPendiente = texto;
  if (respaldoEscribiendo) return;
  respaldoEscribiendo = true;
  try {
    const db = await abrirRespaldo();
    while (db && respaldoPendiente !== null) {
      const t = respaldoPendiente;
      respaldoPendiente = null;
      await new Promise(resolve => {
        try {
          const tx = db.transaction('estado', 'readwrite', { durability: 'strict' });
          tx.objectStore('estado').put(t, 'actual');
          tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    respaldoPendiente = null;
  } finally {
    respaldoEscribiendo = false;
  }
}

function leerRespaldo(db) {
  return new Promise(resolve => {
    try {
      const pedido = db.transaction('estado', 'readonly').objectStore('estado').get('actual');
      pedido.onsuccess = () => resolve(pedido.result || null);
      pedido.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Al arrancar, antes del primer render: si el respaldo es más nuevo que
// localStorage (el teléfono se apagó antes de que Chrome bajara localStorage
// al disco), manda el respaldo. Devuelve true si recuperó una ronda en curso.
async function recuperarRespaldo() {
  const db = await abrirRespaldo();
  if (!db) return false;
  const texto = await leerRespaldo(db);
  let copia = null;
  try { copia = texto ? JSON.parse(texto) : null; } catch { copia = null; }
  if (!copia || (copia.rev || 0) <= (estado.rev || 0)) {
    // localStorage es igual o más nuevo: se respalda tal cual (también cubre el
    // primer arranque de esta versión, que todavía no tiene respaldo).
    if (estado.sesion || estado.ejecucion || estado.cola.length) respaldar(JSON.stringify(estado));
    return false;
  }
  const teniaRonda = Boolean(estado.ejecucion && !estado.ejecucion.cerrada);
  estado = Object.assign(estadoVacio(), copia);
  try { localStorage.setItem(CLAVE, texto); } catch {}
  return !teniaRonda && Boolean(estado.ejecucion && !estado.ejecucion.cerrada);
}

// Pide que el navegador no borre los datos de la app para hacer espacio. En
// una PWA instalada Chrome suele concederlo solo; si no, no cambia nada.
function pedirAlmacenamientoPersistente() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {}
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
  pedirAlmacenamientoPersistente();
  await bajarPaquete(true);
  render();
  // Los guardias entran, hacen la ronda y salen: sin esto la versión solo
  // quedaba anotada si el minuto del reloj caía dentro de la sesión.
  revisarVersion();
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
  marcaRetenida = null;
  detenerGps();
  api('/api/logout', { metodo: 'POST' }).catch(() => {});
  // El rev sigue subiendo: si volviera a 0, al próximo arranque el respaldo
  // (con la sesión vieja) le ganaría a este estado vacío.
  estado = Object.assign(estadoVacio(), { rev: estado.rev });
  guardarEstado();
  render();
}

// ---------- Eliminar mi cuenta (CU-25) ----------
// Requisito de Google Play. El servidor borra el usuario y anonimiza sus
// rondas (lib/cuenta.js); acá además se borra todo lo que el teléfono guarda.

function errorEliminar(texto) {
  const el = $('error-eliminar');
  el.textContent = texto;
  el.classList.remove('oculta');
}

// Una ronda abierta o marcas en cola solo existen en este teléfono: borrar la
// cuenta antes de enviarlas las perdería. El servidor cerraría la ronda igual,
// pero sin esas marcas el informe saldría incompleto sin culpa del guardia.
function motivoParaNoEliminar() {
  if (estado.ejecucion && !estado.ejecucion.cerrada) return 'Termina tu ronda en curso antes de eliminar tu cuenta.';
  if (estado.cola.length) return 'Hay marcas sin enviar. Conéctate y espera a que se envíen antes de eliminar tu cuenta.';
  return null;
}

function irAEliminarCuenta() {
  const motivo = motivoParaNoEliminar();
  if (motivo) return aviso(motivo, 'error', 6000);
  $('eliminar-pin').value = '';
  $('error-eliminar').classList.add('oculta');
  mostrarVista('vista-eliminar');
}

async function eliminarCuenta() {
  $('error-eliminar').classList.add('oculta');
  const pin = $('eliminar-pin').value.trim();
  if (!pin) return errorEliminar('Escribe tu PIN para confirmar.');
  const motivo = motivoParaNoEliminar();
  if (motivo) return errorEliminar(motivo);
  const btn = $('btn-confirmar-eliminar');
  btn.disabled = true;
  try {
    await api('/api/mi/cuenta', { metodo: 'DELETE', cuerpo: { pin } });
  } catch (err) {
    btn.disabled = false;
    return errorEliminar(err.status ? err.message : 'Necesitas conexión para eliminar tu cuenta.');
  }
  await borrarDatosLocales();
  btn.disabled = false;
  $('eliminar-pin').value = '';
  $('campo-usuario').value = '';
  $('campo-pin').value = '';
  render();
  aviso('Tu cuenta fue eliminada. Los datos de este teléfono también se borraron.', 'ok', 8000);
}

// No espera para siempre a algo que puede no llegar (serviceWorker.ready sin
// service worker registrado, por ejemplo).
const conTope = (promesa, ms) => Promise.race([promesa, new Promise(r => setTimeout(() => r(null), ms))]);

// Deja el teléfono como recién instalado: sin sesión, sin paquete de rondas
// (trae los códigos de los QR), sin respaldo en IndexedDB y sin suscripción a
// la alarma (Web Push o Fully). La del servidor ya la borró el DELETE.
async function borrarDatosLocales() {
  olvidarPendiente();
  marcaRetenida = null;
  detenerGps();
  liberarWakeLock();
  cerrarAlarmaKiosco();
  try { localStorage.removeItem(CLAVE_ALARMA_KIOSCO); } catch {}
  try {
    if (pushSoportado()) {
      const reg = await conTope(navigator.serviceWorker.ready, 3000);
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    }
  } catch { /* sin push no hay nada que desuscribir */ }
  // Primero se pisa el respaldo con un estado vacío (rev más alto): si después
  // no se puede borrar la base de IndexedDB, igual no resucita nada al abrir.
  estado = Object.assign(estadoVacio(), { rev: estado.rev });
  estado.rev = (estado.rev || 0) + 1;
  await respaldar(JSON.stringify(estado)).catch(() => {});
  try { localStorage.removeItem(CLAVE); } catch {}
  try {
    const db = await respaldoDb;
    if (db) db.close();
  } catch {}
  respaldoDb = null;
  await conTope(new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve();
      const pedido = indexedDB.deleteDatabase(CLAVE);
      pedido.onsuccess = pedido.onerror = pedido.onblocked = () => resolve();
    } catch {
      resolve();
    }
  }), 3000);
  estado = estadoVacio();
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
  cerrarAlarmaKiosco(); // salir a la ronda es atender la alarma
  // Es el toque que más importa para el GPS: los puntos bajo techo dependen del
  // fix tomado en la entrada, y un watch muerto por un permiso negado no revive solo.
  reengancharSiNegado();
  iniciarGps();
  pedirWakeLock();
  render();
  sincronizar();
}

// Valida un código contra el paquete local y registra la marca. `leidoMs` es
// cuándo se LEYÓ el QR: un reintento del QR retenido trae la hora de la lectura
// original, para que el plazo de retención no se renueve con cada intento.
// `nfc` viene solo cuando el código salió de una chapita: { serie }, el número
// de serie de fábrica que el lector entregó junto con el texto (CU-28).
function procesarCodigo(texto, leidoMs = Date.now(), nfc = null) {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  if (!ejecucion || !ronda || ejecucion.cerrada) return;

  const limpio = String(texto || '').trim();
  let punto = null;
  if (limpio.toUpperCase().startsWith('RQR:')) {
    punto = ronda.puntos.find(p => p.payload === limpio) || null;
    if (!punto) {
      const esDeOtroLado = !estado.paquete.rondas.some(r => r.puntos.some(p => p.payload === limpio));
      const que = nfc ? 'Esa chapita' : 'Ese QR';
      aviso(esDeOtroLado ? `${que} no es de este condominio o no existe.` : 'Ese punto no es parte de esta ronda.', 'error');
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

  // Punto con chapita NFC: el QR y una chapita ajena no sirven (espejo de
  // medioDeLaMarca en lib/rondas.js). El rechazo queda registrado como los del
  // GPS y nunca entra a la cola como marca.
  const motivo = motivoMedio(punto, limpio, nfc);
  if (motivo) {
    aviso(motivo, 'error', 7000);
    navigator.vibrate && navigator.vibrate([80, 60, 80]);
    registrarRechazo(punto, { motivo });
    return;
  }

  // Ese punto ya está esperando señal: volver a escanearlo no la mejora, y
  // reiniciar el plazo sería regalar tiempo infinito escaneando en loop.
  if (marcaPendiente && marcaPendiente.punto.id === punto.id) {
    // Lo que sí cambia es la lectura: el QR se volvió a leer ahora, y el plazo
    // de la retención que venga después se cuenta desde acá. La espera en sí no
    // se alarga más allá de sus 15 s.
    marcaPendiente.leidoMs = Math.max(marcaPendiente.leidoMs || 0, leidoMs);
    marcaPendiente.hasta = Math.min(marcaPendiente.desde + VENTANA_PENDIENTE_MS, marcaPendiente.leidoMs + RETENCION_MS);
    aviso(`📍 "${punto.nombre}" ya está esperando señal. Quédate quieto unos segundos.`, 'info');
    return;
  }

  // Un código nuevo reemplaza al QR retenido: o es el reintento de ese mismo
  // punto, o el guardia ya siguió caminando y el anterior no va a mejorar. Si era
  // de OTRO punto se le dice, después del resultado de este: si no, el panel
  // desaparece y el punto anterior termina como faltante sin que sepa por qué.
  const soltada = marcaRetenida && marcaRetenida.punto.id !== punto.id && retencionVigente(marcaRetenida, Date.now())
    ? marcaRetenida.punto
    : null;
  marcaRetenida = null;

  // Verificación de presencia BLOQUEANTE (CU-18). Mismo criterio que el servidor,
  // aplicado antes de encolar: el guardia se entera al instante y la marca
  // rechazada nunca entra a la cola offline. Cubre el escaneo por cámara y el
  // código a mano — los dos pasan por acá, así no queda una puerta de atrás.
  const presencia = cfgGps().bloquea ? verificarPresencia(punto) : null;
  if (presencia && !presencia.ok) {
    if (esperaSirve(presencia)) dejarPendiente(punto, limpio, presencia, leidoMs, nfc);
    else rechazarMarca(punto, presencia);
  } else {
    registrarMarca(punto, limpio, nfc);
  }
  avisarRetenidaSoltada(soltada);
}

// ---------- Chapitas NFC (CU-28) ----------

// Normaliza la serie de una chapita como lib/codigos.js: hexadecimal en
// mayúsculas y sin separadores. Web NFC la entrega como "04:a2:3b:…".
function normalizarSerie(texto) {
  const limpio = String(texto == null ? '' : texto).replace(/[\s:-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,20}$/.test(limpio) && limpio.length % 2 === 0 ? limpio : null;
}

// Con qué se hizo una marca: 'nfc' | 'qr' | 'manual'.
function medioDe(punto, texto, nfc) {
  if (!String(texto).toUpperCase().startsWith('RQR:')) return 'manual';
  return nfc && punto.nfc ? 'nfc' : 'qr';
}

// Por qué este medio no sirve para este punto, o null si sirve. Mismo criterio
// que medioDeLaMarca() en el servidor: la app no puede aceptar lo que el
// servidor va a rechazar, porque el guardia ya habría visto el ✅.
function motivoMedio(punto, texto, nfc) {
  if (!punto.nfc) return null;
  if (medioDe(punto, texto, nfc) === 'manual') {
    // La regla del código a mano en puntos con chapita la decide el servidor
    // (MANUAL_EN_PUNTO_NFC) y viaja en el paquete. Un paquete anterior a la
    // regla no la trae: se aplica la de hoy, que es rechazar.
    const regla = (estado.paquete && estado.paquete.manualEnNfc) || 'rechazo';
    return regla === 'rechazo'
      ? `En "${punto.nombre}" el código a mano no sirve: se marca con la chapita NFC. Si no lee, toca «La chapita no lee» para avisar al administrador.`
      : null;
  }
  if (!nfc) return `Este punto se marca con la chapita NFC: acerca la parte trasera del teléfono a la chapita de "${punto.nombre}".`;
  if (!nfc.serie) return 'El teléfono no entregó el número de serie de la chapita. Vuelve a acercarlo.';
  // El paquete no trae la serie, trae su huella (SHA-256): la serie no queda
  // guardada en el teléfono del guardia. Sin huella calculada (un navegador sin
  // crypto.subtle) decide el servidor.
  if (nfc.huella && punto.nfcHuella && nfc.huella !== punto.nfcHuella) {
    return `Esta chapita no es la registrada para "${punto.nombre}". Si la cambiaron, avisa al administrador.`;
  }
  return null;
}

// La huella de una serie: SHA-256 en hexadecimal, igual que huellaSerie() de
// lib/codigos.js. null si el navegador no tiene crypto.subtle.
async function huellaSerie(serie) {
  try {
    const bytes = new TextEncoder().encode(serie);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

// Qué abre "Escanear" (puro, se prueba sin teléfono). Nunca la cámara y el
// lector a la vez: cada punto se marca solo con su medio.
//   'nfc'    todos los puntos que faltan tienen chapita → pantalla de la chapita
//   'qr'     ninguno la tiene → la cámara, como siempre
//   'elegir' ronda mixta sin orden: la app no sabe frente a qué punto está el
//            guardia, así que le pregunta ("¿Qué hay en este punto?")
// Con orden estricto manda el medio del próximo punto.
function medioEscaner(ronda, ejecucion) {
  if (!ronda) return 'qr';
  const marcados = new Set(((ejecucion && ejecucion.escaneos) || []).map(e => e.puntoId));
  const pendientes = ronda.puntos.filter(p => !marcados.has(p.id));
  if (!pendientes.length) return 'qr';
  if (ronda.ordenEstricto) return pendientes[0].nfc ? 'nfc' : 'qr';
  const conChapita = pendientes.filter(p => p.nfc).length;
  if (conChapita === pendientes.length) return 'nfc';
  return conChapita ? 'elegir' : 'qr';
}

function esIphone() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

// Por qué este teléfono no puede leer chapitas, o null si puede intentarlo.
// Web NFC (NDEFReader) solo existe en Chrome de Android: ni Safari, ni el
// WebView de Fully Kiosk, ni Firefox lo tienen.
function sinLectorNfc() {
  if ('NDEFReader' in window) return null;
  // Fully Kiosk tiene su propio lector NFC, pero esta versión no lo usa
  // todavía (pendiente en entrega/FULLY-KIOSK.md).
  if (fullyDisponible() || esWebViewAndroid()) return 'Este teléfono todavía no lee chapitas NFC: los puntos con chapita se marcan con Chrome en un Android con NFC.';
  if (esIphone()) return 'En iPhone la app no puede leer chapitas NFC (Apple no lo permite a las apps web): los puntos con chapita se marcan con un Android con NFC.';
  return 'Este navegador no lee chapitas NFC: abre la app en Chrome de un Android con NFC.';
}

// Qué le pasó al lector, en palabras del guardia. Los nombres de error son los
// de la especificación de Web NFC y sus pruebas (web-platform-tests):
//   NotAllowedError    el permiso de NFC está negado para este sitio
//   NotSupportedError  el teléfono no tiene NFC (o Chrome no puede usarlo)
//   NotReadableError   el teléfono tiene NFC pero está apagado
//   AbortError         lo detuvimos nosotros (Cancelar): no es un error
function textoErrorNfc(err) {
  const nombre = err && err.name;
  if (nombre === 'NotAllowedError') {
    return 'La app no tiene permiso para usar NFC. En Chrome: toca el candado junto a la dirección → Permisos → NFC → Permitir, y toca Reintentar.';
  }
  if (nombre === 'NotReadableError') {
    return 'El NFC del teléfono está apagado. Actívalo en Ajustes (busca "NFC") y toca Reintentar.';
  }
  if (nombre === 'NotSupportedError') {
    return 'Este teléfono no tiene NFC, o Chrome no puede usarlo: los puntos con chapita se marcan con un Android con NFC.';
  }
  return `No se pudo activar el lector NFC${nombre ? ` (${nombre})` : ''}. Toca Reintentar.`;
}

// El texto RQR:… grabado en la chapita: el primer registro de texto NDEF.
function textoDeChapita(mensaje) {
  for (const registro of (mensaje && mensaje.records) || []) {
    if (registro.recordType !== 'text' || !registro.data) continue;
    try {
      return new TextDecoder(registro.encoding || 'utf-8').decode(registro.data);
    } catch { /* registro ilegible: se prueba el siguiente */ }
  }
  return null;
}

// Arranca el lector. Web NFC exige que venga de un toque del guardia (por eso
// se llama desde el botón, nunca solo) y pide permiso la primera vez. Se detiene
// con detenerLectorNfc(); la página oculta lo suspende sola.
async function iniciarLectorNfc(alError) {
  detenerLectorNfc();
  const control = new AbortController();
  lectorNfc = control;
  try {
    const lector = new NDEFReader();
    lector.onreading = evento => {
      if (lectorNfc === control) chapitaLeida(evento);
    };
    lector.onreadingerror = () => {
      if (lectorNfc === control) alError('No se pudo leer la chapita. Mantén el teléfono quieto sobre ella un par de segundos.', false);
    };
    await lector.scan({ signal: control.signal });
  } catch (err) {
    if (lectorNfc !== control || (err && err.name === 'AbortError')) return;
    lectorNfc = null;
    alError(textoErrorNfc(err), true);
  }
}

function detenerLectorNfc() {
  if (lectorNfc) lectorNfc.abort();
  lectorNfc = null;
}

async function chapitaLeida(evento) {
  const texto = textoDeChapita(evento.message);
  if (!texto || !texto.trim().toUpperCase().startsWith('RQR:')) {
    aviso('Esa chapita no es de Rondas QR (está vacía o tiene otra cosa).', 'error');
    navigator.vibrate && navigator.vibrate([80, 60, 80]);
    return;
  }
  const serie = normalizarSerie(evento.serialNumber);
  // La chapita sigue en el campo mientras el teléfono está apoyado: el mismo
  // texto de hace un instante no es una lectura nueva.
  const ahora = Date.now();
  const clave = `${texto}|${serie}`;
  if (clave === ultimoCodigoLeido.valor && ahora - ultimoCodigoLeido.ts < 2500) return;
  ultimoCodigoLeido = { valor: clave, ts: ahora };
  cerrarPantallaNfc();
  const huella = serie ? await huellaSerie(serie) : null;
  procesarCodigo(texto.trim(), ahora, { serie, huella });
}

// "Escanear": la cámara o la pantalla de la chapita, según los puntos que
// faltan (medioEscaner). En una ronda mixta sin orden se pregunta primero.
function escanear() {
  const medio = medioEscaner(rondaActual(), estado.ejecucion);
  if (medio === 'nfc') abrirPantallaNfc();
  else if (medio === 'elegir') $('modal-medio').classList.remove('oculta');
  else abrirEscaner();
}

function elegirMedio(medio) {
  $('modal-medio').classList.add('oculta');
  // El toque en "Una chapita" es el gesto que Web NFC exige para leer.
  if (medio === 'nfc') abrirPantallaNfc();
  else abrirEscaner();
}

// Los puntos de chapita que el guardia puede estar intentando marcar: con
// orden estricto, solo el próximo; si no, todos los de chapita pendientes.
function puntosNfcPendientes() {
  const ronda = rondaActual();
  if (!ronda || !estado.ejecucion) return [];
  const marcados = new Set(estado.ejecucion.escaneos.map(e => e.puntoId));
  const pendientes = ronda.puntos.filter(p => !marcados.has(p.id));
  if (ronda.ordenEstricto) return pendientes.length && pendientes[0].nfc ? [pendientes[0]] : [];
  return pendientes.filter(p => p.nfc);
}

// "La chapita no lee": el guardia está en el punto y no hay cómo marcarlo
// (chapita rota, despegada, o un teléfono que no lee NFC). El código a mano
// no sirve en un punto con chapita —sería la puerta para marcar sin ir—, así
// que el punto queda SIN marcar, y lo que sí queda es el aviso: viaja como un
// rechazo con `reporte: 'chapita'` y el informe se lo dice al administrador.
function reportarChapita() {
  const candidatos = puntosNfcPendientes();
  const lista = $('nfc-reporte');
  if (!candidatos.length) { cerrarPantallaNfc(); return; }
  if (candidatos.length === 1) { confirmarReporte(candidatos[0]); return; }
  lista.innerHTML = '<p class="nota centrado">¿En qué punto estás?</p>'
    + candidatos.map(p => `<button class="btn btn-borde" data-reportar="${esc(p.id)}">${esc(p.nombre)}</button>`).join('');
  lista.classList.remove('oculta');
  for (const btn of lista.querySelectorAll('[data-reportar]')) {
    btn.addEventListener('click', () => confirmarReporte(candidatos.find(p => p.id === btn.dataset.reportar)));
  }
}

function confirmarReporte(punto) {
  if (!punto) return;
  if (!confirm(`"${punto.nombre}" va a quedar SIN marcar y se le avisará al administrador que la chapita no leyó. ¿Avisar?`)) return;
  registrarReporteChapita(punto);
  cerrarPantallaNfc();
}

function registrarReporteChapita(punto) {
  const ejecucion = estado.ejecucion;
  if (!ejecucion || ejecucion.cerrada) return;
  if (!ejecucion.reportados) ejecucion.reportados = [];
  if (!ejecucion.reportados.includes(punto.id)) {
    ejecucion.reportados.push(punto.id);
    const sinLector = sinLectorNfc();
    estado.cola.push({
      tipo: 'rechazo',
      ejecucionId: ejecucion.id,
      puntoId: punto.id,
      ts: new Date().toISOString(),
      reporte: 'chapita',
      motivo: sinLector ? `El teléfono no lee chapitas NFC (${sinLector})` : 'El guardia reportó que la chapita no leyó.'
    });
    guardarEstado();
    sincronizar();
  }
  aviso(`"${punto.nombre}" quedó SIN marcar. Se le avisará al administrador que la chapita no leyó.`, 'error', 7000);
  render();
}

function abrirPantallaNfc() {
  reengancharSiNegado();
  vigilarGps();
  $('modal-nfc').classList.remove('oculta');
  $('nfc-reporte').classList.add('oculta');
  const texto = $('nfc-texto');
  const reintentar = $('btn-reintentar-nfc');
  reintentar.classList.add('oculta');
  texto.classList.remove('error');
  const falta = sinLectorNfc();
  if (falta) {
    texto.textContent = falta;
    texto.classList.add('error');
    return;
  }
  texto.textContent = 'Mantenlo quieto unos segundos, hasta que vibre. La primera vez Chrome pide permiso para usar NFC.';
  iniciarLectorNfc((motivo, definitivo) => {
    if ($('modal-nfc').classList.contains('oculta')) return;
    texto.textContent = motivo;
    texto.classList.add('error');
    if (definitivo) reintentar.classList.remove('oculta');
  });
}

function cerrarPantallaNfc() {
  detenerLectorNfc();
  $('modal-nfc').classList.add('oculta');
}

// El aviso de un QR retenido que se soltó porque llegó otro. Se suma al aviso
// que acaba de dejar el punto nuevo en vez de pisarlo.
function avisarRetenidaSoltada(punto) {
  if (!punto) return;
  const el = $('aviso');
  const previo = el && !el.classList.contains('oculta') && el.textContent ? `${el.textContent} · ` : '';
  aviso(`${previo}"${punto.nombre}" quedó SIN marcar: ${volverALeer(punto)}.`, 'error', 7000);
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

function dejarPendiente(punto, codigo, presencia, leidoMs = Date.now(), nfc = null) {
  // Solo una marca en espera a la vez. Si había otra, el guardia ya se movió
  // hasta este punto: la anterior no va a mejorar. Se cierra como rechazo —con
  // su registro— y se le dice, en vez de dejarla morir en silencio.
  const desplazada = marcaPendiente;
  if (desplazada) registrarRechazo(desplazada.punto, desplazada.ultimo || { motivo: desplazada.motivo });
  // `desde` cuenta los 15 s de espera; `leidoMs` es la hora de la lectura del
  // QR y pasa intacta a la retención si la espera no alcanza. `hasta` corta la
  // espera donde vence la retención: un Reintentar tardío no estira el plazo.
  const ahora = Date.now();
  marcaPendiente = {
    punto, codigo, nfc, desde: ahora, leidoMs,
    hasta: Math.min(ahora + VENTANA_PENDIENTE_MS, leidoMs + RETENCION_MS),
    motivo: presencia.motivo, ultimo: presencia
  };
  clearInterval(pendienteTimer);
  // También corre sin fixes nuevos: si el GPS se calló del todo, el plazo tiene
  // que vencer igual y decírselo al guardia.
  pendienteTimer = setInterval(revisarPendiente, 1000);
  navigator.vibrate && navigator.vibrate(60);
  // La espera se muestra en el panel de la marca (pintarMarca), que no se
  // esfuma. El aviso flotante queda solo para lo que el panel no dice: que la
  // marca anterior se perdió.
  if (desplazada) aviso(`"${desplazada.punto.nombre}" quedó SIN marcar, vuelve a escanearlo.`, 'error', 6000);
  // Si el watch venía callado no se espera al próximo tick del vigía: de los 15
  // segundos de plazo, tres son muchos.
  vigilarGps();
  pintarGps();
}

// Suelta la marca en espera. El QR retenido es aparte: se suelta al salir, al
// cerrar la ronda o cuando llega otro código.
function olvidarPendiente() {
  clearInterval(pendienteTimer);
  pendienteTimer = null;
  marcaPendiente = null;
}

// Corre con cada fix nuevo y una vez por segundo. Solo llama al reducer y pinta.
function revisarPendiente() {
  if (!marcaPendiente) { olvidarPendiente(); return; }
  const pendiente = marcaPendiente;
  const r = evaluarPendiente(pendiente, gpsUltimo(), Date.now());
  if (r.veredicto) pendiente.ultimo = r.veredicto;
  if (r.accion === 'esperar') { pintarMarca(); return; }
  olvidarPendiente();
  if (r.accion === 'aceptar') registrarMarca(pendiente.punto, pendiente.codigo, pendiente.nfc);
  else rechazarMarca(pendiente.punto, pendiente.ultimo || { motivo: r.motivo }, pendiente.codigo, pendiente.leidoMs, pendiente.nfc);
}

// ---------- QR retenido (v1.21) ----------
// Hasta v1.20 un rechazo por señal botaba también la lectura del QR: el guardia
// tenía que abrir la cámara y apuntar de nuevo a un código que la app ya había
// leído bien. Era el error más repetido de la marcación y el QR no tenía la
// culpa. Ahora, si el rechazo es de los que la señal puede arreglar, el QR
// queda retenido y se reintenta con un toque.
//
// Reintentar es EXACTAMENTE volver a escanear —pasa por procesarCodigo() con el
// mismo código— sin la cámara. Mismo criterio, mismo plazo, mismo registro de
// rechazo si vuelve a fallar. Lo que el guardia podía hacer antes escaneando
// otra vez lo hace ahora sin apuntar.
//
// El plazo existe para que la lectura del QR y la marca no queden separadas por
// media ronda: pasado ese tiempo hay que volver a pararse frente al código. Se
// cuenta desde la LECTURA (`desde` es leidoMs), no desde el último rechazo: si
// no, cada Reintentar fallido lo renovaría y el plazo no existiría.
const RETENCION_MS = 120000;

// Puro: ¿el QR retenido todavía se puede reintentar?
function retencionVigente(retenida, ahora) {
  return Boolean(retenida && retenida.punto && ahora - retenida.desde <= RETENCION_MS);
}

function reintentarRetenida() {
  // Antes que nada: si el GPS murió por un permiso negado, este toque es el que
  // lo vuelve a pedir, aunque el QR ya haya vencido y haya que escanear de nuevo.
  reengancharSiNegado();
  const retenida = marcaRetenida;
  marcaRetenida = null;
  if (!retencionVigente(retenida, Date.now())) {
    aviso('Pasó mucho tiempo desde que leíste el QR: vuelve a escanearlo.', 'error', 5000);
    pintarMarca();
    return;
  }
  procesarCodigo(retenida.codigo, retenida.desde, retenida.nfc || null);
  pintarMarca();
}

// Por qué no entró, en corto. No se reusa presencia.motivo: ese texto es el del
// rechazo seco (y el espejo del servidor) y termina en "vuelve a escanear", que
// es justo lo que acá ya no hace falta. En un punto anclado (bajo techo) la
// distancia es a la ENTRADA del recinto, y hay que decirlo.
function textoRetenida(presencia, anclado) {
  const p = presencia || {};
  if (p.sinGps) {
    return anclado
      ? 'El teléfono no alcanzó a tomar la ubicación de la entrada.'
      : `El teléfono todavía no tiene ubicación (${gpsMotivoFalla || 'buscando señal'}).`;
  }
  if (p.vencido) return `Tu ubicación es de hace ${minutos(p.edadMs)} y hace falta una más reciente.`;
  if (p.impreciso) return `La señal es demasiado imprecisa (±${p.acc} m).`;
  if (p.distanciaM != null) {
    return `El GPS te ubica a ${p.distanciaM} m${anclado ? ' de la entrada' : ''} y el máximo es ${p.topeM} m`
      + `${p.acc != null ? ` (señal ±${p.acc} m)` : ''}.`;
  }
  return 'No se pudo confirmar tu ubicación.';
}

function descartarRetenida() {
  marcaRetenida = null;
  pintarMarca();
}

// El panel de la marca en curso, sobre el botón de escanear. Dos estados:
//   afinando     QR leído, esperando señal. Se resuelve solo.
//   recuperable  QR leído, la señal no alcanzó. Se reintenta sin escanear.
// La marca aceptada y el rechazo definitivo siguen saliendo por aviso().
//
// Ningún título lleva ✓: "QR leído" no es "punto marcado", y confundirlos es
// justo cómo un guardia se va del punto creyendo que quedó hecho.
// Qué tiene que volver a hacer el guardia con un punto que quedó sin marcar.
// En un punto QR, el mismo texto de siempre.
function volverALeer(punto) {
  return punto && punto.nfc ? 'vuelve a acercar el teléfono a su chapita' : 'vuelve a escanear su QR';
}

// "QR de X leído" o "Chapita de X leída", para la marca en espera o retenida.
function lecturaDe(marca) {
  return marca.nfc ? `Chapita de "${marca.punto.nombre}" leída` : `QR de "${marca.punto.nombre}" leído`;
}

function pintarMarca() {
  const el = $('marca-estado');
  if (!el) return;
  if (marcaRetenida && !retencionVigente(marcaRetenida, Date.now())) {
    // Vence una sola vez y se dice: si no, el panel desaparece solo y el punto
    // termina como faltante sin que el guardia sepa por qué.
    const vencida = marcaRetenida;
    marcaRetenida = null;
    aviso(`Se acabó el plazo para "${vencida.punto.nombre}": ${volverALeer(vencida.punto)}.`, 'error', 6000);
    navigator.vibrate && navigator.vibrate([80, 60, 80]);
  }
  const acciones = $('marca-acciones');
  if (marcaPendiente) {
    const restanteS = Math.max(0, Math.ceil((limitePendiente(marcaPendiente) - Date.now()) / 1000));
    $('marca-titulo').textContent = `${lecturaDe(marcaPendiente)} · afinando ubicación… ${restanteS} s`;
    $('marca-detalle').textContent = `Quédate quieto junto ${marcaPendiente.nfc ? 'a la chapita' : 'al QR'}: si la señal entra, la marca se registra sola. No hace falta escanear de nuevo.`;
    acciones.classList.add('oculta');
    el.classList.remove('oculta');
  } else if (marcaRetenida) {
    const punto = marcaRetenida.punto;
    const anclado = umbralesDe(punto).anclado;
    $('marca-titulo').textContent = `${lecturaDe(marcaRetenida)} · todavía NO está marcado`;
    // El motivo se recalcula con la señal de AHORA (pintarMarca corre con cada
    // fix y cada 3 s). Solo informa: aunque ya alcance, la marca no entra sola;
    // Reintentar sigue pasando por procesarCodigo() con el control completo.
    const ahora = verificarPresencia(punto);
    const listo = !ahora || ahora.ok;
    let queHacer;
    if (listo) queHacer = 'La señal ya alcanza: toca Reintentar';
    else if (gpsPermisoNegado) queHacer = 'Activa la ubicación del teléfono para esta app y toca Reintentar';
    else if (anclado) queHacer = 'Este punto se verifica por la entrada: sal a donde haya señal, pasa por la entrada del recinto y toca Reintentar';
    else queHacer = `Espera unos segundos junto ${marcaRetenida.nfc ? 'a la chapita' : 'al QR'} y toca Reintentar`;
    $('marca-detalle').textContent = `${listo ? '' : `${textoRetenida(ahora, anclado)} `}${queHacer}. No hace falta escanear de nuevo.`;
    acciones.classList.remove('oculta');
    el.classList.remove('oculta');
  } else {
    el.classList.add('oculta');
  }
}

// Encola la marca. Es el único camino por el que un escaneo entra a la ronda:
// llegue directo o después de esperar señal, el estado queda igual.
function registrarMarca(punto, codigo, nfc = null) {
  const ejecucion = estado.ejecucion;
  const ronda = rondaActual();
  // Entre el escaneo y la aceptación pasaron segundos: la ronda pudo cerrarse y
  // el punto pudo marcarse por otra vía.
  if (!ejecucion || !ronda || ejecucion.cerrada) return;
  if (ejecucion.escaneos.some(e => e.puntoId === punto.id)) return;
  if (marcaRetenida && marcaRetenida.punto.id === punto.id) marcaRetenida = null;

  const ts = new Date().toISOString();
  const gps = gpsParaMarca(punto);
  const medio = medioDe(punto, codigo, nfc);
  ejecucion.escaneos.push({ puntoId: punto.id, ts, offline: !navigator.onLine, gps, medio });
  estado.cola.push({
    tipo: 'escaneo',
    ejecucionId: ejecucion.id,
    codigo,
    ts,
    offline: !navigator.onLine,
    gps,
    // La serie de la chapita viaja con la marca: el servidor la exige en los
    // puntos NFC. Sin chapita, null (un QR o el código a mano).
    nfc: nfc ? { serie: nfc.serie || null } : null
  });
  guardarEstado();
  navigator.vibrate && navigator.vibrate(120);
  aviso(`✅ ${punto.nombre} (${ejecucion.escaneos.length}/${ronda.puntos.length})`, 'ok');
  render();
  sincronizar();
}

// La marca no entró: se le dice al guardia y queda el registro. Con `codigo` y
// un rechazo que la señal puede arreglar (esperaSirve), el QR queda retenido
// para reintentar sin escanear; si no, es un rechazo definitivo como siempre.
// El registro del rechazo es el mismo en los dos casos: la marca no contó.
function rechazarMarca(punto, presencia, codigo, leidoMs, nfc = null) {
  navigator.vibrate && navigator.vibrate([80, 60, 80, 60, 80]);
  const retenible = codigo && esperaSirve(presencia);
  const retenida = retenible ? { punto, codigo, nfc, desde: leidoMs != null ? leidoMs : Date.now(), presencia } : null;
  if (retenida && retencionVigente(retenida, Date.now())) {
    marcaRetenida = retenida;
    // El panel lo explica, pero el aviso fijo es lo que se ve aunque el teléfono
    // no vibre (iPhone, kiosco) y aunque el panel quede fuera de la pantalla.
    aviso(`"${punto.nombre}" todavía NO está marcado: falta la ubicación. Toca Reintentar.`, 'error', 6000);
  } else if (retenida) {
    // La espera terminó justo donde vencía el plazo de la lectura: retenerla
    // sería decir "toca Reintentar" y en el mismo instante "se acabó el plazo".
    aviso(`Se acabó el plazo para "${punto.nombre}": ${volverALeer(punto)}.`, 'error', 6000);
  } else {
    aviso(presencia.motivo || 'No se pudo confirmar tu ubicación.', 'error', 6000);
  }
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

// El comentario opcional de la ronda en curso. Se guarda mientras se escribe
// (queda en `estado`), así sobrevive a una recarga o a que se apague el teléfono.
function comentarioRonda() {
  return String((estado.ejecucion && estado.ejecucion.comentario) || '').replace(/\s+/g, ' ').trim().slice(0, 280);
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
    : retencionVigente(marcaRetenida, Date.now())
      ? `"${marcaRetenida.punto.nombre}" tiene el QR leído pero NO está marcado: falta confirmar la ubicación.\n\n`
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
  marcaRetenida = null;
  ejecucion.cerrada = true;
  ejecucion.fin = new Date().toISOString();
  // El comentario viaja en el mismo evento del cierre: si no hay señal, espera
  // en la cola con él y sube cuando vuelve.
  estado.cola.push({ tipo: 'cerrar', ejecucionId: ejecucion.id, fin: ejecucion.fin, comentario: comentarioRonda() });
  guardarEstado();
  detenerGps();
  render();
  sincronizar();
}

// ---------- Cola de sincronización ----------

// Qué hacer con el evento de la cola cuando el envío falló. El servidor es
// idempotente en los cuatro eventos (iniciar, escaneo, rechazo, cerrar), así que
// reintentar es siempre seguro, incluso si el servidor sí lo procesó y se perdió
// la respuesta.
//   'sesion'     401: se conserva la cola y se pide entrar de nuevo.
//   'reintentar' sin respuesta, 5xx, 408 o 429: el fallo es del camino o del
//                servidor (un deploy, el proxy de Railway que da 502), no del
//                evento. Borrarlo perdería la marca que el guardia ya vio como ✅.
//   'descartar'  4xx definitivo (400, 403, 404, 409, 422): reintentar no lo
//                arregla. También un evento que ya agotó sus intentos, para que
//                uno que siempre da 500 no trabe para siempre lo que viene detrás.
// Sin respuesta (sin red) no cuenta intentos: horas sin señal no descartan nada.
const MAX_INTENTOS_EVENTO = 20;
const ESPERA_REINTENTO_MS = 4000;
const ESPERA_REINTENTO_MAX_MS = 300000;

function decidirFalla(evento, err) {
  if (err.status === 401) return 'sesion';
  if (!err.status) return 'reintentar';
  const transitorio = err.status >= 500 || err.status === 408 || err.status === 429;
  if (!transitorio) return 'descartar';
  return (evento.intentos || 0) + 1 >= MAX_INTENTOS_EVENTO ? 'descartar' : 'reintentar';
}

// Espera antes del próximo intento tras `intentos` fallos con respuesta: 4 s,
// 8 s, 16 s… con tope de 5 minutos.
function esperaReintentoMs(intentos) {
  return Math.min(ESPERA_REINTENTO_MS * 2 ** Math.max(0, intentos - 1), ESPERA_REINTENTO_MAX_MS);
}

async function sincronizar() {
  if (sincronizando || !estado.sesion || !navigator.onLine) { pintarConexion(); return; }
  sincronizando = true;
  try {
    while (estado.cola.length) {
      const evento = estado.cola[0];
      // Un evento que el servidor no pudo atender espera su turno de reintento.
      if (evento.noAntesDe && evento.noAntesDe > Date.now()) break;
      try {
        if (evento.tipo === 'iniciar') {
          await api('/api/ejecuciones', {
            metodo: 'POST',
            cuerpo: { id: evento.ejecucionId, rondaId: evento.rondaId, inicio: evento.inicio }
          });
        } else if (evento.tipo === 'escaneo') {
          await api(`/api/ejecuciones/${evento.ejecucionId}/escaneos`, {
            metodo: 'POST',
            cuerpo: { codigo: evento.codigo, ts: evento.ts, offline: evento.offline, gps: evento.gps || null, nfc: evento.nfc || null }
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
              edadMs: evento.edadMs,
              reporte: evento.reporte || null
            }
          });
        } else if (evento.tipo === 'cerrar') {
          const informe = await api(`/api/ejecuciones/${evento.ejecucionId}/cerrar`, {
            metodo: 'POST',
            cuerpo: { fin: evento.fin, comentario: evento.comentario || '' }
          });
          estado.ultimoInforme = informe;
          if (estado.ejecucion && estado.ejecucion.id === evento.ejecucionId) estado.ejecucion = null;
        }
        estado.cola.shift();
        guardarEstado();
      } catch (err) {
        const decision = decidirFalla(evento, err);
        if (decision === 'sesion') {
          // Sesión caducada: se conserva la cola y se pide entrar de nuevo.
          estado.sesion = null;
          guardarEstado();
          aviso('La sesión caducó. Entra de nuevo para enviar lo pendiente.', 'error');
          break;
        } else if (decision === 'reintentar') {
          // Sin red no se anota nada. Con respuesta de error del servidor (502
          // en un deploy, 500, 429) el evento se conserva con su espera.
          if (err.status) {
            evento.intentos = (evento.intentos || 0) + 1;
            evento.noAntesDe = Date.now() + esperaReintentoMs(evento.intentos);
            guardarEstado();
          }
          break;
        } else {
          // El servidor rechazó el evento (p. ej. validación) o agotó sus
          // reintentos: no bloquear la cola.
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

// Desde v1.21 el lector deja de fallar callado. Tres cosas:
//   · más píxeles sobre el QR: se pide la cámara a 1080p y jsQR lee el recorte
//     del recuadro a 640 px, no el cuadro entero achicado a 480 (ver
//     LADO_RECORTE_MAX: más que eso, con poca luz, cuesta casi un segundo);
//   · si el detector nativo existe pero no sirve, entra jsQR. Falla de dos
//     maneras (Chromium y Android WebView lo implementan sobre Google Play
//     Services): revienta en cada detect() cuando falta Play Services, y ahí
//     jsQR lo reemplaza; o responde vacío para siempre cuando el módulo de
//     códigos no está operativo, y ahí desde los 3 s sin lectura se intercala
//     una pasada de jsQR cada medio segundo, sin soltar al nativo que sí puede
//     estar funcionando (el guardia a veces abre el lector y recién camina);
//   · a los 8 segundos sin lectura la pantalla lo dice y ofrece salidas
//     (linterna si la hay, código a mano) en vez de dejar al guardia apuntando.
//
// Cada apertura del lector es un "turno". Los ciclos de lectura, la cámara y el
// aviso de ayuda pertenecen a su turno y mueren con él: cancelar y reabrir
// rápido en un teléfono lento ya no deja dos ciclos vivos ni una cámara huérfana,
// que en un kiosco (la página no se recarga nunca) quedaba encendida.
const AYUDA_ESCANER_MS = 8000;
const TEXTO_ESCANER = 'Apunta al QR del punto de control';
let ayudaEscanerTimer = null;
let linternaEncendida = false;
let turnoEscaner = 0;

function turnoVivo(turno) {
  return escaneando && turno === turnoEscaner;
}

function pistaVideo() {
  return stream ? stream.getVideoTracks()[0] || null : null;
}

// Lo que la cámara sabe hacer, si lo declara. Chrome y Android WebView (Fully
// Kiosk) declaran la linterna solo si la cámara que eligieron tiene flash; Safari
// la declara desde iOS 17, pero no el enfoque. Lo que no se declara no aparece.
function capacidadesCamara() {
  const pista = pistaVideo();
  try {
    return pista && pista.getCapabilities ? pista.getCapabilities() : {};
  } catch {
    return {};
  }
}

async function alternarLinterna() {
  const pista = pistaVideo();
  if (!pista) return;
  try {
    await pista.applyConstraints({ advanced: [{ torch: !linternaEncendida }] });
    linternaEncendida = !linternaEncendida;
  } catch {
    aviso('Este teléfono no dejó encender la linterna.', 'error');
  }
  $('btn-linterna').textContent = linternaEncendida ? '🔦 Apagar luz' : '🔦 Encender luz';
}

function mostrarAyudaEscaner(turno) {
  if (!turnoVivo(turno)) return;
  $('modal-escaner').classList.add('escaner-ayuda');
  // A los 8 s ya se sabe si hay botón de linterna: no se manda a buscar uno que
  // no existe.
  const hayLinterna = !$('btn-linterna').classList.contains('oculta');
  $('escaner-texto').textContent = '¿No lee? Acércate hasta que el QR llene el recuadro y mantén el teléfono quieto. '
    + (hayLinterna ? 'Si está oscuro, enciende la luz.' : 'Si está oscuro, busca más luz o ingresa el código a mano.');
  $('btn-escaner-manual').classList.remove('oculta');
}

async function abrirEscaner() {
  // Ya abierto: una segunda activación del botón de atrás (Enter de un teclado,
  // doble toque de TalkBack con el foco en el botón) no abre otro turno. Si lo
  // abriera, la cámara del primero quedaría encendida para siempre en un kiosco.
  if (escaneando) return;
  // Toque del guardia: si el GPS murió por un permiso negado se vuelve a pedir
  // ahora, mientras apunta, y no recién cuando el QR ya se leyó.
  reengancharSiNegado();
  const turno = ++turnoEscaner;
  $('modal-escaner').classList.remove('oculta', 'escaner-ayuda');
  $('escaner-texto').textContent = TEXTO_ESCANER;
  $('btn-escaner-manual').classList.add('oculta');
  $('btn-linterna').classList.add('oculta');
  linternaEncendida = false;
  escaneando = true;
  // Con el lector abierto hay una marca en juego: si el watch venía callado se
  // reengancha ya, y la lectura nueva llega mientras el guardia apunta.
  vigilarGps();
  try {
    const nuevo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    // El guardia pudo cancelar (o cancelar y reabrir) mientras el sistema
    // preguntaba por el permiso: esta cámara ya no es de nadie.
    if (!turnoVivo(turno)) {
      for (const pista of nuevo.getTracks()) pista.stop();
      return;
    }
    // Segunda defensa: nunca se pisa la referencia a una cámara sin apagarla.
    if (stream) for (const pista of stream.getTracks()) pista.stop();
    stream = nuevo;
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    if (!turnoVivo(turno)) return;
    const capacidades = capacidadesCamara();
    // Enfoque continuo donde se pueda pedir: un QR a 20 cm con el foco clavado
    // en el infinito no lo lee ningún decodificador.
    if (Array.isArray(capacidades.focusMode) && capacidades.focusMode.includes('continuous')) {
      pistaVideo().applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    if (capacidades.torch) {
      $('btn-linterna').textContent = '🔦 Encender luz';
      $('btn-linterna').classList.remove('oculta');
    }
    clearTimeout(ayudaEscanerTimer);
    ayudaEscanerTimer = setTimeout(() => mostrarAyudaEscaner(turno), AYUDA_ESCANER_MS);
    if ('BarcodeDetector' in window) {
      cicloDetector(new BarcodeDetector({ formats: ['qr_code'] }), turno);
    } else {
      cicloJsqr(turno);
    }
  } catch (err) {
    // Un turno ya cerrado no tiene a quién avisarle: el play() que revienta
    // porque el guardia canceló no es "no se pudo abrir la cámara".
    if (!turnoVivo(turno)) return;
    cerrarEscaner();
    aviso('No se pudo abrir la cámara. Usa el código manual.', 'error');
  }
}

function cerrarEscaner() {
  escaneando = false;
  clearTimeout(ayudaEscanerTimer);
  ayudaEscanerTimer = null;
  if (stream) {
    for (const pista of stream.getTracks()) pista.stop();
    stream = null;
  }
  $('modal-escaner').classList.add('oculta');
}

function abrirManual() {
  $('campo-codigo').value = '';
  $('modal-manual').classList.remove('oculta');
  $('campo-codigo').focus();
}

// Devuelve true si consumió el código (cerró el lector y lo procesó). Con el
// mismo QR de hace menos de 2,5 s devuelve false y el ciclo SIGUE leyendo: hasta
// v1.21 ese caso terminaba el ciclo y dejaba la cámara viva sin leer nada —el
// guardia que volvía a abrir el lector con el QR todavía al frente se quedaba
// apuntando a una cámara sorda—. La ventana se conserva: si un detect() en vuelo
// resuelve después de cerrar, evita procesar el mismo código dos veces.
function codigoDetectado(valor) {
  const ahora = Date.now();
  if (valor === ultimoCodigoLeido.valor && ahora - ultimoCodigoLeido.ts < 2500) return false;
  ultimoCodigoLeido = { valor, ts: ahora };
  cerrarEscaner();
  procesarCodigo(valor);
  return true;
}

// Cuántos fallos seguidos del detector nativo se toleran antes de pasar a jsQR.
const FALLOS_DETECTOR_MAX = 5;
// Desde cuándo y cada cuánto se intercala jsQR con un detector nativo que
// responde pero no lee nada.
const RESPALDO_JSQR_MS = 3000;
const CADA_JSQR_MS = 500;

function cicloDetector(detector, turno) {
  const video = $('video');
  const pasarJsqr = lectorJsqr();
  const inicio = Date.now();
  let fallos = 0;
  let proximoJsqr = 0;
  const paso = async () => {
    if (!turnoVivo(turno)) return;
    try {
      const codigos = (await detector.detect(video)).filter(c => c.rawValue);
      if (!turnoVivo(turno)) return;
      fallos = 0;
      // Con dos códigos en cuadro (el QR y la etiqueta de un medidor al lado)
      // gana el que es de la app, no el primero que devolvió el detector.
      const propio = codigos.find(c => c.rawValue.toUpperCase().startsWith('RQR:')) || codigos[0];
      if (propio) {
        if (codigoDetectado(propio.rawValue)) return;
      } else if (Date.now() - inicio > RESPALDO_JSQR_MS && Date.now() >= proximoJsqr) {
        const { texto, ms } = pasarJsqr();
        // El próximo turno de jsQR se cuenta desde que ESTA pasada terminó y
        // crece con lo que costó: con una escena oscura y ruidosa una pasada
        // puede llevar casi un segundo, y el detector nativo —que puede estar
        // funcionando— tiene que conservar la mayor parte del hilo.
        proximoJsqr = Date.now() + Math.max(CADA_JSQR_MS, 4 * ms);
        if (texto && codigoDetectado(texto)) return;
      }
    } catch {
      if (!turnoVivo(turno)) return;
      if (++fallos >= FALLOS_DETECTOR_MAX) return cicloJsqr(turno);
    }
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// Qué pedazo del cuadro de video cae bajo el recuadro de la pantalla, en píxeles
// del video. El video se muestra con object-fit: cover —escalado hasta llenar y
// recortado por los lados—, así que hay que deshacer esa cuenta. Puro: recibe
// las medidas y devuelve un cuadrado {x, y, lado}, o null si no hay con qué.
//
// `margen` agranda el recuadro: jsQR necesita ver los tres ojos del QR completos
// y el guardia nunca lo centra perfecto.
function recorteEscaner(videoW, videoH, cajaVideo, cajaMarco, margen = 1.3) {
  if (!(videoW > 0 && videoH > 0) || !cajaVideo || !cajaMarco) return null;
  if (!(cajaVideo.width > 0 && cajaVideo.height > 0 && cajaMarco.width > 0)) return null;
  const escala = Math.max(cajaVideo.width / videoW, cajaVideo.height / videoH);
  // Lo que object-fit: cover dejó fuera de pantalla, por cada lado.
  const fueraX = (videoW * escala - cajaVideo.width) / 2;
  const fueraY = (videoH * escala - cajaVideo.height) / 2;
  const centroX = (cajaMarco.left - cajaVideo.left + cajaMarco.width / 2 + fueraX) / escala;
  const centroY = (cajaMarco.top - cajaVideo.top + cajaMarco.height / 2 + fueraY) / escala;
  const lado = Math.floor(Math.min(Math.max(cajaMarco.width, cajaMarco.height) * margen / escala, videoW, videoH));
  if (!(lado > 0) || !Number.isFinite(centroX) || !Number.isFinite(centroY)) return null;
  const acotar = (v, max) => Math.round(Math.min(Math.max(v, 0), max));
  return { x: acotar(centroX - lado / 2, videoW - lado), y: acotar(centroY - lado / 2, videoH - lado), lado };
}

// Tamaños de lo que se le pasa a jsQR. La ganancia está en el recorte: el
// recuadro llega a 640 px en vez de ocupar ~340 de un cuadro de 480, casi el
// doble de píxeles por módulo para un QR chico o a un metro. No se va a
// resolución nativa a propósito: con poca luz el sensor mete ruido, el
// binarizador de jsQR lo convierte en miles de candidatos a "ojo" y una pasada
// de 800 px pasaba de decenas de milisegundos a casi un segundo. Achicar con
// suavizado promedia ese ruido. El cuadro completo va como en v1.20, solo como
// red para el QR que quedó fuera del recuadro.
const LADO_RECORTE_MAX = 640;
const ANCHO_COMPLETO = 480;
// Respiro mínimo entre pasadas. jsQR es síncrono: sin pausa el teléfono se va
// en decodificar y el video del visor y los botones se traban, que es lo
// contrario de ayudar a apuntar. La pausa real crece con lo que costó la pasada.
const PAUSA_JSQR_MS = 40;

// Una pasada de jsQR sobre el cuadro actual: devuelve el texto leído (o null) y
// cuánto tardó. La usan el ciclo de jsQR y el respaldo intercalado del detector
// nativo, que reparten el hilo según ese costo.
function lectorJsqr() {
  const video = $('video');
  const lienzo = $('lienzo');
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  let pasada = 0;
  return () => {
    if (!window.jsQR || video.readyState !== video.HAVE_ENOUGH_DATA || !video.videoWidth) return { texto: null, ms: 0 };
    const t0 = Date.now();
    pasada++;
    // Dos de cada tres pasadas leen el recuadro; la tercera, el cuadro entero.
    const recorte = pasada % 3
      ? recorteEscaner(video.videoWidth, video.videoHeight,
        video.getBoundingClientRect(), document.querySelector('.escaner-marco').getBoundingClientRect())
      : null;
    if (recorte) {
      lienzo.width = lienzo.height = Math.min(recorte.lado, LADO_RECORTE_MAX);
    } else {
      const escala = Math.min(1, ANCHO_COMPLETO / video.videoWidth);
      lienzo.width = Math.round(video.videoWidth * escala);
      lienzo.height = Math.round(video.videoHeight * escala);
    }
    // Cambiar el tamaño del lienzo reinicia el contexto: el suavizado va después.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (recorte) ctx.drawImage(video, recorte.x, recorte.y, recorte.lado, recorte.lado, 0, 0, lienzo.width, lienzo.height);
    else ctx.drawImage(video, 0, 0, lienzo.width, lienzo.height);
    const imagen = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
    // Una de cada cuatro prueba también el QR invertido (claro sobre oscuro):
    // cuesta el doble, así que no va en todas.
    const resultado = window.jsQR(imagen.data, imagen.width, imagen.height,
      { inversionAttempts: pasada % 4 ? 'dontInvert' : 'attemptBoth' });
    return { texto: resultado && resultado.data ? resultado.data : null, ms: Date.now() - t0 };
  };
}

function cicloJsqr(turno) {
  const pasar = lectorJsqr();
  const paso = () => {
    if (!turnoVivo(turno)) return;
    const { texto, ms } = pasar();
    if (texto && codigoDetectado(texto)) return;
    // Al menos tan larga como la pasada: jsQR nunca se lleva más de la mitad del
    // hilo, y Cancelar, la luz y "Código a mano" siguen respondiendo.
    setTimeout(paso, Math.max(PAUSA_JSQR_MS, ms));
  };
  paso();
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
  pintarAlarma();

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

// ---------- Actualización remota ----------
// El teléfono de la garita corre en modo kiosco: la página no se cierra nunca
// y nadie la recarga, así que un deploy no llega solo. Cada minuto se le
// pregunta al servidor qué versión sirve; si no es esta, la app se recarga
// cuando es seguro (sin ronda en curso, sin nada por enviar, sin nadie
// escribiendo). De paso el servidor anota qué versión corre este guardia y el
// panel la muestra: es la constancia de que el deploy llegó.

const CLAVE_RECARGA = 'rondasqr-recarga';

function seguroRecargar() {
  const foco = document.activeElement;
  const escribiendo = foco && /^(INPUT|TEXTAREA|SELECT)$/.test(foco.tagName);
  // Con la alarma de Fully sonando tampoco: la recarga la cortaría a la mitad.
  return !estado.ejecucion && !estado.cola.length && !sincronizando && !escribiendo && !alarmaTimer;
}

async function revisarVersion() {
  if (!navigator.onLine) return;
  let version;
  try {
    const anonimo = () => api('/api/version');
    const r = estado.sesion
      ? await api('/api/mi/version', { metodo: 'POST', cuerpo: { version: VERSION_APP } }).catch(anonimo)
      : await anonimo();
    version = r.version;
  } catch {
    return; // sin red o servidor caído: se reintenta en el próximo ciclo
  }
  // Misma versión que el servidor, pero corriendo sobre una página o un estilos
  // de otra (ver shellMixto): también hay que recargar, cuando sea seguro.
  if (!version || (version === VERSION_APP && !shellMixto()) || !seguroRecargar()) return;
  // Antes de soltar la página que funciona se comprueba que la nueva está
  // completa en el servidor: la página es la de esa versión y app.js también.
  // Si no (deploy a medias, sin señal, copia vieja del caché que el service
  // worker devuelve como si fuera buena), no se recarga.
  try {
    const [pagina, codigo] = await Promise.all([
      fetch('./', { cache: 'no-store' }),
      fetch('app.js', { cache: 'no-store' })
    ]);
    if (!pagina.ok || !codigo.ok) return;
    if (!(await codigo.text()).includes(`VERSION_APP = '${version}'`)) return;
    // La página tiene que ser la de esa versión. Una que declara OTRA versión no
    // sirve nunca. Una sin marca (anterior a v1.21) sirve solo si es un cambio
    // real de versión —un rollback a v1.20.x tiene que llegar a los kioscos—;
    // para reparar un shell mezclado, sin marca es justo la copia vieja del caché.
    const marca = /<meta name="version-app" content="([^"]+)">/.exec(await pagina.text());
    if (marca ? marca[1] !== version : version === VERSION_APP) return;
  } catch {
    return;
  }
  if (!seguroRecargar()) return; // pudo empezar una ronda mientras se comprobaba
  // Freno por si la recarga no trae la versión nueva (un caché intermedio):
  // tres intentos seguidos y después uno por hora, nunca un bucle de recargas.
  let intento = {};
  try { intento = JSON.parse(localStorage.getItem(CLAVE_RECARGA)) || {}; } catch { /* sin respaldo: se parte de cero */ }
  if (intento.version !== version) intento = { version, veces: 0, ts: 0 };
  if (intento.veces >= 3 && Date.now() - intento.ts < 60 * 60 * 1000) return;
  intento.veces++;
  intento.ts = Date.now();
  try { localStorage.setItem(CLAVE_RECARGA, JSON.stringify(intento)); } catch { /* sin freno, pero se recarga igual */ }
  try {
    const reg = await conTope(navigator.serviceWorker.getRegistration(), 3000);
    if (reg) await conTope(reg.update(), 5000);
  } catch { /* sin service worker: la recarga igual trae lo nuevo */ }
  location.reload();
}

// ---------- Alarma de ronda en este teléfono ----------
// Cada cuánto suena lo decide el administrador (viene en el paquete como
// alarmaMin). La suscripción queda amarrada al condominio, no al guardia: si
// cambia el turno y entra otro, el teléfono de la garita sigue sonando.
//
// Dos caminos, y en cada teléfono corre UNO solo (modoAlarma()), así una misma
// alarma no puede sonar dos veces en la misma app:
//   'push'    Web Push (Chrome Android, iPhone con la app instalada). Suena
//             aunque la app esté cerrada.
//   'fully'   Fully Kiosk con su interfaz JavaScript activa (objeto `fully`).
//             El Android WebView no tiene push: la app le pregunta al servidor
//             cada minuto y la hace sonar con las funciones de Fully. Solo con
//             la página viva: pantalla encendida o con el protector de pantalla.
//   'kiosco'  Android WebView SIN la interfaz de Fully: no puede sonar; la app
//             dice qué ajuste falta.
// Si el teléfono también tiene la app en Chrome con la alarma activada, esa es
// otra app y suena aparte: eso se evita en la configuración (FULLY-KIOSK.md).

function fullyDisponible() {
  return typeof fully !== 'undefined' && fully !== null && typeof fully.playSound === 'function';
}

// "; wv)" en el user agent es la marca del Android WebView (Fully lo usa, Chrome no).
function esWebViewAndroid() {
  return /;\s*wv\)/.test(navigator.userAgent || '');
}

function modoAlarma() {
  if (fullyDisponible()) return 'fully';
  if (pushSoportado()) return 'push';
  if (esWebViewAndroid() || leerAlarmaKiosco()) return 'kiosco';
  return null;
}

function base64AUint8(base64) {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const crudo = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(crudo, c => c.charCodeAt(0));
}

function pushSoportado() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function textoIntervalo(min) {
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60), resto = min % 60;
  const horas = h === 1 ? '1 hora' : `${h} horas`;
  if (!resto) return horas;
  return resto === 30 ? `${horas} y media` : `${horas} ${resto} min`;
}

async function pintarAlarma() {
  const btn = $('btn-alarma');
  const nota = $('estado-alarma');
  const min = (estado.paquete && estado.paquete.alarmaMin) || 0;
  const modo = modoAlarma();
  if (modo === 'fully' || modo === 'kiosco') return pintarAlarmaKiosco(modo, alarmaKioscoMin !== null ? alarmaKioscoMin : min);
  if (modo !== 'push') {
    btn.classList.add('oculta');
    nota.textContent = min ? 'Este navegador no puede recibir la alarma de ronda. En iPhone: instala la app en la pantalla de inicio y ábrela desde ahí.' : '';
    return;
  }
  btn.classList.remove('oculta');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.textContent = sub ? '🔕 Desactivar alarma de ronda en este teléfono' : '⏰ Activar alarma de ronda en este teléfono';
    btn.disabled = Notification.permission === 'denied';
    if (Notification.permission === 'denied') nota.textContent = 'Las notificaciones están bloqueadas para esta app. Actívalas en la configuración del teléfono.';
    else if (!min) nota.textContent = 'El administrador todavía no programó la alarma de ronda.';
    else nota.textContent = sub ? `Alarma activa: suena cada ${textoIntervalo(min)}.` : `El administrador programó una alarma cada ${textoIntervalo(min)}.`;
  } catch {
    btn.disabled = true;
    nota.textContent = 'No se pudo consultar el estado de las notificaciones.';
  }
}

async function alternarAlarma() {
  if (modoAlarma() !== 'push') return alternarAlarmaKiosco();
  const btn = $('btn-alarma');
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/mi/push/suscribir', { metodo: 'DELETE', cuerpo: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      aviso('Alarma de ronda desactivada en este teléfono.');
    } else {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        aviso('Sin permiso de notificaciones no puede sonar la alarma.', 'error');
        return pintarAlarma();
      }
      const { clave } = await api('/api/push/clave');
      const nueva = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64AUint8(clave) });
      await api('/api/mi/push/suscribir', { metodo: 'POST', cuerpo: { suscripcion: nueva.toJSON() } });
      aviso('Listo: la alarma de ronda sonará en este teléfono.', 'ok');
    }
  } catch (err) {
    aviso(err.message || 'No se pudo cambiar la alarma de ronda.', 'error');
  }
  pintarAlarma();
}

// ---------- Alarma de ronda dentro de Fully Kiosk ----------
// Cuándo toca lo decide el servidor (lib/recordatorios.js, el mismo reloj que
// el Web Push): acá no se cuentan intervalos. La app pregunta una vez por
// minuto, con la credencial del teléfono que el servidor entregó al activarla
// (sirve sin sesión: la garita puede quedar en el login), y el servidor contesta
// con la alarma en pie, si hay. Cada alarma suena UNA vez por teléfono: su `ts`
// queda anotado acá como `vista`, también después de una recarga.
//
// Sin señal no llega nada (igual que el push); al volver, si la alarma sigue en
// pie (nadie salió a la ronda y no se cumplió el intervalo), suena atrasada.
//
// Registro en localStorage, fuera de `estado`: tiene que sobrevivir a "Salir"
// (es del teléfono, no del guardia). { token, vista, sonada }

const CLAVE_ALARMA_KIOSCO = 'rondasqr-alarma-kiosco';
// alarma.wav: tres pitidos por segundo durante 4 s (8 kHz, 8 bits). Se toca
// sin bucle y la app lo repite: si la página muere a la mitad, el sonido se
// corta solo en segundos en vez de quedar sonando para siempre.
const SONIDO_ALARMA_MS = 4000;
// Cuánto insiste si nadie toca «Entendido». El aviso en pantalla queda.
const ALARMA_INSISTE_MS = 60000;
// Canal de audio de Android para playSound: 4 = alarma (tiene su propio
// volumen, aparte del de multimedia).
const CANAL_ALARMA = 4;

let alarmaKioscoMin = null;        // cada cuánto, según la última consulta
let alarmaKioscoConexion = null;   // null: sin consultar todavía · true/false
let alarmaKioscoConsultando = false;
let alarmaTimer = null;            // repetición del sonido mientras insiste
let alarmaAviso = null;            // el aviso en pantalla

function leerAlarmaKiosco() {
  try {
    const r = JSON.parse(localStorage.getItem(CLAVE_ALARMA_KIOSCO));
    return r && typeof r.token === 'string' ? r : null;
  } catch {
    return null;
  }
}

function guardarAlarmaKiosco(registro) {
  try { localStorage.setItem(CLAVE_ALARMA_KIOSCO, JSON.stringify(registro)); } catch { /* se pierde la anotación, no la alarma */ }
}

// Qué hacer con la alarma que contestó el servidor:
//   null       nada: no hay, ya pasó por este teléfono, o viene rota
//   'sonar'    hacerla sonar
//   'atender'  anotarla sin sonar: el guardia ya está en una ronda en ESTE
//              teléfono (el servidor puede no saberlo: la ronda se inició sin
//              señal). La prueba del panel suena igual: la pidieron a propósito.
function decidirAlarmaKiosco(alarma, registro, rondaEnCurso) {
  if (!alarma || !registro) return null;
  const ts = Date.parse(alarma.ts);
  if (!Number.isFinite(ts)) return null;
  if (ts <= (Date.parse(registro.vista) || 0)) return null;
  return rondaEnCurso && !alarma.prueba ? 'atender' : 'sonar';
}

// Llama una función de Fully sin dejar que una que falte (versión vieja de
// Fully) o que lance frene a las demás.
function llamarFully(nombre, ...args) {
  try {
    if (fullyDisponible() && typeof fully[nombre] === 'function') return fully[nombre](...args);
  } catch { /* sigue con las otras */ }
  return null;
}

async function consultarAlarmaKiosco() {
  const registro = leerAlarmaKiosco();
  if (!registro || alarmaKioscoConsultando) return;
  if (!navigator.onLine) {
    alarmaKioscoConexion = false;
    return;
  }
  alarmaKioscoConsultando = true;
  const interfaz = fullyDisponible();
  try {
    const r = await api('/api/alarma-kiosco', {
      metodo: 'POST', cuerpo: { token: registro.token, interfaz, sonada: registro.sonada || null }
    });
    alarmaKioscoConexion = true;
    alarmaKioscoMin = Number(r.minutos) || 0;
    // Sin la interfaz no se anota nada: si la activan mientras la alarma sigue
    // en pie, suena entonces. Se relee el registro: lo pudieron desactivar
    // mientras la consulta iba y volvía.
    const vigente = leerAlarmaKiosco();
    const rondaEnCurso = Boolean(estado.ejecucion && !estado.ejecucion.cerrada);
    const accion = interfaz && vigente ? decidirAlarmaKiosco(r.alarma, vigente, rondaEnCurso) : null;
    if (accion) {
      // Se anota ANTES de sonar: si algo de Fully lanza, no se reintenta cada minuto.
      vigente.vista = r.alarma.ts;
      if (accion === 'sonar') vigente.sonada = r.alarma.ts;
      guardarAlarmaKiosco(vigente);
      if (accion === 'sonar') sonarAlarmaKiosco(r.alarma);
    }
  } catch (err) {
    if (err.status === 404) {
      // El servidor ya no lo tiene: lo dieron de baja, pasó una semana sin
      // consultar o se borró la cuenta que lo activó.
      try { localStorage.removeItem(CLAVE_ALARMA_KIOSCO); } catch {}
      alarmaKioscoConexion = null;
      aviso('La alarma de ronda se desactivó en este teléfono. Actívala de nuevo si corresponde.', 'error', 8000);
    } else {
      alarmaKioscoConexion = false;
    }
  } finally {
    alarmaKioscoConsultando = false;
  }
  if (estado.sesion) pintarAlarma();
}

function sonarAlarmaKiosco(alarma) {
  cerrarAlarmaKiosco();
  // Con el protector de pantalla la página sigue viva: se lo saca y se trae Fully
  // al frente. Con la pantalla APAGADA esto ya no corre (el WebView se detiene).
  llamarFully('turnScreenOn');
  llamarFully('stopScreensaver');
  llamarFully('bringToForeground');
  llamarFully('showNotification', alarma.titulo, alarma.cuerpo, new URL('./', location.href).href, true);
  llamarFully('vibrate', 1500);
  const sonido = new URL('alarma.wav', location.href).href;
  const inicio = Date.now();
  llamarFully('playSound', sonido, false, CANAL_ALARMA);
  alarmaTimer = setInterval(() => {
    if (Date.now() - inicio + SONIDO_ALARMA_MS > ALARMA_INSISTE_MS) return callarAlarmaKiosco();
    llamarFully('playSound', sonido, false, CANAL_ALARMA);
  }, SONIDO_ALARMA_MS);
  mostrarAvisoAlarma(alarma);
}

// Encima de todo (también del lector y del login), con estilo en línea: tiene
// que verse aunque el estilos.css cargado sea de otra versión.
function mostrarAvisoAlarma(alarma) {
  const caja = document.createElement('div');
  caja.className = 'caja caja-alerta';
  caja.setAttribute('role', 'alert');
  // El tono de .caja-alerta es transparente: va sobre un fondo opaco para que
  // no se trasluzca la pantalla de abajo.
  caja.style.cssText = 'position:fixed;left:16px;right:16px;top:16px;z-index:70;margin:0 auto;max-width:520px;'
    + 'background:linear-gradient(rgba(245,158,11,.18),rgba(245,158,11,.18)),#1d1d28;'
    + 'box-shadow:0 12px 32px rgba(0,0,0,.5)';
  caja.innerHTML = `<strong>${esc(alarma.titulo)}</strong>`
    + `<p>${esc(alarma.cuerpo)} (${esc(hora(Date.now()))})</p>`
    + '<button class="btn btn-principal">Entendido</button>';
  caja.querySelector('button').addEventListener('click', cerrarAlarmaKiosco);
  document.body.appendChild(caja);
  alarmaAviso = caja;
}

function callarAlarmaKiosco() {
  if (!alarmaTimer) return;
  clearInterval(alarmaTimer);
  alarmaTimer = null;
  llamarFully('stopSound');
}

function cerrarAlarmaKiosco() {
  callarAlarmaKiosco();
  if (alarmaAviso) alarmaAviso.remove();
  alarmaAviso = null;
}

function pintarAlarmaKiosco(modo, min) {
  const btn = $('btn-alarma');
  const nota = $('estado-alarma');
  const registro = leerAlarmaKiosco();
  btn.disabled = false;
  if (modo === 'kiosco' && !registro) {
    btn.classList.add('oculta');
    nota.textContent = min
      ? 'En este navegador la alarma de ronda no puede sonar. Si es Fully Kiosk, falta activar su interfaz JavaScript: avísale a soporte.'
      : '';
    return;
  }
  btn.classList.remove('oculta');
  btn.textContent = registro ? '🔕 Desactivar alarma de ronda en este teléfono' : '⏰ Activar alarma de ronda en este teléfono';
  if (!registro) {
    nota.textContent = min
      ? `El administrador programó una alarma cada ${textoIntervalo(min)}. En este teléfono suena con la pantalla encendida o con el protector de pantalla, no apagada.`
      : 'El administrador todavía no programó la alarma de ronda.';
  } else if (modo === 'kiosco') {
    nota.textContent = 'La alarma está activada, pero Fully tiene apagada su interfaz JavaScript y así no puede sonar. Avísale a soporte.';
  } else if (alarmaKioscoConexion === false) {
    nota.textContent = 'Sin conexión con el servidor: la alarma no puede llegar hasta que vuelva la señal.';
  } else if (!min) {
    nota.textContent = 'Alarma activada en este teléfono, pero el administrador todavía no la programó.';
  } else {
    nota.textContent = `Alarma activa: suena cada ${textoIntervalo(min)}. Deja la pantalla encendida o con el protector: apagada no suena.`;
  }
}

async function alternarAlarmaKiosco() {
  const btn = $('btn-alarma');
  btn.disabled = true;
  const registro = leerAlarmaKiosco();
  try {
    if (registro) {
      await api('/api/mi/alarma-kiosco', { metodo: 'DELETE', cuerpo: { token: registro.token } });
      try { localStorage.removeItem(CLAVE_ALARMA_KIOSCO); } catch {}
      cerrarAlarmaKiosco();
      alarmaKioscoConexion = null;
      aviso('Alarma de ronda desactivada en este teléfono.');
    } else if (fullyDisponible()) {
      const r = await api('/api/mi/alarma-kiosco', {
        metodo: 'POST', cuerpo: { dispositivo: llamarFully('getDeviceId'), nombre: llamarFully('getDeviceName') }
      });
      // La alarma que ya estaba en pie queda como vista: activar no la hace sonar de golpe.
      guardarAlarmaKiosco({ token: r.token, vista: r.alarma ? r.alarma.ts : null, sonada: null });
      alarmaKioscoMin = Number(r.minutos) || 0;
      alarmaKioscoConexion = true;
      aviso('Listo: la alarma de ronda sonará en este teléfono mientras la app esté abierta y la pantalla no se apague.', 'ok', 8000);
    }
  } catch (err) {
    aviso(err.status ? err.message : 'Necesitas conexión para cambiar la alarma de ronda.', 'error');
  }
  pintarAlarma();
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
  // La marca en espera o retenida va en su propio panel, junto al botón de
  // escanear; esta línea sigue mostrando la señal, que es lo que la resuelve.
  pintarMarca();
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

// Mismo texto que el informe (lib/informes.js).
const MEDIOS = { nfc: '📶 NFC', qr: '📷 QR', manual: '⌨️ a mano' };

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
  // En una ronda de puros QR todo queda como antes de las chapitas, también el
  // botón: los guardias de un condominio sin chapitas no tienen por qué
  // enterarse de que existen. "Escanear" a secas solo donde hay alguna.
  const conChapitas = ronda.puntos.some(p => p.nfc);
  $('btn-escanear').textContent = conChapitas ? 'Escanear' : '📷 Escanear QR';
  // Sin pisar lo que el guardia está escribiendo: renderRonda corre con cada marca.
  const comentario = $('ronda-comentario');
  if (document.activeElement !== comentario) comentario.value = ejecucion.comentario || '';
  pintarGps();

  const lista = $('lista-puntos');
  lista.innerHTML = '';
  const marcados = new Map(ejecucion.escaneos.map(e => [e.puntoId, e]));
  // Con qué se marcó cada punto solo se muestra en una ronda con chapitas
  // (conChapitas, arriba): en una ronda de puros QR la pantalla queda igual.
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
        <div class="nota">${marca
          ? `Marcado ${esc(hora(marca.ts))}${conChapitas && MEDIOS[marca.medio] ? ` · ${MEDIOS[marca.medio]}` : ''}${marca.offline ? ' (sin señal)' : ''}`
          : `Pendiente${p.nfc ? ' · 📶 chapita' : ''}${(ejecucion.reportados || []).includes(p.id) ? ' · ⚠️ avisaste que no lee' : ''}`}</div>
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

// ---------- Página de otra versión (v1.21) ----------
// El service worker es network-first ARCHIVO POR ARCHIVO. Con señal
// intermitente justo después de un deploy, la página puede salir de la copia
// vieja del caché y app.js del servidor ya nuevo, o estilos.css viejo con lo
// demás nuevo, en cualquier combinación. En el teléfono de la garita (kiosco)
// eso no lo arregla nadie a mano. Y el salto a esta versión lo ejecuta el
// código de la ANTERIOR, que no sabe comprobarlo: la protección tiene que vivir
// acá. Dos partes:
//   · completarHtmlAnterior() deja la página vieja con la misma estructura que
//     la nueva (agrega lo que falta y envuelve el video en el visor) y, si los
//     estilos son de otra versión, inyecta las reglas que mantienen "Cancelar"
//     a la vista;
//   · shellMixto() le dice a revisarVersion() que recargue cuando sea seguro,
//     para terminar de bajar la página y los estilos de esta versión.
// Las dos versiones se leen de marcas explícitas —<meta name="version-app"> en
// index.html y --version-app en estilos.css—, no de cómo se ve la página: una
// medida de maquetación con el lector oculto no distingue nada.
let estilosAnteriores = false;

function versionDelShell() {
  const meta = document.querySelector('meta[name="version-app"]');
  return meta ? meta.getAttribute('content') : null;
}

function versionDeEstilos() {
  try {
    const valor = getComputedStyle(document.documentElement).getPropertyValue('--version-app');
    return String(valor || '').trim().replace(/^["']|["']$/g, '') || null;
  } catch {
    return null;
  }
}

function shellMixto() {
  return versionDelShell() !== VERSION_APP || estilosAnteriores;
}

// Lo mínimo del lector y del panel que tiene que valer aunque estilos.css sea de
// otra versión (o no haya cargado): el visor que se encoge, el video dentro de
// él y el pie siempre por encima. Sin esto un guardia de kiosco puede quedar
// encerrado en la cámara, con Cancelar fuera de la pantalla o tapado.
const ESTILOS_MINIMOS = '.escaner-visor{position:relative;flex:1 1 0;min-height:0;overflow:hidden}'
  + '#video{flex:1;width:100%;min-height:0;object-fit:cover}'
  + '.escaner-visor>#video{position:absolute;inset:0;height:100%}'
  + '.escaner-visor .escaner-marco{transform:translate(-50%,-50%);width:auto;height:min(70vw,300px,85%)}'
  + '.escaner-pie{position:relative;z-index:1;flex:none;max-height:60vh;overflow-y:auto}'
  + '.escaner-pie .botonera-fila .btn{font-size:15px;padding:14px 10px}'
  + '#btn-cancelar-escaner{position:sticky;bottom:0}'
  + '.marca-estado .botonera-fila{margin-top:12px}';

// La pantalla de la chapita, para la página de una versión anterior. Es la
// misma de index.html: si cambia allá, cambia acá.
const HTML_MODAL_NFC = `
  <div id="modal-nfc" class="modal modal-centrado oculta">
    <div class="dialogo dialogo-nfc">
      <svg class="dibujo-nfc" viewBox="0 0 160 120" aria-hidden="true">
        <rect x="58" y="6" width="58" height="104" rx="9" fill="none" stroke="currentColor" stroke-width="5"/>
        <circle cx="87" cy="20" r="4" fill="currentColor"/>
        <path d="M44 40a26 26 0 0 0 0 40M34 32a38 38 0 0 0 0 56" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
        <rect x="4" y="44" width="30" height="30" rx="7" fill="currentColor" opacity=".85"/>
      </svg>
      <h2>Acerca la parte trasera del teléfono a la chapita</h2>
      <p id="nfc-texto" class="nota centrado" role="status"></p>
      <button id="btn-reintentar-nfc" class="btn btn-principal oculta">Reintentar</button>
      <div id="nfc-reporte" class="oculta"></div>
      <div class="botonera-fila">
        <button id="btn-cancelar-nfc" class="btn btn-borde">Cancelar</button>
        <button id="btn-nfc-reportar" class="btn btn-borde">⚠️ La chapita no lee</button>
      </div>
    </div>
  </div>

  <!-- Ronda con puntos de QR y de chapita, sin orden: la app no sabe frente a
       cuál está el guardia, así que pregunta. Abre solo la cámara o solo el
       lector de la chapita, nunca los dos. -->
  <div id="modal-medio" class="modal modal-centrado oculta">
    <div class="dialogo dialogo-nfc">
      <h2>¿Qué hay en este punto?</h2>
      <div class="botonera-fila">
        <button id="btn-medio-qr" class="btn btn-principal">📷 Un QR</button>
        <button id="btn-medio-nfc" class="btn btn-principal">📶 Una chapita</button>
      </div>
      <button id="btn-cancelar-medio" class="btn btn-borde">Cancelar</button>
    </div>
  </div>`;

// Idempotente y sin lanzar: corre en cada arranque, también sobre la página
// nueva, donde no hace nada. Usa solo clases que ya existían en estilos.css.
function completarHtmlAnterior() {
  try {
    const escanear = $('btn-escanear');
    if (!$('marca-estado') && escanear) {
      escanear.insertAdjacentHTML('beforebegin', `
        <div id="marca-estado" class="caja caja-alerta marca-estado oculta">
          <strong id="marca-titulo"></strong>
          <p id="marca-detalle" class="marca-detalle" role="status"></p>
          <div id="marca-acciones" class="botonera-fila oculta">
            <button id="btn-descartar-marca" class="btn btn-borde">Cancelar</button>
            <button id="btn-reintentar-marca" class="btn btn-principal">Reintentar</button>
          </div>
        </div>`);
    }
    // v1.24: la pantalla de la chapita y la pregunta de la ronda mixta
    // (CU-28). El texto del botón lo pone renderRonda() según la ronda.
    if (!$('modal-nfc') && $('modal-manual')) $('modal-manual').insertAdjacentHTML('afterend', HTML_MODAL_NFC);
    const cancelar = $('btn-cancelar-escaner');
    if (cancelar && !$('escaner-texto')) {
      const texto = cancelar.parentNode.querySelector('p');
      if (texto) {
        texto.id = 'escaner-texto';
        texto.setAttribute('role', 'status');
      } else {
        cancelar.insertAdjacentHTML('beforebegin', '<p id="escaner-texto" class="nota centrado" role="status"></p>');
      }
    }
    if (cancelar && !$('btn-linterna')) {
      cancelar.insertAdjacentHTML('beforebegin', `
        <div class="botonera-fila">
          <button id="btn-linterna" class="btn btn-borde oculta">🔦 Encender luz</button>
          <button id="btn-escaner-manual" class="btn btn-borde oculta">⌨️ Código a mano</button>
        </div>`);
    }
    // En la página vieja el video y el recuadro cuelgan directo del modal. Se
    // los envuelve en el visor, igual que en la página nueva: así un mismo
    // estilos.css (el viejo, el nuevo o las reglas mínimas) vale para las dos.
    const video = $('video');
    const padre = video && video.parentNode;
    if (padre && !(padre.classList && padre.classList.contains('escaner-visor'))) {
      const visor = document.createElement('div');
      visor.className = 'escaner-visor';
      padre.insertBefore(visor, video);
      visor.appendChild(video);
      const marco = document.querySelector('.escaner-marco');
      if (marco) visor.appendChild(marco);
    }
    if (versionDeEstilos() !== VERSION_APP) {
      estilosAnteriores = true;
      if (!$('estilos-shell-anterior')) {
        document.head.insertAdjacentHTML('beforeend', `<style id="estilos-shell-anterior">${ESTILOS_MINIMOS}</style>`);
      }
    }
  } catch { /* lo que no se pudo completar lo resuelve la recarga, con red */ }
}

document.addEventListener('DOMContentLoaded', () => {
  // Antes que cualquier otra cosa: los botones de esta versión se cablean abajo
  // y una página de la versión anterior no los trae.
  completarHtmlAnterior();
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
  $('btn-alarma').addEventListener('click', alternarAlarma);
  $('btn-eliminar-cuenta').addEventListener('click', irAEliminarCuenta);
  $('btn-cancelar-eliminar').addEventListener('click', render);
  $('btn-confirmar-eliminar').addEventListener('click', eliminarCuenta);
  $('eliminar-pin').addEventListener('keydown', e => { if (e.key === 'Enter') eliminarCuenta(); });
  $('btn-escanear').addEventListener('click', escanear);
  // Los botones de la chapita (v1.24) se cablean sin poder tumbar el arranque:
  // si una página vieja quedara sin ellos, los puntos QR tienen que seguir
  // funcionando igual. Lo mismo en la tecla Escape, más abajo.
  const alTocar = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  alTocar('btn-cancelar-nfc', cerrarPantallaNfc);
  alTocar('btn-nfc-reportar', reportarChapita);
  alTocar('btn-medio-qr', () => elegirMedio('qr'));
  alTocar('btn-medio-nfc', () => elegirMedio('nfc'));
  alTocar('btn-cancelar-medio', () => $('modal-medio').classList.add('oculta'));
  alTocar('btn-reintentar-nfc', abrirPantallaNfc);
  $('btn-cancelar-escaner').addEventListener('click', cerrarEscaner);
  $('btn-linterna').addEventListener('click', alternarLinterna);
  $('btn-escaner-manual').addEventListener('click', () => { cerrarEscaner(); abrirManual(); });
  $('btn-reintentar-marca').addEventListener('click', reintentarRetenida);
  $('btn-descartar-marca').addEventListener('click', descartarRetenida);
  $('btn-manual').addEventListener('click', abrirManual);
  $('btn-cancelar-manual').addEventListener('click', () => $('modal-manual').classList.add('oculta'));
  $('btn-confirmar-manual').addEventListener('click', () => {
    const codigo = $('campo-codigo').value.trim();
    $('modal-manual').classList.add('oculta');
    if (codigo) procesarCodigo(codigo);
  });
  $('campo-codigo').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-confirmar-manual').click(); });
  $('btn-cerrar-ronda').addEventListener('click', cerrarRonda);
  $('ronda-comentario').addEventListener('input', e => {
    if (!estado.ejecucion || estado.ejecucion.cerrada) return;
    estado.ejecucion.comentario = e.target.value;
    guardarEstado();
  });
  $('btn-volver').addEventListener('click', volverAlInicio);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('modal-escaner').classList.contains('oculta')) cerrarEscaner();
    if ($('modal-nfc') && !$('modal-nfc').classList.contains('oculta')) cerrarPantallaNfc();
    if ($('modal-medio') && !$('modal-medio').classList.contains('oculta')) $('modal-medio').classList.add('oculta');
    if (!$('modal-manual').classList.contains('oculta')) $('modal-manual').classList.add('oculta');
  });

  // Volver del segundo plano. El navegador estrangula —o mata— el watch de
  // ubicación con la pantalla apagada, y hasta v1.13 nadie lo revivía: el
  // guardia desbloqueaba el teléfono, escaneaba, y la app le decía "sin señal"
  // con el GPS técnicamente encendido. También se re-pide el Wake Lock, que el
  // sistema libera solo al ocultarse la página.
  document.addEventListener('visibilitychange', () => {
    // Al ir a segundo plano (pantalla apagada, otra app) se vuelve a guardar:
    // es el último momento seguro antes de que Android mate la app o se apague.
    if (document.visibilityState === 'hidden') {
      if (estado.ejecucion || estado.cola.length) guardarEstado();
      return;
    }
    // Con la pantalla apagada el reloj de un minuto no corre: al encenderla
    // (lo primero que hace el guardia antes de entrar) se revisa la versión, y
    // en Fully la alarma de ronda (si sonó mientras tanto y sigue en pie).
    revisarVersion();
    consultarAlarmaKiosco();
    if (!estado.sesion) return;
    if (gpsWatchId === null || !gpsFresco()) reiniciarGps();
    if (estado.ejecucion && !estado.ejecucion.cerrada) pedirWakeLock();
    pintarGps();
    pintarGpsInicio();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Primero se recupera el respaldo y recién ahí arranca todo lo que lee o
  // escribe `estado`: sincronizar con el estado viejo podría mandar dos veces
  // o perder la cola que traía el respaldo.
  recuperarRespaldo().catch(() => false).then(recuperada => {
    if (estado.sesion) pedirAlmacenamientoPersistente();
    window.addEventListener('online', () => { pintarConexion(); sincronizar(); consultarAlarmaKiosco(); });
    window.addEventListener('offline', pintarConexion);
    setInterval(sincronizar, 4000);
    $('version-app').textContent = `Versión ${VERSION_APP.slice(1)}`;
    setInterval(revisarVersion, 60000);
    revisarVersion();
    // Alarma de ronda en Fully: solo hace algo si este teléfono la activó.
    setInterval(consultarAlarmaKiosco, 60000);
    consultarAlarmaKiosco();
    // El fix GPS caduca solo (cfgGps().frescoMs): sin repintar, el guardia
    // seguiría viendo "ubicación activa" cuando ya no le van a aceptar la marca.
    setInterval(() => { vigilarGps(); pintarGps(); pintarGpsInicio(); }, 3000);
    render();
    // La app arrancó: el vigía (vigia.js) ya no tiene que rescatar nada.
    window.__appLista = true;
    if (recuperada) aviso('Se recuperó tu ronda en curso: sigue donde quedaste.', 'ok', 6000);
    sincronizar();
  });
});
