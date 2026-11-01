// Flechas ↑ ↓ del editor de rondas (v1.24): cambiar un punto de lugar en la
// secuencia. La lógica es moverEnSecuencia() de public/admin.js, pura; se
// prueba sacándola del archivo, como app-gps.test.js hace con app.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// En Windows, con core.autocrlf=true, el archivo llega con CRLF y el fin de la
// función ('\n}\n') no aparecería: se normaliza a LF antes de buscarlo.
const fuente = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8').replace(/\r\n/g, '\n');
const inicio = fuente.indexOf('function moverEnSecuencia(');
assert.ok(inicio !== -1, 'public/admin.js ya no define moverEnSecuencia()');
const ctx = vm.createContext({});
vm.runInContext(fuente.slice(inicio, fuente.indexOf('\n}\n', inicio) + 2), ctx);
const mover = (lista, i, delta) => [...vm.runInContext(`moverEnSecuencia(${JSON.stringify(lista)}, ${i}, ${delta})`, ctx)];

const DIEZ = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];

test('subir y bajar cambian el punto con su vecino', () => {
  assert.deepEqual(mover(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(mover(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
});

test('en los bordes no hace nada', () => {
  assert.deepEqual(mover(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(mover(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(mover([], 0, 1), []);
  assert.deepEqual(mover(['a'], 5, -1), ['a']);
});

test('el punto 10 llega al puesto 5 con cinco toques de ↑, sin perder ni repetir puntos', () => {
  let lista = DIEZ;
  for (let i = 9; i > 4; i--) lista = mover(lista, i, -1);
  assert.deepEqual(lista, ['p1', 'p2', 'p3', 'p4', 'p10', 'p5', 'p6', 'p7', 'p8', 'p9']);
  assert.deepEqual([...lista].sort(), [...DIEZ].sort());
});

test('no modifica la secuencia que recibe', () => {
  const original = ['a', 'b', 'c'];
  vm.runInContext(`globalThis.__l = ${JSON.stringify(original)}; moverEnSecuencia(__l, 0, 1)`, ctx);
  assert.deepEqual([...vm.runInContext('__l', ctx)], original);
});
