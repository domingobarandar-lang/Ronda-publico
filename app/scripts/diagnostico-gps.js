#!/usr/bin/env node
// Diagnóstico del GPS por punto (ADR-001, fase 0): qué puntos generan las marcas
// dudosas y de qué tipo son, con las marcas y los rechazos reales. Es la misma
// cuenta que la «Señal en este punto» del panel (lib/senal-puntos.js), con más
// detalle y para todos los condominios de una vez.
//
// SOLO LECTURA: abre la base en modo readOnly y no la pasa por crearStore(),
// que crea tablas, aplica restauraciones pendientes y cambia el modo del diario.
// Igual, en producción se corre SOLO con permiso explícito (como en INC-001):
// lee nombres de puntos y ubicaciones de los guardias.
//
// Uso (desde app/, con DB_PATH como el servidor):
//   node scripts/diagnostico-gps.js                      → últimos 30 días, todos los condominios
//   node scripts/diagnostico-gps.js --dias 60
//   node scripts/diagnostico-gps.js --condominio aromos
//   node scripts/diagnostico-gps.js --json               → para guardarlo y comparar después
// En Railway (la base está en el volumen):
//   railway ssh -- node scripts/diagnostico-gps.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { cargarEnv } = require('../lib/env');
const { resolverRutas } = require('../lib/store');
const { configGps } = require('../lib/rondas');
const { resumenSenal } = require('../lib/senal-puntos');

// Cómo se fijó el punto (las tres generaciones que conviven, ver admin.js).
function metodoFijado(p) {
  if (p.lat == null) return null;
  if (p.precisionM == null) return 'sin medir (antes de v1.13)';
  if (p.dispersionM == null) return 'la mejor de 12 s (v1.13)';
  return 'promediado (v1.14+)';
}

// Qué clase de problema tiene el punto (ADR-001, fase 0, paso 2). Puede tener
// más de uno. Se decide por proporción, no por un caso suelto: con un solo
// rechazo, un punto 🟢 de 245 marcas salía «semi-techado», y uno con 1
// «imprecisa» en 290 intentos, «bajo losa». Un punto con buena señal no tiene
// techo que clasificar, y en uno con chapita o sin ubicación el GPS no decide
// (lo mismo que recomendacion() en lib/senal-puntos.js). La entrada perdida sí
// se cuenta siempre.
const PROPORCION_LOSA = 0.1;

function clasificar(s, p, cfg) {
  const clases = [];
  if (s.anclaPerdida) clases.push('ancla perdida');
  if (!s.nivel || s.nivel === 'buena' || s.modo === 'nfc' || s.modo === 'ninguna') return clases;
  const intentos = s.marcas + s.rechazosGps;
  const imprecisas = intentos ? s.rechazos.imprecisa / intentos : 0;
  if (imprecisas >= PROPORCION_LOSA || (s.accP90 != null && s.accP90 >= cfg.precisionMaxM)) clases.push('bajo losa');
  else clases.push('semi-techado');
  if (p.lat != null && (p.precisionM == null || p.dispersionM == null)) clases.push('mal fijado');
  return clases;
}

function leerBase(rutaSqlite) {
  if (!fs.existsSync(rutaSqlite)) throw new Error(`No existe la base ${rutaSqlite}. Revisa DB_PATH.`);
  const sql = new DatabaseSync(rutaSqlite, { readOnly: true });
  try {
    const estado = {};
    for (const { clave, valor } of sql.prepare('SELECT clave, valor FROM estado').all()) {
      if (clave === 'condominios' || clave === 'puntos') estado[clave] = JSON.parse(valor);
    }
    return {
      condominios: estado.condominios || [],
      puntos: estado.puntos || [],
      ejecucionesDesde: (desde, condominioId) => sql
        .prepare('SELECT datos FROM ejecuciones WHERE condominio_id = ? AND inicio >= ? ORDER BY inicio')
        .all(String(condominioId), desde)
        .map(f => JSON.parse(f.datos)),
      cerrar: () => sql.close()
    };
  } catch (err) {
    sql.close();
    throw err;
  }
}

function diagnosticar({ rutaDb = process.env.DB_PATH, dias = 30, condominioId, ahora = Date.now() } = {}) {
  const cfg = configGps();
  const desde = new Date(ahora - dias * 86400000).toISOString();
  const base = leerBase(resolverRutas(rutaDb).sqlite);
  try {
    const condominios = base.condominios
      .filter(c => !condominioId || c.id === condominioId)
      .map(c => {
        const puntos = base.puntos.filter(p => p.condominioId === c.id);
        const ejecuciones = base.ejecucionesDesde(desde, c.id);
        const resumen = resumenSenal(puntos, ejecuciones, cfg).map((s, i) => {
          const p = puntos[i];
          return {
            ...s,
            precisionM: p.precisionM != null ? p.precisionM : null,
            fijado: metodoFijado(p),
            clases: clasificar(s, p, cfg)
          };
        });
        return { id: c.id, nombre: c.nombre, ejecuciones: ejecuciones.length, puntos: resumen };
      });
    return { desde, dias, cfg: { ...cfg }, condominios };
  } finally {
    base.cerrar();
  }
}

const ORDEN = { mala: 0, regular: 1, buena: 2 };
const ICONO = { mala: '🔴', regular: '🟡', buena: '🟢' };
const MODO = { gps: '📍 exacto', anclaje: '🏠 entrada', nfc: '📶 chapita', ninguna: 'sin ubicación' };

function formatear(d) {
  const l = [];
  l.push(`Diagnóstico del GPS por punto — desde ${d.desde.slice(0, 10)} (${d.dias} días)`);
  l.push(`Lectura buena ≤ ±${d.cfg.lecturaBuenaM} m · cercanía ${d.cfg.cercaniaM} m / ${d.cfg.cercaniaMin} min · error extra ${d.cfg.errorExtraM} m`);
  for (const c of d.condominios) {
    l.push('');
    l.push(`${c.nombre || c.id} — ${c.ejecuciones} rondas`);
    const puntos = [...c.puntos].sort((a, b) => (ORDEN[a.nivel] ?? 3) - (ORDEN[b.nivel] ?? 3) || b.rechazosGps - a.rechazosGps);
    for (const s of puntos) {
      const r = s.rechazos;
      l.push(`  ${ICONO[s.nivel] || '⚪'} ${s.nombre} · ${MODO[s.modo] || s.modo}`
        + (s.fijado ? ` · fijado ±${s.precisionM ?? '?'} m, ${s.fijado}` : ''));
      l.push(`     ${s.marcas} marcas (${s.sinGps} sin GPS)`
        + (s.accMediana != null ? ` · ± mediana ${s.accMediana} m, p90 ${s.accP90} m` : '')
        + ` · ${s.porCercania} por cercanía · ${s.alBorde} al borde del tope`);
      l.push(`     rechazos del GPS: ${s.rechazosGps} (imprecisa ${r.imprecisa}, distancia ${r.distancia}, `
        + `vencida ${r.vencida}, sin señal ${r.sinSenal})`
        + (s.anclaPerdida ? ` · ${s.anclaPerdida} con la entrada perdida` : '')
        + (r.chapita ? ` · ${r.chapita} avisos de chapita` : ''));
      if (s.clases.length) l.push(`     → ${s.clases.join(', ')}`);
      if (s.recomendacion) l.push(`     💡 ${s.recomendacion}`);
    }
  }
  return l.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const valor = nombre => {
    const i = args.indexOf(nombre);
    return i === -1 ? undefined : args[i + 1];
  };
  const dias = Number(valor('--dias') || 30);
  if (!Number.isFinite(dias) || dias <= 0) throw new Error('--dias tiene que ser un número de días.');
  const d = diagnosticar({ dias, condominioId: valor('--condominio') });
  console.log(args.includes('--json') ? JSON.stringify(d, null, 2) : formatear(d));
}

if (require.main === module) {
  cargarEnv(path.join(__dirname, '..'));
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { diagnosticar, formatear, clasificar };
