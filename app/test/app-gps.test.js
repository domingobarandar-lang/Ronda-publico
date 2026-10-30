// Lo que la app del guardia decide SOLA, sin servidor y sin pantalla:
//   consolidarFixes()   convierte el buffer de lecturas del GPS en el fix único
//                       que ve el resto del sistema (v1.14, río arriba del
//                       espejo cliente/servidor).
//   evaluarPendiente()  decide si una marca que quedó esperando señal se acepta,
//                       sigue esperando o se rechaza.
//
// Las dos son puras a propósito: son el único camino nuevo por el que una marca
// puede contar o no contar, y el arnés de paridad-gps.test.js solo puede montar
// lo que no toca el DOM. Se extraen del fuente real —no de una copia— para que
// este test no pueda quedar desfasado del archivo que se despliega.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const motor = require('../lib/rondas');
const geo = require('../public/geo');

const fuente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function extraer(nombre) {
  const i = fuente.indexOf(`function ${nombre}(`);
  assert.ok(i !== -1, `public/app.js ya no define ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

// Los umbrales también salen del fuente: si alguien los mueve en app.js, este
// test tiene que moverse con ellos y no seguir probando un número que ya no es.
function constante(nombre) {
  const m = new RegExp(`const ${nombre} = (\\d+)`).exec(fuente);
  assert.ok(m, `public/app.js ya no define ${nombre}`);
  return m[1];
}

// Monta las funciones del teléfono con las globales que usan. `geo` entra como
// parámetro: en el navegador lo carga geo.js con un <script> antes de app.js.
function montarApp(cfg) {
  const nombres = [
    'cfgGps', 'umbralesDe', 'margenM', 'distanciaM', 'minutos',
    'gpsUltimo', 'verificarPresencia', 'consolidarFixes', 'agregarFix', 'limitePendiente', 'evaluarPendiente', 'esperaSirve'
  ];
  const codigo = `
    let estado = { paquete: { gps: CFG } };
    let gpsActual = null;
    let gpsMotivoFalla = null;
    let bufferFixes = [];
    const BUFFER_MAX = ${constante('BUFFER_MAX')};
    const VENTANA_PENDIENTE_MS = ${constante('VENTANA_PENDIENTE_MS')};
    ${nombres.map(extraer).join('\n')}
    return {
      consolidarFixes, evaluarPendiente, verificarPresencia, gpsUltimo, esperaSirve,
      fijarGps: g => { gpsActual = g; },
      alimentar: fixes => { bufferFixes = []; for (const f of fixes) agregarFix(f); return bufferFixes; },
      ventanaMs: VENTANA_PENDIENTE_MS
    };
  `;
  return new Function('CFG', 'geo', codigo)(cfg, geo);
}

const cfg = motor.configGps();
const app = montarApp(cfg);

const LAT = -33.45;
const LON = -70.66;
// Una lectura a `dLatM` metros al norte del punto, tomada hace `edadS` segundos.
const fix = (dLatM, acc, edadS = 0, ahora = Date.now()) => ({
  lat: LAT + dLatM / 111320,
  lon: LON,
  acc,
  ts: ahora - edadS * 1000
});

// ---------- consolidarFixes ----------

test('CRÍTICO consolidarFixes con buffer vacío devuelve null, no {lat: NaN}', () => {
  // {lat: NaN} haría NaN la distancia, "NaN <= topeM" sería false, y el guardia
  // quedaría bloqueado con un mensaje que no explica nada.
  assert.equal(app.consolidarFixes([], Date.now()), null);
  assert.equal(app.consolidarFixes(null, Date.now()), null);
  assert.equal(app.consolidarFixes(undefined, Date.now()), null);
});

test('consolidarFixes promedia y devuelve un fix usable', () => {
  const ahora = Date.now();
  const c = app.consolidarFixes([fix(0, 8, 2, ahora), fix(2, 8, 1, ahora), fix(-2, 8, 0, ahora)], ahora);
  assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), 'el fix consolidado salió NaN');
  assert.ok(Number.isFinite(c.acc) && c.acc > 0);
  assert.ok(geo.metrosEntre({ lat: LAT, lon: LON }, c) < 2);
});

test('consolidarFixes: un fix malo NO desplaza a uno bueno', () => {
  // La propiedad que sostenía mejorFix() hasta v1.13. Ahora la sostiene el peso
  // 1/acc²: la lectura de ±300 m pesa 2.500 veces menos que la de ±6 m.
  const ahora = Date.now();
  const buenos = [fix(0, 6, 3, ahora), fix(1, 6, 2, ahora), fix(-1, 6, 1, ahora)];
  const conBasura = app.consolidarFixes([...buenos, fix(400, 300, 0, ahora)], ahora);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, conBasura);
  assert.ok(d < 5, `la lectura de antena se llevó el fix a ${Math.round(d)} m`);
});

test('consolidarFixes: pasada la ventana de frescura, la lectura nueva manda', () => {
  // Igual que mejorFix(): después de frescoMs el guardia probablemente ya se
  // movió, así que las lecturas viejas dejan de contar aunque fueran mejores.
  const ahora = Date.now();
  const viejoBueno = fix(0, 5, cfg.frescoMs / 1000 + 30, ahora);
  const nuevoPeor = fix(100, 40, 0, ahora);
  const c = app.consolidarFixes([viejoBueno, nuevoPeor], ahora);
  const d = geo.metrosEntre({ lat: LAT, lon: LON }, c);
  assert.ok(d > 90, `la lectura vencida siguió mandando (quedó a ${Math.round(d)} m)`);
});

test('consolidarFixes: sin ninguna precisión declarada, el acc sigue siendo desconocido', () => {
  // Declararlo por la dispersión sería inventar confianza sobre datos de calidad
  // ignorada. null hace que margenM() asuma precisionSupuestaM, que es lo justo.
  const ahora = Date.now();
  const c = app.consolidarFixes([fix(0, null, 1, ahora), fix(1, null, 0, ahora)], ahora);
  assert.equal(c.acc, null);
});

test('consolidarFixes nunca declara una precisión mejor que el piso físico', () => {
  const ahora = Date.now();
  const juntas = Array.from({ length: 20 }, (_, i) => fix(0, 1, i * 0.1, ahora));
  assert.ok(app.consolidarFixes(juntas, ahora).acc >= geo.PISO_FISICO_M);
});

test('el buffer se poda al insertar y no crece sin techo', () => {
  const ahora = Date.now();
  // 200 lecturas de un segundo cada una: solo sobreviven las de la ventana.
  const muchas = Array.from({ length: 200 }, (_, i) => fix(0, 10, 200 - i, ahora));
  const buffer = app.alimentar(muchas);
  assert.ok(buffer.length <= 60, `el buffer quedó con ${buffer.length} lecturas`);
  const tsMax = Math.max(...buffer.map(f => f.ts));
  assert.ok(buffer.every(f => tsMax - f.ts <= cfg.frescoMs), 'quedaron lecturas fuera de la ventana');
});

test('el buffer NO viaja en el estado que se serializa a localStorage', () => {
  // guardarEstado() serializa `estado` entero en cada marca: veinte lecturas de
  // GPS por segundo ahí dentro serían escrituras a disco a ese ritmo.
  assert.match(fuente, /^let bufferFixes = \[\];$/m, 'bufferFixes debe ser variable de módulo');
  const estadoInicial = /\{ sesion: null, paquete: null, ejecucion: null, cola: \[\], ultimoInforme: null \}/;
  assert.match(fuente, estadoInicial, 'cambió la forma de `estado`: revisar que el buffer no entró');
  assert.ok(!/estado\.(bufferFixes|fixes|marcaPendiente|marcaRetenida)/.test(fuente), 'el buffer se coló dentro de `estado`');
});

// ---------- evaluarPendiente ----------

const PUNTO = {
  nombre: 'Portería',
  lat: LAT,
  lon: LON,
  verificacion: 'gps',
  radioM: 20,
  ventanaMs: cfg.frescoMs,
  precisionM: 5
};
// Un fix ya consolidado, como el que le llega al reducer.
const fixA = (dLatM, acc, edadMs = 0) => ({ lat: LAT + dLatM / 111320, lon: LON, acc, edadMs });
const pendiente = desde => ({ punto: PUNTO, codigo: 'PRT234', desde, motivo: 'lejos' });

test('evaluarPendiente acepta apenas la señal entra', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 3000);
  assert.equal(r.accion, 'aceptar');
});

test('evaluarPendiente acepta en el segundo 14,9', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 14900);
  assert.equal(r.accion, 'aceptar');
});

test('evaluarPendiente rechaza en el segundo 15,1 aunque la señal ya esté buena', () => {
  // El plazo se mira ANTES que el veredicto: si no, la ventana no sería una
  // ventana sino una espera indefinida disfrazada.
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 15100);
  assert.equal(r.accion, 'rechazar');
});

test('evaluarPendiente sigue esperando cuando el fix EMPEORA', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(300, 90), desde + 5000);
  assert.equal(r.accion, 'esperar');
  assert.ok(r.restanteMs > 0 && r.restanteMs <= app.ventanaMs);
  assert.match(r.motivo, /Estás a \d+ m/);
});

test('evaluarPendiente espera también sin ningún fix', () => {
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), null, desde + 1000);
  assert.equal(r.accion, 'esperar');
});

test('evaluarPendiente no acepta nada cuando la ronda se cerró con una marca en espera', () => {
  // cerrarRonda() borra el pendiente; lo que quede en vuelo tiene que morir acá
  // y nunca colarse como aceptado.
  const r = app.evaluarPendiente(null, fixA(0, 5), Date.now());
  assert.equal(r.accion, 'rechazar');
  assert.match(r.motivo, /vuelve a escanear/i);
});

test('la espera NO afloja el criterio: lejos de verdad sigue rechazado', () => {
  // Es la garantía de todo el cambio. A 1,1 km, con la mejor señal posible y
  // todo el plazo por delante, la marca no entra ni ahora ni en 15 segundos.
  const desde = Date.now();
  for (const t of [0, 5000, 14900, 15100]) {
    const r = app.evaluarPendiente(pendiente(desde), fixA(1100, 5), desde + t);
    assert.notEqual(r.accion, 'aceptar', `a los ${t} ms la aceptó`);
  }
});

test('el veredicto que sale del reducer trae con qué registrar el rechazo', () => {
  // Sin distancia, tope y señal, la telemetría de rechazos es un texto libre y
  // el próximo ajuste de umbrales vuelve a ser a ciegas.
  const desde = Date.now();
  const r = app.evaluarPendiente(pendiente(desde), fixA(1100, 12), desde + 16000);
  assert.equal(r.accion, 'rechazar');
  assert.ok(r.veredicto.distanciaM > 1000);
  assert.equal(r.veredicto.topeM, 20 + 5 + 12);
  assert.equal(r.veredicto.acc, 12);
});

// ---- esperaSirve: a quién le sirve esperar ----

test('esperaSirve: en un punto anclado, un fix vencido NO se espera', () => {
  // "Vencido" en un anclado son 15 minutos, no 20 segundos: quedarse quieto no
  // lo arregla, y el mensaje de espera contradiría al veredicto.
  assert.equal(app.esperaSirve({ vencido: true, anclado: true }), false);
  assert.equal(app.esperaSirve({ vencido: true, anclado: false }), true);
});

test('esperaSirve: la señal fría se espera, la distancia real no', () => {
  assert.equal(app.esperaSirve({ sinGps: true }), true);
  assert.equal(app.esperaSirve({ impreciso: true }), true);
  // Apenas sobre el tope: un fix malo puede estar equivocado por esto.
  assert.equal(app.esperaSirve({ distanciaM: 60, topeM: 35 }), true);
  // A 1,1 km no hay señal que arregle eso: es distancia, no error de medida.
  assert.equal(app.esperaSirve({ distanciaM: 1100, topeM: 35 }), false);
});

// ---------- v1.21: menos marcas perdidas por la mecánica ----------
// Piezas montadas aparte: ninguna toca el criterio de presencia.

function montarV121() {
  const codigo = `
    const SILENCIO_WATCH_MS = ${constante('SILENCIO_WATCH_MS')};
    const SIN_PRIMERA_LECTURA_MS = ${constante('SIN_PRIMERA_LECTURA_MS')};
    const RETENCION_MS = ${constante('RETENCION_MS')};
    let gpsMotivoFalla = null;
    let ultimoCodigoLeido = { valor: null, ts: 0 };
    const procesados = [];
    let cerrados = 0;
    const cerrarEscaner = () => { cerrados++; };
    const procesarCodigo = v => { procesados.push(v); };
    ${['watchCallado', 'retencionVigente', 'recorteEscaner', 'minutos', 'textoRetenida', 'codigoDetectado'].map(extraer).join('\n')}
    return {
      watchCallado, retencionVigente, recorteEscaner, textoRetenida, codigoDetectado,
      procesados, cerrados: () => cerrados,
      silencioMs: SILENCIO_WATCH_MS, primeraMs: SIN_PRIMERA_LECTURA_MS, retencionMs: RETENCION_MS
    };
  `;
  return new Function(codigo)();
}

const v121 = montarV121();

test('vigía del GPS: un watch que sigue hablando no se toca', () => {
  const ahora = Date.now();
  assert.equal(v121.watchCallado(ahora - 2000, ahora - 60000, ahora), false);
});

test('vigía del GPS: callado más de la mitad de la frescura, se reengancha', () => {
  const ahora = Date.now();
  assert.equal(v121.watchCallado(ahora - v121.silencioMs - 1, ahora - 60000, ahora), true);
  // El reenganche tiene que dejarle tiempo a la lectura nueva para llegar antes
  // de que la anterior venza: si no, el vigía llegaría tarde siempre.
  assert.ok(v121.silencioMs < cfg.frescoMs, 'el vigía espera más que la frescura del fix');
});

test('vigía del GPS: un watch que todavía no habló está adquiriendo, no callado', () => {
  // Un GPS que necesita 20-40 s seguidos para el primer fix (cielo parcial, salida
  // de un subterráneo) no llegaría nunca si se lo corta a los 10 s: cada corte
  // reinicia la búsqueda. Antes de su primera lectura se le da más que su propio
  // timeout de 15 s.
  const ahora = Date.now();
  assert.equal(v121.watchCallado(0, ahora - 3000, ahora), false);
  assert.equal(v121.watchCallado(0, ahora - 40000, ahora), false, 'cortó una adquisición de 40 s');
  // La lectura de ANTES del reenganche no cuenta como "habló".
  assert.equal(v121.watchCallado(ahora - 60000, ahora - 30000, ahora), false);
  assert.equal(v121.watchCallado(0, ahora - v121.primeraMs - 1, ahora), true);
  assert.ok(v121.primeraMs > 15000, 'el plazo de la primera lectura no supera el timeout del watch');
});

test('vigía del GPS: solo reengancha con una marca en juego y nunca sin permiso', () => {
  // En un kiosco (Fully sobre Android WebView) cada watchPosition nuevo vuelve a
  // pedirle el permiso a la app anfitriona: no puede pasar cada 12 s todo el turno.
  const cuerpo = extraer('vigilarGps');
  assert.match(cuerpo, /if \(!marcaEnJuego\(\)\) return;/);
  assert.match(cuerpo, /gpsPermisoNegado\) return;/);
  assert.match(extraer('marcaEnJuego'), /marcaPendiente \|\| retencionVigente\(marcaRetenida, Date\.now\(\)\) \|\| lectorAbierto/);
});

test('permiso de ubicación negado: lo vuelven a pedir los toques del guardia', () => {
  // Con code 1 el navegador borró el watch y en un kiosco la página nunca pasa
  // por segundo plano: sin esto, Reintentar repetiría el mismo rechazo para siempre.
  for (const nombre of ['reintentarRetenida', 'abrirEscaner', 'iniciarRonda']) {
    assert.match(extraer(nombre), /reengancharSiNegado\(\);/, `${nombre}() no vuelve a pedir la ubicación`);
  }
});

test('QR retenido: se puede reintentar dentro del plazo y no después', () => {
  const ahora = Date.now();
  const retenida = desde => ({ punto: PUNTO, codigo: 'PRT234', desde });
  assert.equal(v121.retencionVigente(retenida(ahora - 5000), ahora), true);
  assert.equal(v121.retencionVigente(retenida(ahora - v121.retencionMs - 1), ahora), false);
  assert.equal(v121.retencionVigente(null, ahora), false);
});

test('QR retenido: reintentar pasa por el mismo control que escanear', () => {
  // La garantía del cambio: no hay camino nuevo hacia registrarMarca(). El
  // reintento vuelve a entrar por procesarCodigo(), con su verificación.
  const cuerpo = extraer('reintentarRetenida');
  assert.match(cuerpo, /procesarCodigo\(retenida\.codigo, retenida\.desde, retenida\.nfc \|\| null\)/);
  assert.ok(!/registrarMarca/.test(cuerpo), 'el reintento registra la marca sin verificar');
});

test('QR retenido: el plazo se cuenta desde la LECTURA y no se renueva al reintentar', () => {
  // Si cada Reintentar fallido lo renovara, el plazo anunciado no existiría y la
  // lectura del QR y la marca podrían quedar separadas por media ronda.
  assert.match(extraer('procesarCodigo'), /dejarPendiente\(punto, limpio, presencia, leidoMs, nfc\)/);
  assert.match(extraer('revisarPendiente'), /pendiente\.codigo, pendiente\.leidoMs, pendiente\.nfc\)/);
  assert.match(extraer('rechazarMarca'), /desde: leidoMs != null \? leidoMs : Date\.now\(\)/);
});

test('QR retenido: en un punto bajo techo el texto habla de la entrada', () => {
  const distancia = { distanciaM: 70, topeM: 45, acc: 12 };
  assert.match(v121.textoRetenida(distancia, true), /a 70 m de la entrada/);
  assert.doesNotMatch(v121.textoRetenida(distancia, false), /entrada/);
  assert.match(v121.textoRetenida({ sinGps: true }, true), /ubicación de la entrada/);
});

test('lector: releer el mismo QR antes de 2,5 s no lo deja sordo', () => {
  // codigoDetectado() devuelve false cuando ignora el código: el ciclo sigue
  // leyendo en vez de terminar con la cámara viva y sin nadie mirando.
  assert.equal(v121.codigoDetectado('RQR:p1:ABC123'), true);
  assert.equal(v121.codigoDetectado('RQR:p1:ABC123'), false);
  assert.deepEqual(v121.procesados, ['RQR:p1:ABC123']);
  assert.equal(v121.cerrados(), 1, 'el duplicado cerró el lector');
  for (const nombre of ['cicloDetector', 'cicloJsqr']) {
    assert.doesNotMatch(extraer(nombre), /return codigoDetectado\(/, `${nombre}() termina aunque el código se haya ignorado`);
  }
});

test('lector: un detector nativo que responde vacío no lo deja sin leer', () => {
  // Play Services sin el módulo de códigos: detect() resuelve [] para siempre.
  // Desde RESPALDO_JSQR_MS sin lectura se intercala jsQR.
  const cuerpo = extraer('cicloDetector');
  assert.match(cuerpo, /RESPALDO_JSQR_MS/);
  assert.match(cuerpo, /pasarJsqr\(\)/);
});

test('QR retenido: solo se retiene lo que la señal puede arreglar', () => {
  // Lejos de verdad (esperaSirve false) sigue siendo un rechazo seco.
  assert.match(extraer('rechazarMarca'), /const retenible = codigo && esperaSirve\(presencia\);/);
  assert.equal(app.esperaSirve({ distanciaM: 1100, topeM: 35 }), false);
});

test('QR retenido: la espera de un Reintentar tardío no pasa el plazo de la lectura', () => {
  // Reintentar a los 119 s abría 15 s más de espera: la marca entraba a los
  // 134 s de leer el QR. Con `hasta`, la espera se corta donde vence la lectura.
  const desde = Date.now();
  const tardio = { ...pendiente(desde), hasta: desde + 1000 };
  assert.equal(app.evaluarPendiente(tardio, fixA(0, 8), desde + 500).accion, 'aceptar');
  assert.equal(app.evaluarPendiente(tardio, fixA(0, 8), desde + 1500).accion, 'rechazar');
  // Sin `hasta`, como antes: 15 s desde que empezó a esperar.
  assert.equal(app.evaluarPendiente(pendiente(desde), fixA(0, 8), desde + 14000).accion, 'aceptar');
  assert.match(extraer('dejarPendiente'), /hasta: Math\.min\(ahora \+ VENTANA_PENDIENTE_MS, leidoMs \+ RETENCION_MS\)/);
  // Y una retención que nacería vencida no se muestra como "toca Reintentar".
  assert.match(extraer('rechazarMarca'), /if \(retenida && retencionVigente\(retenida, Date\.now\(\)\)\)/);
});

test('QR retenido: si llega el QR de otro punto, el retenido no se pierde en silencio', () => {
  const cuerpo = extraer('procesarCodigo');
  assert.match(cuerpo, /marcaRetenida\.punto\.id !== punto\.id/);
  assert.match(cuerpo, /avisarRetenidaSoltada\(soltada\);\s*\}$/);
});

test('lector: una segunda activación del botón no abre otro turno ni deja una cámara encendida', () => {
  const cuerpo = extraer('abrirEscaner');
  // Lo primero que hace, antes de cualquier otra cosa.
  assert.match(cuerpo, /^function abrirEscaner\(\) \{\s*(?:\/\/[^\n]*\s*)*if \(escaneando\) return;/);
  assert.match(cuerpo, /if \(stream\) for \(const pista of stream\.getTracks\(\)\) pista\.stop\(\);\s*stream = nuevo;/);
});

test('lector: jsQR reparte el hilo según lo que cuesta cada pasada', () => {
  // Con poca luz una pasada puede llevar casi un segundo: el intervalo se cuenta
  // desde que terminó y crece con su costo, y la pausa nunca es menor que la pasada.
  assert.match(extraer('cicloDetector'), /proximoJsqr = Date\.now\(\) \+ Math\.max\(CADA_JSQR_MS, 4 \* ms\);/);
  assert.match(extraer('cicloJsqr'), /setTimeout\(paso, Math\.max\(PAUSA_JSQR_MS, ms\)\);/);
  assert.ok(Number(constante('LADO_RECORTE_MAX')) <= 640, 'el recorte volvió a resolución casi nativa');
});

// Pantalla de teléfono vertical: video 1080x1920 mostrado en 360x640 (cover
// exacto, escala 1/3), recuadro de 252 px centrado.
const cajaVideo = { left: 0, top: 0, width: 360, height: 640 };
const cajaMarco = { left: 54, top: 194, width: 252, height: 252 };

test('recorte del lector: toma el recuadro, a resolución del video', () => {
  const r = v121.recorteEscaner(1080, 1920, cajaVideo, cajaMarco, 1);
  assert.deepEqual(r, { x: 162, y: 582, lado: 756 });
});

test('recorte del lector: deshace el recorte de object-fit cover', () => {
  // Cámara apaisada (1920x1080) en pantalla vertical: cover la escala por el
  // alto y bota los costados. El centro del recuadro sigue siendo el del video.
  const r = v121.recorteEscaner(1920, 1080, cajaVideo, cajaMarco, 1);
  assert.ok(Math.abs(r.x + r.lado / 2 - 960) <= 1);
  assert.ok(Math.abs(r.y + r.lado / 2 - 540) <= 1);
});

test('recorte del lector: nunca se sale del cuadro ni devuelve basura', () => {
  const esquina = { left: 300, top: 600, width: 252, height: 252 };
  const r = v121.recorteEscaner(1080, 1920, cajaVideo, esquina, 1.3);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.lado <= 1080 && r.y + r.lado <= 1920);
  // Video todavía sin dimensiones: null, y el lector cae al cuadro completo.
  assert.equal(v121.recorteEscaner(0, 0, cajaVideo, cajaMarco), null);
  assert.equal(v121.recorteEscaner(1080, 1920, { left: 0, top: 0, width: 0, height: 0 }, cajaMarco), null);
});
