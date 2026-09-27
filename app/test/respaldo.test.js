// Respaldo diario de la base (v1.17): foto con VACUUM INTO en el volumen, se
// conservan 14, y copia comprimida por correo a RESPALDO_TO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { crearStore } = require('../lib/store');
const respaldo = require('../lib/respaldo');
const { construirMime } = require('../lib/correo');

const silencio = () => {};

function base() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-respaldo-'));
  const store = crearStore(path.join(dir, 'rondas.sqlite'), { log: silencio });
  store.db.condominios.push({ id: 'c1', nombre: 'Uno' });
  store.guardar();
  store.ejecuciones.guardar({ id: 'e1', condominioId: 'c1', inicio: '2026-09-26T03:00:00.000Z', estado: 'completa', escaneos: [] });
  return { dir, store, carpeta: path.join(dir, 'respaldos') };
}

// Un "Gmail" de mentira que anota lo que se habría mandado.
function buzon({ falla = false } = {}) {
  const enviados = [];
  const enviar = async correo => {
    if (falla) return { enviada: false, error: 'Gmail: 503' };
    enviados.push(correo);
    return { enviada: true, to: correo.to };
  };
  return { enviados, enviar };
}

const env = extra => ({ RESPALDO_TO: 'operacion@ejemplo.cl', RESPALDO_HORA: '10', ...extra });

test('antes de la hora no hace nada; a la hora saca la foto y la manda comprimida', async () => {
  const { store, carpeta } = base();
  const { enviados, enviar } = buzon();

  assert.equal(await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 9 }, env: env(), enviar, log: silencio }), null);
  assert.ok(!fs.existsSync(carpeta));

  const r = await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 10 }, env: env(), enviar, log: silencio });
  assert.equal(r.foto.ruta, path.join(carpeta, 'rondas-2026-09-27.sqlite'));
  assert.equal(enviados.length, 1);
  const correo = enviados[0];
  assert.deepEqual(correo.to, ['operacion@ejemplo.cl']);
  assert.match(correo.subject, /Respaldo Rondas QR — 2026-09-27/);
  assert.match(correo.texto, /1 condominios.*1 rondas/s);
  assert.equal(correo.adjuntos[0].filename, 'rondas-2026-09-27.sqlite.gz');
  assert.equal(correo.adjuntos[0].contentType, 'application/gzip');
  assert.equal(correo.grande, true, 'va por el endpoint de subida de Gmail');

  // Lo adjunto es una base que se abre y trae los datos.
  const copia = path.join(carpeta, 'desde-correo.sqlite');
  fs.writeFileSync(copia, zlib.gunzipSync(correo.adjuntos[0].content));
  const abierta = crearStore(copia, { log: silencio });
  assert.equal(abierta.ejecuciones.obtener('e1').id, 'e1');
  assert.deepEqual(abierta.db.condominios, [{ id: 'c1', nombre: 'Uno' }]);
  abierta.cerrar();
  store.cerrar();
});

test('una vez al día: la segunda revisión del mismo día no rehace la foto ni reenvía', async () => {
  const { store, carpeta } = base();
  const { enviados, enviar } = buzon();
  const ahora = { fecha: '2026-09-27', hora: 11 };
  const primera = await respaldo.revisar(store, { ahora, env: env(), enviar, log: silencio });
  const mtime = fs.statSync(primera.foto.ruta).mtimeMs;
  const segunda = await respaldo.revisar(store, { ahora: { ...ahora, hora: 12 }, env: env(), enviar, log: silencio });
  assert.equal(segunda.foto.nueva, false);
  assert.equal(fs.statSync(primera.foto.ruta).mtimeMs, mtime);
  assert.equal(enviados.length, 1);
  assert.equal(store.db.respaldoEstado.ultimoCorreo, '2026-09-27', 'queda anotado en la base: sobrevive a un reinicio');

  await respaldo.revisar(store, { ahora: { fecha: '2026-09-28', hora: 10 }, env: env(), enviar, log: silencio });
  assert.equal(enviados.length, 2, 'al día siguiente sale otro');
  assert.equal(fs.readdirSync(carpeta).filter(f => f.endsWith('.sqlite')).length, 2);
  store.cerrar();
});

test('RESPALDO_CORREO_CADA_DIAS espacia los correos; la foto sigue siendo diaria', async () => {
  const { store, carpeta } = base();
  const { enviados, enviar } = buzon();
  const e = env({ RESPALDO_CORREO_CADA_DIAS: '3' });
  for (const fecha of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) {
    await respaldo.revisar(store, { ahora: { fecha, hora: 10 }, env: e, enviar, log: silencio });
  }
  assert.deepEqual(enviados.map(c => c.subject.slice(-10)), ['2026-09-20', '2026-09-23']);
  assert.equal(fs.readdirSync(carpeta).length, 4);
  store.cerrar();
});

test('se conservan las últimas 14 fotos', async () => {
  const { store, carpeta } = base();
  fs.mkdirSync(carpeta, { recursive: true });
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(carpeta, `rondas-2026-09-${String(d).padStart(2, '0')}.sqlite`), 'vieja');
  fs.writeFileSync(path.join(carpeta, 'otra-cosa.txt'), 'no se toca');
  const r = await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 10 }, env: env({ RESPALDO_TO: '' }), log: silencio });
  assert.equal(r.foto.borrados.length, 7);
  const quedan = fs.readdirSync(carpeta).filter(f => f.startsWith('rondas-')).sort();
  assert.equal(quedan.length, 14);
  assert.equal(quedan[0], 'rondas-2026-09-08.sqlite');
  assert.equal(quedan.at(-1), 'rondas-2026-09-27.sqlite');
  assert.ok(fs.existsSync(path.join(carpeta, 'otra-cosa.txt')));
  store.cerrar();
});

test('sin RESPALDO_TO la foto se hace igual y el log avisa que no sale copia', async () => {
  const { store } = base();
  const mensajes = [];
  const { enviados, enviar } = buzon();
  const r = await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 10 }, env: env({ RESPALDO_TO: '' }), enviar, log: m => mensajes.push(m) });
  assert.ok(fs.existsSync(r.foto.ruta));
  assert.equal(enviados.length, 0);
  assert.ok(mensajes.some(m => /RESPALDO_TO vacío/.test(m)));
  store.cerrar();
});

test('si el envío falla no se anota: la próxima revisión lo reintenta', async () => {
  const { store } = base();
  const mensajes = [];
  const caido = buzon({ falla: true });
  await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 10 }, env: env(), enviar: caido.enviar, log: m => mensajes.push(m) });
  assert.equal((store.db.respaldoEstado || {}).ultimoCorreo, undefined);
  assert.ok(mensajes.some(m => /FALLÓ el envío/.test(m)));
  const sano = buzon();
  await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 11 }, env: env(), enviar: sano.enviar, log: silencio });
  assert.equal(sano.enviados.length, 1);
  store.cerrar();
});

test('tamaño: cerca del tope avisa en el log y en el correo; sobre el tope no adjunta', async () => {
  const { store } = base();
  const mensajes = [];
  const cerca = buzon();
  await respaldo.revisar(store, { ahora: { fecha: '2026-09-27', hora: 10 }, env: env(), enviar: cerca.enviar, log: m => mensajes.push(m), avisoMb: 0, maxMb: 10 });
  assert.match(cerca.enviados[0].subject, /^⚠️/);
  assert.match(cerca.enviados[0].texto, /se acerca al tope de Gmail/);
  assert.equal(cerca.enviados[0].adjuntos.length, 1);
  assert.ok(mensajes.some(m => /AVISO/.test(m)));

  const encima = buzon();
  await respaldo.revisar(store, { ahora: { fecha: '2026-09-28', hora: 10 }, env: env(), enviar: encima.enviar, log: silencio, avisoMb: 0, maxMb: 0 });
  assert.equal(encima.enviados[0].adjuntos.length, 0);
  assert.match(encima.enviados[0].texto, /no va adjunto.*R2\/S3/s);
  store.cerrar();
});

test('el MIME del correo declara el adjunto como gzip', () => {
  const mime = construirMime({ from: 'a@b.cl', to: ['c@d.cl'], subject: 'x', texto: 'y', adjuntos: [{ filename: 'r.sqlite.gz', contentType: 'application/gzip', content: 'AAAA' }] });
  assert.match(mime, /Content-Type: application\/gzip; name="r\.sqlite\.gz"/);
  const docx = construirMime({ from: 'a@b.cl', to: ['c@d.cl'], subject: 'x', texto: 'y', adjuntos: [{ filename: 'i.docx', content: 'AAAA' }] });
  assert.match(docx, /wordprocessingml\.document; name="i\.docx"/, 'el informe semanal sigue saliendo como .docx');
});
