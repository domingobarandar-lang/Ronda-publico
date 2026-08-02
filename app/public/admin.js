// Panel del administrador — app aparte de la del guardia: manifiesto, ícono y
// sesión propios. Se instala/marca en el equipo del administrador (/panel).
'use strict';

const CLAVE_ADMIN = 'rondasqr-admin';
let sesion = cargarSesion();
let secuencia = [];        // puntoIds elegidos para la ronda en edición
let puntosCache = [];
let rondaEnEdicion = null; // id de la ronda que se está editando
let promptInstalacion = null; // evento beforeinstallprompt capturado (Chrome/Edge)

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
  ({ informes: cargarInformes, puntos: cargarPuntos, guardias: cargarGuardias, rondas: cargarRondas, avisos: cargarAvisos })[nombre]();
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
  $('tabla-informes').innerHTML = `
    <table>
      <thead><tr><th>Inicio</th><th>Ronda</th><th>Guardia</th><th>Puntos</th><th>Estado</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
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

async function cargarPuntos() {
  puntosCache = await api('/api/admin/puntos');
  if (!puntosCache.length) {
    $('tabla-puntos').innerHTML = '<p class="nota">Aún no hay puntos. Agrega el primero arriba.</p>';
    return;
  }
  // Tres estados posibles de verificación por punto (CU-19):
  //   sin ubicación → no se verifica
  //   exacta        → hay que estar sobre el punto (20 m)
  //   por entrada   → punto bajo techo: basta haber pasado por la entrada
  const verificacionTexto = p => {
    if (p.lat == null) return '<span class="nota">sin verificar</span>';
    const mapa = `<a href="https://maps.google.com/?q=${p.lat},${p.lon}" target="_blank">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</a>`;
    return p.verificacion === 'anclaje'
      ? `🏠 <strong>Por entrada</strong> · ${p.radioM || 40} m · ${p.ventanaMin || 15} min<br><span class="nota">${mapa}</span>`
      : `📍 <strong>Exacta</strong> · ${p.radioM || 20} m<br><span class="nota">${mapa}</span>`;
  };
  const filas = puntosCache.map(p => `
    <tr>
      <td>${esc(p.nombre)}</td>
      <td><code>${esc(p.codigoCorto)}</code></td>
      <td>${verificacionTexto(p)}</td>
      <td>
        <button class="btn btn-borde btn-chico" data-ubicar="${p.id}" data-modo="gps">📍 Fijar aquí</button>
        <button class="btn btn-borde btn-chico" data-ubicar="${p.id}" data-modo="anclaje">🏠 Fijar entrada</button>
        ${p.lat != null ? `<button class="btn btn-borde btn-chico" data-ajustar="${p.id}">Ajustar</button>` : ''}
        ${p.lat != null ? `<button class="btn btn-borde btn-chico" data-desubicar="${p.id}">Quitar 📍</button>` : ''}
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
      const anclaje = btn.dataset.modo === 'anclaje';
      if (!('geolocation' in navigator)) return aviso('Este navegador no entrega ubicación.', 'error');
      const pregunta = anclaje
        ? `Fijar la ENTRADA de "${punto.nombre}" donde estás parado AHORA.\n\n`
          + 'Úsalo para puntos bajo techo (subterráneos, salas de calderas, interiores) donde el GPS no llega.\n\n'
          + 'Párate en el último lugar del recorrido donde el teléfono TODAVÍA tiene señal — la puerta del recinto o la rampa de bajada. '
          + 'El guardia podrá marcar el punto si pasó por acá en los últimos minutos.\n\n¿Continuar?'
        : `Fijar la ubicación EXACTA de "${punto.nombre}" donde estás parado AHORA.\n\n`
          + 'Hazlo desde un teléfono, de pie junto al punto. El guardia solo podrá marcar estando encima.\n\n¿Continuar?';
      if (!confirm(pregunta)) return;
      aviso('Obteniendo ubicación…');
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          await api(`/api/admin/puntos/${punto.id}`, {
            metodo: 'PUT',
            cuerpo: {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              verificacion: anclaje ? 'anclaje' : 'gps'
            }
          });
          aviso(anclaje
            ? 'Entrada fijada: este punto se marca habiendo pasado por acá hace poco.'
            : 'Ubicación fijada: las marcas en este punto ahora se verifican por distancia.');
          cargarPuntos();
        } catch (err) { aviso(err.message, 'error'); }
      }, () => aviso('No se pudo obtener la ubicación (¿permiso denegado?).', 'error'),
        { enableHighAccuracy: true, timeout: 15000 });
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
      <td>
        <button class="btn btn-borde btn-chico" data-pin="${g.id}">Nuevo PIN</button>
        <button class="btn btn-peligro btn-chico" data-eliminar="${g.id}">Eliminar</button>
      </td>
    </tr>`).join('');
  $('tabla-guardias').innerHTML = `
    <table>
      <thead><tr><th>Nombre</th><th>Usuario</th><th></th></tr></thead>
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
  for (const btn of $('tabla-guardias').querySelectorAll('[data-eliminar]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este guardia? No podrá volver a entrar.')) return;
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
    li.innerHTML = `${esc(p ? p.nombre : pid)} <button type="button" class="quitar" title="Quitar">✕</button>`;
    li.querySelector('.quitar').addEventListener('click', () => { secuencia.splice(i, 1); pintarEditorRonda(); });
    ol.appendChild(li);
  });
  if (!secuencia.length) ol.innerHTML = '<li class="nota vacio">Vacía: escribe el primer punto a la izquierda.</li>';
  $('btn-guardar-ronda').textContent = rondaEnEdicion ? 'Guardar cambios' : 'Guardar ronda';
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
// (lo borraron desde la fábrica), se cae al primero de la lista.
async function cargarSelectorCondominios() {
  const sel = $('selector-condominio');
  let datos;
  try {
    datos = await api('/api/admin/condominios');
  } catch {
    sel.innerHTML = `<option>${esc((sesion.condominio && sesion.condominio.nombre) || '—')}</option>`;
    return;
  }
  const lista = datos.condominios || [];
  sel.innerHTML = lista.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('');
  const elegido = lista.some(c => c.id === condominioActivo())
    ? condominioActivo()
    : (datos.activo || (lista[0] && lista[0].id));
  sel.value = elegido;
  const nombre = (lista.find(c => c.id === elegido) || {}).nombre || '';
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
  cargarSelectorCondominios().finally(() => mostrarTab('informes'));
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
      await api('/api/admin/puntos', { metodo: 'POST', cuerpo: { nombre: $('punto-nombre').value } });
      $('punto-nombre').value = '';
      aviso('Punto creado. Reimprime la hoja de QR para pegarlo.');
      cargarPuntos();
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
  $('btn-guardar-chatid').addEventListener('click', async () => {
    try {
      await api('/api/admin/telegram', { metodo: 'PUT', cuerpo: { chatId: $('campo-chatid').value } });
      aviso('Guardado. Si el servidor tiene el bot configurado, los próximos informes llegarán por Telegram.');
    } catch (err) { aviso(err.message, 'error'); }
  });
  render();
});
