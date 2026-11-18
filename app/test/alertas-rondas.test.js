// Alertas inmediatas (lib/alertas-rondas.js): horas sin rondas y pocas rondas
// en el día, contra el promedio del propio condominio.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crearStore } = require('../lib/store');
const alertas = require('../lib/alertas-rondas');
const { inicioDiaChile, sumarDias } = require('../lib/fechas-chile');

const APP = path.join(__dirname, '..');
const HORA = 3600000;
const silencio = () => {};
// Lunes 16/11/2026 a las 00:10 de Chile (UTC-3): el domingo 15 ya terminó.
const AHORA = Date.parse('2026-11-16T03:10:00Z');

function base(condominios = ['norte']) {
  const store = crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-alertas-')), 'rondas.sqlite'), { log: silencio });
  for (const id of condominios) {
    store.db.condominios.push({ id, nombre: `Condominio ${id}` });
    store.db.rondas.push({ id: `r-${id}`, condominioId: id, nombre: 'Perímetro', puntoIds: ['p1'] });
  }
  store.guardar();
  return store;
}

let n = 0;
// `porDia` rondas por día de Chile, desde `desde` durante `dias` días, una
// cada 2 h desde las 00:30.
function rondas(store, condominioId, desde, dias, porDia) {
  for (let d = 0; d < dias; d++) {
    const t0 = Date.parse(inicioDiaChile(sumarDias(desde, d)));
    for (let k = 0; k < porDia; k++) {
      const inicio = t0 + 30 * 60000 + k * 2 * HORA;
      store.ejecuciones.guardar({ id: `e${n++}`, rondaId: `r-${condominioId}`, condominioId, guardiaId: 'g', inicio: new Date(inicio).toISOString(),
        fin: new Date(inicio + 20 * 60000).toISOString(), estado: 'completa', escaneos: [], evaluacion: null });
    }
  }
}

const op = extra => ({ ...alertas.opcionesDesdeEnv({ SALUD_TO: 'jose@ejemplo.cl' }), ...extra });

test('opciones: 12 h sin rondas y mínimo automático por defecto; 0 apaga; un número fija el mínimo', () => {
  assert.deepEqual(alertas.opcionesDesdeEnv({}), { to: [], sinRondaHoras: 12, minRondasDia: null });
  assert.equal(alertas.opcionesDesdeEnv({ ALERTA_SIN_RONDA_HORAS: '0' }).sinRondaHoras, 0);
  assert.equal(alertas.opcionesDesdeEnv({ ALERTA_MIN_RONDAS_DIA: '0' }).minRondasDia, 0);
  assert.equal(alertas.opcionesDesdeEnv({ ALERTA_MIN_RONDAS_DIA: '6' }).minRondasDia, 6);
  assert.equal(alertas.opcionesDesdeEnv({ ALERTA_MIN_RONDAS_DIA: '' }).minRondasDia, null);
});

test('el mínimo automático es la mitad del promedio de las 4 semanas anteriores; sin 7 días de historia no se revisa', () => {
  const store = base(['norte', 'nuevo']);
  rondas(store, 'norte', '2026-10-18', 28, 10); // 18/10 al 14/11: 10 por día
  rondas(store, 'nuevo', '2026-11-10', 5, 10);  // solo 5 días de historia
  assert.deepEqual(alertas.promedioDiario(store, 'norte', '2026-11-15'), { promedio: 10, dias: 28 });
  assert.deepEqual(alertas.minimoDiario(store, 'norte', '2026-11-15', op()), { minimo: 5, promedio: 10, automatico: true });
  assert.equal(alertas.minimoDiario(store, 'nuevo', '2026-11-15', op()), null);
  assert.equal(alertas.minimoDiario(store, 'nuevo', '2026-11-15', op({ minRondasDia: 3 })).minimo, 3, 'con número fijo sí');
  assert.equal(alertas.minimoDiario(store, 'norte', '2026-11-15', op({ minRondasDia: 0 })), null, 'apagado');
  // Uno que hace 3 al día avisa con 0 (mínimo 1, no 1,5 → 1).
  const chico = base(['chico']);
  rondas(chico, 'chico', '2026-10-18', 28, 3);
  assert.equal(alertas.minimoDiario(chico, 'chico', '2026-11-15', op()).minimo, 1);
  store.cerrar();
  chico.cerrar();
});

test('día con pocas rondas: avisa una vez apenas termina el día, en hora de Chile', () => {
  const store = base();
  rondas(store, 'norte', '2026-10-18', 28, 10);
  rondas(store, 'norte', '2026-11-15', 1, 3); // el domingo: 00:30, 02:30 y 04:30
  // Y una a las 23:10 del domingo (02:10 UTC del lunes): cuenta para el
  // domingo y evita que salte también la de horas sin rondas.
  store.ejecuciones.guardar({ id: 'reciente', rondaId: 'r-norte', condominioId: 'norte', guardiaId: 'g', inicio: new Date(AHORA - HORA).toISOString(), estado: 'completa', escaneos: [] });

  const r = alertas.evaluar(store, { ahora: AHORA, op: op() });
  assert.deepEqual(r.alertas, ['🟡 Condominio norte: el 15-11-2026 hizo 4 rondas, menos de 5 (la mitad de su promedio de 10,0 por día).']);
  assert.equal(alertas.rondasDelDia(store, 'norte', '2026-11-15'), 4);
  assert.deepEqual(alertas.evaluar(store, { ahora: AHORA + HORA, op: op(), estado: r.estado }).alertas, [], 'el mismo día no se repite');
  store.cerrar();
});

test('horas sin rondas: avisa al pasar el plazo, una vez, y de nuevo después de otra ronda', () => {
  const store = base();
  const ronda = (id, inicio, estado = 'completa') => store.ejecuciones.guardar({ id, rondaId: 'r-norte', condominioId: 'norte', guardiaId: 'g', inicio: new Date(inicio).toISOString(), estado, escaneos: [] });
  const sinMinimo = op({ minRondasDia: 0 });
  ronda('a', AHORA - 11 * HORA);
  assert.deepEqual(alertas.evaluar(store, { ahora: AHORA, op: sinMinimo }).alertas, [], '11 h: todavía no');

  const r = alertas.evaluar(store, { ahora: AHORA + HORA, op: sinMinimo });
  assert.equal(r.alertas.length, 1);
  assert.match(r.alertas[0], /^🔴 Condominio norte: lleva 12 horas sin rondas\. La última empezó el dom\.?,? 15-11,? 13:10\.$/);
  assert.deepEqual(alertas.evaluar(store, { ahora: AHORA + 5 * HORA, op: sinMinimo, estado: r.estado }).alertas, [], 'no se repite');

  // Vuelve a haber una ronda; 12 h después se avisa de nuevo.
  ronda('b', AHORA + 6 * HORA);
  const r2 = alertas.evaluar(store, { ahora: AHORA + 7 * HORA, op: sinMinimo, estado: r.estado });
  assert.deepEqual(r2.alertas, []);
  assert.equal(alertas.evaluar(store, { ahora: AHORA + 18 * HORA, op: sinMinimo, estado: r2.estado }).alertas.length, 1);

  // Una ronda en curso cuenta como actividad.
  ronda('c', AHORA + 19 * HORA, 'en_curso');
  assert.deepEqual(alertas.evaluar(store, { ahora: AHORA + 40 * HORA, op: sinMinimo, estado: r2.estado }).alertas, []);
  store.cerrar();
});

test('no alerta por condominios sin rondas configuradas ni por los que nunca tuvieron una', () => {
  const store = base(['norte']);
  store.db.condominios.push({ id: 'sin-rondas', nombre: 'Sin rondas' });
  assert.deepEqual(alertas.evaluar(store, { ahora: AHORA, op: op() }).alertas, []);
  store.cerrar();
});

test('revisar: manda un correo con todas las alertas, guarda el estado solo si salió y sin SALUD_TO no hace nada', async () => {
  const store = base(['norte', 'sur']);
  store.ejecuciones.guardar({ id: 'x', rondaId: 'r-norte', condominioId: 'norte', guardiaId: 'g', inicio: new Date(AHORA - 20 * HORA).toISOString(), estado: 'completa', escaneos: [] });
  store.ejecuciones.guardar({ id: 'y', rondaId: 'r-sur', condominioId: 'sur', guardiaId: 'g', inicio: new Date(AHORA - 30 * HORA).toISOString(), estado: 'completa', escaneos: [] });
  const enviados = [];
  const env = { SALUD_TO: 'jose@ejemplo.cl', ALERTA_MIN_RONDAS_DIA: '0' };

  assert.equal(await alertas.revisar(store, { ahora: AHORA, env: {}, enviar: async m => enviados.push(m), log: silencio }), null);

  const falla = await alertas.revisar(store, { ahora: AHORA, env, enviar: async () => ({ enviada: false, error: 'Gmail: 503' }), log: silencio });
  assert.equal(falla.enviada, false);
  assert.equal(store.db.alertasEstado, undefined, 'si no salió, se reintenta');

  const r = await alertas.revisar(store, { ahora: AHORA, env, enviar: async m => { enviados.push(m); return { enviada: true }; }, log: silencio });
  assert.equal(r.enviada, true);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].subject, '🔴 Alerta Ronda — 2 condominios');
  assert.match(enviados[0].texto, /Condominio norte: lleva 20 horas sin rondas[\s\S]*Condominio sur: lleva 30 horas sin rondas/);
  assert.equal((await alertas.revisar(store, { ahora: AHORA + HORA, env, enviar: async m => { enviados.push(m); return { enviada: true }; }, log: silencio })).enviada, false);
  assert.equal(enviados.length, 1, 'no repite');
  store.cerrar();
});

test('con TZ=UTC, como Railway, el día y la hora son los de Chile', () => {
  const r = spawnSync(process.execPath, ['-e', `
    const a = require('./lib/alertas-rondas');
    const { crearStore } = require('./lib/store');
    const p = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ronda-al-')), 'r.sqlite');
    const s = crearStore(p, { log: () => {} });
    s.db.condominios.push({ id: 'n', nombre: 'Norte' }); s.db.rondas.push({ id: 'r', condominioId: 'n', puntoIds: [] }); s.guardar();
    // 23:10 del domingo en Chile = 02:10 UTC del lunes.
    s.ejecuciones.guardar({ id: 'e', rondaId: 'r', condominioId: 'n', inicio: '2026-11-16T02:10:00.000Z', estado: 'completa', escaneos: [] });
    const r = a.evaluar(s, { ahora: Date.parse('2026-11-16T14:10:00Z'), op: { to: ['x@y.cl'], sinRondaHoras: 12, minRondasDia: 0 } });
    process.stdout.write(JSON.stringify([a.rondasDelDia(s, 'n', '2026-11-15'), r.alertas]));`], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }
  });
  assert.equal(r.status, 0, r.stderr);
  const [delDomingo, lista] = JSON.parse(r.stdout);
  assert.equal(delDomingo, 1);
  assert.match(lista[0], /12 horas sin rondas\. La última empezó el dom\.?,? 15-11,? 23:10\./);
});
