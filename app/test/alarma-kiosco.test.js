// Alarma de ronda en los teléfonos con Fully Kiosk (v1.22). El Android WebView
// no tiene Web Push: la app pregunta cada minuto y la hace sonar con las
// funciones propias de Fully. Acá se prueba el lado del servidor (cuándo toca,
// el registro de los teléfonos, la prueba del panel) y la parte del teléfono
// que decide sonar o no y que no repite una alarma (sacada del app.js real).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const recordatorios = require('../lib/recordatorios');
const { crearAlarmaKiosco, ANOTAR_VISTO_MS, OLVIDAR_MS } = require('../lib/alarma-kiosco');

let base;
let servidor;
let store;
let push;
const enviados = [];

async function api(ruta, { metodo = 'GET', cuerpo, token, condominio } = {}) {
  const cabeceras = { 'content-type': 'application/json' };
  if (token) cabeceras.authorization = `Bearer ${token}`;
  if (condominio) cabeceras['x-condominio'] = condominio;
  const resp = await fetch(base + ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}
const login = async (usuario, pin) => (await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).datos;
const activar = (token, dispositivo, nombre = 'Garita') =>
  api('/api/mi/alarma-kiosco', { metodo: 'POST', token, cuerpo: { dispositivo, nombre } });
const consultar = (token, extra = {}) => api('/api/alarma-kiosco', { metodo: 'POST', cuerpo: { token, interfaz: true, ...extra } });
const condominio = id => store.db.condominios.find(c => c.id === id);
const iso = t => new Date(t).toISOString();
const MIN = 60000;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-kiosco-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async (s, payload) => { enviados.push({ endpoint: s.endpoint, datos: JSON.parse(payload) }); } });
  ({ store, push } = creado);
  await new Promise(r => { servidor = creado.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

// ---------- Servidor: cuándo toca (sin un segundo reloj) ----------

test('alarmaVigente sale de lo que anotó revisar(): en pie hasta que alguien sale a la ronda o se cumple el intervalo', async () => {
  const c = condominio('aromos');
  // Fechas en el pasado: más adelante otro test hace sonar la alarma con la hora real.
  const t0 = Date.parse('2020-01-06T10:00:00.000Z');
  c.recordatorioMin = 30;
  c.recordatorioDesde = iso(t0);
  delete c.recordatorioUltimo;
  delete c.alarmaPrueba;

  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 10 * MIN), null, 'antes de la primera alarma no hay nada');
  await recordatorios.revisar(store, push, t0 + 30 * MIN);
  const ts = c.recordatorioUltimo.ts;
  assert.equal(ts, iso(t0 + 30 * MIN));

  const a = recordatorios.alarmaVigente(store, c, t0 + 31 * MIN);
  assert.deepEqual(a, {
    ts, prueba: false,
    titulo: '⏰ Hora de hacer la ronda',
    cuerpo: 'Condominio Los Aromos: toca salir a recorrer los puntos.'
  });
  // Misma alarma en cada consulta: la identidad es el ts, el teléfono no la repite.
  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 50 * MIN).ts, ts);
  // Cumplido el intervalo ya no está en pie (revisar() anota otra o ya no toca).
  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 60 * MIN), null);

  // Una ronda que empezó DESPUÉS de la alarma la atiende (desde cualquier teléfono).
  const e = { id: 'e-kiosco', condominioId: 'aromos', estado: 'en_curso', inicio: iso(t0 + 35 * MIN) };
  store.ejecuciones.guardar(e);
  try {
    assert.equal(recordatorios.alarmaVigente(store, c, t0 + 36 * MIN), null, 'en curso no suena');
    store.ejecuciones.guardar({ ...e, estado: 'completa' });
    assert.equal(recordatorios.alarmaVigente(store, c, t0 + 40 * MIN), null, 'ya salieron a la ronda');
    // Una ronda ANTERIOR a la alarma no la atiende.
    store.ejecuciones.guardar({ ...e, estado: 'completa', inicio: iso(t0 + 5 * MIN) });
    assert.equal(recordatorios.alarmaVigente(store, c, t0 + 40 * MIN).ts, ts);
  } finally {
    store.ejecuciones.eliminar('e-kiosco');
  }

  // Guardar el intervalo reinicia el conteo: la alarma de antes ya no vale.
  c.recordatorioDesde = iso(t0 + 45 * MIN);
  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 46 * MIN), null);
  c.recordatorioDesde = iso(t0);
  // Apagada no hay alarma programada en pie.
  c.recordatorioMin = 0;
  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 31 * MIN), null);
  c.recordatorioMin = 30;
});

test('la prueba del panel queda en pie 10 minutos y gana la alarma más nueva', () => {
  const c = condominio('aromos');
  const t0 = Date.parse(c.recordatorioUltimo.ts);
  c.alarmaPrueba = { ts: iso(t0 + 2 * MIN) };
  const a = recordatorios.alarmaVigente(store, c, t0 + 3 * MIN);
  assert.equal(a.ts, c.alarmaPrueba.ts);
  assert.equal(a.prueba, true);
  assert.equal(a.titulo, '⏰ Prueba de alarma de ronda');
  // Vencida la prueba vuelve la programada (más vieja: el teléfono ya no la repite).
  const despues = t0 + 2 * MIN + recordatorios.PRUEBA_VIGENTE_MS;
  assert.equal(recordatorios.alarmaVigente(store, c, despues).ts, c.recordatorioUltimo.ts);
  // Con la alarma apagada la prueba igual suena.
  c.recordatorioMin = 0;
  assert.equal(recordatorios.alarmaVigente(store, c, t0 + 3 * MIN).prueba, true);
  c.recordatorioMin = 30;
  delete c.alarmaPrueba;
});

// ---------- Servidor: registro de los teléfonos con Fully ----------

test('activar pide sesión; la consulta va con la credencial del teléfono, sin sesión', async () => {
  assert.equal((await activar(null, 'fully-1')).status, 401);
  const pedro = await login('pedro', '2222');
  const r = await activar(pedro.token, 'fully-1', 'Garita norte');
  assert.equal(r.status, 201);
  assert.match(r.datos.token, /^[0-9a-f]{64}$/);
  assert.notEqual(r.datos.token, pedro.token);

  assert.equal((await consultar('x'.repeat(64))).status, 404);
  assert.equal((await consultar(undefined)).status, 404);
  const c = await consultar(r.datos.token);
  assert.equal(c.status, 200);
  assert.equal(typeof c.datos.minutos, 'number');
  // Cerrar la sesión no la apaga: es del teléfono, no del guardia.
  await api('/api/logout', { metodo: 'POST', token: pedro.token });
  assert.equal((await consultar(r.datos.token)).status, 200);
});

test('la alarma programada llega a Fully y a Web Push a la vez, sin tocar el push', async () => {
  const pedro = await login('pedro', '2222');
  const marta = await login('marta', '1111');
  await api('/api/mi/push/suscribir', { metodo: 'POST', token: pedro.token, cuerpo: { suscripcion: { endpoint: 'https://push.ejemplo/chrome', keys: { p256dh: 'p', auth: 'a' } } } });
  const { datos: { token, alarma } } = await activar(pedro.token, 'fully-1');
  assert.equal(alarma, null, 'sin alarma en pie al activar');

  await api('/api/admin/alarma-ronda', { metodo: 'PUT', token: marta.token, cuerpo: { minutos: 30 } });
  const c = condominio('aromos');
  c.recordatorioDesde = iso(Date.now() - 31 * MIN);
  enviados.length = 0;
  await recordatorios.revisar(store, push);
  // El push sale igual que antes: solo a la suscripción, nada "para Fully".
  assert.deepEqual(enviados.map(e => e.endpoint), ['https://push.ejemplo/chrome']);
  assert.equal(c.recordatorioUltimo.total, 1);

  const r1 = await consultar(token);
  assert.equal(r1.datos.minutos, 30);
  assert.equal(r1.datos.alarma.ts, c.recordatorioUltimo.ts);
  assert.equal(r1.datos.alarma.prueba, false);
  // El servidor contesta lo mismo en la siguiente: no repetir es cosa del teléfono.
  assert.equal((await consultar(token)).datos.alarma.ts, r1.datos.alarma.ts);

  // Activar con una alarma ya en pie la devuelve, para que no suene de golpe.
  const otra = await activar(pedro.token, 'fully-2', 'Garita sur');
  assert.equal(otra.datos.alarma.ts, r1.datos.alarma.ts);
  await api('/api/mi/alarma-kiosco', { metodo: 'DELETE', token: pedro.token, cuerpo: { token: otra.datos.token } });
  await api('/api/mi/push/suscribir', { metodo: 'DELETE', token: pedro.token, cuerpo: { endpoint: 'https://push.ejemplo/chrome' } });
});

test('el panel ve cada teléfono con Fully: conectado, con o sin interfaz, y cuándo sonó', async () => {
  const marta = await login('marta', '1111');
  const registro = store.db.alarmaKioscos.find(k => k.dispositivo === 'fully-1');
  await consultar(registro.token, { sonada: '2026-10-26T12:00:00.000Z' });
  let estado = (await api('/api/admin/alarma-ronda', { token: marta.token })).datos;
  assert.equal(estado.telefonos, 1);
  assert.equal(estado.kioscos.length, 1);
  assert.deepEqual(estado.kioscos[0], {
    nombre: 'Garita',
    guardia: 'Pedro Soto',
    visto: registro.visto,
    conectado: true,
    interfaz: true,
    sonada: '2026-10-26T12:00:00.000Z'
  });

  // Si apagan la interfaz JavaScript de Fully, la app lo avisa en su consulta.
  await consultar(registro.token, { interfaz: false });
  estado = (await api('/api/admin/alarma-ronda', { token: marta.token })).datos;
  assert.equal(estado.kioscos[0].interfaz, false);
  await consultar(registro.token, { interfaz: true });

  // El otro condominio no ve este teléfono.
  const carmen = await login('carmen', '4444');
  assert.deepEqual((await api('/api/admin/alarma-ronda', { token: carmen.token })).datos.kioscos, []);
});

test('la consulta de cada minuto no escribe la base cada minuto', () => {
  const kioscos = crearAlarmaKiosco(store);
  const t = Date.now();
  const r = kioscos.activar({ condominioId: 'mirador', usuarioId: 'u-jorge', dispositivo: 'fully-throttle' }, t);
  kioscos.latido(r.token, { interfaz: true }, t + MIN);
  assert.equal(r.visto, iso(t), 'al minuto no se anota');
  kioscos.latido(r.token, { interfaz: true }, t + ANOTAR_VISTO_MS);
  assert.equal(r.visto, iso(t + ANOTAR_VISTO_MS));
  // Un cambio de interfaz o de alarma sonada se anota siempre.
  kioscos.latido(r.token, { interfaz: false }, t + ANOTAR_VISTO_MS + MIN);
  assert.equal(r.interfaz, false);
  assert.equal(kioscos.desactivar(r.token, 'mirador'), true);
});

test('el mismo teléfono reemplaza su registro; solo su condominio lo da de baja', async () => {
  const pedro = await login('pedro', '2222');
  const jorge = await login('jorge', '5555');
  const antes = store.db.alarmaKioscos.find(k => k.dispositivo === 'fully-1').token;
  const nuevo = (await activar(pedro.token, 'fully-1')).datos.token;
  assert.equal(store.db.alarmaKioscos.filter(k => k.dispositivo === 'fully-1').length, 1);
  assert.equal((await consultar(antes)).status, 404);

  // El guardia de otro condominio no puede apagar la garita ajena.
  await api('/api/mi/alarma-kiosco', { metodo: 'DELETE', token: jorge.token, cuerpo: { token: nuevo } });
  assert.equal((await consultar(nuevo)).status, 200);
  await api('/api/mi/alarma-kiosco', { metodo: 'DELETE', token: pedro.token, cuerpo: { token: nuevo } });
  assert.equal((await consultar(nuevo)).status, 404);
});

test('la prueba del panel llega a los teléfonos con Fully; sin ningún teléfono, 422', async () => {
  const carmen = await login('carmen', '4444');
  const jorge = await login('jorge', '5555');
  // Mirador sin teléfonos.
  assert.equal((await api('/api/admin/alarma-ronda/prueba', { metodo: 'POST', token: carmen.token })).status, 422);

  const { datos: { token } } = await activar(jorge.token, 'fully-mirador');
  const r = await api('/api/admin/alarma-ronda/prueba', { metodo: 'POST', token: carmen.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.datos, { ok: 0, total: 0, kioscos: { total: 1, conectados: 1 } });
  const c = await consultar(token);
  assert.equal(c.datos.alarma.prueba, true);
  assert.equal(c.datos.alarma.titulo, '⏰ Prueba de alarma de ronda');
  assert.equal(c.datos.alarma.ts, condominio('mirador').alarmaPrueba.ts);
});

test('un teléfono que no consulta en una semana se olvida; borrar la cuenta borra los suyos', async () => {
  const kioscos = crearAlarmaKiosco(store);
  const viejo = kioscos.activar({ condominioId: 'mirador', usuarioId: 'u-jorge', dispositivo: 'fully-viejo' });
  viejo.visto = iso(Date.now() - OLVIDAR_MS - MIN);
  const carmen = await login('carmen', '4444');
  const panel = (await api('/api/admin/alarma-ronda', { token: carmen.token })).datos;
  assert.ok(!panel.kioscos.some(k => k.visto === viejo.visto), 'el panel no muestra el olvidado');
  assert.equal((await consultar(viejo.token)).status, 404);

  const luis = await login('luis', '3333');
  const { datos: { token } } = await activar(luis.token, 'fully-luis');
  assert.equal((await api('/api/mi/cuenta', { metodo: 'DELETE', token: luis.token, cuerpo: { pin: '3333' } })).status, 200);
  assert.equal((await consultar(token)).status, 404);
});

// ---------- Teléfono: el app.js real ----------

const fuente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function extraer(nombre) {
  const i = fuente.search(new RegExp(`(async )?function ${nombre}\\(`));
  assert.ok(i !== -1, `public/app.js ya no define ${nombre}()`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}()`);
}

function constante(nombre) {
  const m = new RegExp(`const ${nombre} = ([^;]+);`).exec(fuente);
  assert.ok(m, `public/app.js ya no define ${nombre}`);
  return m[1];
}

// Monta la alarma de Fully del teléfono con todo lo de afuera falso: el
// servidor (respuestas en cola), Fully (anota cada llamada), el almacenamiento
// y el reloj. `recargar()` vuelve a montar el código sobre el MISMO
// almacenamiento: es lo que pasa cuando la app se recarga para actualizarse.
function montarTelefono({ ua = 'Mozilla/5.0 (Linux; Android 12; SM-A125M Build/SP1A; wv) AppleWebKit/537.36 Version/4.0 Chrome/129 Mobile Safari/537.36' } = {}) {
  const almacen = new Map();
  const respuestas = [];
  const pedidos = [];
  const llamadas = [];
  const avisos = [];
  const intervalos = new Map();
  let siguiente = 1;
  const fullyFalso = new Proxy({}, {
    get: (_, nombre) => (...args) => { llamadas.push([nombre, ...args]); return nombre === 'getDeviceId' ? 'fully-abc' : null; }
  });
  const contexto = vm.createContext({
    navigator: { onLine: true, userAgent: ua },
    window: {},
    localStorage: {
      getItem: k => (almacen.has(k) ? almacen.get(k) : null),
      setItem: (k, v) => almacen.set(k, String(v)),
      removeItem: k => almacen.delete(k)
    },
    location: { href: 'https://rondas.ejemplo/' },
    URL,
    setInterval: fn => { const id = siguiente++; intervalos.set(id, fn); return id; },
    clearInterval: id => intervalos.delete(id),
    console
  });
  const nombres = [
    'pushSoportado', 'fullyDisponible', 'esWebViewAndroid', 'modoAlarma', 'leerAlarmaKiosco', 'guardarAlarmaKiosco',
    'decidirAlarmaKiosco', 'llamarFully', 'consultarAlarmaKiosco', 'sonarAlarmaKiosco', 'callarAlarmaKiosco',
    'cerrarAlarmaKiosco', 'seguroRecargar'
  ];
  const montar = () => vm.runInContext(`
    var estado = { sesion: null, ejecucion: null, cola: [] };
    var sincronizando = false;
    var document = { activeElement: null };
    var ahora = Date.parse('2026-10-26T10:00:00.000Z');
    Date.now = () => ahora;
    var CLAVE_ALARMA_KIOSCO = ${constante('CLAVE_ALARMA_KIOSCO')};
    var SONIDO_ALARMA_MS = ${constante('SONIDO_ALARMA_MS')};
    var ALARMA_INSISTE_MS = ${constante('ALARMA_INSISTE_MS')};
    var CANAL_ALARMA = ${constante('CANAL_ALARMA')};
    var alarmaKioscoMin = null, alarmaKioscoConexion = null, alarmaKioscoConsultando = false;
    var alarmaTimer = null, alarmaAviso = null;
    var avisoAlarma = [];
    function mostrarAvisoAlarma(a) { avisoAlarma.push(a); alarmaAviso = { remove() { alarmaAviso = null; } }; }
    function pintarAlarma() {}
    function aviso(texto, tipo) { __avisos.push([texto, tipo]); }
    async function api(ruta, op) {
      __pedidos.push(JSON.stringify([ruta, op]));
      const r = __respuestas.shift();
      if (r && r.falla) throw Object.assign(new Error('HTTP ' + r.falla), { status: r.falla });
      return r;
    }
    ${nombres.map(extraer).join('\n')}
  `, contexto);
  Object.assign(contexto, { __respuestas: respuestas, __pedidos: pedidos, __avisos: avisos, fully: fullyFalso });
  montar();
  const en = codigo => vm.runInContext(codigo, contexto);
  return {
    en,
    llamadas,
    pedidos,
    pedido: i => JSON.parse(pedidos[i]),
    avisos,
    intervalos,
    almacen,
    sinFully: () => { contexto.fully = undefined; },
    responder: (...r) => respuestas.push(...r),
    // Copias del lado del test: los objetos del app.js son de otro realm.
    registro: () => JSON.parse(JSON.stringify(en('leerAlarmaKiosco()'))),
    sonidos: () => llamadas.filter(l => l[0] === 'playSound').length,
    consultar: () => en('consultarAlarmaKiosco()'),
    recargar: () => { llamadas.length = 0; intervalos.clear(); montar(); },
    avanzar: ms => en(`ahora += ${ms}`)
  };
}

const alarma = (ts, extra = {}) => ({ ts, prueba: false, titulo: '⏰ Hora de hacer la ronda', cuerpo: 'Condominio Los Aromos: toca salir a recorrer los puntos.', ...extra });
const errorHttp = status => ({ falla: status });

test('decidirAlarmaKiosco: suena una vez por alarma, anota sin sonar con una ronda en curso', () => {
  const t = montarTelefono();
  const decidir = (a, r, enCurso = false) => t.en(`decidirAlarmaKiosco(${JSON.stringify(a)}, ${JSON.stringify(r)}, ${enCurso})`);
  const reg = { token: 'x', vista: '2026-10-26T10:00:00.000Z' };
  assert.equal(decidir(null, reg), null);
  assert.equal(decidir(alarma('2026-10-26T10:00:00.000Z'), reg), null, 'la misma ya vista');
  assert.equal(decidir(alarma('2026-10-26T09:30:00.000Z'), reg), null, 'una más vieja que la vista');
  assert.equal(decidir(alarma('2026-10-26T10:30:00.000Z'), reg), 'sonar');
  assert.equal(decidir(alarma('2026-10-26T10:30:00.000Z'), { token: 'x', vista: null }), 'sonar');
  assert.equal(decidir(alarma('basura'), reg), null);
  assert.equal(decidir(alarma('2026-10-26T10:30:00.000Z'), null), null, 'sin activar no suena');
  assert.equal(decidir(alarma('2026-10-26T10:30:00.000Z'), reg, true), 'atender');
  assert.equal(decidir(alarma('2026-10-26T10:30:00.000Z', { prueba: true }), reg, true), 'sonar', 'la prueba suena igual');
});

test('modoAlarma: un solo camino por teléfono, nunca Fully y Web Push juntos', () => {
  const t = montarTelefono();
  // Fully con interfaz, aunque el WebView declarara push: gana Fully, el push no se toca.
  t.en("navigator.serviceWorker = {}; window.PushManager = function () {}; window.Notification = function () {}");
  assert.equal(t.en('modoAlarma()'), 'fully');
  t.sinFully();
  assert.equal(t.en('modoAlarma()'), 'push');
  // WebView sin la interfaz de Fully (y sin push): no puede sonar, la app dice por qué.
  t.en('delete navigator.serviceWorker; delete window.PushManager; delete window.Notification');
  assert.equal(t.en('modoAlarma()'), 'kiosco');
  // Chrome Android y iPhone no cambian.
  const chrome = montarTelefono({ ua: 'Mozilla/5.0 (Linux; Android 12; K) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36' });
  chrome.sinFully();
  chrome.en("navigator.serviceWorker = {}; window.PushManager = function () {}; window.Notification = function () {}");
  assert.equal(chrome.en('modoAlarma()'), 'push');
  const safari = montarTelefono({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' });
  safari.sinFully();
  assert.equal(safari.en('modoAlarma()'), null, 'Safari sin instalar: el mismo aviso de siempre');
});

test('CRÍTICO la alarma suena una sola vez: ni cada minuto, ni tras recargar la app', async () => {
  const t = montarTelefono();
  t.almacen.set('rondasqr-alarma-kiosco', JSON.stringify({ token: 'tok', vista: null, sonada: null }));
  const a1 = alarma('2026-10-26T10:00:00.000Z');

  t.responder({ minutos: 30, alarma: a1 });
  await t.consultar();
  assert.equal(t.sonidos(), 1);
  const [ruta, cuerpo] = t.pedido(0);
  assert.equal(ruta, '/api/alarma-kiosco');
  assert.deepEqual(cuerpo, { metodo: 'POST', cuerpo: { token: 'tok', interfaz: true, sonada: null } });
  const play = t.llamadas.find(l => l[0] === 'playSound');
  assert.deepEqual(play, ['playSound', 'https://rondas.ejemplo/alarma.wav', false, 4]);
  assert.deepEqual(t.llamadas.find(l => l[0] === 'showNotification'),
    ['showNotification', a1.titulo, a1.cuerpo, 'https://rondas.ejemplo/', true]);
  assert.ok(t.llamadas.some(l => l[0] === 'turnScreenOn') && t.llamadas.some(l => l[0] === 'stopScreensaver'));
  assert.deepEqual(t.registro(), { token: 'tok', vista: a1.ts, sonada: a1.ts });

  // Mientras suena no se recarga para actualizar.
  assert.equal(t.en('seguroRecargar()'), false);

  // Al minuto el servidor contesta la misma alarma: no vuelve a sonar, y el
  // teléfono le cuenta que ya sonó.
  t.responder({ minutos: 30, alarma: a1 });
  await t.consultar();
  assert.equal(t.llamadas.filter(l => l[0] === 'showNotification').length, 1);
  assert.equal(t.pedido(1)[1].cuerpo.sonada, a1.ts);

  // La app se recarga (actualización) con la alarma todavía en pie: tampoco.
  t.recargar();
  t.responder({ minutos: 30, alarma: a1 });
  await t.consultar();
  assert.equal(t.sonidos(), 0);

  // La siguiente alarma sí.
  t.responder({ minutos: 30, alarma: alarma('2026-10-26T10:30:00.000Z') });
  await t.consultar();
  assert.equal(t.sonidos(), 1);
});

test('el sonido insiste un minuto y se corta solo; «Entendido» lo corta antes', async () => {
  const t = montarTelefono();
  t.almacen.set('rondasqr-alarma-kiosco', JSON.stringify({ token: 'tok', vista: null }));
  t.responder({ minutos: 30, alarma: alarma('2026-10-26T10:00:00.000Z') });
  await t.consultar();
  const [repetir] = [...t.intervalos.values()];
  for (let i = 0; i < 20; i++) {
    t.avanzar(4000);
    if (t.intervalos.size) repetir();
  }
  const tocadas = t.sonidos();
  assert.ok(tocadas >= 14 && tocadas <= 15, `un minuto de pitidos de 4 s (tocó ${tocadas})`);
  assert.equal(t.intervalos.size, 0, 'el sonido no queda repitiéndose');
  assert.ok(t.llamadas.some(l => l[0] === 'stopSound'));
  assert.equal(t.en('seguroRecargar()'), true);

  t.responder({ minutos: 30, alarma: alarma('2026-10-26T10:30:00.000Z') });
  await t.consultar();
  t.en('cerrarAlarmaKiosco()');
  assert.equal(t.intervalos.size, 0);
  assert.equal(t.en('alarmaAviso'), null);
});

test('sin la interfaz de Fully no suena ni la da por vista; con una ronda en curso la anota sin sonar', async () => {
  const t = montarTelefono();
  t.almacen.set('rondasqr-alarma-kiosco', JSON.stringify({ token: 'tok', vista: null }));
  const a1 = alarma('2026-10-26T10:00:00.000Z');
  t.sinFully();
  t.responder({ minutos: 30, alarma: a1 });
  await t.consultar();
  assert.equal(t.pedido(0)[1].cuerpo.interfaz, false, 'el panel se entera de que falta la interfaz');
  assert.equal(t.registro().vista, null);

  // El guardia está en una ronda en ESTE teléfono (iniciada sin señal): se anota sin sonar.
  const t2 = montarTelefono();
  t2.almacen.set('rondasqr-alarma-kiosco', JSON.stringify({ token: 'tok', vista: null }));
  t2.en("estado.ejecucion = { id: 'e1', cerrada: false }");
  t2.responder({ minutos: 30, alarma: a1 });
  await t2.consultar();
  assert.equal(t2.sonidos(), 0);
  assert.equal(t2.registro().vista, a1.ts);
  assert.equal(t2.registro().sonada, undefined);
});

test('sin señal no consulta; si el servidor ya no tiene el teléfono, se borra y se avisa', async () => {
  const t = montarTelefono();
  t.almacen.set('rondasqr-alarma-kiosco', JSON.stringify({ token: 'tok', vista: null }));
  t.en('navigator.onLine = false');
  await t.consultar();
  assert.equal(t.pedidos.length, 0);
  assert.equal(t.en('alarmaKioscoConexion'), false);

  t.en('navigator.onLine = true');
  t.responder(errorHttp(502));
  await t.consultar();
  assert.equal(t.en('alarmaKioscoConexion'), false, 'un 502 es falta de conexión, no baja');
  assert.ok(t.registro());

  t.responder(errorHttp(404));
  await t.consultar();
  assert.equal(t.registro(), null);
  assert.match(t.avisos[0][0], /se desactivó en este teléfono/);

  // Sin activar, la app no le pregunta nada al servidor.
  await t.consultar();
  assert.equal(t.pedidos.length, 2);
});
