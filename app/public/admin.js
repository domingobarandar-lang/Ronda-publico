// Panel del administrador — app aparte de la del guardia: manifiesto, ícono y
// sesión propios. Se instala/marca en el equipo del administrador (/panel).
'use strict';

const CLAVE_ADMIN = 'rondasqr-admin';
let sesion = cargarSesion();
let secuencia = [];        // puntoIds elegidos para la ronda en edición
let puntosCache = [];
let rondaEnEdicion = null; // id de la ronda que se está editando
let promptInstalacion = null; // evento beforeinstallprompt capturado (Chrome/Edge)
let grabacionNfc = null;   // AbortController de la chapita que se está grabando

const $ = id => document.getElementById(id);

function cargarSesion() {
  try { return JSON.parse(localStorage.getItem(CLAVE_ADMIN) || 'null'); }
  catch { return null; }
}
function guardarSesion() {
  if (sesion) localStorage.setItem(CLAVE_ADMIN, JSON.stringify(sesion));
  else localStorage.removeItem(CLAVE_ADMIN);
}

let avisoTimer = null;
function aviso(texto, tipo = 'ok') {
  const el = $('aviso');
  el.textContent = texto;
  el.className = `aviso aviso-${tipo}`;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.add('oculta'), 3000);
}

// Condominio sobre el que está trabajando el panel. Vive dentro de la sesión
// guardada para que informe.html y hoja-qr.html —que abren en otra pestaña— lean
// el mismo y no impriman los QR del condominio equivocado.
function condominioActivo() {
  if (!sesion) return null;
  return (sesion.condominioActivo && sesion.condominioActivo.id) ||
    (sesion.condominio && sesion.condominio.id) || null;
}
// errores.js etiqueta con esto lo que manda a Sentry (v1.26), para que
// /fabrica separe los errores por condominio.
if (typeof window !== 'undefined') window.__erroresCondominio = condominioActivo;

async function api(ruta, opciones = {}) {
  const cabeceras = { 'content-type': 'application/json' };
  if (sesion) cabeceras.authorization = `Bearer ${sesion.token}`;
  const activo = condominioActivo();
  if (activo) cabeceras['x-condominio'] = activo;
  const resp = await fetch(ruta, {
    method: opciones.metodo || 'GET',
    headers: cabeceras,
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined
  });
  const datos = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    sesion = null;
    guardarSesion();
    render();
    throw new Error(datos.error || 'Sesión caducada.');
  }
  if (!resp.ok) throw new Error(datos.error || `Error HTTP ${resp.status}`);
  return datos;
}

function fecha(ts) {
  return ts ? new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

function esc(texto) {
  const div = document.createElement('div');
  div.textContent = String(texto == null ? '' : texto);
  return div.innerHTML;
}

// ---------- Login ----------

async function entrar() {
  $('error-login').classList.add('oculta');
  try {
    const r = await api('/api/login', {
      metodo: 'POST',
      cuerpo: { usuario: $('campo-usuario').value, pin: $('campo-pin').value }
    });
    if (r.rol === 'fabrica') {
      // La cuenta de la operación tiene su propia pantalla (alta de condominios).
      location.href = '/fabrica';
      return;
    }
    if (r.rol !== 'admin') {
      $('error-login').innerHTML =
        'Este panel es solo para administradores. Los guardias entran por ' +
        '<a href="/" target="_blank" rel="noopener">la app del guardia</a>.';
      $('error-login').classList.remove('oculta');
      return;
    }
    sesion = r;
    guardarSesion();
    render();
  } catch (err) {
    $('error-login').textContent = err.message || 'No se pudo conectar.';
    $('error-login').classList.remove('oculta');
  }
}

function salir() {
  api('/api/logout', { metodo: 'POST' }).catch(() => {});
  sesion = null;
  guardarSesion();
  location.href = './'; // vuelve al selector de rol
}

// ---------- Pestañas ----------

function mostrarTab(nombre) {
  for (const t of document.querySelectorAll('.tab')) t.classList.add('oculta');
  for (const p of document.querySelectorAll('.pestana')) p.classList.remove('activa');
  $(`tab-${nombre}`).classList.remove('oculta');
  document.querySelector(`.pestana[data-tab="${nombre}"]`).classList.add('activa');
  // El GPS solo se calienta en la pestaña donde se mide; en cualquier otra es
  // batería quemada sin motivo.
  if (nombre !== 'puntos') enfriarGps();
  const cargar = { informes: cargarInformes, puntos: cargarPuntos, guardias: cargarGuardias, rondas: cargarRondas, avisos: cargarAvisos }[nombre];
  // Con la sesión vencida, api() ya volvió al login: ese 401 no es un fallo y
  // no tiene que llegar a errores.js (aviso rojo + Sentry). Cualquier otro error
  // sigue sin atrapar y se reporta como siempre.
  return cargar().catch(err => { if (sesion) throw err; });
}

// ---------- Informes ----------

const CHIPS = {
  completa: '<span class="chip chip-verde">Completa</span>',
  completa_obs: '<span class="chip chip-ambar">Con observaciones</span>',
  sospechosa: '<span class="chip chip-roja">🔴 SOSPECHOSA</span>',
  incompleta: '<span class="chip chip-roja">INCOMPLETA</span>',
  en_curso: '<span class="chip">En curso</span>'
};

// Deja las fechas del informe semanal en la semana anterior (lunes a domingo).
function prellenarSemana() {
  const desde = $('semana-desde'), hasta = $('semana-hasta');
  if (!desde || !hasta || desde.value || hasta.value) return;
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoy = new Date();
  const lunEsta = new Date(hoy); lunEsta.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
  const lunAnt = new Date(lunEsta); lunAnt.setDate(lunEsta.getDate() - 7);
  const domAnt = new Date(lunAnt); domAnt.setDate(lunAnt.getDate() + 6);
  desde.value = iso(lunAnt);
  hasta.value = iso(domAnt);
}

async function descargarInformeSemanal() {
  const desde = $('semana-desde').value, hasta = $('semana-hasta').value;
  if (!desde || !hasta) { aviso('Elige las fechas de la semana.', 'error'); return; }
  const btn = $('btn-informe-semanal');
  const textoOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = 'Generando…';
  try {
    const resp = await fetch(`/api/admin/informe-semanal.docx?desde=${desde}&hasta=${hasta}`, {
      // No pasa por api() porque baja un .docx, así que la cabecera del
      // condominio activo se pone a mano.
      headers: { authorization: `Bearer ${sesion.token}`, 'x-condominio': condominioActivo() || '' }
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.error || 'No se pudo generar el informe.');
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Informe-Semanal-${desde}_a_${hasta}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    aviso('Informe descargado. Ya puedes adjuntarlo a un correo.');
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = textoOriginal;
  }
}

async function cargarInformes() {
  prellenarSemana();
  const lista = await api('/api/admin/ejecuciones');
  if (!lista.length) {
    $('tabla-informes').innerHTML = '<p class="nota">Todavía no hay rondas registradas.</p>';
    return;
  }
  const filas = lista.map(e => `
    <tr>
      <td>${fecha(e.inicio)}</td>
      <td>${esc(e.ronda)}</td>
      <td>${esc(e.guardia)}</td>
      <td>${e.hechos}/${e.total}</td>
      <td>${CHIPS[e.estado] || esc(e.estado)}</td>
      <td>
        ${e.estado === 'en_curso'
          ? `<button class="btn btn-borde btn-chico" data-cerrar="${e.id}">Cerrar</button>`
          : `<a class="btn btn-borde btn-chico" href="informe.html?id=${e.id}" target="_blank">Ver informe</a>`}
      </td>
    </tr>`).join('');
  // El servidor manda como máximo las últimas 200 (las anteriores siguen en el
  // informe semanal por rango de fechas).
  const tope = lista.length >= 200
    ? '<p class="nota">Se muestran las últimas 200 rondas. Para fechas anteriores usa el informe semanal.</p>'
    : '';
  $('tabla-informes').innerHTML = `
    <table>
      <thead><tr><th>Inicio</th><th>Ronda</th><th>Guardia</th><th>Puntos</th><th>Estado</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>${tope}`;
  for (const btn of $('tabla-informes').querySelectorAll('[data-cerrar]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Cerrar esta ronda ahora? Se evaluará con lo que el guardia haya marcado hasta el momento.')) return;
      try {
        await api(`/api/admin/ejecuciones/${btn.dataset.cerrar}/cerrar`, { metodo: 'POST' });
        aviso('Ronda cerrada y informe generado.');
        cargarInformes();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
}

// ---------- Puntos ----------

// Medición de la ubicación de un punto (CU-23). Fijarlo con UNA lectura era el
// error de fondo: el primer fix de un GPS frío viene de WiFi o de antena con
// ±30-100 m, y esa coordenada quedaba guardada como la verdad del punto para
// siempre — después el guardia, parado encima del QR, aparecía "a 60 m" y la
// marca se rechazaba.
//
// Hasta v1.13 se muestreaban 12 s y se guardaba la MEJOR lectura. Las dos cosas
// estaban mal y por la misma razón:
//   · 12 s no alcanzan. Un receptor GNSS frío necesita 30-60 s para converger,
//     así que en esa ventana el número está dominado por WiFi y antena — que es
//     justo el caso de los puntos semi-techados, los que duelen.
//   · quedarse con el mínimo de N lecturas es elegir el error más favorable y
//     llamarlo precisión. margenM() necesita números honestos para poder apretar
//     el radio sin rechazar a nadie; con uno optimista pasa lo contrario.
// Desde v1.14 se muestrea largo, se promedia con public/geo.js y se declara el ±
// que corresponde. El número guardado sube en el papel y baja en la realidad.
const MEDICION = {
  segundos: 45,      // ventana normal de muestreo
  extendidoS: 90,    // hasta acá se estira si a los 45 s el ± sigue sobre avisarM
  objetivoM: 10,     // dispersión con la que ya se puede cortar antes de tiempo
  minSegundos: 20,   // …pero nunca antes de esto
  minMuestras: 8,    // …ni con menos lecturas que esto
  descartarS: 5,     // basura de convergencia: los primeros segundos no cuentan
  accMaxM: 100,      // lectura de WiFi/antena: no entra al promedio (= precisionMaxM)
  avisarM: 25,       // sobre esto se guarda, pero avisando
  maximaM: 60        // sobre esto no se guarda: la coordenada sería basura
};

// Queda pegada al punto medido. Cuando dentro de un año haya que re-afinar los
// umbrales con los datos de terreno, esto es lo que dice qué método produjo cada
// coordenada, sin tener que volver a caminar el condominio.
const VERSION_MEDICION = 'v1.14.0';

// ---- Calentamiento del receptor ----
// El cronómetro de la medición arrancaba con el GPS en frío, así que los
// primeros 30 s se iban en converger. Al abrir la pestaña de puntos se enciende
// un watch descartable —sus lecturas no se usan— solo para que el receptor tenga
// efemérides cuando el administrador apriete el botón. Con tope duro: es la
// batería del teléfono de alguien.
let calentandoId = null;
let calentandoTimer = null;

function calentarGps() {
  if (calentandoId !== null || !('geolocation' in navigator)) return;
  calentandoId = navigator.geolocation.watchPosition(
    () => {},
    () => {},
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
  calentandoTimer = setTimeout(enfriarGps, MEDICION.extendidoS * 1000);
}

function enfriarGps() {
  if (calentandoId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(calentandoId);
  clearTimeout(calentandoTimer);
  calentandoId = null;
  calentandoTimer = null;
}

// Muestrea la ubicación y devuelve la posición promediada con su ± honesto.
// Toda la matemática vive en public/geo.js, compartida con la app del guardia.
function medirUbicacion(alProgreso) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Este navegador no entrega ubicación.'));
      return;
    }
    // El calentamiento ya cumplió: desde acá manda el watch de la medición.
    enfriarGps();
    const inicio = Date.now();
    const todas = [];   // todo lo que llegó, por si el filtro deja el conjunto vacío
    const utiles = [];  // lo que entra al promedio
    let fallo = null;
    let watchId = null;
    let tick = null;
    let limiteS = MEDICION.segundos;

    // Resultado de lo que hay hasta ahora. null mientras no haya nada usable.
    const resultado = () => {
      const muestras = geo.filtrarOutliers(utiles.length ? utiles : todas);
      const centro = geo.centroidePonderado(muestras);
      if (!centro) return null;
      const declaradas = muestras.map(m => m.acc).filter(a => Number.isFinite(a));
      return {
        lat: centro.lat,
        lon: centro.lon,
        precisionM: geo.precisionHonesta(muestras, centro),
        dispersionM: Math.ceil(geo.dispersion68(muestras, centro)),
        precisionDeclaradaM: declaradas.length ? Math.round(geo.mediana(declaradas)) : null,
        muestras: muestras.length
      };
    };

    const listo = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearInterval(tick);
      const r = resultado();
      if (r) resolve(Object.assign(r, { segundos: Math.round((Date.now() - inicio) / 1000) }));
      else reject(new Error(fallo || 'No se pudo obtener la ubicación.'));
    };

    watchId = navigator.geolocation.watchPosition(
      pos => {
        const transcurridoS = (Date.now() - inicio) / 1000;
        const acc = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
        const muestra = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc };
        todas.push(muestra);
        // Los primeros segundos son convergencia, y una lectura de ±300 m es de
        // antena: ninguna de las dos describe dónde está este punto.
        if (transcurridoS >= MEDICION.descartarS && acc != null && acc <= MEDICION.accMaxM) {
          utiles.push(muestra);
        }
        // Corte anticipado COMPUESTO. El de v1.13 —cortar apenas una lectura
        // declarara ±10 m— era el atajo que hacía inútil la ventana larga: la
        // primera lectura optimista terminaba la medición. Ahora hay que llevar
        // tiempo Y muestras Y que las muestras estén de acuerdo entre ellas.
        if (transcurridoS >= MEDICION.minSegundos && utiles.length >= MEDICION.minMuestras) {
          const r = resultado();
          if (r && r.dispersionM <= MEDICION.objetivoM) listo();
        }
      },
      err => {
        fallo = err && err.code === 1
          ? 'Falta el permiso de ubicación en este navegador.'
          : 'El teléfono no está entregando ubicación (sin señal).';
        // Sin permiso no va a llegar nada nunca: cortar de inmediato. Con
        // "sin señal" se sigue esperando, que el fix suele llegar tarde.
        if (err && err.code === 1) listo();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: MEDICION.segundos * 1000 }
    );

    tick = setInterval(() => {
      const transcurridoS = Math.round((Date.now() - inicio) / 1000);
      const r = resultado();
      if (transcurridoS >= limiteS) {
        // A los 45 s con el ± todavía flojo: seguir hasta 90. Es exactamente el
        // caso del punto semi-techado, donde el receptor recién está agarrando
        // satélites. Se estira solo y se avisa; preguntar a mitad de una medición
        // obliga al administrador a soltar el teléfono para tocar la pantalla.
        if (limiteS < MEDICION.extendidoS && r && r.precisionM > MEDICION.avisarM) {
          limiteS = MEDICION.extendidoS;
        } else {
          return listo();
        }
      }
      if (alProgreso) {
        alProgreso({
          precisionM: r ? r.precisionM : null,
          dispersionM: r ? r.dispersionM : null,
          muestras: r ? r.muestras : 0,
          restanteS: Math.max(0, limiteS - transcurridoS),
          extendida: limiteS > MEDICION.segundos
        });
      }
    }, 1000);
  });
}

// Fija (o vuelve a fijar) la ubicación de un punto midiendo de verdad.
async function fijarUbicacion(punto, anclaje, btn) {
  const pregunta = anclaje
    ? `Fijar la ENTRADA de "${punto.nombre}" donde estás parado AHORA.\n\n`
      + 'Úsalo para puntos bajo techo (subterráneos, salas de calderas, interiores) donde el GPS no llega.\n\n'
      + 'Párate en el último lugar del recorrido donde el teléfono TODAVÍA tiene señal — la puerta del recinto o la rampa de bajada. '
      + 'El guardia podrá marcar el punto si pasó por acá en los últimos minutos.\n\n'
      + `La medición toma hasta ${MEDICION.segundos} segundos: quédate quieto.\n\n¿Continuar?`
    : `Fijar la ubicación EXACTA de "${punto.nombre}" donde estás parado AHORA.\n\n`
      + 'Hazlo desde un teléfono, de pie junto al QR y con el celular en la mano (no en el bolsillo).\n\n'
      + `La medición toma hasta ${MEDICION.segundos} segundos: quédate quieto mientras el GPS afina.\n\n¿Continuar?`;
  if (!confirm(pregunta)) return;

  btn.disabled = true;
  try {
    aviso('Midiendo… buscando señal', 'info');
    const medida = await medirUbicacion(p => aviso(
      p.precisionM == null
        ? `Midiendo… buscando señal (${p.restanteS} s)`
        : `Midiendo… ±${p.precisionM} m con ${p.muestras} lecturas (${p.restanteS} s`
          + `${p.extendida ? ', afinando' : ''})`,
      'info'
    ));

    // Guardar una coordenada de ±80 m es peor que no tener ninguna: bloquea al
    // guardia sin dar ninguna garantía a cambio. Se rechaza y se explica.
    if (medida.precisionM > MEDICION.maximaM) {
      aviso(
        `Señal insuficiente: tras ${medida.segundos} s midiendo, el mejor resultado fue ±${medida.precisionM} m. `
        + 'Sal a cielo abierto, espera unos segundos y reintenta. Si acá nunca hay señal, usa "🏠 Fijar entrada".',
        'error'
      );
      return;
    }
    if (medida.precisionM > MEDICION.avisarM) {
      const seguir = confirm(
        `El resultado fue ±${medida.precisionM} m — no es bueno.\n\n`
        + `Son ${medida.muestras} lecturas promediadas y quedaron repartidas en ${medida.dispersionM} m, `
        + 'así que el ± es real: acá la señal no da para más.\n\n'
        + 'Se puede guardar igual (el sistema le dará al guardia el margen que corresponde a esta imprecisión), '
        + 'pero el control queda más flojo en este punto.\n\n'
        + '¿Guardar así, o cancelar y reintentar con mejor señal?'
      );
      if (!seguir) return;
    }

    await api(`/api/admin/puntos/${punto.id}`, {
      metodo: 'PUT',
      cuerpo: {
        lat: medida.lat,
        lon: medida.lon,
        precisionM: medida.precisionM,
        // Evidencia de CÓMO se llegó a ese número. Sin esto, re-afinar los
        // umbrales en seis meses obliga a volver a caminar el condominio.
        muestras: medida.muestras,
        dispersionM: medida.dispersionM,
        precisionDeclaradaM: medida.precisionDeclaradaM,
        medidoConVersion: VERSION_MEDICION,
        verificacion: anclaje ? 'anclaje' : 'gps'
      }
    });
    aviso(anclaje
      ? `Entrada fijada con ±${medida.precisionM} m: este punto se marca habiendo pasado por acá hace poco.`
      : `Ubicación fijada con ±${medida.precisionM} m (${medida.muestras} lecturas en ${medida.segundos} s).`);
    cargarPuntos();
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function cargarPuntos() {
  // El receptor empieza a calentar apenas se abre la pestaña, no cuando el
  // administrador aprieta el botón: así el cronómetro de la medición no se gasta
  // esperando a que el GPS despierte.
  calentarGps();
  puntosCache = await api('/api/admin/puntos');
  if (!puntosCache.length) {
    $('tabla-puntos').innerHTML = '<p class="nota">Aún no hay puntos. Agrega el primero arriba.</p>';
    return;
  }
  // Tres estados posibles de verificación por punto (CU-19):
  //   sin ubicación → no se verifica
  //   exacta        → hay que estar sobre el punto (20 m)
  //   por entrada   → punto bajo techo: basta haber pasado por la entrada
  // La CALIDAD de la medición se muestra siempre: es lo que explica por qué a un
  // guardia se le rechaza o se le acepta una marca. Hay tres generaciones de
  // punto conviviendo y las tres se ven distinto:
  //   sin precisionM  → fijado antes de v1.13, una sola lectura, calidad ignorada
  //   sin dispersionM → medido con el método de v1.13: la MEJOR de 12 s, un
  //                     número optimista. Se puede confiar menos de lo que dice.
  //   con dispersionM → medido promediando (v1.14): el ± es el real.
  // Ningún punto cambia solo: la marca invita a re-medir, no re-mide.
  const calidadTexto = p => {
    if (p.precisionM == null) return '<span class="rojo">⚠ fijado sin medir — conviene volver a medirlo</span>';
    const viejo = p.dispersionM == null
      ? ' <span class="rojo">· medido con el método antiguo — conviene re-medir</span>'
      : '';
    if (p.precisionM <= 10) return `medido con ±${p.precisionM} m${viejo}`;
    if (p.precisionM <= 25) return `medido con ±${p.precisionM} m (aceptable)${viejo}`;
    return `<span class="rojo">medido con ±${p.precisionM} m — flojo</span>${viejo}`;
  };
  const verificacionTexto = p => {
    if (p.lat == null) return '<span class="nota">sin verificar</span>';
    const mapa = `<a href="https://maps.google.com/?q=${p.lat},${p.lon}" target="_blank">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</a>`;
    const cabecera = p.verificacion === 'anclaje'
      ? `🏠 <strong>Por entrada</strong> · ${p.radioM || 40} m · ${p.ventanaMin || 15} min`
      : `📍 <strong>Exacta</strong> · ${p.radioM || 20} m`;
    return `${cabecera}<br><span class="nota">${mapa} · ${calidadTexto(p)}</span>`;
  };
  // Con qué se marca cada punto (CU-28), siempre a la vista: el administrador
  // tiene que saber de un vistazo cuál es cuál y qué falta. Pendiente es un
  // punto creado "con chapita" que todavía no la tiene grabada: no sale en la
  // hoja de QR y, mientras, se marca con el código a mano.
  const serieCorta = s => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
  const chapitaTexto = p => {
    if (p.nfcSerie) {
      return `<br><span class="nota">📶 NFC · chapita grabada · ${esc(serieCorta(p.nfcSerie))}`
        + ` · ${p.nfcBloqueada ? '🔒 bloqueada' : '<span class="rojo">sin bloquear</span>'}</span>`;
    }
    if (p.nfcPendiente) return '<br><span class="nota rojo">📶 NFC · falta grabar la chapita</span>';
    return '<br><span class="nota">📷 QR</span>';
  };
  // En un punto con chapita la presencia la prueba la chapita: no se ofrecen
  // los botones de ubicación. Si el punto ya traía una, queda "Quitar 📍",
  // porque bajo techo esa ubicación haría rechazar las marcas por falta de GPS.
  const verificacionDe = p => (p.nfcSerie
    ? `📶 <strong>La chapita</strong> prueba que el guardia estuvo ahí${p.lat != null
      ? `<br><span class="nota rojo">Además tiene ubicación GPS: si el punto está bajo techo, quítasela.</span>` : ''}`
    : verificacionTexto(p));
  const botonesUbicacion = p => {
    if (p.nfcSerie) return p.lat != null ? `<button class="btn btn-borde btn-chico" data-desubicar="${p.id}">Quitar 📍</button>` : '';
    return `
        <button class="btn btn-borde btn-chico" data-ubicar="${p.id}" data-modo="gps">📍 ${p.lat != null && p.verificacion !== 'anclaje' ? 'Volver a medir' : 'Fijar aquí'}</button>
        <button class="btn btn-borde btn-chico" data-ubicar="${p.id}" data-modo="anclaje">🏠 Fijar entrada</button>
        ${p.lat != null ? `<button class="btn btn-borde btn-chico" data-ajustar="${p.id}">Ajustar</button>` : ''}
        ${p.lat != null ? `<button class="btn btn-borde btn-chico" data-desubicar="${p.id}">Quitar 📍</button>` : ''}`;
  };
  const filas = puntosCache.map(p => `
    <tr>
      <td>${esc(p.nombre)}${chapitaTexto(p)}</td>
      <td><code>${esc(p.codigoCorto)}</code>${p.nfcSerie ? '<br><span class="nota">no sirve a mano: este punto se marca con la chapita</span>' : ''}</td>
      <td>${verificacionDe(p)}</td>
      <td>
        ${botonesUbicacion(p)}
        ${p.nfcSerie && !p.nfcBloqueada ? `<button class="btn btn-borde btn-chico" data-bloquear="${p.id}">🔒 Bloquear chapita</button>` : ''}
        <button class="btn btn-borde btn-chico" data-chapita="${p.id}">📶 ${p.nfcSerie ? 'Reemplazar chapita' : 'Grabar chapita'}</button>
        ${p.nfcSerie ? `<button class="btn btn-borde btn-chico" data-volver-qr="${p.id}">Volver a QR</button>` : ''}
        <button class="btn btn-borde btn-chico" data-renombrar="${p.id}">Renombrar</button>
        <button class="btn btn-peligro btn-chico" data-eliminar="${p.id}">Eliminar</button>
      </td>
    </tr>`).join('');
  $('tabla-puntos').innerHTML = `
    <table>
      <thead><tr><th>Punto</th><th>Código</th><th>Verificación de presencia</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
  for (const btn of $('tabla-puntos').querySelectorAll('[data-ubicar]')) {
    btn.addEventListener('click', () => {
      const punto = puntosCache.find(p => p.id === btn.dataset.ubicar);
      fijarUbicacion(punto, btn.dataset.modo === 'anclaje', btn);
    });
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-chapita]')) {
    btn.addEventListener('click', () => abrirGrabacion(puntosCache.find(p => p.id === btn.dataset.chapita)));
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-bloquear]')) {
    btn.addEventListener('click', () => abrirBloqueo(puntosCache.find(p => p.id === btn.dataset.bloquear)));
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-volver-qr]')) {
    btn.addEventListener('click', async () => {
      const punto = puntosCache.find(p => p.id === btn.dataset.volverQr);
      if (!confirm(`¿Volver "${punto.nombre}" a QR?\n\nLa chapita deja de valer y el punto se marca otra vez con el QR: `
        + 'reimprime la hoja de QR y pega su lámina.'
        + (punto.nfcBloqueada ? '' : '\n\nLa chapita queda libre: se puede grabar en otro punto o en otro condominio.'))) return;
      try {
        await api(`/api/admin/puntos/${punto.id}/chapita`, { metodo: 'DELETE' });
        aviso(`"${punto.nombre}" vuelve a marcarse con QR. Los guardias lo reciben al actualizar rondas.`);
        cargarPuntos();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-ajustar]')) {
    btn.addEventListener('click', async () => {
      const punto = puntosCache.find(p => p.id === btn.dataset.ajustar);
      const anclado = punto.verificacion === 'anclaje';
      const radio = prompt(
        anclado
          ? `Radio alrededor de la entrada de "${punto.nombre}", en metros.\n\nVacío = usar el valor por defecto (40 m).`
          : `Radio alrededor de "${punto.nombre}", en metros.\n\nVacío = usar el valor por defecto (20 m).`,
        punto.radioM || ''
      );
      if (radio === null) return;
      let ventana = null;
      if (anclado) {
        ventana = prompt(
          `¿Cuántos MINUTOS vale la señal tomada en la entrada de "${punto.nombre}"?\n\n`
          + 'Es el tiempo máximo entre pasar por la entrada y marcar el punto. '
          + 'Más bajo = control más estricto, pero más riesgo de rechazar marcas legítimas.\n\n'
          + 'Vacío = usar el valor por defecto (15 min).',
          punto.ventanaMin || ''
        );
        if (ventana === null) return;
      }
      try {
        const cuerpo = { radioM: radio.trim() === '' ? null : radio.trim() };
        if (anclado) cuerpo.ventanaMin = ventana.trim() === '' ? null : ventana.trim();
        await api(`/api/admin/puntos/${punto.id}`, { metodo: 'PUT', cuerpo });
        aviso('Umbrales actualizados. Los guardias los reciben al actualizar rondas.');
        cargarPuntos();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-desubicar]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Quitar la ubicación? Las marcas en este punto dejarán de verificarse por GPS.')) return;
      try {
        await api(`/api/admin/puntos/${btn.dataset.desubicar}`, { metodo: 'PUT', cuerpo: { quitarUbicacion: true } });
        cargarPuntos();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-renombrar]')) {
    btn.addEventListener('click', async () => {
      const punto = puntosCache.find(p => p.id === btn.dataset.renombrar);
      const nombre = prompt('Nuevo nombre del punto:', punto.nombre);
      if (!nombre) return;
      try {
        await api(`/api/admin/puntos/${punto.id}`, { metodo: 'PUT', cuerpo: { nombre } });
        cargarPuntos();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-puntos').querySelectorAll('[data-eliminar]')) {
    btn.addEventListener('click', async () => {
      const punto = puntosCache.find(p => p.id === btn.dataset.eliminar);
      if (!confirm(`¿Eliminar "${punto.nombre}"? También saldrá de las rondas que lo incluyan.`)) return;
      try {
        await api(`/api/admin/puntos/${punto.id}`, { metodo: 'DELETE' });
        cargarPuntos();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
}

// ---------- Guardias ----------

async function cargarCodigoRegistro() {
  try {
    const { codigo } = await api('/api/admin/registro');
    $('campo-codigo-registro').value = codigo || '';
    $('estado-codigo').textContent = codigo
      ? 'Código vigente. Compártelo solo con tus guardias.'
      : 'Aún no hay código: escribe uno (o genéralo) y guárdalo para permitir el autoservicio.';
  } catch { /* sesión caduca: render() ya redirige al login */ }
}

async function guardarCodigoRegistro(cuerpo, mensaje) {
  try {
    const { codigo } = await api('/api/admin/registro', { metodo: 'PUT', cuerpo });
    $('campo-codigo-registro').value = codigo;
    $('estado-codigo').textContent = 'Código vigente. Compártelo solo con tus guardias.';
    aviso(mensaje);
  } catch (err) { aviso(err.message, 'error'); }
}

async function cargarGuardias() {
  await cargarCodigoRegistro();
  const guardias = await api('/api/admin/guardias');
  if (!guardias.length) {
    $('tabla-guardias').innerHTML = '<p class="nota">Aún no hay guardias registrados.</p>';
    return;
  }
  const filas = guardias.map(g => `
    <tr>
      <td>${esc(g.nombre)}</td>
      <td><code>${esc(g.usuario)}</code></td>
      <td>${g.appVersion
        ? `${esc(g.appVersion)} ${g.appAlDia ? '✓' : '· desactualizada'}<br><span class="nota">visto ${esc(new Date(g.appVista).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</span>`
        : '<span class="nota">sin datos</span>'}</td>
      <td>
        <button class="btn btn-borde btn-chico" data-pin="${g.id}">Nuevo PIN</button>
        ${g.usuario === 'domingo_baranda'
          ? `<button class="btn btn-peligro btn-chico" data-borrar-rondas="${g.id}" data-nombre="${esc(g.nombre || g.usuario)}">Borrar rondas</button>`
          : ''}
        <button class="btn btn-peligro btn-chico" data-eliminar="${g.id}">Eliminar</button>
      </td>
    </tr>`).join('');
  $('tabla-guardias').innerHTML = `
    <table>
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Versión de la app</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
  for (const btn of $('tabla-guardias').querySelectorAll('[data-pin]')) {
    btn.addEventListener('click', async () => {
      const pin = prompt('Nuevo PIN (4 a 8 dígitos):');
      if (!pin) return;
      try {
        await api(`/api/admin/guardias/${btn.dataset.pin}`, { metodo: 'PUT', cuerpo: { pin } });
        aviso('PIN actualizado.');
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-guardias').querySelectorAll('[data-borrar-rondas]')) {
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Borrar TODAS las rondas e informes hechos por "${btn.dataset.nombre}"?\n\nNo se puede deshacer. El guardia sigue pudiendo entrar.`)) return;
      try {
        const r = await api(`/api/admin/guardias/${btn.dataset.borrarRondas}/ejecuciones`, { metodo: 'DELETE' });
        aviso(`${r.eliminadas} ronda(s) borrada(s).`);
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
  for (const btn of $('tabla-guardias').querySelectorAll('[data-eliminar]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este guardia? No podrá volver a entrar.\n\nSus rondas quedan en los informes como «Guardia eliminado», sin su nombre. Si tiene una ronda en curso, se cierra con lo que alcanzó a marcar.')) return;
      try {
        await api(`/api/admin/guardias/${btn.dataset.eliminar}`, { metodo: 'DELETE' });
        cargarGuardias();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
}

// ---------- Rondas ----------

async function cargarRondas() {
  puntosCache = await api('/api/admin/puntos');
  pintarEditorRonda();
  const rondas = await api('/api/admin/rondas');
  if (!rondas.length) {
    $('tabla-rondas').innerHTML = '<p class="nota">Aún no hay rondas definidas.</p>';
    return;
  }
  const nombrePunto = pid => (puntosCache.find(p => p.id === pid) || { nombre: '(eliminado)' }).nombre;
  const filas = rondas.map(r => `
    <tr>
      <td><strong>${esc(r.nombre)}</strong><br><span class="nota">${r.puntoIds.map(nombrePunto).map(esc).join(' → ')}</span></td>
      <td>${r.ordenEstricto ? 'Estricta' : 'Orden libre'}${r.duracionMaxMin ? ` · máx ${r.duracionMaxMin} min` : ''}${r.duracionMinMin ? ` · mín ${r.duracionMinMin} min` : ''}</td>
      <td>
        <button class="btn btn-borde btn-chico" data-editar="${r.id}">Editar</button>
        <button class="btn btn-peligro btn-chico" data-eliminar="${r.id}">Eliminar</button>
      </td>
    </tr>`).join('');
  $('tabla-rondas').innerHTML = `
    <table>
      <thead><tr><th>Ronda</th><th>Reglas</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
  for (const btn of $('tabla-rondas').querySelectorAll('[data-editar]')) {
    btn.addEventListener('click', () => {
      const r = rondas.find(x => x.id === btn.dataset.editar);
      rondaEnEdicion = r.id;
      $('ronda-nombre').value = r.nombre;
      $('ronda-estricta').checked = Boolean(r.ordenEstricto);
      $('ronda-duracion').value = r.duracionMaxMin || '';
      $('ronda-duracion-min').value = r.duracionMinMin || '';
      secuencia = [...r.puntoIds];
      pintarEditorRonda();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
  for (const btn of $('tabla-rondas').querySelectorAll('[data-eliminar]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta ronda? Los informes ya generados se conservan.')) return;
      try {
        await api(`/api/admin/rondas/${btn.dataset.eliminar}`, { metodo: 'DELETE' });
        cargarRondas();
      } catch (err) { aviso(err.message, 'error'); }
    });
  }
}

// Los puntos se escriben a mano: el atajo de "puntos ya creados" solo aparece
// cuando queda alguno del condominio fuera de la secuencia.
// Cambia de lugar el punto `i` de la secuencia: delta -1 lo sube, +1 lo baja.
// Fuera de los bordes no hace nada. Puro: devuelve la secuencia nueva.
// Mover un punto no toca su QR ni su chapita: están amarrados al punto, no a
// su posición en la ronda.
function moverEnSecuencia(lista, i, delta) {
  const j = i + delta;
  if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return lista;
  const nueva = [...lista];
  [nueva[i], nueva[j]] = [nueva[j], nueva[i]];
  return nueva;
}

function pintarEditorRonda() {
  const disponibles = $('puntos-disponibles');
  const restantes = puntosCache.filter(p => !secuencia.includes(p.id));
  disponibles.innerHTML = '';
  for (const p of restantes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-punto';
    btn.textContent = p.nombre;
    btn.addEventListener('click', () => { secuencia.push(p.id); pintarEditorRonda(); });
    disponibles.appendChild(btn);
  }
  $('puntos-ya-creados').classList.toggle('oculta', !restantes.length);
  const ol = $('secuencia');
  ol.innerHTML = '';
  secuencia.forEach((pid, i) => {
    const p = puntosCache.find(x => x.id === pid);
    const li = document.createElement('li');
    li.innerHTML = `${esc(p ? p.nombre : pid)}
      <button type="button" class="mover" data-delta="-1" title="Subir" aria-label="Subir ${esc(p ? p.nombre : '')}"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="mover" data-delta="1" title="Bajar" aria-label="Bajar ${esc(p ? p.nombre : '')}"${i === secuencia.length - 1 ? ' disabled' : ''}>↓</button>
      <button type="button" class="quitar" title="Quitar">✕</button>`;
    for (const btn of li.querySelectorAll('.mover')) {
      btn.addEventListener('click', () => { secuencia = moverEnSecuencia(secuencia, i, Number(btn.dataset.delta)); pintarEditorRonda(); });
    }
    li.querySelector('.quitar').addEventListener('click', () => { secuencia.splice(i, 1); pintarEditorRonda(); });
    ol.appendChild(li);
  });
  if (!secuencia.length) ol.innerHTML = '<li class="nota vacio">Vacía: escribe el primer punto a la izquierda.</li>';
  $('btn-guardar-ronda').textContent = rondaEnEdicion ? 'Guardar cambios' : 'Guardar ronda';
}

// ---------- Chapitas NFC (CU-28) ----------
//
// La chapita se graba en terreno, ya instalada (se lee y se escribe a través
// de la carcasa), con este panel abierto en Chrome de un Android con NFC:
//   1. leer la serie de fábrica (y avisar si ya tiene grabado otro punto)
//   2. escribir el texto del QR del punto (registro NDEF de texto)
//   3. volver a leerla para verificar que quedó bien
//   4. guardar la serie en el servidor: desde ahí el punto solo acepta ESTA chapita
// Si algo falla antes del paso 4 el punto queda como estaba. La chapita queda
// SIN bloquear: se prueba con la app del guardia y, cuando es la definitiva,
// "🔒 Bloquear chapita" la deja de solo lectura para siempre (abrirBloqueo),
// después de comprobar que es la registrada y que tiene el código del punto.

// El mismo texto que lleva el QR (payloadQR en lib/codigos.js).
function payloadDe(punto) {
  return `RQR:${punto.condominioId}:${punto.id}:${punto.codigoCorto}`;
}

// El enlace que va en la chapita junto al texto (v1.25.1). Si la chapita se
// acerca cuando la app del guardia no la está escuchando (cerrada, en segundo
// plano), Android abre este enlace —la app del guardia, o la app instalada—
// en vez de su pantalla de etiquetas («la pantalla en blanco»). Va PRIMERO:
// Android decide qué abrir mirando el primer registro. La app lee el registro
// de texto, esté donde esté, así que las chapitas grabadas antes (solo texto)
// siguen sirviendo, y la app de antes también lee las nuevas. El "#nfc" le
// dice a la app que la abrió una chapita.
function enlaceDeChapita() {
  return `${location.origin}/#nfc`;
}

// Lo que Android deja escribir en una NTAG213 (Ndef.getMaxSize()).
const CAPACIDAD_CHAPITA = 137;

// Bytes del mensaje NDEF con estos registros (registros cortos: < 256 bytes).
// URL: cabecera 3 + tipo "U" + 1 byte de prefijo ("https://" se abrevia) + el
// resto. Texto: cabecera 3 + tipo "T" + estado + idioma "es" + el texto.
function bytesChapita(enlace, texto) {
  const largo = t => new TextEncoder().encode(t).length;
  const urlB = enlace ? 3 + 1 + 1 + largo(enlace.replace(/^https?:\/\//, '')) : 0;
  return urlB + 3 + 1 + 1 + 2 + largo(texto);
}

// Los registros que se graban: enlace + texto si caben, si no solo el texto
// (como hasta la v1.25.0). El texto es lo que marca; el enlace es un resguardo.
function registrosChapita(payload, enlace = enlaceDeChapita()) {
  const texto = { recordType: 'text', lang: 'es', data: payload };
  if (bytesChapita(enlace, payload) > CAPACIDAD_CHAPITA) return [texto];
  return [{ recordType: 'url', data: enlace }, texto];
}

// Como normalizarSerie() de lib/codigos.js.
function normalizarSerie(texto) {
  const limpio = String(texto == null ? '' : texto).replace(/[\s:-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,20}$/.test(limpio) && limpio.length % 2 === 0 ? limpio : null;
}

function textoDeChapita(mensaje) {
  for (const registro of (mensaje && mensaje.records) || []) {
    if (registro.recordType !== 'text' || !registro.data) continue;
    try {
      return new TextDecoder(registro.encoding || 'utf-8').decode(registro.data);
    } catch { /* registro ilegible: se prueba el siguiente */ }
  }
  return null;
}

// Nombres de error de la especificación de Web NFC (ver textoErrorNfc en app.js).
function textoErrorNfc(err) {
  const nombre = err && err.name;
  if (nombre === 'NotAllowedError') return 'Chrome no tiene permiso para usar NFC en este sitio: toca el candado junto a la dirección → Permisos → NFC → Permitir, y vuelve a intentar.';
  if (nombre === 'NotReadableError') return 'El NFC del teléfono está apagado: actívalo en Ajustes (busca "NFC") y vuelve a intentar.';
  if (nombre === 'NotSupportedError') return 'Este teléfono no tiene NFC, o Chrome no puede usarlo. Hace falta un Android con NFC.';
  if (nombre === 'NetworkError') return 'Se perdió el contacto con la chapita a mitad de camino: mantén el teléfono quieto sobre ella y vuelve a intentar.';
  return `Falló la chapita${nombre ? ` (${nombre})` : ''}${err && err.message ? `: ${err.message}` : ''}. Vuelve a intentar.`;
}

// La próxima chapita que toque el teléfono. Una lectura fallida (se movió) no
// termina la espera: se avisa y se sigue esperando.
function proximaLectura(lector, signal, alFallar) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelado', 'AbortError')); return; }
    lector.onreading = evento => resolve(evento);
    lector.onreadingerror = () => alFallar && alFallar();
    signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), { once: true });
  });
}

function cerrarGrabacion() {
  if (grabacionNfc) grabacionNfc.abort();
  grabacionNfc = null;
  $('caja-chapita').classList.add('oculta');
}

function abrirGrabacion(punto) {
  if (!punto) return;
  cerrarGrabacion();
  const caja = $('caja-chapita');
  caja.classList.remove('oculta');
  // La caja va sobre la tabla: en un teléfono, el botón tocado queda muy abajo.
  if (caja.scrollIntoView) caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const bajoTecho = 'Si el punto está bajo techo, no le fijes ubicación GPS: la chapita ya prueba que el guardia estuvo ahí'
    + (punto.lat != null ? ' (este punto tiene ubicación fijada: si está bajo techo, quítasela con "Quitar 📍").' : '.');
  if (!('NDEFReader' in window)) {
    caja.innerHTML = `
      <strong>📶 Grabar chapita — ${esc(punto.nombre)}</strong>
      <p class="nota">Este navegador no puede grabar chapitas. Se hace en terreno, parado junto a la chapita ya instalada,
      desde <strong>Chrome en un teléfono Android con NFC</strong> (en iPhone y en computadores no se puede):
      abre este mismo panel (<code>/panel</code>) en ese teléfono, entra con tu cuenta, ve a Puntos y toca
      “📶 Grabar chapita” en este punto. La guía completa está en entrega/OPERACION.md.</p>
      <p class="nota">${esc(bajoTecho)}</p>
      <button type="button" class="btn btn-borde btn-chico" id="btn-cerrar-chapita">Cerrar</button>`;
    $('btn-cerrar-chapita').addEventListener('click', cerrarGrabacion);
    return;
  }
  caja.innerHTML = `
    <strong>📶 ${punto.nfcSerie ? 'Reemplazar' : 'Grabar'} chapita — ${esc(punto.nombre)}</strong>
    <p class="nota">Párate junto a la chapita ya instalada, con el NFC del teléfono encendido. Al tocar “Empezar”,
    acerca la parte trasera del teléfono a la chapita y no lo muevas hasta que el panel lo diga. La primera vez Chrome pide permiso para usar NFC.</p>
    ${punto.nfcBloqueada ? '<p class="nota rojo">La chapita actual de este punto está bloqueada y no se puede regrabar: para reemplazarla usa una chapita nueva.</p>' : ''}
    <p class="nota">La chapita queda grabada <strong>sin bloquear</strong>: se puede regrabar o usar en otro punto.
    Pruébala con la app del guardia y, cuando sea la definitiva, toca “🔒 Bloquear chapita” en este punto.</p>
    <p class="nota">${esc(bajoTecho)}</p>
    <p id="chapita-estado" class="nota"></p>
    <div class="fila-form">
      <button type="button" class="btn btn-principal" id="btn-empezar-chapita">Empezar</button>
      <button type="button" class="btn btn-borde" id="btn-cerrar-chapita">Cancelar</button>
    </div>`;
  $('btn-cerrar-chapita').addEventListener('click', cerrarGrabacion);
  // Web NFC exige un toque: la grabación arranca con "Empezar", nunca sola.
  $('btn-empezar-chapita').addEventListener('click', () => grabarChapita(punto));
}

// Final de una grabación o de un bloqueo que salió bien: "Empezar" desaparece
// (si quedara, otro toque volvería a arrancar el lector) y "Cancelar" pasa a
// "Cerrar".
function terminarCaja(texto, aviso = false) {
  const estadoEl = $('chapita-estado');
  estadoEl.textContent = texto;
  estadoEl.className = aviso ? 'nota rojo' : 'nota';
  $('btn-empezar-chapita').classList.add('oculta');
  $('btn-cerrar-chapita').textContent = 'Cerrar';
}

async function grabarChapita(punto) {
  if (grabacionNfc) grabacionNfc.abort();
  const control = new AbortController();
  grabacionNfc = control;
  const { signal } = control;
  const estadoEl = $('chapita-estado');
  const mostrar = (texto, tipo) => {
    estadoEl.textContent = texto;
    estadoEl.className = tipo === 'error' ? 'nota rojo' : 'nota';
  };
  // Mientras corre: solo si esta grabación sigue siendo la vigente.
  const pintar = (texto, tipo) => { if (grabacionNfc === control) mostrar(texto, tipo); };
  const empezar = $('btn-empezar-chapita');
  empezar.disabled = true;
  const payload = payloadDe(punto);
  const seMovio = () => pintar('No se pudo leer: mantén el teléfono quieto sobre la chapita.', 'error');
  try {
    const lector = new NDEFReader();
    await lector.scan({ signal });

    // 1. La serie, y lo que la chapita ya traía.
    pintar('Acerca la parte trasera del teléfono a la chapita…');
    const primera = await proximaLectura(lector, signal, seMovio);
    const serie = normalizarSerie(primera.serialNumber);
    if (!serie) throw new Error('El teléfono no entregó el número de serie de esta chapita: prueba con otra.');
    const otro = puntosCache.find(p => p.id !== punto.id && p.nfcSerie === serie);
    if (otro) throw new Error(`Esta chapita ya está registrada en "${otro.nombre}". Usa otra, o primero pasa ese punto a QR.`);
    const previo = textoDeChapita(primera.message);
    if (previo && previo !== payload && /^RQR:/i.test(previo)) {
      const idPrevio = previo.split(':')[2];
      const dueno = puntosCache.find(p => p.id === idPrevio);
      if (!confirm(`Esta chapita tiene grabado ${dueno ? `el punto "${dueno.nombre}"` : 'otro punto'}. ¿Grabarle "${punto.nombre}" encima?`)) {
        throw new DOMException('Cancelado', 'AbortError');
      }
    }

    // 2. Escribir.
    pintar('Grabando… no muevas el teléfono.');
    lector.onreading = null;
    const registros = registrosChapita(payload);
    await lector.write({ records: registros }, { signal, overwrite: true });

    // 3. Verificar: Android avisa una chapita cuando ENTRA al campo, así que hay
    //    que alejarla y volver a acercarla.
    pintar('Grabada. Para verificar: aleja el teléfono y vuelve a acercarlo a la chapita.');
    for (;;) {
      const lectura = await proximaLectura(lector, signal, seMovio);
      if (normalizarSerie(lectura.serialNumber) !== serie) {
        pintar('Esa es otra chapita: acerca la que estás grabando.', 'error');
        continue;
      }
      if (textoDeChapita(lectura.message) !== payload) {
        throw new Error('La verificación falló: la chapita no quedó con el texto del punto. Vuelve a intentar.');
      }
      break;
    }

    control.abort(); // se apaga el lector antes de hablar con el servidor

    // 4. Desde acá el punto solo acepta esta chapita.
    pintar('Guardando…');
    await api(`/api/admin/puntos/${punto.id}/chapita`, { metodo: 'PUT', cuerpo: { serie } });
    grabacionNfc = null;
    terminarCaja(`✅ Chapita grabada (sin bloquear). "${punto.nombre}" ahora se marca con la chapita; los guardias lo reciben al actualizar rondas. `
      + (registros.length > 1
        ? 'Lleva el enlace a la app: si se acerca con la app cerrada, abre la app. '
        : 'No cupo el enlace a la app (dirección muy larga): lleva solo el código, como antes. ')
      + 'Pruébala y, cuando sea la definitiva, toca “🔒 Bloquear chapita”.');
    cargarPuntos();
  } catch (err) {
    if (grabacionNfc !== control) return; // cancelada o reemplazada: nadie mira
    control.abort();
    grabacionNfc = null;
    empezar.disabled = false;
    empezar.textContent = 'Reintentar';
    // `mostrar`, no `pintar`: la grabación ya se soltó (grabacionNfc = null).
    if (err && err.name === 'AbortError') { mostrar('Cancelado. El punto quedó como estaba.'); return; }
    mostrar(err instanceof DOMException ? textoErrorNfc(err) : err.message, 'error');
  }
}

// "🔒 Bloquear chapita": deja la chapita de solo lectura para siempre. Antes
// la lee y comprueba que sea la registrada para el punto (la serie) y que
// tenga su código (el texto): bloquear una chapita equivocada o mal grabada la
// dejaría inservible para siempre.
function abrirBloqueo(punto) {
  if (!punto) return;
  cerrarGrabacion();
  const caja = $('caja-chapita');
  caja.classList.remove('oculta');
  if (caja.scrollIntoView) caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!('NDEFReader' in window)) {
    caja.innerHTML = `
      <strong>🔒 Bloquear chapita — ${esc(punto.nombre)}</strong>
      <p class="nota">Se bloquea en terreno, junto a la chapita, desde <strong>Chrome en un teléfono Android con NFC</strong>:
      abre este panel en ese teléfono, ve a Puntos y toca “🔒 Bloquear chapita” en este punto.</p>
      <button type="button" class="btn btn-borde btn-chico" id="btn-cerrar-chapita">Cerrar</button>`;
    $('btn-cerrar-chapita').addEventListener('click', cerrarGrabacion);
    return;
  }
  caja.innerHTML = `
    <strong>🔒 Bloquear chapita — ${esc(punto.nombre)}</strong>
    <p class="nota">Bloquearla impide que alguien le grabe otro punto encima. <strong>Es para siempre</strong>:
    después no se puede regrabar, ni usar en otro punto, ni en otro condominio. Hazlo cuando ya la probaste con la app del guardia.</p>
    <p class="nota">Antes de bloquear, el panel comprueba que sea la chapita de este punto y que tenga su código.</p>
    <p id="chapita-estado" class="nota"></p>
    <div class="fila-form">
      <button type="button" class="btn btn-peligro" id="btn-empezar-chapita">Sí, bloquear para siempre</button>
      <button type="button" class="btn btn-borde" id="btn-cerrar-chapita">Cancelar</button>
    </div>`;
  $('btn-cerrar-chapita').addEventListener('click', cerrarGrabacion);
  $('btn-empezar-chapita').addEventListener('click', () => bloquearChapita(punto));
}

async function bloquearChapita(punto) {
  if (grabacionNfc) grabacionNfc.abort();
  const control = new AbortController();
  grabacionNfc = control;
  const { signal } = control;
  const estadoEl = $('chapita-estado');
  const mostrar = (texto, tipo) => {
    estadoEl.textContent = texto;
    estadoEl.className = tipo === 'error' ? 'nota rojo' : 'nota';
  };
  // Mientras corre: solo si esta grabación sigue siendo la vigente.
  const pintar = (texto, tipo) => { if (grabacionNfc === control) mostrar(texto, tipo); };
  const empezar = $('btn-empezar-chapita');
  empezar.disabled = true;
  try {
    const lector = new NDEFReader();
    if (typeof lector.makeReadOnly !== 'function') {
      throw new Error('Este Chrome es antiguo y no puede bloquear chapitas: actualízalo y vuelve a intentar.');
    }
    await lector.scan({ signal });
    pintar('Acerca la parte trasera del teléfono a la chapita…');
    const lectura = await proximaLectura(lector, signal, () => pintar('No se pudo leer: mantén el teléfono quieto sobre la chapita.', 'error'));
    const serie = normalizarSerie(lectura.serialNumber);
    if (serie !== punto.nfcSerie) {
      throw new Error(`Esta no es la chapita registrada para "${punto.nombre}": no se bloqueó. Acerca la chapita de este punto.`);
    }
    if (textoDeChapita(lectura.message) !== payloadDe(punto)) {
      throw new Error(`La chapita no tiene el código de "${punto.nombre}": no se bloqueó. Vuelve a grabarla ("Reemplazar chapita") y después bloquéala.`);
    }
    pintar('Es la chapita correcta. Bloqueando… mantén el teléfono sobre ella.');
    lector.onreading = null;
    await lector.makeReadOnly({ signal });
    control.abort();
    pintar('Guardando…');
    await api(`/api/admin/puntos/${punto.id}/chapita/bloqueo`, { metodo: 'PUT', cuerpo: { serie } });
    grabacionNfc = null;
    terminarCaja(`🔒 Chapita de "${punto.nombre}" bloqueada. Ya nadie la puede reescribir.`);
    cargarPuntos();
  } catch (err) {
    if (grabacionNfc !== control) return;
    control.abort();
    grabacionNfc = null;
    empezar.disabled = false;
    empezar.textContent = 'Reintentar';
    if (err && err.name === 'AbortError') { mostrar('Cancelado. La chapita no se bloqueó.'); return; }
    mostrar(err instanceof DOMException ? textoErrorNfc(err) : err.message, 'error');
  }
}

// Escribir un punto a mano: si el nombre ya existe en el condominio se reutiliza
// ese punto (para no duplicar QR); si no, se crea y queda listo para imprimir.
async function agregarPuntoAMano() {
  const campo = $('ronda-punto-nuevo');
  const nombre = campo.value.trim();
  if (!nombre) return;
  const igual = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }) === 0;
  const existente = puntosCache.find(p => igual(p.nombre, nombre));
  try {
    let punto = existente;
    if (!punto) {
      punto = await api('/api/admin/puntos', { metodo: 'POST', cuerpo: { nombre } });
      puntosCache.push(punto);
      aviso(`Punto "${punto.nombre}" creado. Reimprime la hoja de QR para pegarlo.`);
    }
    if (secuencia.includes(punto.id)) aviso(`"${punto.nombre}" ya está en la secuencia.`, 'error');
    else secuencia.push(punto.id);
    campo.value = '';
    pintarEditorRonda();
  } catch (err) { aviso(err.message, 'error'); }
  campo.focus();
}

async function guardarRonda() {
  const cuerpo = {
    nombre: $('ronda-nombre').value,
    puntoIds: secuencia,
    ordenEstricto: $('ronda-estricta').checked,
    duracionMaxMin: $('ronda-duracion').value ? Number($('ronda-duracion').value) : null,
    duracionMinMin: $('ronda-duracion-min').value ? Number($('ronda-duracion-min').value) : null
  };
  try {
    if (rondaEnEdicion) await api(`/api/admin/rondas/${rondaEnEdicion}`, { metodo: 'PUT', cuerpo });
    else await api('/api/admin/rondas', { metodo: 'POST', cuerpo });
    aviso('Ronda guardada. Los guardias la verán al actualizar sus rondas.');
    limpiarEditorRonda();
    cargarRondas();
  } catch (err) { aviso(err.message, 'error'); }
}

function limpiarEditorRonda() {
  rondaEnEdicion = null;
  secuencia = [];
  $('ronda-nombre').value = '';
  $('ronda-punto-nuevo').value = '';
  $('ronda-estricta').checked = false;
  $('ronda-duracion').value = '';
  $('ronda-duracion-min').value = '';
  pintarEditorRonda();
}

// ---------- Avisos push (rondas incompletas) en este dispositivo ----------

function base64AUint8(base64) {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const crudo = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(crudo, c => c.charCodeAt(0));
}

function pushSoportado() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function suscripcionPushActual() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pintarEstadoPush() {
  const btn = $('btn-push');
  const estado = $('estado-push');
  if (!pushSoportado()) {
    btn.disabled = true;
    estado.textContent = 'Este navegador no soporta notificaciones. En iPhone: instala el panel en la pantalla de inicio y ábrelo desde ahí.';
    return;
  }
  try {
    const sub = await suscripcionPushActual();
    if (sub) {
      btn.textContent = '🔕 Desactivar avisos en este teléfono';
      estado.textContent = 'Avisos activados: si una ronda queda incompleta, te llegará una notificación aquí.';
    } else {
      btn.textContent = '🔔 Activar avisos en este teléfono';
      estado.textContent = Notification.permission === 'denied'
        ? 'Las notificaciones están bloqueadas para este sitio. Actívalas en la configuración del navegador y recarga.'
        : '';
    }
    btn.disabled = Notification.permission === 'denied';
  } catch {
    btn.disabled = true;
    estado.textContent = 'No se pudo consultar el estado de las notificaciones en este navegador.';
  }
}

async function alternarPush() {
  const btn = $('btn-push');
  btn.disabled = true;
  try {
    const sub = await suscripcionPushActual();
    if (sub) {
      await api('/api/admin/push/suscribir', { metodo: 'DELETE', cuerpo: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      aviso('Avisos desactivados en este teléfono.');
    } else {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        aviso('No diste permiso de notificaciones.', 'error');
        return pintarEstadoPush();
      }
      const { clave } = await api('/api/admin/push/clave');
      const reg = await navigator.serviceWorker.ready;
      const nueva = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64AUint8(clave)
      });
      await api('/api/admin/push/suscribir', { metodo: 'POST', cuerpo: { suscripcion: nueva.toJSON() } });
      aviso('Listo: cada ronda incompleta llegará como notificación a este teléfono.');
    }
  } catch (err) {
    aviso(err.message || 'No se pudo cambiar el estado de los avisos.', 'error');
  }
  pintarEstadoPush();
}

// ---------- Alarma de ronda (teléfono de la garita) ----------

function horaCorta(ts) {
  return new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function pintarAlarma({ minutos, texto, telefonos, ultima, kioscos = [] }) {
  const campo = $('campo-alarma-ronda');
  // Un intervalo que no está en la lista (fijado por API) se agrega para no
  // mostrar otro distinto del que de verdad rige.
  if (![...campo.options].some(o => Number(o.value) === minutos)) {
    campo.add(new Option(texto, String(minutos)));
  }
  campo.value = String(minutos);
  const partes = [];
  partes.push(minutos ? `Activa: suena cada ${texto}.` : 'Apagada: no se envían alarmas.');
  partes.push(telefonos
    ? `${telefonos} teléfono${telefonos === 1 ? '' : 's'} con la alarma activada.`
    : 'Ningún teléfono la tiene activada todavía: actívala desde la app del guardia.');
  // `ultima` cuenta los teléfonos con notificación; los de Fully van en su lista.
  if (ultima && ultima.ts) {
    partes.push(ultima.total || !kioscos.length
      ? `Última: ${horaCorta(ultima.ts)} (${ultima.ok} de ${ultima.total} teléfonos con notificación).`
      : `Última: ${horaCorta(ultima.ts)} (cómo sonó en cada teléfono con Fully, abajo).`);
  }
  $('estado-alarma').textContent = partes.join(' ');
  $('alarma-kioscos').innerHTML = kioscos.map(k => `<li>${esc(textoKiosco(k))}</li>`).join('');
}

// Un teléfono con Fully Kiosk: si puede sonar ahora y cuándo sonó por última vez.
function textoKiosco({ nombre, guardia, visto, conectado, interfaz, sonada }) {
  const quien = `«${nombre}» (Fully${guardia ? `, activada por ${guardia}` : ''})`;
  // La hora va entre paréntesis: en es-CL termina en "p. m." y un punto después queda doble.
  if (!conectado) {
    return `${quien}: ahí la alarma no puede sonar, está sin conexión desde ${horaCorta(visto)} (pantalla apagada, sin señal o la app cerrada).`;
  }
  if (!interfaz) return `${quien}: conectado, pero con la interfaz JavaScript de Fully apagada. Así la alarma no puede sonar.`;
  return `${quien}: conectado${sonada ? ` (la última alarma sonó el ${horaCorta(sonada)})` : ''}.`;
}

async function cargarAlarma() {
  try {
    pintarAlarma(await api('/api/admin/alarma-ronda'));
  } catch (err) {
    $('estado-alarma').textContent = err.message;
  }
}

async function guardarAlarma() {
  try {
    const estado = await api('/api/admin/alarma-ronda', {
      metodo: 'PUT', cuerpo: { minutos: Number($('campo-alarma-ronda').value) }
    });
    pintarAlarma(estado);
    aviso(estado.minutos ? `Alarma cada ${estado.texto}.` : 'Alarma de ronda apagada.');
  } catch (err) {
    aviso(err.message, 'error');
  }
}

async function probarAlarma() {
  try {
    const r = await api('/api/admin/alarma-ronda/prueba', { metodo: 'POST' });
    const partes = [];
    if (r.total) partes.push(`Alarma enviada a ${r.ok} de ${r.total} teléfonos con notificación.`);
    const k = r.kioscos || { total: 0, conectados: 0 };
    if (k.total) {
      partes.push(k.conectados
        ? `En ${k.conectados === 1 ? 'el teléfono' : `los ${k.conectados} teléfonos`} con Fully suena en menos de un minuto.`
        : 'Ningún teléfono con Fully está conectado ahora: suena si se conecta en los próximos 10 minutos.');
    }
    aviso(partes.join(' '));
    cargarAlarma();
  } catch (err) {
    aviso(err.message, 'error');
  }
}

// ---------- Avisos ----------

// Correos del informe semanal de este condominio.
async function cargarCorreosInforme() {
  try {
    const { correos, respaldo, envioActivo } = await api('/api/admin/correos-informe');
    $('campo-correos-informe').value = (correos || []).join(', ');
    let estado;
    if (!envioActivo) estado = 'El envío por correo todavía no está activo en el servidor: avísale a la fábrica.';
    else if (correos && correos.length) estado = `Listo: el informe sale cada lunes a ${correos.join(' y ')}.`;
    else if (respaldo) estado = `Sin correo propio, el informe va al respaldo del servidor (${respaldo}). Escribe el tuyo acá.`;
    else estado = 'Sin correo cargado no se manda nada. Escribe el tuyo y guárdalo.';
    $('estado-correos').textContent = estado;
  } catch { /* sesión caduca: render() ya redirige al login */ }
}

async function guardarCorreosInforme() {
  try {
    const { correos } = await api('/api/admin/correos-informe', {
      metodo: 'PUT', cuerpo: { correos: $('campo-correos-informe').value }
    });
    aviso(correos.length ? 'Correos guardados. El próximo lunes sale el informe.' : 'Correos borrados: no se enviará el informe semanal.');
    cargarCorreosInforme();
  } catch (err) { aviso(err.message, 'error'); }
}

async function enviarInformeAhora() {
  const btn = $('btn-enviar-informe');
  const textoOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const { to, rango } = await api('/api/admin/informe-semanal/enviar', { metodo: 'POST', cuerpo: {} });
    aviso(`Enviado a ${to} (${rango}). Revisa la bandeja, y también el correo no deseado.`);
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = textoOriginal;
  }
}

async function cargarAvisos() {
  pintarEstadoPush();
  cargarAlarma();
  await cargarCorreosInforme();
  const avisos = await api('/api/admin/notificaciones');
  if (!avisos.length) {
    $('lista-avisos').innerHTML = '<p class="nota">Todavía no hay avisos. Se generan al cerrar cada ronda.</p>';
    return;
  }
  $('lista-avisos').innerHTML = avisos.map(n => `
    <div class="aviso-tarjeta">
      <div class="nota">${fecha(n.ts)} · vía ${n.medio}${n.error ? ` · <span class="rojo">error: ${esc(n.error)}</span>` : ''}</div>
      <pre>${esc(n.texto)}</pre>
    </div>`).join('');
}

// ---------- Selector de condominio ----------

// Carga los condominios en el selector de la barra. Si el guardado ya no existe
// (lo borraron desde la fábrica, o es de una sesión vieja de cuando cualquier
// admin veía todos), se cae al que diga el servidor.
//
// Solo la cuenta de acceso total recibe más de uno. Con uno solo el selector
// no sirve para nada: se esconde y queda el nombre del condominio.
async function cargarSelectorCondominios() {
  const sel = $('selector-condominio');
  const fijo = $('nombre-condominio');
  const mostrarFijo = nombre => {
    fijo.textContent = nombre || '—';
    fijo.classList.remove('oculta');
    sel.classList.add('oculta');
  };
  let datos;
  try {
    datos = await api('/api/admin/condominios');
  } catch {
    // Un 401 deja `sesion = null` y render() ya mostró el login.
    if (!sesion) return;
    mostrarFijo(sesion.condominio && sesion.condominio.nombre);
    return;
  }
  const lista = datos.condominios || [];
  sel.innerHTML = lista.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('');
  const elegido = lista.some(c => c.id === condominioActivo())
    ? condominioActivo()
    : (datos.activo || (lista[0] && lista[0].id));
  sel.value = elegido;
  const nombre = (lista.find(c => c.id === elegido) || {}).nombre || '';
  if (lista.length > 1) {
    sel.classList.remove('oculta');
    fijo.classList.add('oculta');
  } else {
    mostrarFijo(nombre);
  }
  sesion.condominioActivo = { id: elegido, nombre };
  guardarSesion();
}

// Cambiar de condominio recarga la pestaña en la que está: todo lo que se ve
// —informes, puntos, guardias, rondas, avisos— es de un condominio a la vez.
function cambiarCondominio() {
  const sel = $('selector-condominio');
  sesion.condominioActivo = {
    id: sel.value,
    nombre: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : ''
  };
  guardarSesion();
  limpiarEditorRonda();
  const activa = document.querySelector('.pestana.activa');
  mostrarTab(activa ? activa.dataset.tab : 'informes');
  aviso(`Trabajando en ${sesion.condominioActivo.nombre}.`);
}

// ---------- Render y arranque ----------

function render() {
  if (!sesion) {
    $('vista-login').classList.remove('oculta');
    $('vista-panel').classList.add('oculta');
    return;
  }
  $('vista-login').classList.add('oculta');
  $('vista-panel').classList.remove('oculta');
  // Si la sesión se cayó en el selector ya está el login: pedir los informes sin
  // token solo daría otro 401.
  cargarSelectorCondominios().finally(() => sesion && mostrarTab('informes'));
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-login').addEventListener('click', entrar);
  $('campo-pin').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
  $('btn-salir').addEventListener('click', salir);
  $('selector-condominio').addEventListener('change', cambiarCondominio);
  for (const p of document.querySelectorAll('.pestana')) {
    p.addEventListener('click', () => mostrarTab(p.dataset.tab));
  }
  $('form-punto').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const medio = $('punto-medio').value;
      const punto = await api('/api/admin/puntos', { metodo: 'POST', cuerpo: { nombre: $('punto-nombre').value, medio } });
      $('punto-nombre').value = '';
      await cargarPuntos();
      if (medio === 'nfc') {
        aviso('Punto creado. Ve al lugar y aprieta 📶 Grabar chapita.');
        abrirGrabacion(puntosCache.find(p => p.id === punto.id));
      } else {
        aviso('Punto creado. Ya aparece en 🖨️ Imprimir hoja de QR.');
      }
    } catch (err) { aviso(err.message, 'error'); }
  });
  $('form-guardia').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/admin/guardias', {
        metodo: 'POST',
        cuerpo: { usuario: $('guardia-usuario').value, nombre: $('guardia-nombre').value, pin: $('guardia-pin').value }
      });
      $('guardia-usuario').value = $('guardia-nombre').value = $('guardia-pin').value = '';
      aviso('Guardia creado.');
      cargarGuardias();
    } catch (err) { aviso(err.message, 'error'); }
  });
  $('btn-guardar-codigo').addEventListener('click', () =>
    guardarCodigoRegistro({ codigo: $('campo-codigo-registro').value }, 'Código guardado. Entrégaselo a tus guardias.'));
  $('btn-generar-codigo').addEventListener('click', () =>
    guardarCodigoRegistro({ generar: true }, 'Código nuevo generado. El anterior ya no sirve.'));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Instalación del panel como app propia (Chrome/Edge disparan
  // beforeinstallprompt; en iPhone/iPad se agrega a mano desde Compartir).
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    promptInstalacion = e;
    $('btn-instalar').classList.remove('oculta');
  });
  window.addEventListener('appinstalled', () => {
    promptInstalacion = null;
    $('btn-instalar').classList.add('oculta');
    aviso('Panel instalado: ya lo tienes como aplicación propia.');
  });
  $('btn-instalar').addEventListener('click', async () => {
    if (!promptInstalacion) return;
    promptInstalacion.prompt();
    await promptInstalacion.userChoice.catch(() => {});
    promptInstalacion = null;
    $('btn-instalar').classList.add('oculta');
  });
  const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const yaInstalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (esIos && !yaInstalado) $('nota-instalar-ios').classList.remove('oculta');

  $('btn-push').addEventListener('click', alternarPush);
  $('btn-informe-semanal').addEventListener('click', descargarInformeSemanal);
  $('form-punto-ronda').addEventListener('submit', e => { e.preventDefault(); agregarPuntoAMano(); });
  $('btn-guardar-ronda').addEventListener('click', guardarRonda);
  $('btn-limpiar-ronda').addEventListener('click', limpiarEditorRonda);
  $('btn-guardar-correos').addEventListener('click', guardarCorreosInforme);
  $('btn-enviar-informe').addEventListener('click', enviarInformeAhora);
  $('btn-guardar-alarma').addEventListener('click', guardarAlarma);
  $('btn-probar-alarma').addEventListener('click', probarAlarma);
  render();
});
