// Fechas en la zona horaria de Chile (maneja el cambio de horario solo).
// Las ejecuciones guardan el inicio en ISO; los rangos que pide el panel y el
// informe semanal son días de CHILE. Convertir mal es mandar las rondas de
// 21:00-23:59 del domingo a la semana siguiente.
const TZ = 'America/Santiago';

const isoChile = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const horaChile = ts => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const esFecha = f => FECHA.test(String(f || '')) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`));

function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

// Primer instante (ISO UTC) del día `fecha` en Chile. Los desfases de Chile son
// horas enteras, así que el día empieza en una hora en punto UTC: la primera
// que ya cae en esa fecha (vale también el día del cambio de horario).
function inicioDiaChile(fecha) {
  const base = Date.parse(`${fecha}T00:00:00Z`);
  for (let h = 0; h <= 8; h++) {
    const t = base + h * 3600000;
    if (isoChile(t) === fecha) return new Date(t).toISOString();
  }
  return new Date(base + 3 * 3600000).toISOString();
}

module.exports = { TZ, isoChile, horaChile, esFecha, sumarDias, inicioDiaChile };
