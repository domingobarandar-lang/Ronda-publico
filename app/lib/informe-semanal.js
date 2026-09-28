// Informe semanal por condominio, en Word (.docx), para enviar por correo al
// administrador. Se arma con los datos reales del store (ejecuciones cerradas
// en el rango de fechas). Paleta sobria: un violeta apagado + grises.
// Los gráficos son barras de bloques █ coloreados: imprimen limpio y no
// dependen de imágenes ni de librerías de gráficos.
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, VerticalAlign,
  Footer, PageNumber, Tab
} = require('docx');
const { TZ, isoChile, horaChile, esFecha, sumarDias } = require('./fechas-chile');

// ---------- Paleta ----------
const ACCENT = '5E4B8B', ACCENT_L = 'B9AECF', TRACK = 'ECEAF2', HEADFILL = '5E4B8B', ZEBRA = 'F5F3F8';
const INK = '242230', GRAY = '6B6875', LINE = 'D9D5E2', WHITE = 'FFFFFF';
const GREEN = '4E7A5B', OCHRE = 'B07D2B', RED = 'B23A48';
const FONT = 'Calibri';
// Un color por guardia en el gráfico de rondas por día (orden fijo, validado
// para daltonismo; ninguno se confunde con verde/ocre/rojo de estado). Del
// quinto guardia en adelante van juntos en gris como "Otros".
const SERIES = ['5E4B8B', '1BAF7A', '2A78D6', 'E87BA4'], OTROS = 'A3A1AD';

// ---------- Fechas (zona horaria de Chile) ----------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function fechaHoraChile(ts) {
  const p = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  const wd = g('weekday').replace('.', '');
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${g('day')}/${g('month')} · ${g('hour')}:${g('minute')}`;
}
function weekdayDe(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
function diasEntre(desde, hasta) {
  const out = []; const [y, m, d] = desde.split('-').map(Number); const [Y, M, D] = hasta.split('-').map(Number);
  let cur = Date.UTC(y, m - 1, d); const fin = Date.UTC(Y, M - 1, D);
  while (cur <= fin && out.length < 60) { out.push(new Date(cur).toISOString().slice(0, 10)); cur += 86400000; }
  return out;
}
// "Semana del…" solo si el rango ES una semana de lunes a domingo; un rango
// pedido a mano (?desde=&hasta=) se nombra "Del… al…".
function rangoTexto(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number); const [y2, m2, d2] = hasta.split('-').map(Number);
  const semana = weekdayDe(desde) === 'Lun' && diasEntre(desde, hasta).length === 7;
  const pre = semana ? 'Semana del' : 'Del';
  if (desde === hasta) return `${d1} de ${MESES[m1 - 1]} de ${y1}`;
  if (m1 === m2 && y1 === y2) return `${pre} ${d1} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
  if (y1 === y2) return `${pre} ${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
  return `${pre} ${d1} de ${MESES[m1 - 1]} de ${y1} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
}
function semanaAnterior() {
  const [y, m, d] = isoChile(Date.now()).split('-').map(Number);
  const hoy = Date.UTC(y, m - 1, d);
  const dow = (new Date(hoy).getUTCDay() + 6) % 7;          // 0 = lunes
  const lunAnt = hoy - dow * 86400000 - 7 * 86400000;
  return { desde: new Date(lunAnt).toISOString().slice(0, 10), hasta: new Date(lunAnt + 6 * 86400000).toISOString().slice(0, 10) };
}

// ---------- Cálculo de estadísticas ----------
// Las ejecuciones cerradas del condominio cuyo inicio cae, en fecha de CHILE,
// entre `desde` y `hasta` (inclusive), de la más antigua a la más nueva.
// La consulta trae un día de holgura a cada lado (el inicio se guarda en UTC y
// Chile está 3-4 horas atrás) y el corte fino lo hace isoChile(), la misma
// función de siempre: si no, las rondas de 21:00-23:59 del domingo caían en la
// semana siguiente.
function ejecucionesDelRango(store, condominioId, desde, hasta) {
  const conFechas = esFecha(desde) && esFecha(hasta);
  return store.ejecuciones.listar({
    condominioId,
    estadoDistintoDe: 'en_curso',
    desde: conFechas ? `${sumarDias(desde, -1)}T00:00:00.000Z` : undefined,
    hasta: conFechas ? `${sumarDias(hasta, 2)}T00:00:00.000Z` : undefined
  })
    .filter(e => isoChile(e.inicio) >= desde && isoChile(e.inicio) <= hasta)
    .reverse();
}

// ---------- Reglas de redacción ----------
// Todo lo que el informe AFIRMA sale de estas reglas, no de un modelo de
// lenguaje ni de la posición de un dato en una lista. Tres principios:
//  1. Un ranking solo dice "más" o "menos" cuando hay diferencia real. Si hay
//     empate lo dice (antes, con todos los puntos igual de marcados, los de
//     arriba de la lista salían "más cubiertos" y el último "al final").
//  2. Un porcentaje no miente en los bordes: 100% solo si es todo, 0% solo si
//     es nada, y las partes de un total suman 100.
//  3. Los puntos se juzgan por COBERTURA (marcado / lo que tocaba marcar), no
//     por cantidad bruta: un punto que está en menos rondas no está "menos
//     cubierto" por marcarse menos veces.
const plural = (n, uno, varios = uno + 's') => `${n} ${n === 1 ? uno : varios}`;
const porNombre = (a, b) => String(a).localeCompare(String(b), 'es');

function listaNatural(nombres, max = 5) {
  const vis = nombres.slice(0, max);
  const resto = nombres.length - vis.length;
  if (resto > 0) return `${vis.join(', ')} y ${plural(resto, 'otro')} más`;
  return vis.length <= 1 ? vis.join('') : `${vis.slice(0, -1).join(', ')} y ${vis.at(-1)}`;
}

// Reparte `n` unidades (100 para porcentajes, 30 para bloques de una barra)
// entre valores, por resto mayor: las partes suman exacto `n`. Nada que exista
// queda en 0 y nada que conviva con otra parte llega a `n`.
function repartir(valores, n = 100) {
  const total = valores.reduce((a, b) => a + b, 0);
  if (!total) return valores.map(() => 0);
  const exactos = valores.map(v => v * n / total);
  const out = exactos.map(Math.floor);
  let resto = n - out.reduce((a, b) => a + b, 0);
  const orden = exactos.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of orden) { if (resto <= 0) break; out[i]++; resto--; }
  valores.forEach((v, i) => {
    if (v > 0 && out[i] === 0) { const j = out.indexOf(Math.max(...out)); out[j]--; out[i] = 1; }
  });
  return out;
}
// Porcentaje suelto con la misma honestidad en los bordes.
const pctDe = (parte, total) => total ? repartir([parte, total - parte])[0] : 0;

// `store`: el de lib/store.js (la configuración sale de store.db y las
// ejecuciones del repositorio).
function calcular(store, opciones = {}) {
  const db = store.db;
  let { condominioId, desde, hasta } = opciones;
  if (!desde || !hasta) { const s = semanaAnterior(); desde = desde || s.desde; hasta = hasta || s.hasta; }
  if (desde > hasta) [desde, hasta] = [hasta, desde];

  const condominio = db.condominios.find(c => c.id === condominioId) || {};
  const usuarios = new Map(db.usuarios.map(u => [u.id, u]));
  const puntosDb = new Map(db.puntos.map(p => [p.id, p]));
  const nombrePunto = pid => (puntosDb.get(pid) ? puntosDb.get(pid).nombre : '(punto eliminado)');
  const ejec = ejecucionesDelRango(store, condominioId, desde, hasta);

  const diasList = diasEntre(desde, hasta);
  const porDia = new Map(diasList.map(d => [d, 0]));
  const rondasDia = new Map(diasList.map(d => [d, new Map()]));   // día -> guardia -> rondas
  const cobertura = new Map();   // puntoId -> { marcadas, esperadas }
  const cob = pid => { if (!cobertura.has(pid)) cobertura.set(pid, { marcadas: 0, esperadas: 0 }); return cobertura.get(pid); };
  const porGuardia = new Map();
  let total = 0, sinIdentificar = 0, marcDia = 0, marcNoche = 0;
  let completas = 0, incompletas = 0, sospechosas = 0;

  for (const e of ejec) {
    const nMarc = e.escaneos.length;
    total += nMarc;
    const dEj = isoChile(e.inicio);
    if (porDia.has(dEj)) porDia.set(dEj, porDia.get(dEj) + nMarc);
    const esDia = horaChile(e.inicio) >= 6 && horaChile(e.inicio) < 18;
    if (esDia) marcDia += nMarc; else marcNoche += nMarc;

    // Todo lo cerrado que no es incompleta ni sospechosa es completa (con o sin
    // observaciones): así las tres cajas suman siempre el total de rondas.
    const estado = e.estado === 'incompleta' || e.estado === 'sospechosa' ? e.estado : 'completa';
    if (estado === 'completa') completas++; else if (estado === 'incompleta') incompletas++; else sospechosas++;

    const u = usuarios.get(e.guardiaId);
    if (!u) sinIdentificar += nMarc;
    const clave = u ? e.guardiaId : '(eliminado)';
    if (!porGuardia.has(clave)) porGuardia.set(clave, { clave, nombre: u ? (u.nombre || u.usuario) : '(guardia eliminado)', marc: 0, rondas: 0, completas: 0, incompletas: 0, sospechosas: 0, dia: 0, noche: 0 });
    const g = porGuardia.get(clave);
    g.marc += nMarc; g.rondas++; g[estado === 'completa' ? 'completas' : estado + 's']++;
    if (esDia) g.dia++; else g.noche++;
    if (rondasDia.has(dEj)) { const m = rondasDia.get(dEj); m.set(clave, (m.get(clave) || 0) + 1); }

    // Cobertura con lo que se evaluó AL CERRAR (evaluacion.faltantes), no con
    // la ronda de hoy: si el administrador la editó después, la historia no cambia.
    for (const s of e.escaneos) { const c = cob(s.puntoId); c.marcadas++; c.esperadas++; }
    for (const pid of ((e.evaluacion && e.evaluacion.faltantes) || [])) cob(pid).esperadas++;
  }

  const rondasTotal = ejec.length;
  const [pCompletas, pIncompletas, pSospechosas] = repartir([completas, incompletas, sospechosas]);
  const [pDia, pNoche] = repartir([marcDia, marcNoche]);

  const guardias = [...porGuardia.values()]
    .sort((a, b) => b.marc - a.marc || porNombre(a.nombre, b.nombre))
    .map(g => {
      const partes = [];
      if (g.incompletas) partes.push(plural(g.incompletas, 'incompleta'));
      if (g.sospechosas) partes.push(plural(g.sospechosas, 'sospechosa'));
      // Empate de rondas de día y de noche: no se inventa un turno.
      const turno = g.noche > g.dia ? 'Noche' : g.dia > g.noche ? 'Día' : 'Día y noche';
      return { clave: g.clave, nombre: g.nombre, turno, rondasDia: g.dia, rondasNoche: g.noche, marcaciones: g.marc, rondas: g.rondas, completas: g.completas, incidencias: partes.length ? partes.join(' · ') : '—', color: g.sospechosas ? RED : (g.incompletas ? OCHRE : GRAY) };
    });

  const incidencias = ejec.filter(e => e.estado === 'incompleta' || e.estado === 'sospechosa')
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)))
    .map(e => {
      const u = usuarios.get(e.guardiaId);
      const ev = e.evaluacion || {};
      let tipo, tipoColor, detalle;
      if (e.estado === 'sospechosa') {
        tipo = 'Sospechosa'; tipoColor = RED;
        const s = ev.sospechas || [];
        detalle = s.length ? s.join(' · ') : 'Datos que no se pudieron verificar.';
      } else {
        tipo = 'Incompleta'; tipoColor = OCHRE;
        const falt = (ev.faltantes || []).map(nombrePunto);
        detalle = falt.length ? `Faltó marcar: ${falt.join(', ')}.` : 'Quedaron puntos sin marcar.';
      }
      return { fecha: fechaHoraChile(e.inicio), guardia: u ? (u.nombre || u.usuario) : '(guardia eliminado)', tipo, tipoColor, detalle };
    });

  // Resumen de incidencias: cuántas de cada tipo y de qué guardia (el detalle
  // ronda a ronda queda en el panel, no en el informe).
  const quienes = tipo => {
    const m = new Map();
    for (const x of incidencias) if (x.tipo === tipo) m.set(x.guardia, (m.get(x.guardia) || 0) + 1);
    return [...m].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => b.n - a.n || porNombre(a.nombre, b.nombre));
  };
  const resumenIncidencias = { incompletas: quienes('Incompleta'), sospechosas: quienes('Sospechosa') };

  // Puntos: TODOS los del condominio (también los que nadie marcó, que antes no
  // aparecían) más los ya eliminados que tuvieron actividad, sumados en una fila.
  const filas = new Map();
  const fila = (clave, nombre) => { if (!filas.has(clave)) filas.set(clave, { nombre, marcadas: 0, esperadas: 0 }); return filas.get(clave); };
  for (const p of db.puntos.filter(p => p.condominioId === condominioId)) fila(p.id, p.nombre);
  for (const [pid, c] of cobertura) {
    const f = puntosDb.has(pid) ? fila(pid, nombrePunto(pid)) : fila('(eliminado)', '(punto eliminado)');
    f.marcadas += c.marcadas; f.esperadas += c.esperadas;
  }
  const todas = [...filas.values()].map(f => ({ ...f, omitidas: f.esperadas - f.marcadas, pct: pctDe(f.marcadas, f.esperadas) }));
  // Orden: lo que requiere atención primero (menor cobertura, más omisiones);
  // a igualdad, alfabético. Nunca por el orden en que se cargaron los puntos.
  const puntos = todas.filter(f => f.esperadas > 0)
    .sort((a, b) => a.marcadas * b.esperadas - b.marcadas * a.esperadas || b.omitidas - a.omitidas || porNombre(a.nombre, b.nombre));
  const puntosSinRonda = todas.filter(f => f.esperadas === 0).map(f => f.nombre).sort(porNombre);

  const d = {
    condominio: condominio.nombre || 'Condominio', desde, hasta, rango: rangoTexto(desde, hasta),
    total, promedioDiario: diasList.length ? Math.round(total / diasList.length * 10) / 10 : 0,
    rondasTotal, completas, incompletas, sospechosas,
    pct: { completas: pCompletas, incompletas: pIncompletas, sospechosas: pSospechosas },
    cumplimiento: pCompletas, sinIdentificar,
    dias: diasList.map(d => [weekdayDe(d), porDia.get(d) || 0]),
    turno: { dia: { marc: marcDia, pct: pDia }, noche: { marc: marcNoche, pct: pNoche } },
    guardias, puntos, puntosSinRonda, incidencias, resumenIncidencias,
    // Rondas de cada día repartidas por guardia, en el orden de `guardias`.
    rondasPorDia: diasList.map(dd => {
      const m = rondasDia.get(dd);
      return { dia: weekdayDe(dd), total: [...m.values()].reduce((a, b) => a + b, 0), porGuardia: guardias.map(g => m.get(g.clave) || 0) };
    }),
    generado: new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  };
  d.lecturaPuntos = lecturaPuntos(d);
  d.conclusion = conclusion(d);
  return d;
}

// Frase sobre los puntos, derivada solo de los números de la tabla.
function lecturaPuntos(d) {
  const t = [];
  if (!d.puntos.length) t.push('Ningún punto tenía marcas pendientes en las rondas del periodo.');
  else {
    const conFalta = d.puntos.filter(p => p.omitidas > 0);
    if (!conFalta.length) {
      const veces = new Set(d.puntos.map(p => p.marcadas));
      t.push(d.puntos.length === 1
        ? `El único punto recorrido se marcó en todas las rondas que lo incluían (${plural(d.puntos[0].marcadas, 'vez', 'veces')}).`
        : `Los ${d.puntos.length} puntos recorridos se marcaron en todas las rondas que los incluían: cobertura del 100% en cada uno.`);
      t.push(veces.size === 1
        ? `Todos tienen la misma cantidad de marcas (${plural(d.puntos[0].marcadas, 'vez', 'veces')}), así que no hay un punto más ni menos marcado.`
        : 'Las cantidades distintas se deben a que no todas las rondas recorren los mismos puntos, no a omisiones.');
    } else {
      const orden = [...conFalta].sort((a, b) => b.omitidas - a.omitidas || porNombre(a.nombre, b.nombre));
      t.push(`${conFalta.length === 1 ? 'Un punto quedó' : `${conFalta.length} puntos quedaron`} sin marcar alguna vez: ${listaNatural(orden.map(p => `${p.nombre} (${plural(p.omitidas, 'vez', 'veces')})`))}.`);
      const sanos = d.puntos.length - conFalta.length;
      if (sanos) t.push(sanos === 1 ? 'El otro punto tuvo cobertura completa.' : `Los otros ${sanos} tuvieron cobertura completa.`);
    }
  }
  if (d.puntosSinRonda.length) {
    t.push(`${d.puntosSinRonda.length === 1 ? 'Un punto no forma parte' : `${d.puntosSinRonda.length} puntos no forman parte`} de ninguna ronda realizada en el periodo: ${listaNatural(d.puntosSinRonda)}.`);
  }
  return t.join(' ');
}

function conclusion(d) {
  if (!d.rondasTotal) return 'No se registraron rondas cerradas en este periodo.';
  const inc = d.incompletas + d.sospechosas;
  let t = `El periodo cerró con ${plural(d.rondasTotal, 'ronda')}: ${d.completas} completa${d.completas === 1 ? '' : 's'} (${d.cumplimiento}% de cumplimiento) y ${d.sinIdentificar === 0 ? 'ninguna marcación sin identificar' : plural(d.sinIdentificar, 'marcación sin identificar', 'marcaciones sin identificar')}. `;
  if (inc === 0) t += 'No se registraron rondas incompletas ni sospechosas. ';
  else {
    const partes = [];
    if (d.incompletas) partes.push(plural(d.incompletas, 'incompleta'));
    if (d.sospechosas) partes.push(plural(d.sospechosas, 'sospechosa'));
    t += `Hubo ${partes.join(' y ')} que conviene revisar (resumen en la sección 5). `;
  }
  // Los puntos, en corto: el detalle y la tabla ya están en la sección 4.
  const conFalta = d.puntos.filter(p => p.omitidas > 0).length;
  if (!d.puntos.length) return t;
  return t + (conFalta
    ? `${conFalta === 1 ? 'Un punto quedó' : `${conFalta} puntos quedaron`} sin marcar alguna vez (detalle en la sección 4).`
    : 'Todos los puntos recorridos tuvieron cobertura completa.');
}

// Chequeo de coherencia: los números de cada sección tienen que cuadrar entre
// sí. Devuelve la lista de problemas (vacía si todo cuadra). Lo usan los tests
// y generarInformeSemanal, que deja el aviso en el log si algo no cuadra.
function revisarCoherencia(d) {
  const p = [];
  const suma = xs => xs.reduce((a, b) => a + b, 0);
  if (d.completas + d.incompletas + d.sospechosas !== d.rondasTotal) p.push('estados de ronda no suman el total');
  if (d.rondasTotal && suma(Object.values(d.pct)) !== 100) p.push('porcentajes de estado no suman 100');
  if (d.cumplimiento === 100 && d.completas !== d.rondasTotal) p.push('100% de cumplimiento con incidencias');
  if (d.cumplimiento === 0 && d.completas > 0) p.push('0% de cumplimiento con rondas completas');
  if (d.turno.dia.marc + d.turno.noche.marc !== d.total) p.push('turnos no suman el total');
  if (d.total && d.turno.dia.pct + d.turno.noche.pct !== 100) p.push('turnos no suman 100%');
  if (suma(d.dias.map(x => x[1])) !== d.total && d.dias.length < 60) p.push('días no suman el total');
  if (suma(d.guardias.map(g => g.marcaciones)) !== d.total) p.push('guardias no suman el total');
  if (suma(d.guardias.map(g => g.rondas)) !== d.rondasTotal) p.push('rondas por guardia no suman el total');
  if (suma(d.puntos.map(x => x.marcadas)) !== d.total) p.push('puntos no suman el total');
  if (d.incidencias.length !== d.incompletas + d.sospechosas) p.push('incidencias no calzan con los estados');
  if (suma(d.resumenIncidencias.incompletas.map(x => x.n)) !== d.incompletas) p.push('resumen de incompletas no calza');
  if (suma(d.resumenIncidencias.sospechosas.map(x => x.n)) !== d.sospechosas) p.push('resumen de sospechosas no calza');
  if (d.rondasPorDia.length < 60) {
    if (suma(d.rondasPorDia.map(x => x.total)) !== d.rondasTotal) p.push('rondas por día no suman el total');
    d.guardias.forEach((g, i) => { if (suma(d.rondasPorDia.map(x => x.porGuardia[i])) !== g.rondas) p.push(`${g.nombre}: rondas por día no suman sus rondas`); });
  }
  for (const x of d.rondasPorDia) if (suma(x.porGuardia) !== x.total) p.push(`${x.dia}: guardias no suman las rondas del día`);
  for (const x of d.puntos) {
    if (x.omitidas < 0) p.push(`${x.nombre}: más marcas que esperadas`);
    if ((x.pct === 100) !== (x.omitidas === 0)) p.push(`${x.nombre}: porcentaje incoherente`);
  }
  return p;
}

// ---------- Ayudantes de documento ----------
const NO_BORDER = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } };
const hairline = (color = LINE) => ({ style: BorderStyle.SINGLE, size: 4, color });
const run = (text, o = {}) => new TextRun({ text, font: FONT, color: o.color || INK, bold: o.bold, italics: o.italics, size: o.size || 21, allCaps: o.caps, characterSpacing: o.spacing });
const P = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], alignment: o.align, spacing: o.spacing, border: o.border, keepNext: o.keepNext, keepLines: o.keepLines });
function seccion(num, titulo) {
  return new Paragraph({ spacing: { before: 360, after: 140 }, border: { bottom: hairline(LINE) }, keepNext: true, keepLines: true, children: [run(num + '   ', { bold: true, color: ACCENT, size: 26 }), run(titulo, { bold: true, color: INK, size: 26 })] });
}
function cell(children, o = {}) {
  return new TableCell({ children: Array.isArray(children) ? children : [children], width: o.width ? { size: o.width, type: WidthType.DXA } : undefined, shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined, verticalAlign: o.valign || VerticalAlign.CENTER, margins: { top: o.mt ?? 80, bottom: o.mb ?? 80, left: o.ml ?? 120, right: o.mr ?? 120 }, borders: o.borders });
}
function barras(label, value, max, color = ACCENT) {
  // Un valor menor que el máximo nunca llena la barra, y uno mayor que 0 nunca
  // queda vacío: el dibujo no puede sugerir un empate o un cero que no hay.
  let n = max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * 20)) : 0;
  if (value < max && n === 20) n = 19;
  return new TableRow({
    cantSplit: true, children: [
      cell(P(run(label, { size: 20 })), { width: 2600, borders: NO_BORDER }),
      cell(P([run('█'.repeat(n), { color }), run('█'.repeat(20 - n), { color: TRACK })]), { width: 6000, borders: NO_BORDER }),
      cell(P(run(String(value), { bold: true, size: 20 }), { align: AlignmentType.RIGHT }), { width: 760, borders: NO_BORDER })
    ]
  });
}

// ---------- Construcción del documento ----------
function generarDocx(d) {
  const hijos = [
    P(run('Rondas QR — Informe semanal', { color: GRAY, size: 15, caps: true, spacing: 40, bold: true }), { spacing: { after: 40 } }),
    P(run('Informe Semanal de Rondas', { bold: true, size: 40 }), { spacing: { after: 40 } }),
    P(run(d.condominio, { bold: true, size: 26, color: ACCENT }), { spacing: { after: 20 } }),
    P(run(d.rango, { color: GRAY, size: 20 }), { spacing: { after: 120 }, border: { bottom: hairline(ACCENT) } })
  ];

  if (d.rondasTotal === 0) {
    hijos.push(P(run('No se registraron rondas cerradas en este periodo.', { color: GRAY, size: 22, italics: true }), { spacing: { before: 240 } }));
    return documento(d, hijos);
  }

  const inc = d.incompletas + d.sospechosas;
  hijos.push(P(run(`${d.cumplimiento}% de cumplimiento   ·   ${plural(d.sinIdentificar, 'marcación sin identificar', 'marcaciones sin identificar')}   ·   ${plural(inc, 'incidencia registrada', 'incidencias registradas')}`, { color: GRAY, size: 19, italics: true }), { spacing: { before: 100, after: 60 } }));

  // 1 · Resumen
  hijos.push(seccion('1', 'Resumen de la semana'));
  const tile = (num, label) => cell([P(run(num, { bold: true, size: 46, color: ACCENT }), { align: AlignmentType.CENTER, spacing: { after: 20 } }), P(run(label, { color: GRAY, size: 17 }), { align: AlignmentType.CENTER })], { fill: TRACK, mt: 160, mb: 160 });
  hijos.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2340, 2340, 2340, 2340],
    borders: { ...NO_BORDER, insideHorizontal: { style: BorderStyle.SINGLE, size: 12, color: WHITE }, insideVertical: { style: BorderStyle.SINGLE, size: 12, color: WHITE } },
    rows: [new TableRow({ cantSplit: true, children: [tile(String(d.total), 'Total de marcaciones'), tile(String(d.promedioDiario).replace('.', ','), 'Promedio diario'), tile(String(d.rondasTotal), 'Rondas realizadas'), tile(d.cumplimiento + '%', 'Cumplimiento')] })]
  }));
  const idSano = d.sinIdentificar === 0;
  hijos.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [9360],
    borders: { ...NO_BORDER, left: { style: BorderStyle.SINGLE, size: 18, color: idSano ? GREEN : OCHRE } },
    rows: [new TableRow({ cantSplit: true, children: [cell([
      P(run(plural(d.sinIdentificar, 'marcación sin identificar', 'marcaciones sin identificar'), { bold: true, color: idSano ? GREEN : OCHRE, size: 22 }), { spacing: { after: 20 } }),
      P(run(idSano ? 'Cada marca quedó asociada a un guardia con usuario y PIN. Nadie marcó de forma anónima.' : 'Son marcas de un guardia que después fue eliminado de la app: ya no se pueden atribuir a una persona.', { color: GRAY, size: 18 }))
    ], { fill: idSano ? 'EEF3EF' : 'F6F0E6', ml: 200, mt: 140, mb: 140 })] })]
  }));

  // 2 · Estadísticas
  hijos.push(seccion('2', 'Estadísticas de la semana'));
  hijos.push(P(run('Marcaciones por día', { bold: true, size: 22 }), { spacing: { before: 120, after: 60 }, keepNext: true }));
  hijos.push(P(run('Puntos escaneados, según el día en que empezó cada ronda.', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  const maxDia = Math.max(1, ...d.dias.map(x => x[1]));
  hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2600, 6000, 760], borders: NO_BORDER, rows: d.dias.map(([lab, v]) => barras(lab, v, maxDia)) }));

  hijos.push(P(run('Estado de las rondas', { bold: true, size: 22 }), { spacing: { before: 240, after: 60 }, keepNext: true }));
  hijos.push(P(run(`${plural(d.rondasTotal, 'ronda cerrada', 'rondas cerradas')} en el periodo.`, { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  const [cb, ib, sb] = repartir([d.completas, d.incompletas, d.sospechosas], 30);
  hijos.push(P([run('█'.repeat(cb), { color: GREEN }), run('█'.repeat(ib), { color: OCHRE }), run('█'.repeat(sb), { color: RED })], { spacing: { after: 80 } }));
  const filaEstado = (color, nom, val, pctv) => new TableRow({ cantSplit: true, children: [
    cell(P(run('■', { color })), { width: 500, borders: NO_BORDER }),
    cell(P(run(nom, { size: 20 })), { width: 5000, borders: NO_BORDER }),
    cell(P(run(String(val), { bold: true, size: 20 }), { align: AlignmentType.RIGHT }), { width: 1500, borders: NO_BORDER }),
    cell(P(run(pctv, { color: GRAY, size: 20 }), { align: AlignmentType.RIGHT }), { width: 2360, borders: NO_BORDER })
  ] });
  hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [500, 5000, 1500, 2360], borders: NO_BORDER, rows: [
    filaEstado(GREEN, 'Completas', d.completas, d.pct.completas + '%'),
    filaEstado(OCHRE, 'Incompletas', d.incompletas, d.pct.incompletas + '%'),
    filaEstado(RED, 'Sospechosas', d.sospechosas, d.pct.sospechosas + '%')
  ] }));

  if (d.turno.dia.marc + d.turno.noche.marc > 0) {
    // Bajo cada turno, quienes hicieron rondas en ese turno (un guardia puede
    // estar en los dos): la lista explica el número que acompaña.
    const nocheN = d.guardias.filter(g => g.rondasNoche > 0).map(g => g.nombre.split(' ')[0]);
    const diaN = d.guardias.filter(g => g.rondasDia > 0).map(g => g.nombre.split(' ')[0]);
    hijos.push(P(run('Reparto por turno', { bold: true, size: 22 }), { spacing: { before: 240, after: 60 }, keepNext: true }));
    hijos.push(P(run('Marcaciones según la hora de inicio de la ronda (día 06–18 h, noche el resto).', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
    const [nb, dbl] = repartir([d.turno.noche.marc, d.turno.dia.marc], 30);
    hijos.push(P([run('█'.repeat(nb), { color: ACCENT }), run('█'.repeat(dbl), { color: ACCENT_L })], { spacing: { after: 80 } }));
    hijos.push(P([run('■ ', { color: ACCENT }), run(`Noche · ${d.turno.noche.pct}% · ${plural(d.turno.noche.marc, 'marcación', 'marcaciones')}${nocheN.length ? ' · ' + nocheN.join(', ') : ''}`, { size: 18, color: GRAY })], { spacing: { after: 20 } }));
    hijos.push(P([run('■ ', { color: '9788B4' }), run(`Día · ${d.turno.dia.pct}% · ${plural(d.turno.dia.marc, 'marcación', 'marcaciones')}${diaN.length ? ' · ' + diaN.join(', ') : ''}`, { size: 18, color: GRAY })]));
  }

  // 3 · Por guardia
  hijos.push(seccion('3', 'Rondas por guardia'));
  hijos.push(tablaGuardias(d.guardias));
  hijos.push(...graficoRondasPorDia(d));

  // 4 · Puntos
  hijos.push(seccion('4', 'Cobertura por punto de control'));
  hijos.push(P(run('Veces que se marcó cada punto sobre las veces que tocaba marcarlo (rondas realizadas que lo incluían). Primero los que requieren atención; a igual cobertura, por orden alfabético.', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  if (d.puntos.length) hijos.push(tablaPuntos(d.puntos));
  hijos.push(P(run(d.lecturaPuntos, { size: 19 }), { spacing: { before: 120 } }));

  // 5 · Incidencias
  hijos.push(seccion('5', 'Incidencias'));
  hijos.push(...resumenIncidencias(d));

  // 6 · Conclusión
  hijos.push(seccion('6', 'Conclusión'));
  hijos.push(P(run(d.conclusion, { size: 22 }), { spacing: { after: 120, line: 300 } }));
  hijos.push(P(run(`Informe generado por Rondas QR el ${d.generado}. Todas las cifras y frases salen directamente de los registros de la app, con reglas fijas.`, { color: GRAY, size: 17, italics: true }), { spacing: { before: 200 } }));

  return documento(d, hijos);
}

function tablaGuardias(guardias) {
  const th = (t, r) => cell(P(run(t, { bold: true, color: WHITE, size: 18, caps: true, spacing: 20 }), { align: r ? AlignmentType.RIGHT : undefined, keepNext: true }), { fill: HEADFILL });
  const td = (t, o = {}) => cell(P(run(t, { size: 20, color: o.color, bold: o.bold }), { align: o.r ? AlignmentType.RIGHT : undefined, keepNext: o.keepNext }), { fill: o.fill });
  const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: [th('Guardia'), th('Turno'), th('Marcaciones', true), th('Rondas', true), th('Completas', true), th('Incidencias')] })];
  guardias.forEach((g, i) => {
    const f = i % 2 ? ZEBRA : undefined; const keep = i < guardias.length - 1;
    rows.push(new TableRow({ cantSplit: true, children: [
      td(g.nombre, { bold: true, fill: f, keepNext: keep }), td(g.turno, { fill: f, color: GRAY, keepNext: keep }),
      td(String(g.marcaciones), { r: true, fill: f, keepNext: keep }), td(String(g.rondas), { r: true, fill: f, keepNext: keep }),
      td(String(g.completas), { r: true, fill: f, keepNext: keep }), td(g.incidencias, { fill: f, color: g.color, keepNext: keep })
    ] }));
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2200, 1100, 1550, 1150, 1400, 1960], borders: { top: hairline(LINE), bottom: hairline(LINE), insideHorizontal: hairline(LINE), left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows });
}

function tablaPuntos(puntos) {
  const th = (t, r) => cell(P(run(t, { bold: true, color: WHITE, size: 18, caps: true, spacing: 20 }), { align: r ? AlignmentType.RIGHT : undefined, keepNext: true }), { fill: HEADFILL });
  const td = (t, o = {}) => cell(P(run(t, { size: 19, color: o.color, bold: o.bold }), { align: o.r ? AlignmentType.RIGHT : undefined, keepNext: o.keepNext }), { fill: o.fill });
  const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: [th('Punto'), th('Marcado', true), th('Faltó', true), th('Cobertura', true)] })];
  puntos.forEach((x, i) => {
    const f = i % 2 ? ZEBRA : undefined; const keep = i < puntos.length - 1;
    const color = x.omitidas === 0 ? GREEN : (x.pct >= 90 ? OCHRE : RED);
    rows.push(new TableRow({ cantSplit: true, children: [
      td(x.nombre, { bold: true, fill: f, keepNext: keep }),
      td(`${x.marcadas} de ${x.esperadas}`, { r: true, fill: f, keepNext: keep }),
      td(x.omitidas ? String(x.omitidas) : '—', { r: true, fill: f, color: x.omitidas ? color : GRAY, keepNext: keep }),
      td(x.pct + '%', { r: true, fill: f, color, bold: true, keepNext: keep })
    ] }));
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [4360, 1800, 1400, 1800], borders: { top: hairline(LINE), bottom: hairline(LINE), insideHorizontal: hairline(LINE), left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows });
}

// Gráfico de barras apiladas: una barra por día, un tramo por guardia, largo
// proporcional a las rondas del día. Debajo, la misma información en números
// (guardia × día), para leerla sin depender del color.
function graficoRondasPorDia(d) {
  const out = [];
  if (!d.rondasTotal) return out;
  const nSeries = Math.min(d.guardias.length, SERIES.length + (d.guardias.length > SERIES.length ? 1 : 0));
  const color = i => (i < SERIES.length ? SERIES[i] : OTROS);
  // Guardias 5 en adelante se suman en "Otros".
  const agrupar = xs => (xs.length > SERIES.length ? [...xs.slice(0, SERIES.length), xs.slice(SERIES.length).reduce((a, b) => a + b, 0)] : xs);
  const nombres = agrupar(d.guardias.map(g => g.nombre.split(' ')[0])).map((n, i) => (i === SERIES.length ? 'Otros' : n));
  const maxDia = Math.max(1, ...d.rondasPorDia.map(x => x.total));
  const ANCHO = 24;

  out.push(P(run('Rondas por día y guardia', { bold: true, size: 22 }), { spacing: { before: 280, after: 60 }, keepNext: true }));
  out.push(P(run('Cada barra es un día; cada color, un guardia. Según el día en que empezó la ronda.', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  const filas = d.rondasPorDia.map(x => {
    const vals = agrupar(x.porGuardia);
    let largo = x.total ? Math.max(1, Math.round(x.total / maxDia * ANCHO)) : 0;
    if (x.total < maxDia && largo === ANCHO) largo = ANCHO - 1;
    largo = Math.max(largo, vals.filter(v => v > 0).length);
    const bloques = repartir(vals, largo);
    const tramos = bloques.map((b, i) => run('█'.repeat(b), { color: color(i) })).filter((_, i) => bloques[i] > 0);
    return new TableRow({ cantSplit: true, children: [
      cell(P(run(x.dia, { size: 20 })), { width: 1200, borders: NO_BORDER, mt: 30, mb: 30 }),
      cell(P([...tramos, run('█'.repeat(ANCHO - largo), { color: TRACK })]), { width: 7400, borders: NO_BORDER, mt: 30, mb: 30 }),
      cell(P(run(String(x.total), { bold: true, size: 20 }), { align: AlignmentType.RIGHT }), { width: 760, borders: NO_BORDER, mt: 30, mb: 30 })
    ] });
  });
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [1200, 7400, 760], borders: NO_BORDER, rows: filas }));
  const totales = agrupar(d.guardias.map(g => g.rondas));
  out.push(P(nombres.slice(0, nSeries).flatMap((n, i) => [run('■ ', { color: color(i) }), run(`${n} · ${plural(totales[i], 'ronda')}${i < nSeries - 1 ? '     ' : ''}`, { size: 18, color: GRAY })]), { spacing: { before: 80, after: 120 } }));

  // La misma información en números.
  const th = (t, r) => cell(P(run(t, { bold: true, color: WHITE, size: 17, caps: true }), { align: r ? AlignmentType.RIGHT : undefined, keepNext: true }), { fill: HEADFILL, ml: 80, mr: 80 });
  const td = (t, o = {}) => cell(P(run(t, { size: 18, color: o.color, bold: o.bold }), { align: o.r ? AlignmentType.RIGHT : undefined, keepNext: o.keepNext }), { fill: o.fill, ml: 80, mr: 80 });
  const nd = d.rondasPorDia.length;
  const anchoDia = Math.floor(6160 / (nd + 1));
  const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: [th('Guardia'), ...d.rondasPorDia.map(x => th(x.dia, true)), th('Total', true)] })];
  d.guardias.forEach((g, i) => {
    const f = i % 2 ? ZEBRA : undefined; const keep = i < d.guardias.length - 1;
    rows.push(new TableRow({ cantSplit: true, children: [
      td(g.nombre, { bold: true, fill: f, keepNext: keep }),
      ...d.rondasPorDia.map(x => td(x.porGuardia[i] ? String(x.porGuardia[i]) : '—', { r: true, fill: f, color: x.porGuardia[i] ? INK : GRAY, keepNext: keep })),
      td(String(g.rondas), { r: true, bold: true, fill: f, keepNext: keep })
    ] }));
  });
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [3200, ...Array(nd + 1).fill(anchoDia)], borders: { top: hairline(LINE), bottom: hairline(LINE), insideHorizontal: hairline(LINE), left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows }));
  return out;
}

// Incidencias en corto: cuántas de cada tipo y de quién. El detalle de cada
// ronda (hora, puntos faltantes, motivo) está en el panel.
function resumenIncidencias(d) {
  const inc = d.incompletas + d.sospechosas;
  if (!inc) return [P(run('No hubo rondas incompletas ni sospechosas en el periodo.', { color: GREEN, size: 19 }))];
  const out = [P(run(`${plural(inc, 'ronda', 'rondas')} con incidencias de ${d.rondasTotal} (${100 - d.cumplimiento}%).`, { size: 20 }), { spacing: { after: 100 }, keepNext: true })];
  const quien = xs => xs.map(x => `${x.nombre} ${x.n}`).join(' · ') || '—';
  const fila = (color, tipo, n, qs, keep) => new TableRow({ cantSplit: true, children: [
    cell(P(run('■', { color })), { width: 500, borders: NO_BORDER }),
    cell(P(run(tipo, { size: 20, bold: true }), { keepNext: keep }), { width: 2200, borders: NO_BORDER }),
    cell(P(run(String(n), { bold: true, size: 20 }), { align: AlignmentType.RIGHT, keepNext: keep }), { width: 900, borders: NO_BORDER }),
    cell(P(run(n ? quien(qs) : '—', { size: 18, color: GRAY }), { keepNext: keep }), { width: 5760, borders: NO_BORDER })
  ] });
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [500, 2200, 900, 5760], borders: NO_BORDER, rows: [
    fila(OCHRE, 'Incompletas', d.incompletas, d.resumenIncidencias.incompletas, true),
    fila(RED, 'Sospechosas', d.sospechosas, d.resumenIncidencias.sospechosas, false)
  ] }));
  out.push(P(run('Incompleta: quedaron puntos sin marcar (cuáles, en la sección 4). Sospechosa: datos que no se pudieron verificar. El detalle de cada ronda está en el panel, pestaña Informes.', { color: GRAY, size: 17, italics: true }), { spacing: { before: 100 } }));
  return out;
}

function documento(d, hijos) {
  return new Document({
    creator: 'Rondas QR', title: 'Informe Semanal de Rondas',
    styles: { default: { document: { run: { font: FONT, size: 21, color: INK } } } },
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1200, right: 1200 } } },
      footers: { default: new Footer({ children: [new Paragraph({
        border: { top: hairline(LINE) }, tabStops: [{ type: 'right', position: 9360 }],
        children: [run('Rondas QR · Control de rondas de vigilancia', { color: GRAY, size: 16 }), new TextRun({ children: [new Tab(), 'Página ', PageNumber.CURRENT], font: FONT, color: GRAY, size: 16 })]
      })] }) },
      children: hijos
    }]
  });
}

async function generarInformeSemanal(store, opciones) {
  const d = calcular(store, opciones);
  const problemas = revisarCoherencia(d);
  if (problemas.length) console.error(`[informe-semanal] ${d.condominio} ${d.desde}..${d.hasta}: no cuadra — ${problemas.join('; ')}`);
  const buffer = await Packer.toBuffer(generarDocx(d));
  return { buffer, datos: d };
}

module.exports = { generarInformeSemanal, calcular, ejecucionesDelRango, revisarCoherencia, repartir };
