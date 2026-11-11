// Fábrica: alta de condominios y de sus cuentas de administrador.
// Pantalla de la operación, aparte del panel del administrador: acá se crean los
// condominios (lo único que no se puede hacer desde el panel) y se cargan los
// correos del informe semanal de cada uno. Desde la v1.26 cada condominio
// muestra además la salud del producto de la última semana (lib/salud.js) y sus
// errores de Sentry (lib/sentry-lectura.js).
'use strict';

const $ = id => document.getElementById(id);
// La clave conserva el nombre viejo de la app (Rondas QR) a propósito: es donde
// cada teléfono ya tiene guardada la sesión de la fábrica. Renombrarla dejaría
// a todos fuera.
const CLAVE_SESION = 'rondas-qr-fabrica';

let sesion = null;
let avisoTimer;

try { sesion = JSON.parse(localStorage.getItem(CLAVE_SESION) || 'null'); } catch { sesion = null; }

function guardarSesion() {
  if (sesion) localStorage.setItem(CLAVE_SESION, JSON.stringify(sesion));
  else localStorage.removeItem(CLAVE_SESION);
}

function aviso(texto, tipo = 'ok') {
  const el = $('aviso');
  el.textContent = texto;
  el.className = `aviso aviso-${tipo}`;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.add('oculta'), 4000);
}

function esc(texto) {
  const div = document.createElement('div');
  div.textContent = String(texto == null ? '' : texto);
  return div.innerHTML;
}

function fecha(ts) {
  return ts ? new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

async function api(ruta, opciones = {}) {
  const cabeceras = { 'content-type': 'application/json' };
  if (sesion) cabeceras.authorization = `Bearer ${sesion.token}`;
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

// ---------- Login ----------

async function entrar() {
  $('error-login').classList.add('oculta');
  try {
    const r = await api('/api/login', {
      metodo: 'POST',
      cuerpo: { usuario: $('campo-usuario').value, pin: $('campo-pin').value }
    });
    if (r.rol !== 'fabrica') {
      $('error-login').innerHTML = 'Esta cuenta no es de la fábrica. Los administradores entran por <a href="/panel">el panel</a>.';
      $('error-login').classList.remove('oculta');
      return;
    }
    sesion = r;
    guardarSesion();
    $('campo-pin').value = '';
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
  render();
}

// ---------- Alta ----------

// PIN de administrador al azar: 10 caracteres alfanuméricos con al menos una
// letra y un dígito (la regla del servidor). Sin 0/O/1/l/I, que se confunden
// al dictarlo por teléfono.
const LETRAS_PIN = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITOS_PIN = '23456789';
function pinAlAzar() {
  const todos = LETRAS_PIN + DIGITOS_PIN;
  for (;;) {
    const d = new Uint32Array(10);
    crypto.getRandomValues(d);
    const pin = [...d].map(n => todos[n % todos.length]).join('');
    if (/[A-Za-z]/.test(pin) && /\d/.test(pin)) return pin;
  }
}

async function darDeAlta() {
  const btn = $('btn-alta');
  btn.disabled = true;
  try {
    const r = await api('/api/fabrica/condominios', {
      metodo: 'POST',
      cuerpo: {
        nombre: $('alta-nombre').value,
        // Van solo si se abrió el bloque opcional: vacíos = sin cuenta de panel.
        adminUsuario: $('alta-usuario').value,
        adminPin: $('alta-pin').value,
        correos: $('alta-correos').value
      }
    });
    // Si se creó cuenta, el PIN se muestra UNA vez: no se puede volver a leer
    // (queda hasheado). Si se pierde, se cambia desde la ficha del condominio.
    const credenciales = r.admin
      ? `Panel: ${location.origin}/panel
Usuario: ${esc(r.admin.usuario)}
PIN: ${esc(r.pin)}
`
      : '';
    $('alta-resultado').className = 'caja-config';
    $('alta-resultado').innerHTML = `
      <h3>✅ ${esc(r.condominio.nombre)} creado</h3>
      <p class="nota">${r.admin
        ? 'Anota esto ahora: el PIN no se puede volver a ver.'
        : 'Ya aparece en el selector de tu panel para armarle los puntos y la ronda.'}</p>
      <pre id="alta-credenciales">${credenciales}Código de registro para los guardias: ${esc(r.condominio.codigoRegistro)}
Informe semanal a: ${r.condominio.correosInforme.join(', ') || '(sin correo todavía)'}</pre>
      <button id="btn-copiar" class="btn btn-borde btn-chico" type="button">📋 Copiar</button>`;
    $('btn-copiar').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('alta-credenciales').textContent);
        aviso('Credenciales copiadas.');
      } catch { aviso('Cópialas a mano: el navegador no dio permiso.', 'error'); }
    });
    $('alta-nombre').value = $('alta-usuario').value = $('alta-pin').value = $('alta-correos').value = '';
    aviso(`${r.condominio.nombre} creado.`);
    cargar();
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Lista de condominios ----------

const rondas = n => (n === 1 ? '1 ronda' : `${n} rondas`);
const cifra = (texto, chip) => (chip ? `<span class="chip ${chip}">${texto}</span>` : texto);
const fila = (etiqueta, valor, sangria) => `<tr><td${sangria ? ' style="padding-left:28px"' : ''}>${etiqueta}</td><td>${valor}</td></tr>`;

// Cada causa de dificultad (lib/salud.js), con el texto que se muestra.
const CAUSAS = {
  app: [
    ['gps', '📍 <strong>GPS</strong>: sin señal, ubicación vieja o imprecisa'],
    ['sesion', 'Se le cortó la sesión a mitad de ronda'],
    ['telefono', 'El teléfono no terminó la ronda (la cerró el sistema con puntos sin marcar)'],
    ['chapita', 'La chapita no lee']
  ],
  usuario: [
    ['lejos', 'Lejos del punto, con buena señal de GPS'],
    ['medio', 'QR, chapita o código equivocado'],
    ['terminar', 'Marcó todos los puntos y no tocó «Terminar ronda»']
  ]
};

// Salud del producto: lo que falla sin ser un error de código. Dos tablas:
// cómo terminan las rondas, y las rondas con dificultades técnicas separadas en
// fallo de la aplicación y del usuario. El GPS va en rojo: es el fallo de la
// aplicación al que más hay que ponerle ojo.
function bloqueSalud(s) {
  if (!s) return '';
  const r = s.rondas;
  const d = s.dificultades;
  const titulo = `<p class="nota" style="margin-top:14px"><strong>Salud del producto · últimos ${s.dias} días</strong></p>`;
  if (!r.total) return `${titulo}<p class="nota">Sin rondas en los últimos ${s.dias} días.</p>`;

  const estados = [
    ['Completas', `${r.completas} · ${r.porcentaje.completas}%`],
    ['Incompletas', `${r.incompletas} · ${r.porcentaje.incompletas}%`],
    ['Con sospechas', `${r.sospechosas} · ${r.porcentaje.sospechosas}%`],
    ['Cerradas automáticamente', cifra(`${r.automaticas} · ${r.porcentaje.automaticas}%`, r.automaticas > 0 && 'chip-ambar')]
  ];
  const notasEstados = r.enCurso ? [`Además, ${r.enCurso === 1 ? '1 ronda en curso' : `${r.enCurso} rondas en curso`}.`] : [];

  const causa = (lado, [clave, etiqueta]) => {
    const n = d[lado].causas[clave];
    let valor = n ? rondas(n) : '—';
    if (clave === 'gps' && n) {
      valor = cifra(`${rondas(n)} · ${d.gps.porcentaje}%`, 'chip-roja')
        + ` <span class="nota">(${d.gps.rechazos === 1 ? '1 rechazo' : `${d.gps.rechazos} rechazos`})</span>`;
    }
    return fila(etiqueta, valor, true);
  };
  const lado = (nombre, clave) => `<tr><th>${nombre}</th><th>${rondas(d[clave].rondas)} · ${d[clave].porcentaje}%</th></tr>`
    + CAUSAS[clave].map(c => causa(clave, c)).join('');

  const notas = [`Sobre ${rondas(r.total)} de la semana. Una ronda puede tener más de una causa.`];
  // La sesión cortada se anota desde la v1.26: antes de eso, un cero no quiere
  // decir que no pasara.
  if (s.registroDesde && Date.parse(s.registroDesde) > Date.parse(s.desde)) {
    notas.push(`La sesión cortada se cuenta desde el ${esc(fecha(s.registroDesde))} (antes no se anotaba).`);
  }
  const conNotas = lista => lista.map(n => `<p class="nota" style="margin-top:6px">${n}</p>`).join('');

  return `${titulo}
      <table>
        <thead><tr><th>Rondas cerradas</th><th>${r.cerradas}</th></tr></thead>
        <tbody>${estados.map(([etiqueta, valor]) => fila(etiqueta, valor)).join('')}</tbody>
      </table>
      ${conNotas(notasEstados)}
      <p class="nota" style="margin-top:14px"><strong>Rondas con dificultades técnicas: ${rondas(d.rondas)} · ${d.porcentaje}%</strong></p>
      <table>
        <tbody>${lado('Fallo de la aplicación o del teléfono', 'app')}${lado('Fallo del usuario', 'usuario')}</tbody>
      </table>
      ${conNotas(notas)}`;
}

// ---------- Errores técnicos (Sentry) ----------
// Llegan aparte de la lista (GET /api/fabrica/sentry): Sentry puede tardar o no
// estar conectado, y la lista no lo espera. Cada ficha trae un hueco
// [data-sentry] que se llena acá; los errores sin condominio van abajo.

function bloqueSentry(r, dias) {
  if (!r) return '';
  if (r.error) return `<p class="nota rojo">No se pudo leer Sentry: ${esc(r.error)}</p>`;
  if (!r.problemas) return `<p class="nota">Sin errores en los últimos ${dias} días.</p>`;
  const items = r.lista.map(p => {
    const titulo = p.enlace ? `<a href="${esc(p.enlace)}" target="_blank" rel="noopener">${esc(p.titulo)}</a>` : esc(p.titulo);
    const donde = p.donde ? ` <span class="nota">· ${esc(p.donde)}</span>` : '';
    return `<li>${titulo}${donde}<br><span class="nota">${p.eventos === 1 ? '1 vez' : `${p.eventos} veces`} · última: ${esc(fecha(p.ultimaVez))}</span></li>`;
  }).join('');
  const resto = r.problemas - r.lista.length;
  return `<p class="nota"><span class="chip chip-roja">${r.problemas === 1 ? '1 problema' : `${r.problemas} problemas`}</span> sin resolver${resto > 0 ? ', los más frecuentes' : ''}:</p>
      <ul style="margin:6px 0 0 18px">${items}</ul>
      ${resto > 0 ? `<p class="nota" style="margin-top:6px">…y ${resto} más en Sentry.</p>` : ''}`;
}

async function cargarSentry() {
  const general = $('sentry-general');
  try {
    const s = await api('/api/fabrica/sentry');
    if (!s.conectado) {
      general.innerHTML = `<p class="nota">Sentry no está conectado a esta pantalla: falta ${esc(s.falta)} en el servidor.</p>`;
      document.querySelectorAll('[data-sentry]').forEach(el => { el.innerHTML = '<p class="nota">Sentry no está conectado (ver abajo).</p>'; });
      return;
    }
    general.innerHTML = `<p class="nota">Tareas del servidor, pantallas sin sesión y errores anteriores a la v1.26.</p>${bloqueSentry(s.sinCondominio, s.dias)}`;
    document.querySelectorAll('[data-sentry]').forEach(el => {
      el.innerHTML = bloqueSentry(s.porCondominio[el.dataset.sentry], s.dias) || '<p class="nota">—</p>';
    });
  } catch (err) {
    general.innerHTML = `<p class="nota rojo">No se pudo leer Sentry: ${esc(err.message)}</p>`;
  }
}

function ficha(c) {
  // Cada cuenta de panel ve solo su condominio; la de acceso total (marcada)
  // los ve todos y se maneja desde el entorno del servidor, así que acá no se
  // le cambia el PIN ni se la quita.
  const admins = c.administradores.length
    ? c.administradores.map(a => a.accesoTotal ? `
        <div class="fila-form">
          <span class="nota"><strong>${esc(a.usuario)}</strong> · ${esc(a.nombre)} ·
            <strong>🔑 acceso total</strong> (ve todos los condominios; se maneja con ADMIN_TOTAL_* en el servidor)</span>
        </div>` : `
        <div class="fila-form">
          <span class="nota"><strong>${esc(a.usuario)}</strong> · ${esc(a.nombre)}</span>
          <input class="pin-nuevo" data-admin="${esc(a.id)}" autocapitalize="none" autocomplete="off" placeholder="PIN nuevo (8+ letras y números)">
          <button class="btn btn-borde btn-chico" data-accion="pin" data-admin="${esc(a.id)}">Cambiar PIN</button>
          <button class="btn btn-peligro btn-chico" data-accion="quitar-admin" data-admin="${esc(a.id)}" data-usuario="${esc(a.usuario)}">Quitar</button>
        </div>`).join('')
    : '<p class="nota">Sin cuenta de panel propia — se administra desde tu cuenta con el selector. Así conviene.</p>';

  return `
    <div class="aviso-tarjeta" data-condominio="${esc(c.id)}">
      <h3>${esc(c.nombre)}</h3>
      <p class="nota">
        id <code>${esc(c.id)}</code> · código de registro <strong>${esc(c.codigoRegistro || '—')}</strong> ·
        ${c.puntos} punto(s) · ${c.rondas} ronda(s) · ${c.guardias} guardia(s) ·
        última ronda: ${esc(fecha(c.ultimaRonda))}
      </p>
      ${bloqueSalud(c.salud)}
      <p class="nota" style="margin-top:14px"><strong>Errores técnicos (Sentry) · últimos 7 días</strong></p>
      <div data-sentry="${esc(c.id)}"><p class="nota">Cargando…</p></div>

      <div class="fila-form">
        <input class="correos" value="${esc(c.correosInforme.join(', '))}" placeholder="Correo(s) del informe, separados por comas">
        <button class="btn btn-principal btn-chico" data-accion="correos">Guardar correos</button>
        <button class="btn btn-borde btn-chico" data-accion="prueba">Enviar informe de prueba</button>
      </div>
      ${c.correosInforme.length ? '' : '<p class="nota rojo">Sin correo cargado no se manda el informe del lunes.</p>'}

      <p class="nota" style="margin-top:14px"><strong>Cuentas de panel</strong></p>
      ${admins}

      <details>
        <summary class="nota">Agregar una cuenta de panel</summary>
        <div class="fila-form">
          <input class="admin-usuario" autocapitalize="none" placeholder="Usuario">
          <input class="admin-pin" autocapitalize="none" autocomplete="off" placeholder="PIN inicial (8+ letras y números)">
          <button class="btn btn-borde btn-chico" data-accion="nuevo-admin">Agregar</button>
        </div>
      </details>
    </div>`;
}

async function cargar() {
  try {
    const { condominios, envioActivo, respaldo } = await api('/api/fabrica/condominios');
    $('estado-correo').textContent = envioActivo
      ? `Envío por correo activo. Sale cada lunes a las 8 (hora de Chile).${respaldo ? ` Respaldo del servidor: ${respaldo}.` : ''}`
      : 'Ojo: el envío por correo está en pausa (faltan las credenciales de Gmail en el servidor).';
    $('estado-correo').className = envioActivo ? 'nota' : 'nota rojo';
    if (!condominios.length) {
      $('lista-condominios').innerHTML = '<p class="nota">Todavía no hay condominios. Crea el primero arriba.</p>';
      return;
    }
    // Inventario de llaves: la de acceso total abre todos los condominios, y
    // tiene que haber a lo sumo una. Si falta, la operación no puede recorrer
    // los condominios desde el panel.
    const totales = condominios.flatMap(c => c.administradores.filter(a => a.accesoTotal).map(a => a.usuario));
    const alerta = totales.length === 0
      ? '<p class="nota rojo">⚠️ No hay cuenta de acceso total: configura ADMIN_TOTAL_* en el servidor para recorrer todos los condominios desde el panel.</p>'
      : totales.length > 1
        ? `<p class="nota rojo">⚠️ Hay ${totales.length} cuentas de acceso total (${totales.map(esc).join(', ')}). Debería haber una sola.</p>`
        : '';
    $('lista-condominios').innerHTML = alerta + condominios.map(ficha).join('');
    cargarSentry();
  } catch (err) {
    if (sesion) aviso(err.message, 'error');
  }
}

// Un solo listener para toda la lista: las fichas se vuelven a pintar seguido.
async function accionEnLista(e) {
  const btn = e.target.closest('button[data-accion]');
  if (!btn) return;
  const tarjeta = btn.closest('[data-condominio]');
  const id = tarjeta.dataset.condominio;
  btn.disabled = true;
  try {
    if (btn.dataset.accion === 'correos') {
      const { correos } = await api(`/api/fabrica/condominios/${id}/correos`, {
        metodo: 'PUT', cuerpo: { correos: tarjeta.querySelector('.correos').value }
      });
      aviso(correos.length ? `Informe semanal a ${correos.join(' y ')}.` : 'Sin correos: ese condominio no se enviará.');
      cargar();
    } else if (btn.dataset.accion === 'prueba') {
      const r = await api(`/api/fabrica/condominios/${id}/informe-prueba`, { metodo: 'POST', cuerpo: {} });
      aviso(`Enviado a ${r.to} (${r.rango}).`);
    } else if (btn.dataset.accion === 'nuevo-admin') {
      const r = await api(`/api/fabrica/condominios/${id}/administradores`, {
        metodo: 'POST',
        cuerpo: {
          usuario: tarjeta.querySelector('.admin-usuario').value,
          pin: tarjeta.querySelector('.admin-pin').value
        }
      });
      aviso(`Admin ${r.admin.usuario} creado con PIN ${r.pin}. Anótalo.`);
      cargar();
    } else if (btn.dataset.accion === 'quitar-admin') {
      const quien = btn.dataset.usuario;
      if (!confirm(`¿Quitar la cuenta de panel "${quien}"?\n\nPierde el acceso de inmediato. Los datos del condominio (puntos, rondas, informes, guardias) no se tocan.`)) return;
      const r = await api(`/api/fabrica/administradores/${btn.dataset.admin}`, { metodo: 'DELETE' });
      aviso(`Cuenta ${r.usuario} eliminada.`);
      cargar();
    } else if (btn.dataset.accion === 'pin') {
      const campo = tarjeta.querySelector(`.pin-nuevo[data-admin="${btn.dataset.admin}"]`);
      const r = await api(`/api/fabrica/administradores/${btn.dataset.admin}/pin`, {
        metodo: 'PUT', cuerpo: { pin: campo.value }
      });
      campo.value = '';
      aviso(`PIN de ${r.usuario} cambiado a ${r.pin}. Sus sesiones abiertas se cerraron.`);
    }
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Render y arranque ----------

function render() {
  if (!sesion) {
    $('vista-login').classList.remove('oculta');
    $('vista-fabrica').classList.add('oculta');
    return;
  }
  $('vista-login').classList.add('oculta');
  $('vista-fabrica').classList.remove('oculta');
  $('texto-sesion').textContent = `· ${sesion.usuario}`;
  cargar();
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-login').addEventListener('click', entrar);
  $('campo-pin').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
  $('btn-salir').addEventListener('click', salir);
  $('btn-alta').addEventListener('click', darDeAlta);
  $('btn-pin-azar').addEventListener('click', () => { $('alta-pin').value = pinAlAzar(); });
  $('lista-condominios').addEventListener('click', accionEnLista);
  render();
});
