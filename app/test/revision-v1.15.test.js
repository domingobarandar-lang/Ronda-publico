// Regresiones de la revisión de código de v1.14 (arregladas en v1.15).
//
// Cada test de acá falla contra el código anterior, y tres de ellos fallaban
// MATANDO el proceso de node —no devolviendo un error—, que es exactamente lo
// que los hacía graves: Express 4 no atrapa el rechazo de un handler `async`, y
// como la cola del teléfono reintenta sola, un solo evento malo tumbaba el
// servidor otra vez apenas se levantaba.
'use strict';

process.env.FABRICA_USUARIO = 'fabrica';
process.env.FABRICA_PIN = '87654321';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const motor = require('../lib/rondas');
const auth = require('../lib/auth');
const geo = require('../public/geo');

let base;
let servidor;
let store;

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

const login = async (usuario, pin) => (await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } })).datos;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-rev-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  await new Promise(r => { servidor = creado.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

// Crea una ronda propia con `puntoIds` y devuelve {ronda, token del guardia}.
async function rondaNueva(nombre, cuantosPuntos, extra = {}) {
  const admin = await login('admin', '1234');
  const puntos = (await api('/api/admin/puntos', { token: admin.token })).datos;
  const ids = puntos.filter(p => p.lat == null).slice(0, cuantosPuntos).map(p => p.id);
  assert.equal(ids.length, cuantosPuntos, 'la semilla no tiene suficientes puntos sin ubicación');
  const ronda = (await api('/api/admin/rondas', {
    metodo: 'POST', token: admin.token, cuerpo: { nombre, puntoIds: ids, ...extra }
  })).datos;
  const guardia = await login('guardia', '5678');
  const paquete = (await api('/api/mi/paquete', { token: guardia.token })).datos;
  return { ronda: paquete.rondas.find(r => r.id === ronda.id), token: guardia.token, adminToken: admin.token, ids };
}

// ---------- Hallazgo 1a: ronda eliminada con la ejecución abierta ----------

test('CRÍTICO: borrar la ronda con una ejecución abierta no tumba el servidor', async () => {
  // El administrador borra una ronda mientras el guardia la camina. Antes esto
  // desreferenciaba `ronda.puntoIds` en evaluar() y mataba el proceso: el
  // servicio caía para TODOS, y la cola del teléfono lo volvía a tumbar al
  // reintentar el cierre. No es un caso rebuscado: es una acción normal del
  // panel, y la lista de informes ya contemplaba "(ronda eliminada)".
  const { ronda, token, adminToken } = await rondaNueva('Se-borra', 3);
  const ejecucion = (await api('/api/ejecuciones', {
    metodo: 'POST', token, cuerpo: { rondaId: ronda.id }
  })).datos;

  const borrada = await api(`/api/admin/rondas/${ronda.id}`, { metodo: 'DELETE', token: adminToken });
  assert.equal(borrada.status, 200);

  // La marca que venía en camino se rechaza con un mensaje entendible, no con un 500.
  const escaneo = await api(`/api/ejecuciones/${ejecucion.id}/escaneos`, {
    metodo: 'POST', token, cuerpo: { codigo: ronda.puntos[0].payload }
  });
  assert.equal(escaneo.status, 409);
  assert.match(escaneo.datos.error, /ya no existe/i);

  // Y el cierre completa: las marcas que el guardia alcanzó a hacer siguen
  // valiendo aunque el administrador haya borrado la definición de la ronda.
  const cierre = await api(`/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.status, 200);
  assert.match(
    cierre.datos.evaluacion.observaciones.join(' '),
    /eliminada del panel/i,
    'el informe tiene que decir por qué no se sabe cuántos puntos faltaron'
  );
});

test('el motor sobrevive a una ejecución cuya ronda ya no está', () => {
  // Mismo caso sin HTTP de por medio: es el motor el que tiene que aguantar.
  const db = { rondas: [], puntos: [], ejecuciones: [] };
  const ejecucion = { id: 'x', rondaId: 'no-existe', escaneos: [], estado: 'en_curso', inicio: new Date().toISOString() };
  const r = motor.cerrarEjecucion(db, ejecucion, {});
  assert.equal(r.ejecucion.estado, 'completa_obs');
  assert.deepEqual(r.ejecucion.evaluacion.faltantes, []);
});

// ---------- Hallazgo 1b + 2: el ts lo manda el teléfono ----------

test('CRÍTICO: un ts que no es texto no puede matar el cierre', async () => {
  // `a.ts.localeCompare(b.ts)` reventaba en el orden estricto con un ts
  // numérico. saltosEnRafaga() ya se defendía con String(); este camino no.
  const { ronda, token } = await rondaNueva('Ts-numerico', 3, { ordenEstricto: true });
  const ejecucion = (await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } })).datos;

  for (let i = 0; i < 2; i++) {
    const r = await api(`/api/ejecuciones/${ejecucion.id}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: ronda.puntos[i].payload, ts: 1723800000000 + i * 1000 }
    });
    assert.equal(r.status, 200);
  }
  const guardado = store.db.ejecuciones.find(e => e.id === ejecucion.id);
  assert.equal(typeof guardado.escaneos[0].ts, 'string', 'el ts se persiste siempre como texto');

  const cierre = await api(`/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token });
  assert.equal(cierre.status, 200);
  // Y la hora que ve el administrador tiene que ser una fecha de verdad: un ts
  // impresentable salía como "Invalid Date" en el informe y en el correo.
  for (const d of cierre.datos.detalle.filter(x => !x.faltante)) {
    assert.ok(!Number.isNaN(Date.parse(d.hora)), `hora no parseable en el informe: ${d.hora}`);
  }
});

test('el ts de una marca está acotado, igual que el de los rechazos', async () => {
  // db.json se reserializa ENTERO en cada guardado: un campo sin cota es
  // impuesto sobre todas las peticiones, no solo sobre la que trajo la basura.
  const { ronda, token } = await rondaNueva('Ts-largo', 2);
  const ejecucion = (await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } })).datos;

  const r = await api(`/api/ejecuciones/${ejecucion.id}/escaneos`, {
    metodo: 'POST', token, cuerpo: { codigo: ronda.puntos[0].payload, ts: 'X'.repeat(200000) }
  });
  assert.equal(r.status, 200);
  const guardado = store.db.ejecuciones.find(e => e.id === ejecucion.id);
  assert.ok(guardado.escaneos[0].ts.length <= 40, `el ts quedó con ${guardado.escaneos[0].ts.length} caracteres`);
});

test('el inicio y el fin también están acotados', () => {
  // Los tres campos de hora vienen del cliente; arreglar solo uno era dejar el
  // mismo agujero abierto en los otros dos.
  const db = { rondas: [{ id: 'r', condominioId: 'c', puntoIds: [] }], puntos: [], ejecuciones: [] };
  const guardia = { id: 'g', condominioId: 'c' };
  const r = motor.iniciarEjecucion(db, { rondaId: 'r', guardia, inicio: 'Y'.repeat(9000) });
  assert.ok(r.ejecucion.inicio.length <= 40);
  motor.cerrarEjecucion(db, r.ejecucion, { fin: 'Z'.repeat(9000) });
  assert.ok(r.ejecucion.fin.length <= 40);
  assert.equal(r.ejecucion.evaluacion.duracionMin, 0, 'una fecha rota no puede dejar NaN en el informe');
});

// ---------- Hallazgo 3: sesiones ----------

test('la sesión vence a la hora y media y el token deja de servir', async () => {
  assert.equal(auth.VIDA_SESION_MS, 90 * 60 * 1000);
  const { token } = await login('guardia', '5678');
  assert.equal((await api('/api/mi/paquete', { token })).status, 200);

  // Se envejece la sesión en vez de esperar 90 minutos.
  store.db.sesiones[token].creada = new Date(Date.now() - auth.VIDA_SESION_MS - 1000).toISOString();
  const despues = await api('/api/mi/paquete', { token });
  assert.equal(despues.status, 401);
  assert.match(despues.datos.error, /venció/i);
  assert.ok(!store.db.sesiones[token], 'la sesión vencida se borra al detectarla');
});

test('las sesiones vencidas se podan solas y db.json no crece sin techo', () => {
  // Antes no se borraba ninguna: un guardia que entra a diario dejaba 365
  // credenciales permanentes al año, todas reescritas en cada guardado.
  const db = { sesiones: {} };
  const viejo = new Date(Date.now() - auth.VIDA_SESION_MS - 60000).toISOString();
  for (let i = 0; i < 10; i++) db.sesiones[`v${i}`] = { usuarioId: 'u', creada: viejo };
  db.sesiones.fresca = { usuarioId: 'u', creada: new Date().toISOString() };
  // Una sesión sin fecha entendible (las que quedaron de antes de esta guarda)
  // cuenta como vencida: dejarlas vivas para siempre era justo el bug.
  db.sesiones.sinFecha = { usuarioId: 'u' };

  assert.equal(auth.podarSesiones(db), 11);
  assert.deepEqual(Object.keys(db.sesiones), ['fresca']);
});

// ---------- Hallazgos 4 y 5: la marca aceptada que se perdía ----------

// Monta las funciones reales de public/app.js, incluyendo gpsParaMarca(), que
// es la que quedaba FUERA del par espejado por paridad-gps.test.js.
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

function montarApp(cfg) {
  const nombres = ['cfgGps', 'umbralesDe', 'margenM', 'distanciaM', 'minutos',
    'gpsUltimo', 'gpsFresco', 'gpsParaMarca', 'verificarPresencia'];
  const codigo = `
    let estado = { paquete: { gps: CFG } };
    let gpsActual = null;
    let gpsMotivoFalla = null;
    ${nombres.map(extraer).join('\n')}
    return { verificarPresencia, gpsParaMarca, fijarGps: g => { gpsActual = g; } };
  `;
  return new Function('CFG', 'geo', codigo)(cfg, geo);
}

test('CRÍTICO: la app adjunta el mismo fix con el que aceptó la marca', () => {
  // El bug: la app aceptaba mirando la ventana DEL PUNTO y adjuntaba el fix
  // mirando solo `anclado`. En un punto exacto con ventana propia mayor que
  // frescoMs mandaba gps:null, el servidor lo rechazaba por "sin señal", y el
  // guardia veía el ✅ de un punto que no salía en el informe. Peor que un
  // rechazo: le miente al guardia.
  const cfg = motor.configGps();
  const app = montarApp(cfg);
  const LAT = -33.45;
  const LON = -70.66;

  const puntoServidor = {
    id: 'p1', nombre: 'Bomba', condominioId: 'c1',
    lat: LAT, lon: LON, precisionM: 5, ventanaMin: 5   // 300 s, muy sobre frescoMs
  };
  const u = motor.umbralesDe(puntoServidor, cfg);
  const puntoApp = {
    id: 'p1', nombre: 'Bomba', lat: LAT, lon: LON,
    verificacion: motor.modoVerificacion(puntoServidor),
    radioM: u.radioM, ventanaMs: u.ventanaMs, precisionM: u.precisionM
  };
  assert.equal(puntoApp.verificacion, 'gps', 'el escenario exige un punto EXACTO');
  assert.ok(puntoApp.ventanaMs > cfg.frescoMs);

  // Guardia encima del punto, con un fix bueno de hace 60 s.
  app.fijarGps({ lat: LAT, lon: LON, acc: 8, ts: Date.now() - 60000 });

  const veredictoApp = app.verificarPresencia(puntoApp);
  assert.equal(veredictoApp.ok, true, 'la app acepta dentro de la ventana del punto');

  const adjuntado = app.gpsParaMarca(puntoApp);
  assert.ok(adjuntado, 'si el fix sirvió para decidir, tiene que viajar con la marca');

  const veredictoServidor = motor.verificarPresencia(puntoServidor, adjuntado, cfg);
  assert.equal(veredictoServidor.ok, true, 'el servidor tiene que aceptar lo mismo que aceptó la app');
});

test('un fix más viejo que la ventana del punto sigue sin viajar', () => {
  // La otra mitad: alinear los criterios no puede volverse un colador.
  const cfg = motor.configGps();
  const app = montarApp(cfg);
  const punto = {
    lat: -33.45, lon: -70.66, verificacion: 'gps',
    radioM: 20, ventanaMs: cfg.frescoMs, precisionM: 5
  };
  app.fijarGps({ lat: -33.45, lon: -70.66, acc: 8, ts: Date.now() - cfg.frescoMs - 5000 });
  assert.equal(app.verificarPresencia(punto).ok, false);
  assert.equal(app.gpsParaMarca(punto), null);
});

test('cambiar el modo de verificación no deja pegados los umbrales del modo anterior', async () => {
  // Camino real del panel: "🏠 Fijar entrada" → "Ajustar" 5 min → "📍 Volver a
  // medir". La ventana de anclaje quedaba viva en un punto exacto, que es como
  // se llegaba al bug de arriba sin tocar la API a mano.
  const admin = await login('admin', '1234');
  const punto = (await api('/api/admin/puntos', {
    metodo: 'POST', token: admin.token, cuerpo: { nombre: 'Sala calderas rev' }
  })).datos;
  const put = cuerpo => api(`/api/admin/puntos/${punto.id}`, { metodo: 'PUT', token: admin.token, cuerpo });

  await put({ lat: -33.45, lon: -70.66, precisionM: 8, verificacion: 'anclaje' });
  const anclado = (await put({ ventanaMin: '5', radioM: '55' })).datos;
  assert.equal(anclado.ventanaMin, 5);
  assert.equal(anclado.radioM, 55);

  const exacto = (await put({ lat: -33.45, lon: -70.66, precisionM: 5, verificacion: 'gps' })).datos;
  assert.equal(exacto.verificacion, undefined, 'quedó en modo exacto');
  assert.equal(exacto.ventanaMin, undefined, 'la ventana del anclaje no puede sobrevivir al cambio de modo');
  assert.equal(exacto.radioM, undefined, 'el radio del anclaje tampoco');

  // Y si el mismo request trae umbrales explícitos, esos mandan.
  const conUmbral = (await put({ verificacion: 'anclaje', radioM: '30' })).datos;
  assert.equal(conUmbral.radioM, 30);
});

// ---------- Hallazgo 6: escapado en la app del guardia ----------

test('la app del guardia escapa el texto que no controla', () => {
  assert.match(fuente, /function esc\(/, 'public/app.js necesita su propio esc(), como admin.js y fabrica.js');
  // Los nombres de condominio se pintan en la pantalla de registro, que es
  // pública y sin sesión: es el sink más expuesto de los cuatro.
  assert.match(fuente, /<option value="\$\{esc\(c\.id\)\}">\$\{esc\(c\.nombre\)\}<\/option>/);
  // Y ningún sink puede volver a interpolar un nombre crudo.
  for (const crudo of ['${r.nombre}', '${p.nombre}', '${o}', '${informe.ronda}', '${informe.guardia}']) {
    assert.ok(!fuente.includes(crudo), `quedó una interpolación sin escapar: ${crudo}`);
  }
});

// ---------- Hallazgo 8: Telegram fuera ----------

test('no queda ningún canal Telegram en el código', async () => {
  const notificar = fs.readFileSync(path.join(__dirname, '../lib/notificar.js'), 'utf8');
  assert.ok(!/api\.telegram\.org/.test(notificar), 'quedó la llamada saliente a Telegram');
  assert.ok(!/TELEGRAM_BOT_TOKEN/.test(notificar));

  const admin = await login('admin', '1234');
  const r = await api('/api/admin/telegram', { metodo: 'PUT', token: admin.token, cuerpo: { chatId: '123' } });
  assert.equal(r.status, 404, 'la ruta de Telegram ya no existe');
});

test('el aviso de cierre sigue quedando en el panel', async () => {
  // Sacar el canal externo no puede llevarse el aviso que sí se usa.
  const { ronda, token } = await rondaNueva('Aviso-panel', 2);
  const ejecucion = (await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } })).datos;
  const antes = store.db.notificaciones.length;
  await api(`/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token });
  assert.equal(store.db.notificaciones.length, antes + 1);
  assert.equal(store.db.notificaciones.at(-1).medio, 'registro');
  assert.equal(store.db.notificaciones.at(-1).enviada, true);
});

// ---------- La red de seguridad que faltaba ----------

test('ningún handler async queda registrado sin alerta()', () => {
  // La causa raíz de los tres crashes no fue un bug puntual sino una propiedad
  // del archivo: Express 4 no atrapa el rechazo de un handler `async`, y había
  // cinco sin protección. Este test vigila la propiedad, no los cinco casos —
  // el próximo endpoint async que alguien agregue sin envolver falla acá y no
  // en producción a las tres de la mañana.
  const servidorJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const sueltos = [...servidorJs.matchAll(/app\.(get|post|put|delete)\([^\n]*?,\s*async\s*\(/g)];
  assert.deepEqual(
    sueltos.map(m => m[0]), [],
    'hay handlers async registrados sin envolver en alerta()'
  );
  // Y la red final tiene que seguir puesta.
  assert.match(servidorJs, /app\.use\(\(err, req, res, next\)/, 'falta el middleware de errores');
});

test('el servidor sigue en pie después de todo lo anterior', async () => {
  // Cierre de la suite: si alguno de los casos de arriba hubiera vuelto a matar
  // el proceso, este archivo no llegaría hasta acá.
  const admin = await login('admin', '1234');
  assert.equal((await api('/api/admin/puntos', { token: admin.token })).status, 200);
});
