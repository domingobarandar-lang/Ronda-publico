// Consumidores del store sobre SQLite (v1.17): el motor de rondas, los handlers
// y los módulos que leen ejecuciones y notificaciones por el repositorio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const motor = require('../lib/rondas');

const nuevoStore = () => crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-mig-')), 'rondas.sqlite'), { sinPuente: true });

test('iniciarEjecucion usa el repositorio: la nueva no se guarda sola y la repetida vuelve la guardada', () => {
  const store = nuevoStore();
  const db = { rondas: [{ id: 'r', condominioId: 'c', puntoIds: [] }], puntos: [] };
  const guardia = { id: 'g', condominioId: 'c' };

  const r = motor.iniciarEjecucion(db, store.ejecuciones, { ejecucionId: 'ejec-00000001', rondaId: 'r', guardia });
  assert.equal(r.repetida, undefined);
  assert.equal(r.ejecucion.estado, 'en_curso');
  assert.equal(store.ejecuciones.obtener('ejec-00000001'), null, 'quien llama decide cuándo guardar');
  store.ejecuciones.guardar(r.ejecucion);

  const otra = motor.iniciarEjecucion(db, store.ejecuciones, { ejecucionId: 'ejec-00000001', rondaId: 'r', guardia });
  assert.equal(otra.repetida, true);
  assert.deepEqual(otra.ejecucion, r.ejecucion);

  const ajena = motor.iniciarEjecucion(db, store.ejecuciones, { rondaId: 'r', guardia: { id: 'x', condominioId: 'otro' } });
  assert.equal(ajena.codigo, 403);
  store.cerrar();
});
