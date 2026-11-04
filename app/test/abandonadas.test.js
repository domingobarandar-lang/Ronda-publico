// Rondas abandonadas: la que el teléfono inició y nunca cerró ya no queda "en
// curso" para siempre (callando la alarma del condominio), y si el teléfono
// aparece después con las marcas que traía sin señal, la ronda se reabre y
// las recibe. Ver estaAbandonada / reabrirSiAutomatica en lib/rondas.js.
'use strict';

process.env.MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearApp } = require('../server');
const { datosSemilla } = require('../seed');
const recordatorios = require('../lib/recordatorios');

let base;
let servidor;
let store;
let cerrarAbandonadas;
let push;
const avisosPush = [];

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: resp.status, datos: await resp.json().catch(() => ({})) };
}

async function login(usuario, pin) {
  const r = await api('/api/login', { metodo: 'POST', cuerpo: { usuario, pin } });
  assert.equal(r.status, 200);
  return r.datos;
}

const MIN = 60000;
const hace = min => new Date(Date.now() - min * MIN).toISOString();

async function iniciar(token, inicio) {
  const id = 'abn-' + Math.random().toString(36).slice(2, 12);
  const r = await api('/api/ejecuciones', { metodo: 'POST', token, cuerpo: { id, rondaId: 'ronda-express', inicio } });
  assert.equal(r.status, 201);
  return id;
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-abn-'));
  const rutaDb = path.join(dir, 'db.json');
  fs.writeFileSync(rutaDb, JSON.stringify(datosSemilla()));
  const creado = crearApp({ rutaDb, enviarPush: async () => {} });
  store = creado.store;
  cerrarAbandonadas = creado.cerrarAbandonadas;
  push = creado.push;
  push.avisar = async (condominio, aviso) => { avisosPush.push(aviso); };
  await new Promise(resolve => { servidor = creado.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test('una ronda reciente sin marcas NO se da por abandonada', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(30));
  assert.deepEqual(await cerrarAbandonadas(), []);
  assert.equal(store.ejecuciones.obtener(id).estado, 'en_curso');
  // Se cierra para no contaminar los tests que siguen.
  await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token });
});

test('ronda iniciada y nunca cerrada: se cierra sola, avisa y deja de callar la alarma', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(150));
  const condominio = store.db.condominios.find(c => c.id === 'aromos');
  // 20 min: la ronda del test anterior empezó hace 30 y cuenta como la última.
  condominio.recordatorioMin = 20;
  condominio.recordatorioDesde = hace(24 * 60);
  // Mientras está "en curso", la alarma del condominio no suena: ese era el daño.
  assert.equal(recordatorios.leToca(store, condominio), false);

  const pushAntes = avisosPush.length;
  const cerradas = await cerrarAbandonadas();
  assert.deepEqual(cerradas, [id]);

  const e = store.ejecuciones.obtener(id);
  assert.equal(e.estado, 'incompleta');
  assert.equal(e.cierreAutomatico, true);
  assert.equal(e.fin, e.inicio, 'el fin es la última actividad conocida, no la hora del barrido');
  assert.match(e.evaluacion.observaciones[0], /Cerrada automáticamente/);
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /cerrada automáticamente/);
  assert.equal(avisosPush.length, pushAntes + 1, 'el administrador recibe el aviso de ronda incompleta');

  // Ya no hay una "en curso" colgada: la alarma vuelve a funcionar.
  assert.equal(recordatorios.leToca(store, condominio), true);
  condominio.recordatorioMin = 0;

  // Un segundo barrido no la toca de nuevo.
  assert.deepEqual(await cerrarAbandonadas(), []);
});

test('el teléfono aparece con las marcas hechas sin señal: la ronda se reabre y el cierre real manda', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const express = paquete.rondas.find(r => r.id === 'ronda-express');

  const id = await iniciar(token, hace(180));
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');

  // Llega la cola del teléfono: las marcas con su hora original…
  for (const [i, punto] of express.puntos.entries()) {
    const esc = await api(`/api/ejecuciones/${id}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts: hace(175 - i * 5), offline: true }
    });
    assert.equal(esc.status, 200, 'la marca tardía entra en vez de rebotar con 409');
  }
  assert.equal(store.ejecuciones.obtener(id).estado, 'en_curso');

  // …y el cierre de verdad, con la hora de término del teléfono.
  const fin = hace(160);
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin } });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.evaluacion.faltantes.length, 0);
  const e = store.ejecuciones.obtener(id);
  assert.equal(e.fin, fin);
  assert.ok(!e.cierreAutomatico);
  assert.ok(!e.evaluacion.observaciones.some(o => /automáticamente/.test(o)));
});

test('solo el cierre tardío (sin marcas nuevas) también reemplaza al automático', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(200));
  await cerrarAbandonadas();
  const fin = hace(190);
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin } });
  assert.equal(cierre.status, 200);
  assert.equal(store.ejecuciones.obtener(id).fin, fin);
  assert.ok(!store.ejecuciones.obtener(id).cierreAutomatico);
});

test('otro guardia no puede reabrir una ronda cerrada sola; una marca repetida no la reabre', async () => {
  const pedro = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token: pedro.token });
  const punto = paquete.rondas.find(r => r.id === 'ronda-express').puntos[0];

  const id = await iniciar(pedro.token, hace(200));
  const primera = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: punto.payload, ts: hace(195) }
  });
  assert.equal(primera.status, 200);
  await cerrarAbandonadas();

  const luis = await login('luis', '3333');
  const ajeno = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: luis.token, cuerpo: { codigo: punto.payload }
  });
  assert.equal(ajeno.status, 403);

  // El reenvío de una marca que ya estaba no es información nueva.
  const repetida = await api(`/api/ejecuciones/${id}/escaneos`, {
    metodo: 'POST', token: pedro.token, cuerpo: { codigo: punto.payload, ts: hace(195) }
  });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.datos.duplicado, true);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');
  assert.equal(store.ejecuciones.obtener(id).cierreAutomatico, true);
});

test('las colgadas de hace días se cierran sin despertar al administrador', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(3 * 24 * 60));
  const pushAntes = avisosPush.length;
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  assert.equal(store.ejecuciones.obtener(id).estado, 'incompleta');
  assert.equal(avisosPush.length, pushAntes, 'sin push');
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto, /cerrada automáticamente/, 'pero sí queda en el panel');
});

test('el umbral respeta rondas largas: el doble de su duración máxima si pasa de 2 h', () => {
  const motor = require('../lib/rondas');
  assert.equal(motor.umbralAbandonoMs({ duracionMaxMin: 20 }), 120 * MIN);
  assert.equal(motor.umbralAbandonoMs({ duracionMaxMin: 90 }), 180 * MIN);
  assert.equal(motor.umbralAbandonoMs(null), 120 * MIN);
});

// ---------- v1.25: todos los puntos marcados y nadie tocó «Terminar» ----------
//
// Pasó tres veces seguidas en el teléfono compartido de una garita: el guardia
// marcaba los 9 puntos y no tocaba «Terminar ronda». La ronda quedaba en curso
// dos horas (callando la alarma) y después llegaba como "el teléfono no
// terminó la ronda", que no era lo que había pasado.

async function marcarTodo(token, id, minutosUltima) {
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const puntos = paquete.rondas.find(r => r.id === 'ronda-express').puntos;
  for (const [i, punto] of puntos.entries()) {
    const ts = hace(minutosUltima + (puntos.length - 1 - i) * 2);
    const r = await api(`/api/ejecuciones/${id}/escaneos`, {
      metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts, offline: true }
    });
    assert.equal(r.status, 200);
  }
}

test('todos los puntos marcados y sin «Terminar»: se cierra a los 30 min de la última marca, con el motivo real', async () => {
  const { token } = await login('pedro', '2222');
  // INC-004: con 15 min se cortaba al guardia que escribía su observación.
  const reciente = await iniciar(token, hace(40));
  await marcarTodo(token, reciente, 20);
  const olvidada = await iniciar(token, hace(50));
  await marcarTodo(token, olvidada, 31);

  const pushAntes = avisosPush.length;
  assert.deepEqual(await cerrarAbandonadas(), [olvidada], 'la de hace 20 min todavía espera su «Terminar»');

  const e = store.ejecuciones.obtener(olvidada);
  assert.notEqual(e.estado, 'incompleta', 'no le falta ningún punto');
  assert.equal(e.cierreAutomatico, true);
  assert.equal(Date.parse(e.fin), Math.max(...e.escaneos.map(x => Date.parse(x.ts))), 'el fin es la última marca, no la hora del barrido');
  assert.match(e.evaluacion.observaciones[0], /marcó todos los puntos pero no tocó «Terminar ronda»/);
  const aviso = store.notificaciones.ultimas('aromos', 1)[0].texto;
  assert.match(aviso, /el guardia marcó todos los puntos pero no tocó «Terminar ronda»/);
  assert.doesNotMatch(aviso, /el teléfono no terminó la ronda/);
  assert.ok(!avisosPush.slice(pushAntes).some(a => /incompleta/i.test(a.titulo)), 'no despierta a nadie con una "incompleta"');

  // La reciente sigue esperando; se cierra para no contaminar lo que sigue.
  assert.equal(store.ejecuciones.obtener(reciente).estado, 'en_curso');
  await api(`/api/ejecuciones/${reciente}/cerrar`, { metodo: 'POST', token });
});

test('el «Terminar» tardío del guardia: queda terminada por él, con cuánto tardó, sin reabrirla ni repetir el informe', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(60));
  await marcarTodo(token, id, 40);
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  const antes = store.ejecuciones.obtener(id);
  const avisosAntes = store.notificaciones.ultimas('aromos', 50).length;
  const pushAntes = avisosPush.length;

  // El guardia terminó de escribir su observación y tocó «Terminar» 39 min
  // después de la última marca.
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, {
    metodo: 'POST', token, cuerpo: { fin: hace(1), comentario: 'Portón del fondo sin candado' }
  });
  assert.equal(cierre.status, 200);
  assert.equal(cierre.datos.comentario, 'Portón del fondo sin candado');
  const e = store.ejecuciones.obtener(id);
  assert.ok(!e.cierreAutomatico, 'ya no cuenta como cerrada por el sistema');
  assert.equal(e.fin, antes.fin, 'la espera no se cuenta como ronda');
  assert.equal(e.comentario, 'Portón del fondo sin candado');
  assert.equal(e.evaluacion.observaciones[0], 'El guardia tocó «Terminar ronda» 39 min después de la última marca.');
  assert.ok(!e.evaluacion.observaciones.some(o => /automáticamente|no tocó/.test(o)));
  assert.notEqual(e.estado, 'incompleta');

  // Un solo aviso corto que corrige el del cierre automático, sin push.
  assert.equal(store.notificaciones.ultimas('aromos', 50).length, avisosAntes + 1, 'no sale el informe dos veces');
  assert.equal(store.notificaciones.ultimas('aromos', 1)[0].texto,
    '✅ Pedro Soto sí tocó «Terminar ronda» en su ronda "Perimetral express" del '
    + `${new Date(e.inicio).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}, `
    + '39 min después de la última marca. Queda como terminada por el guardia.\n💬 Comentario: Portón del fondo sin candado');
  assert.equal(avisosPush.length, pushAntes);

  // El reintento de la cola no cambia nada ni repite el aviso.
  const reintento = await api(`/api/ejecuciones/${id}/cerrar`, {
    metodo: 'POST', token, cuerpo: { fin: hace(1), comentario: 'Portón del fondo sin candado' }
  });
  assert.equal(reintento.status, 200);
  assert.deepEqual(store.ejecuciones.obtener(id), e);
  assert.equal(store.notificaciones.ultimas('aromos', 50).length, avisosAntes + 1);
});

test('sin señal: el «Terminar» que el guardia tocó a tiempo llega tarde y la ronda queda como si hubiera llegado a tiempo', async () => {
  const { token } = await login('pedro', '2222');
  const id = await iniciar(token, hace(60));
  await marcarTodo(token, id, 40);
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  const antes = store.ejecuciones.obtener(id);
  const ultima = Math.max(...antes.escaneos.map(x => Date.parse(x.ts)));

  // Tocó «Terminar» 3 min después de la última marca, pero el teléfono no
  // tenía señal: el cierre estaba en la cola.
  const fin = new Date(ultima + 3 * MIN).toISOString();
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token, cuerpo: { fin } });
  assert.equal(cierre.status, 200);
  const e = store.ejecuciones.obtener(id);
  assert.ok(!e.cierreAutomatico);
  assert.equal(e.fin, fin, 'la hora de término es la del toque');
  assert.ok(!e.evaluacion.observaciones.some(o => /automáticamente|tocó «Terminar ronda»/.test(o)));
  assert.match(store.notificaciones.ultimas('aromos', 1)[0].texto,
    /^✅ Pedro Soto sí tocó «Terminar ronda» en su ronda .+, 3 min después de la última marca \(el teléfono estaba sin señal y el aviso llegó tarde\)\. Queda como terminada por el guardia\.$/);
});

test('el «Terminar» de un administrador no cambia la ronda que el sistema cerró sola', async () => {
  const pedro = await login('pedro', '2222');
  const id = await iniciar(pedro.token, hace(60));
  await marcarTodo(pedro.token, id, 40);
  assert.deepEqual(await cerrarAbandonadas(), [id]);
  const antes = store.ejecuciones.obtener(id);
  const avisosAntes = store.notificaciones.ultimas('aromos', 50).length;

  const marta = await login('marta', '1111');
  const cierre = await api(`/api/ejecuciones/${id}/cerrar`, {
    metodo: 'POST', token: marta.token, cuerpo: { fin: hace(1), comentario: 'cerrada desde el panel' }
  });
  assert.equal(cierre.status, 200);
  assert.deepEqual(store.ejecuciones.obtener(id), antes);
  assert.equal(store.notificaciones.ultimas('aromos', 50).length, avisosAntes);
});

test('el barrido no pisa el «Terminar» que llega mientras espera el push de otra ronda', async () => {
  const { token } = await login('pedro', '2222');
  // La que sale primero (inicio más reciente): a medias y vencida, su cierre
  // avisa por push. La otra: completa y pasada de los 30 min.
  const aMedias = await iniciar(token, hace(150));
  const completa = await iniciar(token, hace(160));
  await marcarTodo(token, completa, 40);

  // Mientras el barrido espera el push de la primera, el guardia toca
  // «Terminar» en la segunda.
  const avisar = push.avisar;
  push.avisar = async (condominio, aviso) => {
    push.avisar = avisar;
    const cierre = await api(`/api/ejecuciones/${completa}/cerrar`, { metodo: 'POST', token, cuerpo: { fin: hace(0) } });
    assert.equal(cierre.status, 200);
    return avisar(condominio, aviso);
  };
  let cerradas;
  try {
    cerradas = await cerrarAbandonadas();
  } finally {
    push.avisar = avisar;
  }

  assert.ok(cerradas.includes(aMedias));
  assert.ok(!cerradas.includes(completa), 'ya la había terminado el guardia');
  const e = store.ejecuciones.obtener(completa);
  assert.ok(!e.cierreAutomatico, 'sigue siendo la que cerró el guardia');
  assert.ok(!e.evaluacion.observaciones.some(o => /automáticamente/.test(o)));
});

// ---------- terminarTarde (INC-004) contra la biblioteca ----------
//
// El servidor solo llama a terminarTarde con una ronda completa que el sistema
// ya cerró, y los tests de arriba pasan por ahí con 3 y 39 min de espera. Estos
// fijan lo que esos dos puntos no tocan: el borde del plazo y que lo guardado
// sea lo mismo que si el cierre hubiera llegado a tiempo.

// Ronda express con sus 4 puntos marcados cada 2 min, el último en `ultima`, y
// `minutosDeRonda` entre el inicio y esa última marca.
function rondaCompleta(db, ultima, minutosDeRonda) {
  const ronda = db.rondas.find(r => r.id === 'ronda-express');
  const n = ronda.puntoIds.length;
  return {
    id: 'tt-' + Math.random().toString(36).slice(2, 12),
    rondaId: ronda.id,
    condominioId: ronda.condominioId,
    guardiaId: 'u-pedro',
    inicio: new Date(ultima - minutosDeRonda * MIN).toISOString(),
    fin: null,
    estado: 'en_curso',
    escaneos: ronda.puntoIds.map((puntoId, i) => ({
      puntoId, ts: new Date(ultima - (n - 1 - i) * 2 * MIN).toISOString(), offline: false, gps: null, medio: 'qr'
    })),
    evaluacion: null
  };
}

// Value: protects=el «Terminar» tocado a tiempo deja la ronda guardada igual que si hubiera llegado antes del cierre (mismo fin, evaluación con su duración y estado), y el tocado tarde la deja con el fin en la última marca más la observación de la espera, en estado completa_obs; fails_when=terminarTarde evalúa antes de poner el fin del toque, deja el estado o las observaciones del cierre automático, o arma el estado antes de agregar la observación de la espera; why_new=los tests HTTP de 3 y 39 min solo miran el fin, que no queden las observaciones del cierre automático y que el estado no sea «incompleta»: no ven la duración, la evaluación completa ni el estado exacto; seam=none; no_claim=no prueba el aviso, el HTTP ni la reapertura
test('terminarTarde: a tiempo la ronda queda igual que si el «Terminar» hubiera llegado antes del cierre; tarde, con la espera dicha', () => {
  const motor = require('../lib/rondas');
  const db = datosSemilla();
  const ultima = Date.parse('2026-11-04T15:00:00.000Z');
  const cerradaPorElSistema = base => {
    const e = structuredClone(base);
    motor.cerrarEjecucion(db, e, { automatico: true, fin: new Date(ultima).toISOString() });
    assert.equal(e.cierreAutomatico, true);
    return e;
  };

  // A tiempo: 5 min después de la última marca. Con 10 min de ronda no pasa
  // los 20 de la ronda express (completa); con 18 sí (observación de duración).
  for (const [minutosDeRonda, estado] of [[10, 'completa'], [18, 'completa_obs']]) {
    const base = rondaCompleta(db, ultima, minutosDeRonda);
    const tocado = new Date(ultima + 5 * MIN).toISOString();
    const normal = structuredClone(base);
    motor.cerrarEjecucion(db, normal, { fin: tocado });
    assert.equal(normal.estado, estado, 'el cierre a tiempo de referencia');

    const tardio = cerradaPorElSistema(base);
    assert.deepEqual(motor.terminarTarde(db, tardio, { fin: tocado }), { minutos: 5, aTiempo: true });
    assert.deepEqual(tardio, normal, `con ${minutosDeRonda} min de ronda queda como el cierre a tiempo`);
  }

  // Tarde: 39 min después. El fin sigue siendo la última marca, y la espera
  // queda como primera observación; con ella, el estado ya no es «completa».
  const base = rondaCompleta(db, ultima, 10);
  const normal = structuredClone(base);
  motor.cerrarEjecucion(db, normal, { fin: new Date(ultima).toISOString() });
  assert.equal(normal.estado, 'completa');

  const tarde = cerradaPorElSistema(base);
  assert.deepEqual(motor.terminarTarde(db, tarde, { fin: new Date(ultima + 39 * MIN).toISOString() }), { minutos: 39, aTiempo: false });
  assert.equal(tarde.fin, normal.fin);
  assert.deepEqual(tarde.evaluacion.observaciones, ['El guardia tocó «Terminar ronda» 39 min después de la última marca.', ...normal.evaluacion.observaciones]);
  assert.equal(tarde.estado, 'completa_obs');
  assert.ok(!tarde.cierreAutomatico);
});

// Value: protects=«a tiempo» es exactamente lo que el cierre del sistema todavía no habría cerrado (a 1 ms del plazo es a tiempo, en el plazo es tarde), con el plazo de RONDA_COMPLETA_CIERRE_MIN, y una hora de toque anterior a la última marca no da minutos negativos; fails_when=terminarTarde usa su propio plazo (un 15 o 30 fijo), compara con <= en vez de <, deja pasar minutos negativos al aviso o pone el fin antes de la última marca; why_new=los tests HTTP solo prueban 3 y 39 min, lejos del borde y con el plazo por defecto: un plazo fijo en el código o corrido pasaría los dos; seam=none; no_claim=no prueba el aviso ni el HTTP
test('terminarTarde: «a tiempo» sigue el mismo plazo con que el sistema cierra la ronda completa', () => {
  const motor = require('../lib/rondas');
  const db = datosSemilla();
  const ultima = Date.parse('2026-11-04T15:00:00.000Z');
  const antes = process.env.RONDA_COMPLETA_CIERRE_MIN;
  // Toca «Terminar» `espera` ms después de la última marca. Devuelve lo de
  // terminarTarde y comprueba que «a tiempo» sea lo que el sistema no habría cerrado.
  const toque = espera => {
    const abierta = rondaCompleta(db, ultima, 10);
    const sistemaYaLaHabriaCerrado = motor.estaAbandonada(db, abierta, ultima + espera);
    motor.cerrarEjecucion(db, abierta, { automatico: true, fin: new Date(ultima).toISOString() });
    const r = motor.terminarTarde(db, abierta, { fin: new Date(ultima + espera).toISOString() });
    assert.equal(r.aTiempo, !sistemaYaLaHabriaCerrado, `a ${espera} ms de la última marca`);
    return r;
  };
  try {
    delete process.env.RONDA_COMPLETA_CIERRE_MIN;
    assert.equal(toque(30 * MIN - 1).aTiempo, true, 'por defecto, a 1 ms de los 30 min todavía es a tiempo');
    assert.equal(toque(30 * MIN).aTiempo, false, 'a los 30 min el sistema ya la cierra');
    process.env.RONDA_COMPLETA_CIERRE_MIN = '45';
    assert.equal(toque(40 * MIN).aTiempo, true, 'con 45 min de plazo, 40 min es a tiempo');
    assert.equal(toque(45 * MIN).aTiempo, false);
  } finally {
    if (antes === undefined) delete process.env.RONDA_COMPLETA_CIERRE_MIN;
    else process.env.RONDA_COMPLETA_CIERRE_MIN = antes;
  }
  // El reloj del teléfono iba atrasado: la hora del toque queda antes de la
  // última marca. El aviso no puede decir «-5 min después de la última marca»,
  // y el fin no puede quedar antes de las marcas: con un mínimo de 8 min, esta
  // ronda de 10 pasaría a «demasiado rápida» (5 min) sin que nadie lo avise.
  assert.equal(toque(-5 * MIN).minutos, 0);
  db.rondas.find(r => r.id === 'ronda-express').duracionMinMin = 8;
  const atrasado = rondaCompleta(db, ultima, 10);
  motor.cerrarEjecucion(db, atrasado, { automatico: true, fin: new Date(ultima).toISOString() });
  assert.deepEqual(motor.terminarTarde(db, atrasado, { fin: new Date(ultima - 5 * MIN).toISOString() }), { minutos: 0, aTiempo: true });
  assert.equal(atrasado.fin, new Date(ultima).toISOString(), 'el fin sigue en la última marca');
  assert.equal(atrasado.estado, 'completa');
});

test('una ronda a medias sigue esperando las 2 h: el cierre rápido es solo para las completas', async () => {
  const { token } = await login('pedro', '2222');
  const { datos: paquete } = await api('/api/mi/paquete', { token });
  const punto = paquete.rondas.find(r => r.id === 'ronda-express').puntos[0];
  const id = await iniciar(token, hace(60));
  await api(`/api/ejecuciones/${id}/escaneos`, { metodo: 'POST', token, cuerpo: { codigo: punto.payload, ts: hace(55), offline: true } });
  assert.deepEqual(await cerrarAbandonadas(), []);
  assert.equal(store.ejecuciones.obtener(id).estado, 'en_curso');
  await api(`/api/ejecuciones/${id}/cerrar`, { metodo: 'POST', token });
});

test('RONDA_COMPLETA_CIERRE_MIN: 30 por defecto, y 0 no es un umbral', () => {
  const motor = require('../lib/rondas');
  const antes = process.env.RONDA_COMPLETA_CIERRE_MIN;
  try {
    delete process.env.RONDA_COMPLETA_CIERRE_MIN;
    assert.equal(motor.umbralCompletaMs(), 30 * MIN);
    process.env.RONDA_COMPLETA_CIERRE_MIN = '0';
    assert.equal(motor.umbralCompletaMs(), 30 * MIN);
    process.env.RONDA_COMPLETA_CIERRE_MIN = '45';
    assert.equal(motor.umbralCompletaMs(), 45 * MIN);
  } finally {
    if (antes === undefined) delete process.env.RONDA_COMPLETA_CIERRE_MIN;
    else process.env.RONDA_COMPLETA_CIERRE_MIN = antes;
  }
  assert.equal(motor.todosMarcados({ escaneos: [{ puntoId: 'a' }] }, { puntoIds: ['a'] }), true);
  assert.equal(motor.todosMarcados({ escaneos: [{ puntoId: 'a' }] }, { puntoIds: ['a', 'b'] }), false);
  assert.equal(motor.todosMarcados({ escaneos: [] }, { puntoIds: [] }), false, 'una ronda sin puntos no está "completa"');
  assert.equal(motor.todosMarcados({ escaneos: [{ puntoId: 'a' }] }, null), false, 'sin la ronda no se puede saber');
});
