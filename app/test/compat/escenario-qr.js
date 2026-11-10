// Escenario de compatibilidad: un condominio que usa SOLO QR, recorrido de punta
// a punta por la API y por la app del guardia. Lo usa test/compat-qr.test.js,
// que lo corre con el código de hoy y lo compara contra lo que hizo la v1.22.0
// (la versión en producción antes de las chapitas NFC) en
// test/fixtures/referencia-qr-v1.22.json.
//
// La idea: los condominios que ya funcionan con QR no pueden notar NINGÚN
// cambio, salvo los que se declaran a propósito en el test. Por eso el escenario
// registra todo lo que un guardia o un administrador ve o recibe: respuestas,
// errores, informes, avisos, la hoja de QR, el informe semanal, la cola y los
// avisos de la app del guardia.
//
// No depende de la versión: recibe las piezas (crearApp, datosSemilla, calcular
// del informe semanal, y el texto de app.js y geo.js) de quien lo llama. Así el
// mismo escenario corre contra una copia de la v1.22 (scripts/generar-referencia-compat.js)
// y contra el código de hoy.
//
// Todo es determinista: horas fijas, ids de ejecución fijos, y lo que el
// servidor inventa (ids y códigos de puntos nuevos, tokens, horas del servidor)
// se reemplaza por marcadores.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// Horas fijas, de noche en Chile, dentro de una semana cerrada.
const T = (min, base = '2026-10-21T03:00:00.000Z') => new Date(Date.parse(base) + min * 60000).toISOString();
// GPS de los puntos que se fijan en el escenario.
const LAT = -33.4489;
const LON = -70.6693;

async function escenarioServidor({ crearApp, datosSemilla, calcularSemanal }) {
  process.env.MOCK = 'true';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-compat-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const push = [];
  const { app, store } = crearApp({ rutaDb, enviarPush: async (s, payload) => { push.push(payload); } });
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const pasos = [];
  // Lo que el servidor inventa en cada corrida, reemplazado por marcadores
  // estables (el primer id nuevo es <id-1>, etc.).
  const marcadores = new Map();
  const marcar = (valor, tipo) => {
    if (!marcadores.has(valor)) marcadores.set(valor, `<${tipo}-${[...marcadores.values()].filter(v => v.startsWith(`<${tipo}-`)).length + 1}>`);
    return marcadores.get(valor);
  };
  async function api(nombre, ruta, { metodo = 'GET', cuerpo, token } = {}) {
    const resp = await fetch(base + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const datos = await resp.json().catch(() => null);
    pasos.push({ paso: nombre, status: resp.status, datos });
    return datos;
  }
  const login = async (usuario, pin) => (await api(`login ${usuario}`, '/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).token;

  // ---- Sesiones
  await api('login PIN malo', '/api/login', { metodo: 'POST', cuerpo: { usuario: 'pedro', pin: '9999' } });
  const pedro = await login('pedro', '2222');
  const marta = await login('marta', '1111');
  const jorge = await login('jorge', '5555');

  // ---- Panel: puntos y ubicaciones
  // En la v1.22 los configuraba el administrador del condominio; hoy solo la
  // cuenta de la operación (acceso total). Los pasos y las respuestas tienen
  // que ser idénticos: lo único que cambió es quién puede hacerlos. Para no
  // sumar una cuenta que la referencia no tiene, Marta lleva la marca de acceso
  // total solo mientras duran estos pasos.
  const cuentaMarta = store.db.usuarios.find(u => u.usuario === 'marta');
  cuentaMarta.accesoTotal = true;
  await api('admin puntos', '/api/admin/puntos', { token: marta });
  const nuevo = await api('admin agrega punto', '/api/admin/puntos', { metodo: 'POST', token: marta, cuerpo: { nombre: 'Jardín' } });
  await api('admin agrega punto sin nombre', '/api/admin/puntos', { metodo: 'POST', token: marta, cuerpo: { nombre: '  ' } });
  await api('admin renombra', `/api/admin/puntos/${nuevo.id}`, { metodo: 'PUT', token: marta, cuerpo: { nombre: 'Jardín norte' } });
  await api('admin fija Portería', '/api/admin/puntos/p-porteria', {
    metodo: 'PUT', token: marta, cuerpo: { lat: LAT, lon: LON, precisionM: 5, verificacion: 'gps', muestras: 40, dispersionM: 3, precisionDeclaradaM: 6, medidoConVersion: 'compat' }
  });
  await api('admin fija entrada Bodega', '/api/admin/puntos/p-bodega', {
    metodo: 'PUT', token: marta, cuerpo: { lat: LAT + 0.001, lon: LON, precisionM: 8, verificacion: 'anclaje' }
  });
  await api('admin ubicación inválida', '/api/admin/puntos/p-sede', { metodo: 'PUT', token: marta, cuerpo: { lat: 200, lon: 0 } });
  await api('admin ajusta radio', '/api/admin/puntos/p-porteria', { metodo: 'PUT', token: marta, cuerpo: { radioM: 25 } });
  await api('admin puntos después', '/api/admin/puntos', { token: marta });
  const hoja = await api('hoja de QR', '/api/admin/hoja-qr', { token: marta });
  // Las imágenes se comparan por su huella: idénticas o no. La del punto nuevo
  // lleva su código al azar: cambia en cada corrida.
  for (const p of (hoja && hoja.puntos) || []) {
    p.dataUrl = p.id === nuevo.id ? '<qr-del-punto-nuevo>' : crypto.createHash('sha256').update(p.dataUrl || '').digest('hex');
  }
  await api('admin elimina punto', `/api/admin/puntos/${nuevo.id}`, { metodo: 'DELETE', token: marta });
  await api('admin elimina punto inexistente', '/api/admin/puntos/no-existe', { metodo: 'DELETE', token: marta });
  delete cuentaMarta.accesoTotal;

  // ---- Guardia: paquete
  const paquete = await api('paquete pedro', '/api/mi/paquete', { token: pedro });
  const payload = id => paquete.rondas.flatMap(r => r.puntos).find(p => p.id === id).payload;
  const payloadMirador = (await api('paquete jorge', '/api/mi/paquete', { token: jorge })).rondas[0].puntos[0].payload;
  const cerca = { lat: LAT + 0.00005, lon: LON, acc: 6, edadMs: 2000 };
  const lejos = { lat: LAT + 0.01, lon: LON, acc: 6, edadMs: 2000 };

  // ---- Ronda nocturna (orden estricto), con todo lo que puede pasar
  const e1 = 'e-compat-0001';
  const marca = (nombre, cuerpo, ej = e1, token = pedro) => api(nombre, `/api/ejecuciones/${ej}/escaneos`, { metodo: 'POST', token, cuerpo });
  await api('inicia nocturna', '/api/ejecuciones', { metodo: 'POST', token: pedro, cuerpo: { id: e1, rondaId: 'ronda-nocturna', inicio: T(0) } });
  await api('inicia nocturna (reenvío)', '/api/ejecuciones', { metodo: 'POST', token: pedro, cuerpo: { id: e1, rondaId: 'ronda-nocturna', inicio: T(0) } });
  await marca('Portería lejos', { codigo: payload('p-porteria'), ts: T(1), gps: lejos });
  await marca('Portería sin GPS', { codigo: payload('p-porteria'), ts: T(1) });
  await api('rechazo GPS', `/api/ejecuciones/${e1}/rechazos`, { metodo: 'POST', token: pedro, cuerpo: { puntoId: 'p-porteria', ts: T(1), motivo: 'lejos', distanciaM: 1100, topeM: 36, acc: 6, edadMs: 2000 } });
  await api('rechazo GPS (reenvío)', `/api/ejecuciones/${e1}/rechazos`, { metodo: 'POST', token: pedro, cuerpo: { puntoId: 'p-porteria', ts: T(1), motivo: 'lejos' } });
  await api('rechazo de otro condominio', `/api/ejecuciones/${e1}/rechazos`, { metodo: 'POST', token: pedro, cuerpo: { puntoId: 'p-m-acceso', ts: T(1) } });
  await marca('Portería cerca', { codigo: payload('p-porteria'), ts: T(2), gps: cerca });
  await marca('Portería duplicada', { codigo: payload('p-porteria'), ts: T(3), gps: lejos });
  await marca('código inventado', { codigo: 'ZZZZZZ', ts: T(4) });
  await marca('texto basura', { codigo: '<script>', ts: T(4) });
  await marca('QR forjado (código malo)', { codigo: payload('p-quincho').replace(/:[^:]+$/, ':AAAAAA'), ts: T(4) });
  await marca('QR de otro condominio', { codigo: payloadMirador, ts: T(4) });
  await marca('Estacionamiento a mano sin señal', { codigo: 'est456', ts: T(8), offline: true });
  await marca('Piscina (saltando Quincho)', { codigo: payload('p-piscina'), ts: T(14) });
  await marca('Quincho fuera de orden', { codigo: payload('p-quincho'), ts: T(18) });
  await marca('Bodega anclada, pasó por la entrada', { codigo: payload('p-bodega'), ts: T(22), gps: { lat: LAT + 0.001, lon: LON, acc: 8, edadMs: 5 * 60000 } });
  await marca('Sala de bombas', { codigo: payload('p-bombas'), ts: T(27) });
  await marca('Acceso trasero', { codigo: payload('p-trasero'), ts: T(33) });
  await marca('guardia de otro condominio', { codigo: payload('p-sede'), ts: T(34) }, e1, jorge);
  await api('cierra nocturna', `/api/ejecuciones/${e1}/cerrar`, { metodo: 'POST', token: pedro, cuerpo: { fin: T(50), comentario: '  Luminaria   apagada  ' } });
  await marca('marca con la ronda cerrada', { codigo: payload('p-sede'), ts: T(51) });
  await api('cierra nocturna (reenvío)', `/api/ejecuciones/${e1}/cerrar`, { metodo: 'POST', token: pedro, cuerpo: { fin: T(52) } });

  // ---- Ronda express en ráfaga (sospechosa)
  const e2 = 'e-compat-0002';
  await api('inicia express', '/api/ejecuciones', { metodo: 'POST', token: pedro, cuerpo: { id: e2, rondaId: 'ronda-express', inicio: T(60) } });
  for (const [i, pid] of ['p-quincho', 'p-piscina', 'p-trasero'].entries()) {
    await marca(`express ${pid}`, { codigo: payload(pid), ts: T(60 + i * 0.05) }, e2);
  }
  await api('cierra express', `/api/ejecuciones/${e2}/cerrar`, { metodo: 'POST', token: pedro, cuerpo: { fin: T(61) } });

  // ---- Ronda olvidada, la cierra el administrador
  const e3 = 'e-compat-0003';
  await api('inicia olvidada', '/api/ejecuciones', { metodo: 'POST', token: pedro, cuerpo: { id: e3, rondaId: 'ronda-express', inicio: T(90) } });
  await marca('olvidada Quincho', { codigo: payload('p-quincho'), ts: T(95) }, e3);
  await api('guardia ajeno no la cierra', `/api/ejecuciones/${e3}/cerrar`, { metodo: 'POST', token: jorge });
  await api('admin cierra olvidada', `/api/admin/ejecuciones/${e3}/cerrar`, { metodo: 'POST', token: marta });

  // ---- Lo que ve el administrador
  for (const id of [e1, e2, e3]) await api(`informe ${id}`, `/api/admin/informes/${id}`, { token: marta });
  await api('listado de rondas', '/api/admin/ejecuciones?desde=2026-10-19&hasta=2026-10-25', { token: marta });
  const avisos = store.notificaciones.ultimas('aromos', 50).map(n => ({ texto: n.texto, medio: n.medio, enviada: n.enviada }));
  const guardadas = [e1, e2, e3].map(id => store.ejecuciones.obtener(id));
  const semanal = calcularSemanal(store, { condominioId: 'aromos', desde: '2026-10-19', hasta: '2026-10-25' });
  delete semanal.generado;

  servidor.close();

  // Tokens y horas del servidor no se comparan; ids y códigos nuevos, por
  // marcador. La ronda olvidada la cierra el administrador AHORA: su hora de
  // cierre y su duración dependen del reloj del día en que corre el test.
  const horaDelServidor = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !v.startsWith('2026-10-2');
  const limpio = JSON.parse(JSON.stringify({ pasos, avisos, guardadas, semanal, push }), (clave, valor) => {
    if (clave === 'token' || clave === 'generado' || clave === 'expira' || clave === 'creado' || clave === 'visto') return '<variable>';
    if (horaDelServidor(valor)) return '<hora-del-servidor>';
    if (clave === 'duracionMin' && valor > 10000) return '<variable>';
    if (typeof valor === 'string' && /tomó \d{4,} min/.test(valor)) {
      valor = valor.replace(/tomó \d{4,} min/g, 'tomó <variable> min');
    }
    if (typeof valor === 'string' && /cerrada por el administrador/.test(valor)) {
      valor = valor.replace(/Fin: [^·]+· Duración: [^\n]+/, 'Fin: <variable> · Duración: <variable>');
    }
    if (typeof valor === 'string' && nuevo && valor === nuevo.id) return marcar(valor, 'id');
    if (typeof valor === 'string' && nuevo && valor === nuevo.codigoCorto) return marcar(valor, 'codigo');
    if (typeof valor === 'string' && nuevo && valor.includes(`:${nuevo.id}:`)) return valor.replace(nuevo.id, marcar(nuevo.id, 'id')).replace(nuevo.codigoCorto, marcar(nuevo.codigoCorto, 'codigo'));
    return valor;
  });
  return limpio;
}

// ---------- La app del guardia, en un navegador de mentira ----------

function elementoFalso(registro, id) {
  const clases = new Set(['oculta']);
  const oyentes = {};
  const hijos = [];
  let html = '';
  let texto = '';
  const e = {
    id, value: '', style: {}, disabled: false, dataset: {},
    get textContent() { return texto; },
    set textContent(v) {
      texto = String(v);
      html = texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (id === 'aviso') registro.avisos.push(texto);
    },
    get innerHTML() { return html + hijos.map(h => h.innerHTML).join(''); },
    set innerHTML(v) { html = String(v); hijos.length = 0; },
    get className() { return [...clases].join(' '); },
    set className(v) { clases.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => clases.add(c)); },
    classList: {
      add: (...c) => c.forEach(x => clases.add(x)),
      remove: (...c) => c.forEach(x => clases.delete(x)),
      contains: c => clases.has(c),
      toggle: (c, si) => ((si ?? !clases.has(c)) ? clases.add(c) : clases.delete(c))
    },
    oyentes,
    addEventListener(tipo, fn) { (oyentes[tipo] = oyentes[tipo] || []).push(fn); },
    removeEventListener() {},
    appendChild(h) { hijos.push(h); return h; },
    insertAdjacentHTML() {}, insertBefore(n) { return n; }, focus() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    play: () => Promise.resolve(), parentNode: null
  };
  return e;
}

async function escenarioApp({ appJs, geoJs }) {
  const registro = { avisos: [], camaras: 0 };
  const elementos = new Map();
  const $ = id => {
    if (!elementos.has(id)) elementos.set(id, elementoFalso(registro, id));
    return elementos.get(id);
  };
  const almacen = {};
  let alArrancar = null;
  let alFix = null;
  const ahora = Date.parse('2026-10-21T03:00:00.000Z');
  const RealDate = Date;
  // Reloj fijo: las horas que la app pone en la cola son las mismas en las dos versiones.
  let reloj = ahora;
  class DateFijo extends RealDate {
    constructor(...a) { super(...(a.length ? a : [reloj])); }
    static now() { return reloj; }
  }
  const ctx = {
    Date: DateFijo, TextDecoder, TextEncoder, AbortController, crypto: globalThis.crypto, Math, JSON, Promise,
    localStorage: { getItem: k => (k in almacen ? almacen[k] : null), setItem: (k, v) => { almacen[k] = v; }, removeItem: k => { delete almacen[k]; } },
    document: {
      addEventListener: (tipo, fn) => { if (tipo === 'DOMContentLoaded') alArrancar = fn; },
      getElementById: $,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => elementoFalso(registro, null),
      documentElement: elementoFalso(registro, null), head: elementoFalso(registro, null), body: elementoFalso(registro, null),
      visibilityState: 'visible', activeElement: null
    },
    navigator: {
      onLine: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140', vibrate: () => true,
      geolocation: { watchPosition: ok => { alFix = ok; return 1; }, clearWatch() {} },
      mediaDevices: { getUserMedia: () => { registro.camaras++; return Promise.reject(new Error('sin cámara')); } }
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { reload() {}, pathname: '/' },
    confirm: () => true,
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    console: { warn() {}, log() {}, error() {} }
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(geoJs, ctx, { filename: 'geo.js' });
  vm.runInContext(appJs, ctx, { filename: 'app.js' });
  const correr = codigo => vm.runInContext(codigo, ctx);
  if (alArrancar) {
    try { alArrancar(); } catch (err) { registro.errorArranque = err.message; }
  }
  await new Promise(r => setTimeout(r, 30));

  // Paquete de un condominio de puros QR, como lo arma la v1.22.
  const P = (id, nombre, codigo, extra = {}) => ({ id, nombre, codigoCorto: codigo, payload: `RQR:aromos:${id}:${codigo}`, lat: null, lon: null, verificacion: null, radioM: null, ventanaMs: null, precisionM: null, anclado: false, ...extra });
  const paquete = {
    generado: '2026-10-21T02:00:00.000Z',
    condominio: { id: 'aromos', nombre: 'Los Aromos' },
    gps: { radioOkM: 20, margenMaxM: 40, precisionMaxM: 100, precisionSupuestaM: 15, precisionMinM: 3, frescoMs: 20000, anclaRadioM: 40, anclaVentanaMin: 15, bloquea: true },
    alarmaMin: 0,
    rondas: [
      { id: 'r1', nombre: 'Nocturna', ordenEstricto: true, duracionMaxMin: 45, puntos: [
        P('p1', 'Portería', 'PRT234', { lat: LAT, lon: LON, verificacion: 'gps', radioM: 20, ventanaMs: 20000, precisionM: 5 }),
        P('p2', 'Quincho', 'QCH789'),
        P('p3', 'Piscina', 'PSC234')
      ] },
      { id: 'r2', nombre: 'Express', ordenEstricto: false, duracionMaxMin: 20, puntos: [P('p2', 'Quincho', 'QCH789'), P('p3', 'Piscina', 'PSC234')] },
      { id: 'r3', nombre: 'Perímetro', ordenEstricto: false, duracionMaxMin: 30, puntos: [
        P('p1', 'Portería', 'PRT234', { lat: LAT, lon: LON, verificacion: 'gps', radioM: 20, ventanaMs: 20000, precisionM: 5 }),
        P('p4', 'Estacionamiento', 'EST456', { lat: LAT + 0.002, lon: LON, verificacion: 'gps', radioM: 20, ventanaMs: 20000, precisionM: 5 }),
        P('p2', 'Quincho', 'QCH789')
      ] }
    ]
  };
  correr(`estado.sesion = { token: 't', usuario: 'pedro' }; estado.paquete = ${JSON.stringify(paquete)}; guardarEstado();`);
  const pasos = [];
  const foto = nombre => {
    correr('pintarMarca()');
    const ej = correr('estado.ejecucion && JSON.parse(JSON.stringify(estado.ejecucion))');
    pasos.push({
      paso: nombre,
      avisos: registro.avisos.splice(0),
      cola: correr('JSON.parse(JSON.stringify(estado.cola))'),
      escaneos: ej ? ej.escaneos : null,
      cerrada: ej ? ej.cerrada : null,
      lista: $('lista-puntos').innerHTML,
      progreso: $('ronda-progreso').textContent,
      boton: $('btn-escanear').textContent,
      marcaTitulo: $('marca-titulo').textContent,
      marcaDetalle: $('marca-detalle').textContent,
      escaner: !$('modal-escaner').classList.contains('oculta'),
      camaras: registro.camaras
    });
  };

  correr("iniciarRonda('r1')");
  correr("estado.ejecucion.id = 'e-app-1'; estado.cola[0].ejecucionId = 'e-app-1';");
  foto('inicia ronda');
  // "Escanear" en una ronda de puros QR: la cámara, como siempre.
  for (const fn of ($('btn-escanear').oyentes.click || [])) fn({});
  await new Promise(r => setTimeout(r, 30));
  foto('toca Escanear');
  correr('cerrarEscaner()');
  // Portería sin GPS todavía: la marca queda esperando señal.
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[0].puntos[0].payload)})`);
  correr('pintarMarca()');
  foto('Portería sin señal');
  // Llega un fix bueno: la marca entra sola.
  reloj += 3000;
  if (alFix) alFix({ coords: { latitude: LAT, longitude: LON, accuracy: 6 }, timestamp: reloj });
  correr('revisarPendiente()');
  foto('Portería con señal');
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[0].puntos[0].payload)})`);
  foto('Portería otra vez');
  correr('procesarCodigo("ZZZZZZ")');
  foto('código inventado');
  correr('procesarCodigo("RQR:mirador:p-m-acceso:MAP234")');
  foto('QR de otro condominio');
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[1].puntos[0].payload.replace('QCH789', 'AAAAAA'))})`);
  foto('QR forjado');
  reloj += 60000;
  correr('procesarCodigo("qch789")');
  foto('Quincho a mano');
  // Piscina leída como QR por la cámara (mismo camino que el lector).
  reloj += 60000;
  correr(`codigoDetectado(${JSON.stringify(paquete.rondas[0].puntos[2].payload)})`);
  foto('Piscina por la cámara');
  correr('renderRonda()');
  foto('pantalla de la ronda');
  correr("estado.ejecucion.comentario = 'todo en orden'");
  reloj += 60000;
  correr('cerrarRonda()');
  foto('termina la ronda');
  // Ronda sin orden, puros QR.
  correr('estado.ejecucion = null; estado.cola = []; estado.ultimoInforme = null;');
  correr("iniciarRonda('r2')");
  correr("estado.ejecucion.id = 'e-app-2'; estado.cola[0].ejecucionId = 'e-app-2';");
  for (const fn of ($('btn-escanear').oyentes.click || [])) fn({});
  await new Promise(r => setTimeout(r, 30));
  foto('ronda sin orden: toca Escanear');
  correr('cerrarEscaner()');
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[1].puntos[1].payload)})`);
  correr('renderRonda()');
  foto('ronda sin orden: Piscina');
  correr('cerrarRonda()');

  // Señal que no llega: la marca espera, queda retenida, se suelta y vence.
  correr('estado.ejecucion = null; estado.cola = []; estado.ultimoInforme = null;');
  reloj += 30 * 60000; // el último fix ya no sirve
  correr("iniciarRonda('r3')");
  correr("estado.ejecucion.id = 'e-app-3'; estado.cola[0].ejecucionId = 'e-app-3';");
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[2].puntos[0].payload)})`);
  foto('Portería sin señal: espera');
  reloj += 16000;
  correr('revisarPendiente()');
  foto('Portería: no llegó la señal, queda retenida');
  correr('reintentarRetenida()');
  foto('Portería: Reintentar sin señal');
  reloj += 16000;
  correr('revisarPendiente()');
  correr(`procesarCodigo(${JSON.stringify(paquete.rondas[2].puntos[1].payload)})`);
  foto('Estacionamiento suelta a Portería');
  reloj += 16000;
  correr('revisarPendiente()');
  foto('Estacionamiento retenida');
  reloj += 3 * 60000;
  foto('Estacionamiento: vence el plazo');
  correr('procesarCodigo("QCH789")');
  correr('cerrarRonda()');
  foto('termina con faltantes');
  return { errorArranque: registro.errorArranque || null, pasos };
}

async function correrEscenario(piezas) {
  // La hora del aviso al administrador (hora() en lib/informes.js) y la de la
  // lista de la app («Marcado 03:00 a. m.») salen con la zona horaria del
  // equipo. La referencia de la v1.22 se generó en UTC; en un equipo con la
  // hora de Chile todo salía corrido 3 horas. Se fija UTC para las dos corridas
  // (la de hoy y la que genera la referencia): Node la aplica aunque se cambie
  // con el proceso andando, también en Windows.
  process.env.TZ = 'UTC';
  return { servidor: await escenarioServidor(piezas), app: await escenarioApp(piezas) };
}

module.exports = { correrEscenario };
