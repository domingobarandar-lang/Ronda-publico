// Prueba que una ronda empezada no se pierde (v1.25.1), en Chromium y con la
// app del guardia de verdad: login, "Iniciar", código a mano, "Terminar ronda".
//
// Casos (los de entrega/PRUEBAS-NFC.md §6, que también se prueban a mano):
//   A. Teléfono apagado y prendido, con y sin señal (la página arranca de cero).
//   B. La sesión vence a mitad de la ronda: la ronda sigue, se termina, y al
//      volver a entrar se envía todo.
//   C. La sesión vence sin señal: la ronda sigue y NO manda al login.
//   D. Otro guardia entra en el mismo teléfono: lo del primero queda apartado,
//      no se manda con la sesión del segundo y no se mezcla; el primero vuelve,
//      retoma su ronda y la termina.
//   E. Chrome borra el almacenamiento: solo localStorage (se recupera del
//      respaldo) y todo (se recupera del servidor al entrar).
//
// "Apagar el teléfono" acá es cerrar la pestaña y abrir otra en el mismo perfil:
// la página arranca de cero desde lo guardado. Lo que NO se puede simular es
// el apagón a mitad de una escritura del disco ni la limpieza que decide
// Chrome por su cuenta: eso está en PRUEBAS-NFC.md para el teléfono real.
//
// Uso (desde app/, con Playwright): node scripts/probar-sesion-ronda.js [carpeta-de-capturas]
'use strict';

process.env.MOCK = 'true';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');

const capturas = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-sesion-')));
fs.mkdirSync(capturas, { recursive: true });

const resultados = [];
function revisar(nombre, ok, detalle = '') {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}
const espera = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-sesion-db-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const { app, store } = crearApp({ rutaDb, enviarPush: async () => {} });
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // Lo que sabe el servidor.
  const ejecucion = id => store.ejecuciones.obtener(id);
  const vencerSesiones = usuarioId => {
    for (const s of Object.values(store.db.sesiones)) if (s.usuarioId === usuarioId) s.creada = '2000-01-01T00:00:00.000Z';
  };

  const navegador = await chromium.launch();
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errores = [];

  // Prender el teléfono: una pestaña nueva que arranca de cero desde lo guardado.
  async function prender() {
    const p = await ctx.newPage();
    p.on('dialog', d => d.accept());
    p.on('pageerror', e => errores.push(e.message));
    await p.goto(base);
    await p.waitForFunction(() => window.__appLista === true, null, { timeout: 10000 });
    return p;
  }
  const visible = (p, id) => p.isVisible(`#${id}`);
  const local = (p, expr) => p.evaluate(expr);
  async function entrar(p, usuario, pin) {
    if (!(await visible(p, 'vista-login'))) await p.click('#btn-entrar-de-nuevo');
    await p.fill('#campo-usuario', usuario);
    await p.fill('#campo-pin', pin);
    await p.click('#btn-login');
    await espera(900);
  }
  async function iniciar(p, nombre) {
    await p.click(`#lista-rondas .tarjeta:has-text("${nombre}") button`);
    await espera(300);
  }
  async function marcar(p, codigo) {
    await p.click('#btn-manual');
    await p.fill('#campo-codigo', codigo);
    await p.click('#btn-confirmar-manual');
    await espera(250);
  }
  // Espera a que la cola del guardia de turno quede vacía (se envía cada 4 s).
  async function enviado(p, ms = 9000) {
    try {
      await p.waitForFunction(() => estado.cola.length === 0, null, { timeout: ms });
      return true;
    } catch {
      return false;
    }
  }

  // ---------- A. Teléfono apagado y prendido ----------
  console.log('\nA. Teléfono apagado y prendido');
  let tel = await prender();
  await entrar(tel, 'pedro', '2222');
  await iniciar(tel, 'Perimetral express');
  await marcar(tel, 'PRT234');
  await enviado(tel);
  const idA = await local(tel, () => estado.ejecucion.id);
  await ctx.setOffline(true);
  await marcar(tel, 'QCH789');
  await tel.close(); // se apagó sin señal
  tel = await prender(); // y se prende, todavía sin señal
  revisar('A1 Sin señal, al prender la app vuelve a la ronda', await visible(tel, 'vista-ronda'));
  revisar('A1 Con sus 2 marcas y 1 por enviar', (await tel.textContent('#ronda-progreso')) === '2/4' && (await local(tel, () => estado.cola.length)) === 1);
  await tel.screenshot({ path: path.join(capturas, 'A1-prendido-sin-senal.png') });
  await ctx.setOffline(false);
  await tel.evaluate(() => window.dispatchEvent(new Event('online')));
  revisar('A1 Al volver la señal se envía sola', await enviado(tel) && ejecucion(idA).escaneos.length === 2);
  // Apagón antes de que Chrome bajara localStorage al disco: queda la copia
  // vieja ahí y la nueva en el respaldo (IndexedDB).
  const viejo = await local(tel, () => localStorage.getItem('rondasqr'));
  await marcar(tel, 'PSC234');
  await espera(300);
  await local(tel, v => localStorage.setItem('rondasqr', v), viejo);
  await tel.close();
  tel = await prender();
  revisar('A2 Apagón con localStorage atrasado: se recupera del respaldo con las 3 marcas',
    (await tel.textContent('#ronda-progreso')) === '3/4', await tel.textContent('#aviso'));

  // ---------- B. La sesión vence a mitad de la ronda, con señal ----------
  console.log('\nB. Sesión vencida a mitad de la ronda');
  vencerSesiones('u-pedro');
  await marcar(tel, 'TRS345');
  await espera(4500);
  revisar('B1 El 401 no saca de la ronda', await visible(tel, 'vista-ronda'));
  revisar('B1 Avisa arriba que la sesión venció y ofrece entrar', await visible(tel, 'aviso-sesion'),
    await tel.textContent('#aviso-sesion-texto'));
  revisar('B1 La marca quedó guardada para enviar', (await local(tel, () => estado.cola.length)) >= 1);
  await tel.screenshot({ path: path.join(capturas, 'B1-sesion-vencida-en-ronda.png') });
  await tel.click('#btn-cerrar-ronda');
  await espera(400);
  revisar('B2 Se puede terminar la ronda con la sesión vencida', await visible(tel, 'vista-final'));
  await tel.click('#btn-entrar-de-nuevo');
  revisar('B3 "Entrar de nuevo" abre el login con su usuario puesto', (await tel.inputValue('#campo-usuario')) === 'pedro');
  revisar('B3 Y deja volver sin entrar', await visible(tel, 'btn-volver-ronda'));
  await entrar(tel, 'pedro', '2222');
  const enviadoB = await enviado(tel);
  const ejB = ejecucion(idA);
  revisar('B4 Al volver a entrar se envía todo: ronda cerrada con las 4 marcas, a nombre de Pedro',
    enviadoB && ejB.estado !== 'en_curso' && ejB.escaneos.length === 4 && ejB.guardiaId === 'u-pedro',
    `${ejB.estado}, ${ejB.escaneos.length} marcas`);
  await espera(500);
  // (Sale "con alertas": las marcas de esta prueba van en ráfaga, segundos
  // entre una y otra. Es lo que tiene que decir.)
  revisar('B4 El guardia ve el informe del servidor', await visible(tel, 'vista-final') && /ya le llegó/.test(await tel.textContent('#final-resumen')),
    await tel.textContent('#final-titulo'));
  await tel.click('#btn-volver');
  await espera(500);

  // ---------- C. La sesión vence SIN señal ----------
  console.log('\nC. Sesión vencida sin señal');
  await iniciar(tel, 'Perimetral express');
  await marcar(tel, 'PRT234');
  await enviado(tel);
  const idC = await local(tel, () => estado.ejecucion.id);
  vencerSesiones('u-pedro');
  await ctx.setOffline(true);
  await tel.close();
  tel = await prender(); // se reinició, sin señal
  await marcar(tel, 'QCH789');
  revisar('C1 Sin señal y con la sesión vencida la ronda sigue', await visible(tel, 'vista-ronda'));
  await ctx.setOffline(false);
  await tel.evaluate(() => window.dispatchEvent(new Event('online')));
  await espera(1500);
  await marcar(tel, 'PSC234');
  // Hasta la v1.25.0 esto mandaba al login: sin señal el guardia no podía entrar
  // y la ronda quedaba trabada.
  revisar('C2 Al llegar el 401, marcar otra vez NO manda al login', await visible(tel, 'vista-ronda') && !(await visible(tel, 'vista-login')));
  revisar('C2 La ronda va 3/4, con 2 marcas guardadas', (await tel.textContent('#ronda-progreso')) === '3/4' && (await local(tel, () => estado.cola.length)) === 2);

  // ---------- D. Otro guardia entra en el mismo teléfono ----------
  console.log('\nD. Otro guardia en el mismo teléfono');
  await entrar(tel, 'luis', '3333');
  revisar('D1 Luis entra a SU inicio, sin la ronda de Pedro', await visible(tel, 'vista-inicio') && (await local(tel, () => estado.ejecucion)) === null);
  revisar('D1 Y se le dice que lo de Pedro quedó guardado aparte (v1.25.0)', /Pedro Soto quedó guardado aparte/.test(await tel.textContent('#aviso')),
    await tel.textContent('#aviso'));
  await tel.screenshot({ path: path.join(capturas, 'D1-otro-guardia.png') });
  await espera(4500);
  revisar('D2 Lo de Pedro NO se envía con la sesión de Luis (ni se descarta)',
    ejecucion(idC).escaneos.length === 1 && (await local(tel, () => estado.apartados[0].eventos.length)) === 2);
  await iniciar(tel, 'Perimetral express');
  for (const c of ['PRT234', 'QCH789', 'PSC234', 'TRS345']) await marcar(tel, c);
  const idLuis = await local(tel, () => estado.ejecucion.id);
  await tel.click('#btn-cerrar-ronda');
  await enviado(tel);
  await espera(500);
  revisar('D3 La ronda de Luis queda a nombre de Luis, aparte', ejecucion(idLuis).guardiaId === 'u-luis' && idLuis !== idC);
  await tel.click('#btn-volver');
  await espera(400);
  await tel.click('#btn-salir');
  await espera(400);
  await entrar(tel, 'pedro', '2222');
  revisar('D4 Pedro vuelve a entrar y retoma su ronda donde quedó (3/4)',
    await visible(tel, 'vista-ronda') && (await tel.textContent('#ronda-progreso')) === '3/4', await tel.textContent('#aviso'));
  await enviado(tel);
  revisar('D4 Sus marcas guardadas llegan, con su sesión', ejecucion(idC).escaneos.length === 3 && ejecucion(idC).guardiaId === 'u-pedro');
  await marcar(tel, 'TRS345');
  await tel.click('#btn-cerrar-ronda');
  await enviado(tel);
  const ejD = ejecucion(idC);
  revisar('D5 Pedro termina su ronda completa (4 marcas)', ejD.estado !== 'en_curso' && ejD.escaneos.length === 4, ejD.estado);
  await espera(500);
  await tel.click('#btn-volver');
  await espera(400);

  // (Salir con marcas sin enviar —que en la v1.24.1 las borraba— está en
  // test/sesion-ronda.test.js: con un cierre sin enviar la app se queda en el
  // resumen final, así que desde la pantalla no se llega a "Salir".)

  await iniciar(tel, 'Perimetral express');
  await marcar(tel, 'PRT234');
  await marcar(tel, 'QCH789');
  await enviado(tel);
  const idE = await local(tel, () => estado.ejecucion.id);

  // ---------- E. Chrome borra el almacenamiento ----------
  console.log('\nE. Chrome borra el almacenamiento');
  await local(tel, () => localStorage.clear());
  await tel.close();
  tel = await prender();
  revisar('E1 Sin localStorage, la ronda vuelve del respaldo (IndexedDB)',
    await visible(tel, 'vista-ronda') && (await tel.textContent('#ronda-progreso')) === '2/4');
  await tel.close();
  // Todo borrado (Ajustes → Apps → Chrome → Borrar datos, o "Borrar datos de
  // navegación"): se borra desde una página del mismo sitio sin la app.
  const limpia = await ctx.newPage();
  await limpia.goto(`${base}/manifest.webmanifest`);
  await limpia.evaluate(() => new Promise(r => {
    localStorage.clear();
    const pedido = indexedDB.deleteDatabase('rondasqr');
    pedido.onsuccess = pedido.onerror = pedido.onblocked = () => r();
  }));
  await limpia.close();
  tel = await prender();
  revisar('E2 Sin nada guardado, la app pide entrar', await visible(tel, 'vista-login'));
  await entrar(tel, 'pedro', '2222');
  revisar('E2 Al entrar, la ronda se recupera del servidor con lo que ya había llegado (2/4)',
    await visible(tel, 'vista-ronda') && (await tel.textContent('#ronda-progreso')) === '2/4', await tel.textContent('#aviso'));
  await tel.screenshot({ path: path.join(capturas, 'E2-recuperada-del-servidor.png') });
  await marcar(tel, 'PSC234');
  await marcar(tel, 'TRS345');
  await tel.click('#btn-cerrar-ronda');
  await enviado(tel);
  const ejE = ejecucion(idE);
  revisar('E3 Y se termina en la misma ejecución, sin duplicarla', ejE.estado !== 'en_curso' && ejE.escaneos.length === 4, ejE.estado);
  // Informativo, no cuenta: Chromium sin pantalla nunca lo concede, y en el
  // teléfono lo decide Chrome (PRUEBAS-NFC.md §6 dice cómo verlo).
  console.log(`ℹ️  Almacenamiento persistente concedido: ${await tel.evaluate(() => navigator.storage.persisted())} (en el teléfono lo decide Chrome)`);

  revisar('Sin errores de JavaScript en la página', errores.length === 0, errores.join(' | '));

  await navegador.close();
  servidor.close();
  const fallas = resultados.filter(ok => !ok).length;
  console.log(`\n${resultados.length - fallas}/${resultados.length} bien · capturas en ${capturas}`);
  process.exit(fallas ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
