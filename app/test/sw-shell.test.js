// La app del guardia tiene que arrancar SIN SEÑAL. Eso depende de que todo lo
// que index.html carga esté en el arreglo SHELL de sw.js: un <script> que no se
// precachea deja la pantalla en blanco después de la primera purga de caché, y
// el síntoma aparece recién en el teléfono de un guardia en medio de una ronda.
//
// Es el modo de falla más caro del proyecto y el más fácil de olvidar (agregar
// un archivo nuevo y no tocar el service worker). Acá se cae ruidosamente antes.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publico = path.join(__dirname, '..', 'public');
const leer = archivo => fs.readFileSync(path.join(publico, archivo), 'utf8');

// El arreglo SHELL tal como lo escribe sw.js, sin ejecutarlo (importa el
// service worker completo, que necesita `self`).
function shellDeSw() {
  const fuente = leer('sw.js');
  const i = fuente.indexOf('const SHELL = [');
  assert.ok(i !== -1, 'sw.js ya no define SHELL');
  const fin = fuente.indexOf('];', i);
  return fuente.slice(fuente.indexOf('[', i) + 1, fin)
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, '').trim().replace(/^'|',?$/g, ''))
    .filter(l => l && l !== './');
}

test('todo lo que carga la app del guardia está precacheado en el service worker', () => {
  const shell = shellDeSw();
  const html = leer('index.html');
  // Solo archivos servidos junto a la app: las rutas del servidor (/panel) y lo
  // externo no se precachean ni se pueden precachear.
  const recursos = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(m => m[1])
    .filter(r => /^[^/][\w./-]*\.\w+$/.test(r));
  const faltan = recursos.filter(r => !shell.includes(r));
  assert.deepEqual(faltan, [], `sin esto la app del guardia no arranca sin señal: ${faltan.join(', ')}`);
});

test('los archivos del SHELL existen en public/', () => {
  const faltan = shellDeSw().filter(a => !a.startsWith('vendor/') && !fs.existsSync(path.join(publico, a)));
  // vendor/jsqr.js lo sirve el servidor desde node_modules, no vive en public/.
  assert.deepEqual(faltan, [], `el service worker precachea archivos que no existen: ${faltan.join(', ')}`);
});

test('la VERSION del service worker acompaña a la de package.json', () => {
  // El caché se invalida por VERSION: si no sube, el teléfono se queda con el
  // shell viejo y el archivo nuevo nunca entra.
  const version = require('../package.json').version;
  assert.match(leer('sw.js'), new RegExp(`const VERSION = 'v${version.replace(/\./g, '\\.')}'`),
    `sw.js debe declarar VERSION = 'v${version}'`);
});

test('la VERSION_APP de la app del guardia acompaña a la de package.json', () => {
  // La app se recarga sola cuando su versión no es la del servidor: si
  // VERSION_APP no sube con el release, el teléfono de la garita se recarga
  // contra el freno en vez de quedar al día, y el panel lo muestra desactualizado.
  const version = require('../package.json').version;
  assert.match(leer('app.js'), new RegExp(`const VERSION_APP = 'v${version.replace(/\./g, '\\.')}'`),
    `app.js debe declarar VERSION_APP = 'v${version}'`);
});
