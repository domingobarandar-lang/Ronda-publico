// Coherencia del informe semanal: lo que afirma tiene que salir de los números,
// nunca del orden en que vienen los datos. Sin API: todo son reglas fijas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const { calcular, revisarCoherencia, repartir, generarInformeSemanal } = require('../lib/informe-semanal');

const nuevoStore = () => crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-inf-')), 'rondas.sqlite'));
const RANGO = { condominioId: 'c1', desde: '2026-09-14', hasta: '2026-09-20' };

// Condominio con `n` puntos (P1..Pn, cargados en ese orden) y una ronda que los recorre todos.
function armar(n = 4) {
  const store = nuevoStore();
  store.db.condominios.push({ id: 'c1', nombre: 'Los Aromos' });
  store.db.usuarios.push({ id: 'g1', nombre: 'Pedro Soto' }, { id: 'g2', nombre: 'Ana Rojas' });
  for (let i = 1; i <= n; i++) store.db.puntos.push({ id: 'p' + i, condominioId: 'c1', nombre: 'Punto ' + i });
  store.db.rondas.push({ id: 'r1', condominioId: 'c1', puntoIds: store.db.puntos.map(p => p.id) });
  let k = 0;
  const ronda = ({ marcados, faltantes = [], estado, guardiaId = 'g1', inicio, sospechas = [] }) => {
    k++;
    const ini = inicio || `2026-09-${String(14 + (k % 7)).padStart(2, '0')}T${String(10 + (k % 10)).padStart(2, '0')}:00:00-03:00`;
    store.ejecuciones.guardar({
      id: 'e' + k, rondaId: 'r1', condominioId: 'c1', guardiaId, inicio: ini, fin: ini,
      estado: estado || (faltantes.length ? 'incompleta' : 'completa'),
      escaneos: marcados.map(p => ({ puntoId: p, ts: ini })),
      evaluacion: { faltantes, sospechas, observaciones: [] }
    });
  };
  return { store, ronda };
}

test('todos los puntos igual de marcados: dice empate, no inventa "más" ni "menos" marcado', () => {
  const { store, ronda } = armar(4);
  for (let i = 0; i < 7; i++) ronda({ marcados: ['p1', 'p2', 'p3', 'p4'] });
  const d = calcular(store, RANGO);
  assert.deepEqual(revisarCoherencia(d), []);
  assert.ok(d.puntos.every(p => p.marcadas === 7 && p.pct === 100));
  assert.deepEqual(d.puntos.map(p => p.nombre), ['Punto 1', 'Punto 2', 'Punto 3', 'Punto 4'], 'a igualdad, alfabético');
  assert.match(d.lecturaPuntos, /misma cantidad de marcas \(7 veces\)/);
  assert.match(d.lecturaPuntos, /no hay un punto más ni menos marcado/);
  assert.match(d.conclusion, /Todos los puntos recorridos tuvieron cobertura completa\./);
  assert.doesNotMatch(d.conclusion, /más cubiertos|al final del ranking/);
  store.cerrar();
});

test('el orden de carga de los puntos no decide nada: el que faltó va primero y se nombra', () => {
  const { store, ronda } = armar(4);
  for (let i = 0; i < 5; i++) ronda({ marcados: ['p1', 'p2', 'p3', 'p4'] });
  ronda({ marcados: ['p2', 'p3', 'p4'], faltantes: ['p1'] });
  const d = calcular(store, RANGO);
  assert.deepEqual(revisarCoherencia(d), []);
  assert.equal(d.puntos[0].nombre, 'Punto 1');
  assert.equal(d.puntos[0].omitidas, 1);
  assert.equal(d.puntos[0].pct, 83);
  assert.match(d.lecturaPuntos, /Un punto quedó sin marcar alguna vez: Punto 1 \(1 vez\)\. Los otros 3 tuvieron cobertura completa\./);
  store.cerrar();
});

test('puntos en menos rondas no salen "menos cubiertos"; los que nadie recorrió aparecen', () => {
  const { store } = armar(0);
  store.db.puntos.push(
    { id: 'a', condominioId: 'c1', nombre: 'Acceso' }, { id: 'b', condominioId: 'c1', nombre: 'Bodega' },
    { id: 'z', condominioId: 'c1', nombre: 'Zona piscina' });
  const ini = '2026-09-15T22:00:00-03:00';
  const g = (id, pts) => store.ejecuciones.guardar({ id, rondaId: 'r', condominioId: 'c1', guardiaId: 'g1', inicio: ini, fin: ini, estado: 'completa', escaneos: pts.map(p => ({ puntoId: p, ts: ini })), evaluacion: { faltantes: [], sospechas: [] } });
  g('x1', ['a', 'b']); g('x2', ['a']); g('x3', ['a']);
  const d = calcular(store, RANGO);
  assert.deepEqual(revisarCoherencia(d), []);
  assert.deepEqual(d.puntos.map(p => [p.nombre, p.marcadas, p.pct]), [['Acceso', 3, 100], ['Bodega', 1, 100]]);
  assert.match(d.lecturaPuntos, /no todas las rondas recorren los mismos puntos, no a omisiones/);
  assert.match(d.lecturaPuntos, /Un punto no forma parte de ninguna ronda realizada en el periodo: Zona piscina\./);
  store.cerrar();
});

test('cumplimiento: nunca 100% si hubo una incompleta, y los porcentajes suman 100', () => {
  const { store, ronda } = armar(2);
  for (let i = 0; i < 299; i++) ronda({ marcados: ['p1', 'p2'] });
  ronda({ marcados: ['p1'], faltantes: ['p2'] });
  const d = calcular(store, RANGO);
  assert.deepEqual(revisarCoherencia(d), []);
  assert.equal(d.cumplimiento, 99, 'con redondeo común decía 100%');
  assert.equal(d.pct.incompletas, 1, 'con redondeo común decía 0%');
  assert.deepEqual(repartir([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(repartir([1, 1, 1], 30), [10, 10, 10]);
  store.cerrar();
});

test('turno con empate de rondas de día y de noche no se inventa', () => {
  const { store, ronda } = armar(1);
  ronda({ marcados: ['p1'], inicio: '2026-09-15T10:00:00-03:00' });
  ronda({ marcados: ['p1'], inicio: '2026-09-15T23:00:00-03:00' });
  const d = calcular(store, RANGO);
  assert.equal(d.guardias[0].turno, 'Día y noche');
  assert.equal(d.turno.dia.pct + d.turno.noche.pct, 100);
  store.cerrar();
});

test('el rango se nombra "Semana" solo si es de lunes a domingo', () => {
  const { store } = armar(1);
  assert.equal(calcular(store, RANGO).rango, 'Semana del 14 al 20 de septiembre de 2026');
  assert.equal(calcular(store, { ...RANGO, desde: '2026-09-16' }).rango, 'Del 16 al 20 de septiembre de 2026');
  store.cerrar();
});

test('con datos al azar, las cifras del informe siempre cuadran entre sí', async () => {
  let semilla = 7;
  const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let caso = 0; caso < 40; caso++) {
    const n = 1 + Math.floor(azar() * 8);
    const { store, ronda } = armar(n);
    const rondas = Math.floor(azar() * 30);
    for (let i = 0; i < rondas; i++) {
      const todos = store.db.puntos.map(p => p.id);
      const faltantes = todos.filter(() => azar() < 0.1);
      const marcados = todos.filter(p => !faltantes.includes(p));
      const estado = !faltantes.length && azar() < 0.1 ? 'sospechosa' : (!faltantes.length && azar() < 0.2 ? 'completa_obs' : undefined);
      ronda({ marcados, faltantes, estado, guardiaId: azar() < 0.5 ? 'g1' : (azar() < 0.9 ? 'g2' : 'borrado'),
        inicio: `2026-09-${14 + Math.floor(azar() * 7)}T${String(Math.floor(azar() * 24)).padStart(2, '0')}:15:00-03:00` });
    }
    if (azar() < 0.3) store.db.puntos.pop();   // un punto eliminado con historia
    const d = calcular(store, RANGO);
    assert.deepEqual(revisarCoherencia(d), [], `caso ${caso}`);
    // Si dice que hay un punto con faltas, la tabla lo confirma, y al revés.
    assert.equal(/sin marcar alguna vez/.test(d.conclusion + d.lecturaPuntos), d.puntos.some(p => p.omitidas > 0), `caso ${caso}`);
    if (caso % 10 === 0) assert.ok((await generarInformeSemanal(store, RANGO)).buffer.length > 1000);
    store.cerrar();
  }
});

test('incidencias en resumen y rondas por día y guardia cuadran', () => {
  const { store, ronda } = armar(2);
  ronda({ marcados: ['p1', 'p2'], guardiaId: 'g1', inicio: '2026-09-14T10:00:00-03:00' });
  ronda({ marcados: ['p1'], faltantes: ['p2'], guardiaId: 'g1', inicio: '2026-09-14T12:00:00-03:00' });
  ronda({ marcados: ['p1'], faltantes: ['p2'], guardiaId: 'g2', inicio: '2026-09-16T23:00:00-03:00' });
  ronda({ marcados: ['p1', 'p2'], estado: 'sospechosa', guardiaId: 'g2', inicio: '2026-09-16T23:30:00-03:00' });
  const d = calcular(store, RANGO);
  assert.deepEqual(revisarCoherencia(d), []);
  assert.deepEqual(d.resumenIncidencias.incompletas, [{ nombre: 'Ana Rojas', n: 1 }, { nombre: 'Pedro Soto', n: 1 }]);
  assert.deepEqual(d.resumenIncidencias.sospechosas, [{ nombre: 'Ana Rojas', n: 1 }]);
  assert.deepEqual(d.guardias.map(g => g.nombre), ['Ana Rojas', 'Pedro Soto'], '3 marcaciones cada uno: alfabético');
  assert.deepEqual(d.rondasPorDia.map(x => [x.dia, x.total, x.porGuardia]), [
    ['Lun', 2, [0, 2]], ['Mar', 0, [0, 0]], ['Mié', 2, [2, 0]], ['Jue', 0, [0, 0]],
    ['Vie', 0, [0, 0]], ['Sáb', 0, [0, 0]], ['Dom', 0, [0, 0]]]);
  store.cerrar();
});
