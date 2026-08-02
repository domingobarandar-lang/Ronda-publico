// A quién le llega el informe semanal.
//
// Un administrador puede tener más de un condominio (una corredora con dos, o
// con diez). El correo del lunes se agrupa POR DESTINATARIO: recibe UN solo
// mensaje con el .docx de cada uno de sus condominios adjunto, en vez de un
// correo por condominio. Cada administrador ve lo suyo y nada del vecino.
//
// El destinatario es el interruptor: un condominio sin correos cargados no se
// manda. INFORME_TO queda como respaldo global para los que no tengan ninguno
// (útil en pruebas y recién desplegado, antes de que los admins carguen el suyo).
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

const esCorreo = texto => EMAIL.test(String(texto || '').trim());

// Acepta lista o texto separado por comas, punto y coma o espacios. Normaliza a
// minúsculas (así "Admin@X.cl" y "admin@x.cl" no son dos destinatarios) y deja
// fuera repetidos y lo que no parezca un correo.
function normalizarCorreos(valor) {
  const crudos = Array.isArray(valor) ? valor : String(valor || '').split(/[,;\s]+/);
  const limpios = [];
  for (const crudo of crudos) {
    const correo = String(crudo || '').trim().toLowerCase();
    if (correo && esCorreo(correo) && !limpios.includes(correo)) limpios.push(correo);
  }
  return limpios;
}

// Los correos de un condominio, o el respaldo si no tiene ninguno propio.
function correosDelCondominio(condominio, respaldo) {
  const propios = normalizarCorreos((condominio || {}).correosInforme);
  return propios.length ? propios : normalizarCorreos(respaldo);
}

// [{ correo, condominioIds }] — un grupo por destinatario. Orden alfabético
// estable: el log del lunes se lee siempre igual y los tests no dependen del
// orden en que estén los condominios en la base.
function agruparPorDestinatario(condominios, { respaldo } = {}) {
  const porCorreo = new Map();
  for (const condominio of condominios || []) {
    for (const correo of correosDelCondominio(condominio, respaldo)) {
      if (!porCorreo.has(correo)) porCorreo.set(correo, []);
      porCorreo.get(correo).push(condominio.id);
    }
  }
  return [...porCorreo.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([correo, condominioIds]) => ({ correo, condominioIds }));
}

module.exports = { esCorreo, normalizarCorreos, correosDelCondominio, agruparPorDestinatario };
