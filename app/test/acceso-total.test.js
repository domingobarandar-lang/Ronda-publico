// Cuenta de panel con acceso total: se crea y se mantiene SOLO desde el entorno
// (ADMIN_TOTAL_*). Pruebas del módulo puro, sin levantar el servidor.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPin, verificarPin } = require('../lib/auth');
const fabrica = require('../lib/fabrica');

let n = 0;
const ayudantes = { hashPin, verificarPin, id: () => `u-${++n}` };
const PIN = 'Prueba2026Total';

function base() {
  return {
    condominios: [{ id: 'aromos', nombre: 'Los Aromos' }, { id: 'mirador', nombre: 'Mirador' }],
    usuarios: [
      { id: 'u-g', condominioId: 'aromos', usuario: 'pedro', rol: 'guardia', pinHash: hashPin('2222') },
      { id: 'u-a', condominioId: 'aromos', usuario: 'marta', rol: 'admin', pinHash: hashPin('1111') }
    ]
  };
}
const env = extra => ({
  ADMIN_TOTAL_USUARIO: 'Operacion', ADMIN_TOTAL_NOMBRE: 'Operación', ADMIN_TOTAL_PIN: PIN,
  ADMIN_TOTAL_CONDOMINIO: 'mirador', ...extra
});

test('acceso total: sin configurar no hace nada', () => {
  const db = base();
  const r = fabrica.asegurarAccesoTotal(db, {}, ayudantes);
  assert.equal(r.motivo, 'sin configurar');
  assert.equal(db.usuarios.length, 2);
});

test('acceso total: se crea como admin con la marca, en su condominio de casa', () => {
  const db = base();
  const r = fabrica.asegurarAccesoTotal(db, env(), ayudantes);
  assert.equal(r.creada, true);
  const u = db.usuarios.find(x => x.usuario === 'operacion');
  assert.equal(u.rol, 'admin');
  assert.equal(u.accesoTotal, true);
  assert.equal(u.condominioId, 'mirador');
  assert.equal(u.nombre, 'Operación');
  assert.ok(verificarPin(PIN, u.pinHash));
  assert.ok(!verificarPin(PIN.toLowerCase(), u.pinHash), 'distingue mayúsculas');

  // Segundo arranque igual: no reescribe nada.
  const otra = fabrica.asegurarAccesoTotal(db, env(), ayudantes);
  assert.equal(otra.creada, false);
  assert.ok(!otra.actualizada);
});

test('acceso total: condominio de casa inexistente cae al primero; sin condominios no se crea', () => {
  const db = base();
  const r = fabrica.asegurarAccesoTotal(db, env({ ADMIN_TOTAL_CONDOMINIO: 'no-existe' }), ayudantes);
  assert.equal(r.creada, true);
  assert.equal(db.usuarios.find(x => x.usuario === 'operacion').condominioId, 'aromos');
  assert.match(r.avisoCasa, /no existe/);

  const vacia = { condominios: [], usuarios: [] };
  const sin = fabrica.asegurarAccesoTotal(vacia, env(), ayudantes);
  assert.equal(sin.creada, false);
  assert.match(sin.motivo, /ningún condominio/);
  assert.equal(vacia.usuarios.length, 0);
});

test('acceso total: el PIN tiene que ser alfanumérico de 8 a 32', () => {
  for (const pin of ['12345678', 'abcdefgh', 'Ab1', 'Abcd-1234']) {
    const db = base();
    const r = fabrica.asegurarAccesoTotal(db, env({ ADMIN_TOTAL_PIN: pin }), ayudantes);
    assert.equal(r.creada, false, `PIN "${pin}"`);
    assert.match(r.motivo, /ADMIN_TOTAL_PIN/);
    assert.ok(!db.usuarios.some(x => x.usuario === 'operacion'));
  }
});

test('acceso total: si el usuario existe con otro rol no se toca', () => {
  const db = base();
  const antes = JSON.stringify(db);
  const r = fabrica.asegurarAccesoTotal(db, env({ ADMIN_TOTAL_USUARIO: 'pedro' }), ayudantes);
  assert.equal(r.creada, false);
  assert.match(r.motivo, /otro rol/);
  assert.equal(JSON.stringify(db), antes, 'el guardia queda intacto');
});

test('acceso total: un admin existente recibe la marca y el entorno manda el PIN', () => {
  const db = base();
  const r = fabrica.asegurarAccesoTotal(db, env({ ADMIN_TOTAL_USUARIO: 'marta' }), ayudantes);
  assert.equal(r.actualizada, true);
  const marta = db.usuarios.find(x => x.usuario === 'marta');
  assert.equal(marta.accesoTotal, true);
  assert.equal(marta.condominioId, 'mirador');
  assert.ok(verificarPin(PIN, marta.pinHash));
  assert.ok(!verificarPin('1111', marta.pinHash));
  assert.equal(db.usuarios.length, 2, 'no duplica la cuenta');
});
