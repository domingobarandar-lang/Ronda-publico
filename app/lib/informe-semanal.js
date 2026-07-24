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
const { armarInforme } = require('./informes');

// ---------- Paleta ----------
const ACCENT = '5E4B8B', ACCENT_L = 'B9AECF', TRACK = 'ECEAF2', HEADFILL = '5E4B8B', ZEBRA = 'F5F3F8';
const INK = '242230', GRAY = '6B6875', LINE = 'D9D5E2', WHITE = 'FFFFFF';
const GREEN = '4E7A5B', OCHRE = 'B07D2B', RED = 'B23A48';
const FONT = 'Calibri';

// ---------- Fechas (zona horaria de Chile) ----------
const TZ = 'America/Santiago';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const isoChile = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const horaChile = ts => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));
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
function rangoTexto(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number); const [y2, m2, d2] = hasta.split('-').map(Number);
  if (m1 === m2 && y1 === y2) return `Semana del ${d1} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
  if (y1 === y2) return `Semana del ${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
  return `Semana del ${d1} de ${MESES[m1 - 1]} de ${y1} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
}
function semanaAnterior() {
  const [y, m, d] = isoChile(Date.now()).split('-').map(Number);
  const hoy = Date.UTC(y, m - 1, d);
  const dow = (new Date(hoy).getUTCDay() + 6) % 7;          // 0 = lunes
  const lunAnt = hoy - dow * 86400000 - 7 * 86400000;
  return { desde: new Date(lunAnt).toISOString().slice(0, 10), hasta: new Date(lunAnt + 6 * 86400000).toISOString().slice(0, 10) };
}

// ---------- Cálculo de estadísticas ----------
function calcular(db, opciones = {}) {
  let { condominioId, desde, hasta } = opciones;
  if (!desde || !hasta) { const s = semanaAnterior(); desde = desde || s.desde; hasta = hasta || s.hasta; }
  if (desde > hasta) [desde, hasta] = [hasta, desde];

  const condominio = db.condominios.find(c => c.id === condominioId) || {};
  const usuarios = new Map(db.usuarios.map(u => [u.id, u]));
  const puntos = new Map(db.puntos.map(p => [p.id, p]));
  const ejec = db.ejecuciones.filter(e =>
    e.condominioId === condominioId && e.estado !== 'en_curso' &&
    isoChile(e.inicio) >= desde && isoChile(e.inicio) <= hasta);

  const diasList = diasEntre(desde, hasta);
  const porDia = new Map(diasList.map(d => [d, 0]));
  const porPunto = new Map();
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

    const completa = e.estado === 'completa' || e.estado === 'completa_obs';
    if (completa) completas++; else if (e.estado === 'incompleta') incompletas++; else if (e.estado === 'sospechosa') sospechosas++;

    const u = usuarios.get(e.guardiaId);
    if (!u) sinIdentificar += nMarc;
    if (!porGuardia.has(e.guardiaId)) porGuardia.set(e.guardiaId, { nombre: u ? (u.nombre || u.usuario) : '(guardia eliminado)', marc: 0, rondas: 0, completas: 0, incompletas: 0, sospechosas: 0, dia: 0, noche: 0 });
    const g = porGuardia.get(e.guardiaId);
    g.marc += nMarc; g.rondas++;
    if (completa) g.completas++; else if (e.estado === 'incompleta') g.incompletas++; else if (e.estado === 'sospechosa') g.sospechosas++;
    if (esDia) g.dia++; else g.noche++;

    for (const s of e.escaneos) porPunto.set(s.puntoId, (porPunto.get(s.puntoId) || 0) + 1);
  }

  const rondasTotal = completas + incompletas + sospechosas;
  const turnoTotal = marcDia + marcNoche;
  const pct = v => turnoTotal ? Math.round(v / turnoTotal * 100) : 0;

  const guardias = [...porGuardia.values()].sort((a, b) => b.marc - a.marc).map(g => {
    const partes = [];
    if (g.incompletas) partes.push(`${g.incompletas} incompleta${g.incompletas > 1 ? 's' : ''}`);
    if (g.sospechosas) partes.push(`${g.sospechosas} sospechosa${g.sospechosas > 1 ? 's' : ''}`);
    return { nombre: g.nombre, turno: g.noche >= g.dia ? 'Noche' : 'Día', marcaciones: g.marc, rondas: g.rondas, completas: g.completas, incidencias: partes.length ? partes.join(' · ') : '—', color: g.sospechosas ? RED : (g.incompletas ? OCHRE : GRAY) };
  });

  const incidencias = ejec.filter(e => e.estado === 'incompleta' || e.estado === 'sospechosa')
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)))
    .map(e => {
      const u = usuarios.get(e.guardiaId);
      const inf = armarInforme(db, e);
      let tipo, tipoColor, detalle;
      if (e.estado === 'sospechosa') {
        tipo = 'Sospechosa'; tipoColor = RED;
        const s = (inf.evaluacion && inf.evaluacion.sospechas) || [];
        detalle = s.length ? s.join(' · ') : 'Datos que no se pudieron verificar.';
      } else {
        tipo = 'Incompleta'; tipoColor = OCHRE;
        const falt = inf.detalle.filter(x => x.faltante).map(x => x.nombre);
        detalle = falt.length ? `Faltó marcar: ${falt.join(', ')}.` : 'Quedaron puntos sin marcar.';
      }
      return { fecha: fechaHoraChile(e.inicio), guardia: u ? (u.nombre || u.usuario) : '(guardia eliminado)', tipo, tipoColor, detalle };
    });

  return {
    condominio: condominio.nombre || 'Condominio', desde, hasta, rango: rangoTexto(desde, hasta),
    total, promedioDiario: diasList.length ? Math.round(total / diasList.length) : 0,
    rondasTotal, completas, incompletas, sospechosas,
    cumplimiento: rondasTotal ? Math.round(completas / rondasTotal * 100) : 0, sinIdentificar,
    dias: diasList.map(d => [weekdayDe(d), porDia.get(d) || 0]),
    turno: { dia: { marc: marcDia, pct: pct(marcDia) }, noche: { marc: marcNoche, pct: pct(marcNoche) } },
    guardias,
    puntos: [...porPunto.entries()].map(([pid, v]) => [puntos.get(pid) ? puntos.get(pid).nombre : '(punto eliminado)', v]).sort((a, b) => b[1] - a[1]).slice(0, 10),
    incidencias,
    generado: new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  };
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
  const n = max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * 20)) : 0;
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
  hijos.push(P(run(`${d.cumplimiento}% de cumplimiento   ·   ${d.sinIdentificar} marcaciones sin identificar   ·   ${inc} incidencia${inc === 1 ? '' : 's'} registrada${inc === 1 ? '' : 's'}`, { color: GRAY, size: 19, italics: true }), { spacing: { before: 100, after: 60 } }));

  // 1 · Resumen
  hijos.push(seccion('1', 'Resumen de la semana'));
  const tile = (num, label) => cell([P(run(num, { bold: true, size: 46, color: ACCENT }), { align: AlignmentType.CENTER, spacing: { after: 20 } }), P(run(label, { color: GRAY, size: 17 }), { align: AlignmentType.CENTER })], { fill: TRACK, mt: 160, mb: 160 });
  hijos.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2340, 2340, 2340, 2340],
    borders: { ...NO_BORDER, insideHorizontal: { style: BorderStyle.SINGLE, size: 12, color: WHITE }, insideVertical: { style: BorderStyle.SINGLE, size: 12, color: WHITE } },
    rows: [new TableRow({ cantSplit: true, children: [tile(String(d.total), 'Total de marcaciones'), tile(String(d.promedioDiario), 'Promedio diario'), tile(String(d.rondasTotal), 'Rondas realizadas'), tile(d.cumplimiento + '%', 'Cumplimiento')] })]
  }));
  const idSano = d.sinIdentificar === 0;
  hijos.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [9360],
    borders: { ...NO_BORDER, left: { style: BorderStyle.SINGLE, size: 18, color: idSano ? GREEN : OCHRE } },
    rows: [new TableRow({ cantSplit: true, children: [cell([
      P(run(`${d.sinIdentificar} marcaciones sin identificar`, { bold: true, color: idSano ? GREEN : OCHRE, size: 22 }), { spacing: { after: 20 } }),
      P(run(idSano ? 'Cada marca quedó asociada a un guardia con usuario y PIN. Nadie marcó de forma anónima.' : 'Hay marcas cuyo guardia fue eliminado y ya no se pueden atribuir.', { color: GRAY, size: 18 }))
    ], { fill: idSano ? 'EEF3EF' : 'F6F0E6', ml: 200, mt: 140, mb: 140 })] })]
  }));

  // 2 · Estadísticas
  hijos.push(seccion('2', 'Estadísticas de la semana'));
  hijos.push(P(run('Marcaciones por día', { bold: true, size: 22 }), { spacing: { before: 120, after: 60 }, keepNext: true }));
  hijos.push(P(run('Puntos escaneados cada día de la semana.', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  const maxDia = Math.max(1, ...d.dias.map(x => x[1]));
  hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2600, 6000, 760], borders: NO_BORDER, rows: d.dias.map(([lab, v]) => barras(lab, v, maxDia)) }));

  hijos.push(P(run('Estado de las rondas', { bold: true, size: 22 }), { spacing: { before: 240, after: 60 }, keepNext: true }));
  hijos.push(P(run(`${d.rondasTotal} rondas realizadas durante la semana.`, { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
  const ib = Math.round(d.incompletas / d.rondasTotal * 30);
  const sb = Math.round(d.sospechosas / d.rondasTotal * 30);
  const cb = Math.max(0, 30 - ib - sb);
  hijos.push(P([run('█'.repeat(cb), { color: GREEN }), run('█'.repeat(ib), { color: OCHRE }), run('█'.repeat(sb), { color: RED })], { spacing: { after: 80 } }));
  const filaEstado = (color, nom, val, pctv) => new TableRow({ cantSplit: true, children: [
    cell(P(run('■', { color })), { width: 500, borders: NO_BORDER }),
    cell(P(run(nom, { size: 20 })), { width: 5000, borders: NO_BORDER }),
    cell(P(run(String(val), { bold: true, size: 20 }), { align: AlignmentType.RIGHT }), { width: 1500, borders: NO_BORDER }),
    cell(P(run(pctv, { color: GRAY, size: 20 }), { align: AlignmentType.RIGHT }), { width: 2360, borders: NO_BORDER })
  ] });
  const p100 = v => d.rondasTotal ? Math.round(v / d.rondasTotal * 100) + '%' : '0%';
  hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [500, 5000, 1500, 2360], borders: NO_BORDER, rows: [
    filaEstado(GREEN, 'Completas', d.completas, p100(d.completas)),
    filaEstado(OCHRE, 'Incompletas', d.incompletas, p100(d.incompletas)),
    filaEstado(RED, 'Sospechosas', d.sospechosas, p100(d.sospechosas))
  ] }));

  if (d.turno.dia.marc + d.turno.noche.marc > 0) {
    const nocheN = d.guardias.filter(g => g.turno === 'Noche').map(g => g.nombre.split(' ')[0]);
    const diaN = d.guardias.filter(g => g.turno === 'Día').map(g => g.nombre.split(' ')[0]);
    hijos.push(P(run('Reparto por turno', { bold: true, size: 22 }), { spacing: { before: 240, after: 60 }, keepNext: true }));
    hijos.push(P(run('Marcaciones según la hora de inicio de la ronda (día 06–18 h, noche el resto).', { color: GRAY, size: 18 }), { spacing: { after: 80 }, keepNext: true }));
    const nb = Math.round(d.turno.noche.pct / 100 * 30);
    hijos.push(P([run('█'.repeat(nb), { color: ACCENT }), run('█'.repeat(Math.max(0, 30 - nb)), { color: ACCENT_L })], { spacing: { after: 80 } }));
    hijos.push(P([run('■ ', { color: ACCENT }), run(`Noche · ${d.turno.noche.pct}% · ${d.turno.noche.marc} marcaciones${nocheN.length ? ' · ' + nocheN.join(', ') : ''}`, { size: 18, color: GRAY })], { spacing: { after: 20 } }));
    hijos.push(P([run('■ ', { color: '9788B4' }), run(`Día · ${d.turno.dia.pct}% · ${d.turno.dia.marc} marcaciones${diaN.length ? ' · ' + diaN.join(', ') : ''}`, { size: 18, color: GRAY })]));
  }

  // 3 · Por guardia
  hijos.push(seccion('3', 'Rondas por guardia'));
  hijos.push(tablaGuardias(d.guardias));

  // 4 · Puntos
  hijos.push(seccion('4', 'Puntos más marcados'));
  if (d.puntos.length) {
    const maxP = Math.max(1, ...d.puntos.map(x => x[1]));
    hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2600, 6000, 760], borders: NO_BORDER, rows: d.puntos.map(([nom, v]) => barras(nom, v, maxP)) }));
  } else {
    hijos.push(P(run('Sin marcaciones en el periodo.', { color: GRAY, size: 18 })));
  }

  // 5 · Incidencias
  hijos.push(seccion('5', 'Rondas con incidencias'));
  hijos.push(d.incidencias.length ? tablaIncidencias(d.incidencias) : P(run('No hubo rondas incompletas ni sospechosas esta semana.', { color: GREEN, size: 19 })));

  // 6 · Conclusión
  hijos.push(seccion('6', 'Conclusión'));
  hijos.push(P(run(conclusion(d), { size: 22 }), { spacing: { after: 120, line: 300 } }));
  hijos.push(P(run(`Informe generado por Rondas QR el ${d.generado}. El administrador recibe este documento por correo cada lunes y no necesita ingresar a la aplicación.`, { color: GRAY, size: 17, italics: true }), { spacing: { before: 200 } }));

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

function tablaIncidencias(incs) {
  const th = t => cell(P(run(t, { bold: true, color: WHITE, size: 18, caps: true, spacing: 20 }), { keepNext: true }), { fill: HEADFILL });
  const td = (t, o = {}) => cell(P(run(t, { size: 19, color: o.color, bold: o.bold }), { keepNext: o.keepNext }), { fill: o.fill });
  const rows = [new TableRow({ tableHeader: true, cantSplit: true, children: [th('Fecha y hora'), th('Guardia'), th('Tipo'), th('Detalle')] })];
  incs.forEach((x, i) => {
    const f = i % 2 ? ZEBRA : undefined; const keep = i < incs.length - 1;
    rows.push(new TableRow({ cantSplit: true, children: [
      td(x.fecha, { fill: f, color: GRAY, keepNext: keep }), td(x.guardia, { fill: f, bold: true, keepNext: keep }),
      td(x.tipo, { fill: f, color: x.tipoColor, bold: true, keepNext: keep }), td(x.detalle, { fill: f, keepNext: keep })
    ] }));
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [2320, 1820, 1420, 3800], borders: { top: hairline(LINE), bottom: hairline(LINE), insideHorizontal: hairline(LINE), left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, rows });
}

function conclusion(d) {
  const inc = d.incompletas + d.sospechosas;
  let t = `La semana cerró con un ${d.cumplimiento}% de rondas completas (${d.completas} de ${d.rondasTotal}) y ${d.sinIdentificar === 0 ? 'ninguna marcación sin identificar' : d.sinIdentificar + ' marcaciones sin identificar'}. `;
  if (inc === 0) t += 'No se registraron rondas incompletas ni sospechosas: cobertura completa. ';
  else t += `Se registraron ${d.incompletas} incompleta${d.incompletas === 1 ? '' : 's'} y ${d.sospechosas} sospechosa${d.sospechosas === 1 ? '' : 's'} que conviene revisar. `;
  if (d.puntos.length >= 2) t += `Los puntos más cubiertos fueron ${d.puntos[0][0]} y ${d.puntos[1][0]}; ${d.puntos[d.puntos.length - 1][0]} quedó al final del ranking.`;
  return t;
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

async function generarInformeSemanal(db, opciones) {
  const d = calcular(db, opciones);
  const buffer = await Packer.toBuffer(generarDocx(d));
  return { buffer, datos: d };
}

module.exports = { generarInformeSemanal, calcular };
