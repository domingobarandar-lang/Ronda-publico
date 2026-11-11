#!/usr/bin/env node
// Prueba de carga de la base SQLite (v1.17): N guardias haciendo su ronda a la
// vez sobre una base con M rondas ya guardadas. Mide la latencia de cada
// petición, el bloqueo del event loop y verifica que no se pierda ninguna
// marca. Usa una base temporal: no toca data/ ni producción.
//
// Uso (desde app/):
//   node scripts/prueba-carga.js                         → 100 guardias, 100 mil rondas
//   node scripts/prueba-carga.js --guardias 20 --rondas 5000
//
// El cliente corre en el MISMO proceso que el servidor (así no hace falta
// levantar nada aparte): las latencias incluyen el trabajo de los dos, o sea
// que en producción deberían ser iguales o mejores.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const { crearStore } = require('../lib/store');
const { hashPin } = require('../lib/auth');

const PUNTOS_POR_RONDA = 10;
const CONDOMINIOS = 30;

function percentil(lista, p) {
  if (!lista.length) return 0;
  const orden = [...lista].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor(p / 100 * orden.length))];
}
const ms = n => `${n.toFixed(1)} ms`;

// Base sintética: 30 condominios con 10 puntos y una ronda cada uno, los
// guardias repartidos entre ellos, y `rondas` ejecuciones históricas con sus
// 10 marcas con GPS (el tamaño real de una ejecución en producción).
function armarBase(ruta, { guardias, rondas }) {
  const store = crearStore(ruta, { log: () => {} });
  const pinHash = hashPin('2468');
  const db = store.db;
  for (let c = 0; c < CONDOMINIOS; c++) {
    const cid = `condo-${c}`;
    db.condominios.push({ id: cid, nombre: `Condominio ${c}`, codigoRegistro: `C${c}`, correosInforme: [] });
    db.usuarios.push({ id: `admin-${c}`, condominioId: cid, usuario: `admin${c}`, nombre: `Admin ${c}`, rol: 'admin', pinHash });
    const puntoIds = [];
    for (let p = 0; p < PUNTOS_POR_RONDA; p++) {
      const id = `${cid}-p${p}`;
      db.puntos.push({ id, condominioId: cid, nombre: `Punto ${p}`, codigoCorto: `${String(c).padStart(2, '0')}${p}X`.slice(0, 6) });
      puntoIds.push(id);
    }
    db.rondas.push({ id: `${cid}-ronda`, condominioId: cid, nombre: 'Nocturna', puntoIds, ordenEstricto: false });
  }
  for (let g = 0; g < guardias; g++) {
    db.usuarios.push({ id: `guardia-${g}`, condominioId: `condo-${g % CONDOMINIOS}`, usuario: `guardia${g}`, nombre: `Guardia ${g}`, rol: 'guardia', pinHash });
  }
  store.guardar();

  const t0 = Date.parse('2026-01-01T03:00:00.000Z');
  store.transaccion(() => {
    for (let i = 0; i < rondas; i++) {
      const cid = `condo-${i % CONDOMINIOS}`;
      const inicio = t0 + Math.floor(i / CONDOMINIOS) * 2 * 3600000;
      store.ejecuciones.guardar({
        id: `hist-${i}`, rondaId: `${cid}-ronda`, condominioId: cid, guardiaId: `guardia-${i % guardias}`,
        inicio: new Date(inicio).toISOString(), fin: new Date(inicio + 40 * 60000).toISOString(),
        estado: i % 9 ? 'completa' : 'incompleta',
        escaneos: Array.from({ length: PUNTOS_POR_RONDA }, (_, p) => ({
          puntoId: `${cid}-p${p}`, ts: new Date(inicio + p * 240000).toISOString(), offline: false,
          gps: { lat: -33.4 + p / 10000, lon: -70.6, acc: 8, edadMs: 1200 }
        })),
        evaluacion: { faltantes: [], sospechas: [], duracionMin: 40 }
      });
    }
  });
  store.cerrar();
}

async function pruebaCarga({ guardias = 100, rondas = 100000, log = console.log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronda-carga-'));
  const ruta = path.join(dir, 'rondas.sqlite');
  const resultado = { guardias, rondas };
  try {
    let t = performance.now();
    armarBase(ruta, { guardias, rondas });
    resultado.armarBaseS = (performance.now() - t) / 1000;
    resultado.tamanoMB = fs.statSync(ruta).size / 1024 / 1024;
    log(`Base: ${rondas} rondas en ${resultado.armarBaseS.toFixed(1)} s, ${resultado.tamanoMB.toFixed(0)} MB (${ruta})`);

    t = performance.now();
    const { crearApp } = require('../server');
    const app = crearApp({ rutaDb: ruta, enviarPush: async () => {} });
    resultado.arranqueMs = performance.now() - t;
    const servidor = await new Promise(r => { const s = app.app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${servidor.address().port}`;
    log(`Arranque del servidor sobre esa base: ${ms(resultado.arranqueMs)}`);

    const tiempos = { login: [], paquete: [], iniciar: [], escanear: [], cerrar: [], listado: [], informe: [] };
    async function api(tipo, ruta, { metodo = 'GET', cuerpo, token } = {}) {
      const t0 = performance.now();
      const resp = await fetch(base + ruta, {
        method: metodo,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
      });
      const datos = tipo === 'informe' ? await resp.arrayBuffer() : await resp.json();
      tiempos[tipo].push(performance.now() - t0);
      if (!resp.ok) throw new Error(`${metodo} ${ruta}: HTTP ${resp.status} ${JSON.stringify(datos)}`);
      return datos;
    }

    // Fase 1: los N guardias entran a la vez. El login verifica el PIN con
    // scrypt SÍNCRONO (lib/auth.js): no toca la base, pero bloquea el event
    // loop ~30 ms por login. Se mide aparte para no mezclarlo con la base.
    const retrasoLogin = monitorEventLoopDelay({ resolution: 10 });
    retrasoLogin.enable();
    t = performance.now();
    const sesiones = await Promise.all(Array.from({ length: guardias }, async (_, g) => {
      const { token } = await api('login', '/api/login', { metodo: 'POST', cuerpo: { usuario: `guardia${g}`, pin: '2468' } });
      const paquete = await api('paquete', '/api/mi/paquete', { token });
      return { token, ronda: paquete.rondas[0] };
    }));
    resultado.loginS = (performance.now() - t) / 1000;
    retrasoLogin.disable();
    resultado.eventLoopLogin = { p99: retrasoLogin.percentile(99) / 1e6, max: retrasoLogin.max / 1e6 };

    // Fase 2 (la de la base): cada guardia inicia su ronda, marca los 10
    // puntos de corrido (el peor caso: sin los minutos reales entre punto y
    // punto) y la cierra. Los N a la vez.
    const retraso = monitorEventLoopDelay({ resolution: 10 });
    retraso.enable();
    t = performance.now();
    const ejecucionIds = await Promise.all(sesiones.map(async ({ token, ronda }) => {
      const ejecucion = await api('iniciar', '/api/ejecuciones', { metodo: 'POST', token, cuerpo: { rondaId: ronda.id } });
      const t0 = Date.now();
      for (const [i, p] of ronda.puntos.entries()) {
        await api('escanear', `/api/ejecuciones/${ejecucion.id}/escaneos`, {
          metodo: 'POST', token, cuerpo: { codigo: p.payload, ts: new Date(t0 + i * 60000).toISOString() }
        });
      }
      await api('cerrar', `/api/ejecuciones/${ejecucion.id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin: new Date(t0 + 11 * 60000).toISOString() } });
      return ejecucion.id;
    }));
    resultado.rondaCompletaS = (performance.now() - t) / 1000;
    retraso.disable();
    resultado.eventLoop = { p50: retraso.percentile(50) / 1e6, p99: retraso.percentile(99) / 1e6, max: retraso.max / 1e6 };

    // El panel de un condominio mientras tanto: listado (200) e informe semanal.
    const admin = await api('login', '/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin0', pin: '2468' } });
    for (let i = 0; i < 5; i++) await api('listado', '/api/admin/ejecuciones', { token: admin.token });
    await api('informe', '/api/admin/informe-semanal.docx?desde=2026-02-02&hasta=2026-02-08', { token: admin.token });

    // Verificación: ninguna marca perdida.
    const perdidas = ejecucionIds.filter(id => {
      const e = app.store.ejecuciones.obtener(id);
      return !e || e.escaneos.length !== PUNTOS_POR_RONDA || e.estado === 'en_curso';
    });
    resultado.marcasPerdidas = perdidas.length;
    resultado.totalEjecuciones = app.store.ejecuciones.contar();
    resultado.tiempos = Object.fromEntries(Object.entries(tiempos).map(([k, v]) => [k, {
      n: v.length, p50: percentil(v, 50), p95: percentil(v, 95), max: Math.max(0, ...v)
    }]));

    // Lo que le cuesta a la BASE una marca, sin HTTP ni cliente de por medio:
    // leer la ejecución, agregarle un escaneo y guardarla.
    const vueltas = 2000;
    t = performance.now();
    for (let i = 0; i < vueltas; i++) {
      const e = app.store.ejecuciones.obtener(`hist-${(i * 7919) % rondas}`);
      e.escaneos.push({ puntoId: 'x', ts: new Date().toISOString() });
      e.escaneos.pop();
      app.store.ejecuciones.guardar(e);
    }
    resultado.costoMarcaMs = (performance.now() - t) / vueltas;

    servidor.close();
    app.store.cerrar();

    log(`\n${guardias} logins a la vez: ${resultado.loginS.toFixed(1)} s (event loop bloqueado hasta ${ms(resultado.eventLoopLogin.max)}, por scrypt)`);
    log(`${guardias} guardias haciendo su ronda a la vez: ${resultado.rondaCompletaS.toFixed(1)} s en total`);
    log('Petición          n      p50        p95        máx');
    for (const [k, v] of Object.entries(resultado.tiempos)) {
      log(`${k.padEnd(12)} ${String(v.n).padStart(6)} ${ms(v.p50).padStart(10)} ${ms(v.p95).padStart(10)} ${ms(v.max).padStart(10)}`);
    }
    log(`Event loop durante las rondas: p50 ${ms(resultado.eventLoop.p50)}, p99 ${ms(resultado.eventLoop.p99)}, máx ${ms(resultado.eventLoop.max)}`);
    log(`Costo de base por marca (leer + guardar la ejecución, sin HTTP): ${resultado.costoMarcaMs.toFixed(2)} ms`);
    log(`Ejecuciones en la base: ${resultado.totalEjecuciones} (esperadas ${rondas + guardias})`);
    log(resultado.marcasPerdidas ? `❌ ${resultado.marcasPerdidas} rondas con marcas perdidas` : '✅ Ninguna marca perdida');
    return resultado;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = (nombre, porDefecto) => {
    const i = args.indexOf(`--${nombre}`);
    return i >= 0 ? Number(args[i + 1]) : porDefecto;
  };
  const log = console.log;
  // Los avisos de cierre se imprimen por consola: en la prueba, ruido.
  console.log = () => {};
  pruebaCarga({ guardias: valor('guardias', 100), rondas: valor('rondas', 100000), log })
    .then(r => {
      console.log = log;
      if (r.marcasPerdidas || r.totalEjecuciones !== r.rondas + r.guardias) process.exitCode = 1;
    })
    .catch(err => {
      console.log = log;
      console.error(`[prueba-carga] ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { pruebaCarga };
