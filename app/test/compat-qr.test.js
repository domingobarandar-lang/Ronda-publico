// COMPATIBILIDAD: un condominio que usa solo QR no nota NADA de las chapitas.
//
// Corre test/compat/escenario-qr.js (una semana de operación de puros QR, por
// la API y por la app del guardia: marcas buenas y malas, GPS, anclaje, sin
// señal, duplicados, ráfaga, cierre del administrador, informes, avisos, hoja
// de QR, informe semanal) con el código de hoy y lo compara, campo por campo,
// con lo que hizo la v1.22.0 —la versión en producción antes de las chapitas—
// guardado en test/fixtures/referencia-qr-v1.22.json.
//
// Las únicas diferencias permitidas son los campos nuevos de la v1.24, y solo
// con su valor "neutro" (un punto sin chapita dice nfc: false; una marca de QR
// dice medio: 'qr'). Cualquier otra diferencia —un texto, un estado, un código
// HTTP, una observación, un aviso— hace fallar este test.
//
// Si un cambio futuro tiene que cambiar a propósito lo que ve un condominio de
// QR, se declara acá abajo (en NUEVOS) y se dice en el CHANGELOG. La referencia
// se regenera con scripts/generar-referencia-compat.js.
'use strict';

process.env.MOCK = 'true';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { correrEscenario } = require('./compat/escenario-qr');

const referencia = require('./fixtures/referencia-qr-v1.22.json');

// Campos que la v1.24 agrega, y el único valor que pueden tener en un
// condominio sin chapitas.
const NUEVOS = {
  nfc: v => v === false || v === null,          // punto del paquete / evento de la cola
  nfcHuella: v => v === null,                   // punto del paquete
  manualEnNfc: v => v === 'rechazo',            // paquete: solo se usa en puntos con chapita
  medio: v => v === null || v === 'qr' || v === 'manual', // marca / detalle del informe
  medios: v => Object.keys(v).every(m => m === 'qr' || m === 'manual'), // informe semanal
  // v1.27, cercanía reciente: los umbrales viajan en el paquete con sus valores
  // por defecto, y ninguna marca de la v1.22 entra por cercanía (las que
  // entraban, entraban por la lectura del momento; las rechazadas siguen
  // rechazadas porque la app de la referencia no manda la lectura cercana).
  lecturaBuenaM: v => v === 20,                 // paquete.gps
  cercaniaM: v => v === 30,
  cercaniaMin: v => v === 5,
  errorExtraM: v => v === 20,
  porCercania: v => v === false                 // detalle del informe
};

// Saca los campos nuevos verificando su valor, y anota dónde aparecieron.
function sinCamposNuevos(valor, ruta = '', vistos = []) {
  if (Array.isArray(valor)) return valor.map((v, i) => sinCamposNuevos(v, `${ruta}[${i}]`, vistos));
  if (!valor || typeof valor !== 'object') return valor;
  const limpio = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (clave in NUEVOS) {
      assert.ok(NUEVOS[clave](v), `${ruta}.${clave} = ${JSON.stringify(v)}: un condominio de puros QR no puede tener ese valor`);
      vistos.push(`${ruta}.${clave}`);
      continue;
    }
    limpio[clave] = sinCamposNuevos(v, `${ruta}.${clave}`, vistos);
  }
  return limpio;
}

let hoy;
test.before(async () => {
  const app = path.join(__dirname, '..');
  hoy = await correrEscenario({
    crearApp: require('../server').crearApp,
    datosSemilla: require('../seed').datosSemilla,
    calcularSemanal: require('../lib/informe-semanal').calcular,
    appJs: fs.readFileSync(path.join(app, 'public/app.js'), 'utf8'),
    geoJs: fs.readFileSync(path.join(app, 'public/geo.js'), 'utf8')
  });
});

test('la referencia es de la v1.22.0 y cubre lo que importa', () => {
  assert.equal(referencia.version, '1.22.0');
  assert.equal(referencia.app.errorArranque, null);
  const estados = referencia.servidor.pasos.map(p => p.status);
  // Hay de todo: aceptadas, rechazadas por GPS y por código, permisos, cerradas.
  for (const s of [200, 201, 401, 403, 404, 409, 422]) assert.ok(estados.includes(s), `la referencia no tiene ninguna respuesta ${s}`);
  assert.ok(referencia.servidor.avisos.length >= 3);
  assert.ok(referencia.app.pasos.some(p => p.camaras > 0), 'la referencia no abrió la cámara');
});

test('la app arranca igual que la v1.22', () => {
  assert.equal(hoy.app.errorArranque, null);
});

test('el botón de escanear de la página es el mismo de la v1.22', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<button id="btn-escanear" class="btn btn-principal btn-gigante">📷 Escanear QR<\/button>/);
  assert.ok(hoy.app.pasos.some(p => p.boton === '📷 Escanear QR'), 'renderRonda no puso el texto del botón');
});

test('API: cada respuesta es la misma que en la v1.22 (salvo los campos nuevos, neutros)', () => {
  const nuevos = [];
  const pasos = sinCamposNuevos(hoy.servidor.pasos, 'pasos', nuevos);
  assert.equal(pasos.length, referencia.servidor.pasos.length);
  pasos.forEach((p, i) => assert.deepEqual(p, referencia.servidor.pasos[i], `cambió la respuesta de "${p.paso}"`));
  // Los campos nuevos aparecen solo donde se esperan: el paquete y los informes
  // (el del panel y el que devuelve el cierre).
  const donde = new Set(nuevos.map(r => hoy.servidor.pasos[Number(/^pasos\[(\d+)\]/.exec(r)[1])].paso));
  assert.deepEqual([...donde].sort(), [
    'admin cierra olvidada', 'cierra express', 'cierra nocturna', 'cierra nocturna (reenvío)',
    'informe e-compat-0001', 'informe e-compat-0002', 'informe e-compat-0003', 'paquete jorge', 'paquete pedro'
  ]);
});

// v1.25, a propósito: las horas de los avisos van en hora de Chile y no en la
// del servidor (Railway corre en UTC y los avisos salían tres horas
// adelantados: «Inicio 01:02 p. m.» de una ronda de las 10:02). La referencia
// se grabó en UTC: sus horas se pasan a Chile antes de comparar, y todo lo
// demás sigue letra por letra. De paso, la hora queda escrita con el Intl de
// este Node (el espacio de "a. m." cambia entre versiones de ICU).
function horasAChile(texto) {
  return texto.replace(/(\d{2})\/(\d{2}), (\d{2}):(\d{2})\s([ap])\.\s?m\./g, (_, dia, mes, h, min, ap) => {
    const t = Date.UTC(2026, Number(mes) - 1, Number(dia), (Number(h) % 12) + (ap === 'p' ? 12 : 0), Number(min));
    return new Date(t).toLocaleString('es-CL', {
      timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  });
}

test('avisos al administrador: el mismo texto, letra por letra (con la hora en Chile, v1.25)', () => {
  const esperados = referencia.servidor.avisos.map(a => ({ ...a, texto: horasAChile(a.texto) }));
  assert.ok(esperados.some((a, i) => a.texto !== referencia.servidor.avisos[i].texto), 'la referencia ya no trae horas que pasar');
  assert.deepEqual(hoy.servidor.avisos, esperados);
  assert.deepEqual(hoy.servidor.push, referencia.servidor.push);
});

test('rondas guardadas: iguales, y cada marca sabe con qué se hizo', () => {
  assert.deepEqual(sinCamposNuevos(hoy.servidor.guardadas), referencia.servidor.guardadas);
  const medios = hoy.servidor.guardadas.flatMap(e => e.escaneos.map(m => m.medio));
  assert.ok(medios.includes('qr') && medios.includes('manual'));
  assert.ok(!medios.includes('nfc'));
});

test('informe semanal: los mismos números y textos', () => {
  assert.deepEqual(sinCamposNuevos(hoy.servidor.semanal), referencia.servidor.semanal);
});

test('app del guardia: mismos avisos, misma cola, misma pantalla, misma cámara', () => {
  const pasos = sinCamposNuevos(hoy.app.pasos, 'app');
  assert.equal(pasos.length, referencia.app.pasos.length);
  pasos.forEach((p, i) => {
    const antes = referencia.app.pasos[i];
    assert.equal(p.paso, antes.paso);
    assert.deepEqual(p.avisos, antes.avisos, `"${p.paso}": cambió lo que se le dice al guardia`);
    assert.deepEqual(p.cola, antes.cola, `"${p.paso}": cambió lo que se manda al servidor`);
    assert.deepEqual(p.escaneos, antes.escaneos, `"${p.paso}": cambiaron las marcas`);
    assert.equal(p.lista, antes.lista, `"${p.paso}": cambió la lista de puntos`);
    assert.equal(p.marcaTitulo, antes.marcaTitulo, `"${p.paso}": cambió el panel de la marca`);
    assert.equal(p.marcaDetalle, antes.marcaDetalle, `"${p.paso}": cambió el panel de la marca`);
    assert.equal(p.camaras, antes.camaras, `"${p.paso}": "Escanear" no abrió la cámara como antes`);
    // El navegador de mentira no carga index.html: en la v1.22 el botón
    // conservaba su texto de la página ("📷 Escanear QR", que la referencia ve
    // vacío). Desde la v1.24.1 lo pone renderRonda(), y en una ronda de puros
    // QR tiene que ser ese mismo texto.
    assert.ok(p.boton === antes.boton || p.boton === '📷 Escanear QR', `"${p.paso}": el botón dice "${p.boton}"`);
    assert.equal(p.escaner, antes.escaner);
    assert.equal(p.progreso, antes.progreso);
    assert.equal(p.cerrada, antes.cerrada);
  });
});
