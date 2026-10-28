// El arranque de la app del guardia, que ningún otro test ejecutaba.
//
// Por qué importa: el service worker es network-first archivo por archivo, así
// que justo después de un deploy un teléfono con señal intermitente puede cargar
// la página vieja del caché con el app.js nuevo, o los estilos de una versión con
// la página de otra. Un listener nuevo sin su botón en la página revienta el
// handler de DOMContentLoaded y la app no arranca; en el teléfono de la garita
// (kiosco) nadie va a destrabarlo. Los tests de abajo arrancan el app.js real
// sobre un DOM de mentira armado con los ids de la página: la de esta versión y
// la de v1.20.2 tal cual se publicó (test/fixtures, sacada de git).
//
// Lo que este DOM NO puede ver es la maquetación (si Cancelar queda a la vista):
// eso se midió en Chrome real con las cuatro combinaciones de página y estilos,
// y se vuelve a medir con la prueba de 5 minutos de entrega/FULLY-KIOSK.md.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publico = path.join(__dirname, '../public');
const fixtures = path.join(__dirname, 'fixtures');
const fuente = fs.readFileSync(path.join(publico, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(publico, 'index.html'), 'utf8');
const estilos = fs.readFileSync(path.join(publico, 'estilos.css'), 'utf8');
const htmlV1202 = fs.readFileSync(path.join(fixtures, 'index-v1.20.2.html'), 'utf8');
const estilosV1202 = fs.readFileSync(path.join(fixtures, 'estilos-v1.20.2.css'), 'utf8');

// Los ids que esta versión agregó a la página.
const IDS_NUEVOS_V121 = [
  'marca-estado', 'marca-titulo', 'marca-detalle', 'marca-acciones', 'btn-descartar-marca',
  'btn-reintentar-marca', 'escaner-texto', 'btn-linterna', 'btn-escaner-manual'
];

const idsDe = texto => new Set([...texto.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
// Lo que getComputedStyle(:root) devolvería para --version-app con esa hoja.
const versionDeHoja = css => {
  const m = /--version-app:\s*([^;]+);/.exec(css);
  return m ? ` ${m[1]}` : '';
};

// Un DOM mínimo: elementos por id, permisivos, que registran los ids del HTML que
// se les inserta y los que se les asignan, y que llevan la cuenta de quién es
// padre de quién cuando la app los mueve.
function crearDom(paginaHtml) {
  const porId = new Map();
  const elemento = (tag = 'div', clases = '') => {
    const clase = new Set(clases.split(/\s+/).filter(Boolean));
    let id = null;
    const e = {
      tagName: tag.toUpperCase(), textContent: '', value: '', style: {}, disabled: false, parentNode: null,
      classList: {
        add: (...c) => c.forEach(x => clase.add(x)),
        remove: (...c) => c.forEach(x => clase.delete(x)),
        contains: c => clase.has(c),
        toggle: (c, si) => ((si ?? !clase.has(c)) ? clase.add(c) : clase.delete(c))
      },
      get id() { return id; },
      set id(v) { id = v; porId.set(v, e); },
      set innerHTML(v) { registrar(v); },
      get innerHTML() { return ''; },
      get className() { return [...clase].join(' '); },
      set className(v) { clase.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => clase.add(x)); },
      addEventListener() {}, removeEventListener() {}, focus() {}, play: () => Promise.resolve(),
      appendChild(hijo) { hijo.parentNode = e; hijo.antesDe = null; return hijo; },
      insertBefore(nuevo, referencia) { nuevo.parentNode = e; nuevo.antesDe = referencia; return nuevo; },
      setAttribute() {}, getAttribute: () => null, querySelector: () => null,
      // Se anota junto a quién y en qué posición quedó cada elemento insertado:
      // un panel en el lugar equivocado (dentro del lector oculto) es tan malo
      // como no tenerlo.
      insertAdjacentHTML(donde, fragmento) { registrar(fragmento, { junto: e, donde }); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [], width: 0, height: 0 }) })
    };
    return e;
  };
  function registrar(fragmento, lugar = null) {
    for (const m of String(fragmento).matchAll(/<(\w+)([^>]*)>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[2]);
      if (!id) continue;
      const clase = /\bclass="([^"]*)"/.exec(m[2]);
      const nuevo = elemento(m[1], clase ? clase[1] : '');
      nuevo.id = id[1];
      nuevo.lugar = lugar;
    }
  }
  registrar(paginaHtml);
  // Las relaciones que el arranque consulta: el <p> del pie del lector (la página
  // vieja lo trae sin id) y el padre del video (el modal en la vieja, el visor
  // en la nueva).
  const pie = { querySelector: sel => (sel === 'p' ? elemento('p', 'nota centrado') : null) };
  if (porId.get('btn-cancelar-escaner')) porId.get('btn-cancelar-escaner').parentNode = pie;
  const marco = elemento('div', 'escaner-marco');
  const video = porId.get('video');
  if (video) {
    const enVisor = /class="escaner-visor"[^>]*>\s*<video id="video"/.test(paginaHtml);
    video.parentNode = enVisor ? elemento('div', 'escaner-visor') : porId.get('modal-escaner');
    marco.parentNode = video.parentNode;
  }
  const meta = /<meta name="version-app" content="([^"]+)">/.exec(paginaHtml);
  return { porId, elemento, marco, meta: meta ? { getAttribute: () => meta[1] } : null };
}

async function arrancar(paginaHtml, hojaCss) {
  const dom = crearDom(paginaHtml);
  let alArrancar = null;
  const ventana = { addEventListener() {} };
  const raiz = dom.elemento('html');
  const documento = {
    documentElement: raiz,
    getElementById: id => dom.porId.get(id) || null,
    querySelector: sel => {
      if (sel === 'meta[name="version-app"]') return dom.meta;
      if (sel === '.escaner-marco') return dom.marco;
      return dom.elemento();
    },
    querySelectorAll: () => [],
    addEventListener: (tipo, fn) => { if (tipo === 'DOMContentLoaded') alArrancar = fn; },
    createElement: tag => dom.elemento(tag),
    head: dom.elemento('head'),
    visibilityState: 'visible',
    activeElement: null
  };
  const contexto = vm.createContext({
    document: documento,
    window: ventana,
    navigator: {
      onLine: false,
      userAgent: 'node',
      vibrate: () => true,
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('sin cámara en el test')) }
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, pathname: '/' },
    matchMedia: () => ({ matches: false }),
    // Solo :root lleva la marca de versión de la hoja; el resto no importa acá.
    getComputedStyle: e => ({
      getPropertyValue: prop => (e === raiz && prop === '--version-app' ? versionDeHoja(hojaCss) : ''),
      minHeight: '0px'
    }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0,
    crypto: globalThis.crypto,
    console: { warn() {}, log() {}, error() {} },
    geo: require('../public/geo')
  });
  vm.runInContext(fuente, contexto, { filename: 'app.js' });
  assert.ok(alArrancar, 'app.js ya no registra su arranque en DOMContentLoaded');
  alArrancar();
  // __appLista se pone dentro de recuperarRespaldo().then(...).
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const enApp = codigo => vm.runInContext(codigo, contexto);
  return { ventana, dom, enApp };
}

test('todo id que app.js busca existe en index.html', () => {
  const usados = new Set([...fuente.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)].map(m => m[1]));
  // El <style> que inyecta completarHtmlAnterior() no vive en la página.
  usados.delete('estilos-shell-anterior');
  const definidos = idsDe(html);
  const faltan = [...usados].filter(id => !definidos.has(id));
  assert.deepEqual(faltan, [], `app.js usa ids que la página no tiene: ${faltan.join(', ')}`);
});

test('la fixture es la página de v1.20.2: no trae nada de esta versión', () => {
  for (const id of IDS_NUEVOS_V121) assert.ok(!idsDe(htmlV1202).has(id), `la fixture trae ${id}`);
  // (id="version-app" es el pie con el número de versión, que ya existía.)
  assert.ok(!/<meta name="version-app"/.test(htmlV1202) && !/--version-app/.test(estilosV1202));
  assert.ok(!/escaner-visor/.test(htmlV1202), 'en v1.20.2 el video colgaba directo del modal');
});

test('la app arranca sobre la página y los estilos de esta versión, sin tocar nada', async () => {
  const { ventana, enApp, dom } = await arrancar(html, estilos);
  assert.equal(ventana.__appLista, true, 'el arranque no llegó al final');
  assert.equal(enApp('estilosAnteriores'), false, 'los estilos de esta versión se toman por viejos');
  assert.equal(enApp('shellMixto()'), false, 'la página de esta versión se toma por mezclada: se recargaría en bucle');
  assert.equal(dom.porId.get('estilos-shell-anterior'), undefined, 'se inyectaron estilos sobre la página nueva');
});

test('CRÍTICO la app arranca sobre la página de v1.20.2 y la deja con la estructura nueva', async () => {
  const { ventana, dom, enApp } = await arrancar(htmlV1202, estilosV1202);
  assert.equal(ventana.__appLista, true, 'con la página anterior la app no arranca');
  for (const id of IDS_NUEVOS_V121) assert.ok(dom.porId.has(id), `no se completó ${id}`);
  // Video y recuadro dentro del visor, como en la página nueva: si no, el
  // estilos.css nuevo tapa el pie con el video (Cancelar no se puede tocar).
  const video = dom.porId.get('video');
  const visor = video.parentNode;
  assert.ok(visor && visor.classList.contains('escaner-visor'), 'el video no quedó dentro de un .escaner-visor');
  assert.equal(dom.marco.parentNode, visor, 'el recuadro no quedó dentro del visor');
  // El visor va donde estaba el video (antes del pie), no al final del modal.
  assert.equal(visor.parentNode, dom.porId.get('modal-escaner'), 'el visor no quedó dentro del modal del lector');
  assert.equal(visor.antesDe, video, 'el visor no quedó en el lugar del video: el pie quedaría arriba');
  // Y cada pieza nueva junto a su ancla: el panel sobre "Escanear QR" (si cae
  // dentro del lector oculto, el guardia nunca ve Reintentar), los botones del
  // lector junto a Cancelar.
  const junto = (id, ancla) => {
    const l = dom.porId.get(id).lugar;
    assert.ok(l && l.junto === dom.porId.get(ancla) && l.donde === 'beforebegin', `${id} no quedó justo antes de ${ancla}`);
  };
  junto('marca-estado', 'btn-escanear');
  junto('btn-linterna', 'btn-cancelar-escaner');
  junto('btn-escaner-manual', 'btn-cancelar-escaner');
  // v1.23 (CU-28): la pantalla de la chapita y la línea de la ronda mixta. Sin
  // ellas el arranque revienta al cablear sus botones.
  for (const id of ['modal-nfc', 'nfc-texto', 'btn-reintentar-nfc', 'btn-cancelar-nfc', 'btn-nfc-manual']) {
    assert.ok(dom.porId.has(id), `no se completó ${id}`);
  }
  junto('escaner-nfc', 'btn-cancelar-escaner');
  assert.equal(enApp('shellMixto()'), true, 'la app no sabe que tiene que recargarse');
});

test('estilos de otra versión se detectan por su marca aunque la página sea nueva', async () => {
  // El caso que la detección por maquetación no veía: index.html nuevo de la red
  // y estilos.css viejo del caché. Sin marca de versión en la hoja, se inyectan
  // las reglas mínimas y la app se recarga en cuanto sea seguro.
  const { enApp, dom } = await arrancar(html, estilosV1202);
  assert.equal(enApp('estilosAnteriores'), true);
  assert.equal(enApp('shellMixto()'), true);
  assert.ok(dom.porId.get('estilos-shell-anterior'), 'no se inyectaron las reglas mínimas');
  const minimos = enApp('ESTILOS_MINIMOS');
  for (const regla of ['.escaner-visor{', '.escaner-visor>#video{position:absolute', '.escaner-pie{position:relative;z-index:1']) {
    assert.ok(minimos.includes(regla), `las reglas mínimas no traen ${regla}`);
  }
});

test('con la página de v1.20.2 el lector abre y cierra sin reventar', async () => {
  const { enApp, dom } = await arrancar(htmlV1202, estilosV1202);
  await enApp('abrirEscaner()');
  assert.equal(dom.porId.get('modal-escaner').classList.contains('oculta'), true,
    'sin cámara el lector tenía que cerrarse y avisar');
});

test('revisarVersion repara un shell mezclado y no bloquea un rollback', () => {
  const inicio = fuente.indexOf('async function revisarVersion(');
  const cuerpo = fuente.slice(inicio, fuente.indexOf('\n}\n', inicio));
  assert.match(cuerpo, /version === VERSION_APP && !shellMixto\(\)/);
  // Una página que declara otra versión no sirve; una sin marca (anterior a la
  // v1.21) sirve si es un cambio real de versión, para que un rollback llegue.
  assert.match(cuerpo, /if \(marca \? marca\[1\] !== version : version === VERSION_APP\) return;/);
});
