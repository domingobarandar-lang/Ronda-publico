// Prueba de las chapitas NFC SIN chapitas ni teléfono con NFC (CU-28).
//
// Web NFC no existe en el computador, así que este script levanta el servidor
// con una base de demo nueva, abre el panel y la app del guardia en Chromium
// con un lector NFC de mentira (NDEFReader simulado) y recorre el camino
// completo: grabar una chapita, marcarla, y los rechazos (foto del QR, chapita
// copiada, código a mano, "La chapita no lee"). Deja capturas de pantalla.
//
// Lo que NO prueba —y por eso existe entrega/PRUEBAS-NFC.md—: la antena del
// teléfono, la carcasa, el permiso de Chrome, el NFC apagado, la chapita que
// se mueve a mitad de la grabación. Eso solo se ve con hardware.
//
// Uso (desde app/, con Playwright instalado: npm i -D playwright && npx playwright install chromium):
//   node scripts/probar-nfc-simulado.js [carpeta-de-capturas]
'use strict';

process.env.MOCK = 'true';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');

const capturas = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-nfc-')));
fs.mkdirSync(capturas, { recursive: true });

// La chapita de mentira: una serie fija y lo que el panel le escriba.
// window.__tocar(texto, serie) es "acercar el teléfono" a una chapita.
const LECTOR_SIMULADO = `
  window.__chapita = { serie: '04:a2:3b:4c:5d:6e:80', texto: null, bloqueada: false };
  window.NDEFReader = class {
    constructor() { window.__lector = this; }
    async scan() {}
    async write(mensaje) { window.__chapita.texto = mensaje.records[0].data; }
    async makeReadOnly() { window.__chapita.bloqueada = true; }
  };
  window.__tocar = (texto = window.__chapita.texto, serie = window.__chapita.serie) => {
    const records = texto == null ? [] : [{ recordType: 'text', encoding: 'utf-8', data: new TextEncoder().encode(texto) }];
    window.__lector.onreading({ serialNumber: serie, message: { records } });
  };`;

const resultados = [];
function revisar(nombre, ok, detalle = '') {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-nfc-db-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const { app } = crearApp({ rutaDb, enviarPush: async () => {} });
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const navegador = await chromium.launch();
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(LECTOR_SIMULADO);
  const espera = ms => new Promise(r => setTimeout(r, ms));

  // 1. Panel: grabar la chapita de "Sala de bombas".
  const panel = await ctx.newPage();
  panel.on('dialog', d => d.accept());
  await panel.goto(`${base}/admin.html`);
  await panel.fill('#campo-usuario', 'marta');
  await panel.fill('#campo-pin', '1111');
  await panel.click('#btn-login');
  await panel.click('[data-tab=puntos]');
  await panel.click('[data-chapita="p-bombas"]');
  await panel.click('#btn-empezar-chapita');
  await espera(200);
  await panel.evaluate(() => window.__tocar(null)); // chapita nueva, vacía
  await espera(300);
  await panel.evaluate(() => window.__tocar()); // alejar y acercar: verificación
  await espera(600);
  const grabada = await panel.textContent('#chapita-estado');
  revisar('El panel graba y verifica la chapita, sin bloquearla', /Chapita grabada \(sin bloquear\)/.test(grabada), grabada.trim());
  revisar('La chapita quedó sin bloquear', !(await panel.evaluate(() => window.__chapita.bloqueada)));
  await panel.waitForSelector('[data-bloquear="p-bombas"]');
  const fila = panel.locator('tr', { has: panel.locator('[data-bloquear="p-bombas"]') });
  revisar('El punto con chapita ofrece "🔒 Bloquear chapita" y no los botones de ubicación',
    (await fila.locator('[data-ubicar]').count()) === 0 && (await fila.locator('[data-bloquear]').count()) === 1);
  await panel.screenshot({ path: path.join(capturas, '1-panel-chapita-grabada.png') });

  // Bloquear: primero se acerca otra chapita (no se bloquea), después la buena.
  await panel.click('[data-bloquear="p-bombas"]');
  await panel.click('#btn-empezar-chapita');
  await espera(200);
  await panel.evaluate(() => window.__tocar('RQR:aromos:p-bombas:BMB892', '04:11:22:33:44:55:66'));
  await espera(300);
  const otraEstado = await panel.textContent('#chapita-estado');
  revisar('Bloquear con otra chapita no bloquea nada', /no es la chapita registrada/.test(otraEstado)
    && !(await panel.evaluate(() => window.__chapita.bloqueada)), otraEstado.trim());
  await panel.click('#btn-empezar-chapita'); // Reintentar
  await espera(200);
  await panel.evaluate(() => window.__tocar());
  await espera(600);
  const bloqueada = await panel.textContent('#chapita-estado');
  revisar('Con la chapita correcta, queda bloqueada', /bloqueada/.test(bloqueada) && (await panel.evaluate(() => window.__chapita.bloqueada)), bloqueada.trim());
  await panel.waitForSelector('[data-chapita="p-bombas"]');
  revisar('Ya bloqueada, el botón "🔒 Bloquear chapita" desaparece', (await panel.locator('[data-bloquear="p-bombas"]').count()) === 0);
  await panel.screenshot({ path: path.join(capturas, '1b-panel-chapita-bloqueada.png') });

  // Grabar en otro punto una chapita que ya es de "Sala de bombas": se detiene y lo dice.
  await panel.click('[data-chapita="p-sede"]');
  await panel.click('#btn-empezar-chapita');
  await espera(200);
  await panel.evaluate(() => window.__tocar());
  await espera(300);
  const repetida = await panel.textContent('#chapita-estado');
  revisar('Una chapita de otro punto no se graba, y el panel dice por qué', /ya está registrada en "Sala de bombas"/.test(repetida), repetida.trim());
  await panel.click('#btn-cerrar-chapita');

  // 2. Guardia: ronda nocturna (orden estricto) hasta la sala de bombas.
  const guardia = await ctx.newPage();
  guardia.on('dialog', d => d.accept());
  await guardia.goto(base);
  await guardia.evaluate(async () => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: 'pedro', pin: '2222' }) });
    localStorage.setItem('rondasqr', JSON.stringify({ sesion: await r.json(), cola: [] }));
  });
  await guardia.reload();
  await espera(800);
  await guardia.evaluate(() => bajarPaquete(true).then(() => iniciarRonda('ronda-nocturna')));
  await espera(600);
  for (const c of ['PRT234', 'EST456', 'QCH789', 'PSC234', 'BDG567']) await guardia.evaluate(c => procesarCodigo(c), c);
  await guardia.click('#btn-escanear');
  await espera(300);
  const pantallaNfc = await guardia.isVisible('#modal-nfc');
  revisar('"Escanear" en un punto con chapita abre solo la pantalla de la chapita', pantallaNfc && !(await guardia.isVisible('#modal-escaner')));
  await guardia.screenshot({ path: path.join(capturas, '2-guardia-pantalla-chapita.png') });

  const aviso = () => guardia.textContent('#aviso');
  await guardia.evaluate(() => procesarCodigo(rondaActual().puntos[5].payload));
  revisar('La foto del QR se rechaza', /se marca con la chapita NFC/.test(await aviso()));
  await guardia.evaluate(() => procesarCodigo('BMB892'));
  revisar('El código a mano se rechaza', /código a mano no sirve/.test(await aviso()));
  await guardia.evaluate(() => window.__tocar(rondaActual().puntos[5].payload, '04:11:22:33:44:55:66'));
  await espera(200);
  revisar('Una copia de la chapita (otra serie) se rechaza', /no es la registrada/.test(await aviso()));
  // Una lectura rechazada cierra la pantalla: el guardia vuelve a tocar Escanear.
  await guardia.click('#btn-escanear');
  await espera(200);
  await guardia.evaluate(() => window.__tocar(rondaActual().puntos[5].payload, '04:a2:3b:4c:5d:6e:80'));
  await espera(300);
  revisar('La chapita verdadera marca el punto', /Sala de bombas \(6\/8\)/.test(await aviso()));
  await espera(4500); // la cola se envía cada 4 s
  revisar('La marca llegó al servidor', (await guardia.evaluate(() => estado.cola.length)) === 0);
  await guardia.screenshot({ path: path.join(capturas, '3-guardia-marcada.png'), fullPage: true });

  await navegador.close();
  servidor.close();
  const fallas = resultados.filter(ok => !ok).length;
  console.log(`\n${resultados.length - fallas}/${resultados.length} bien · capturas en ${capturas}`);
  process.exit(fallas ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
