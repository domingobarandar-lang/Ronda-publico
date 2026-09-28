// Genera un informe semanal de ejemplo (.docx) con datos inventados, para ver
// el formato sin tocar la base real: 3 guardias, 6 puntos, una semana con dos
// rondas incompletas, una sospechosa y un día con una ronda menos.
//   node scripts/informe-ejemplo.js [salida.docx]
// Por defecto escribe entrega/ejemplos/Informe-semanal-ejemplo-v2.docx.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore } = require('../lib/store');
const { generarInformeSemanal, revisarCoherencia } = require('../lib/informe-semanal');

async function main(salida) {
  const store = crearStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rondasqr-ejemplo-')), 'rondas.sqlite'));
  store.db.condominios.push({ id: 'c1', nombre: 'Condominio Los Aromos' });
  store.db.usuarios.push({ id: 'g1', nombre: 'Pedro Soto' }, { id: 'g2', nombre: 'Ana Rojas' }, { id: 'g3', nombre: 'Luis Díaz' });
  ['Portería', 'Estacionamiento visitas', 'Sala de bombas', 'Quincho', 'Piscina', 'Bodega norte']
    .forEach((nombre, i) => store.db.puntos.push({ id: 'p' + i, condominioId: 'c1', nombre }));
  const ids = store.db.puntos.map(p => p.id);

  let k = 0;
  for (let dia = 14; dia <= 20; dia++) {
    for (const hora of ['09', '14', '22', '03']) {
      k++;
      if (dia === 17 && hora === '14') continue;               // el jueves faltó una ronda
      const inicio = `2026-09-${dia}T${hora}:10:00-03:00`;
      const deDia = Number(hora) >= 6 && Number(hora) < 18;
      const guardiaId = deDia ? (dia >= 19 ? 'g3' : 'g1') : 'g2';
      let faltantes = [], estado = 'completa', sospechas = [];
      if (k === 5 || k === 17) { faltantes = ['p3']; estado = 'incompleta'; }
      if (k === 22) { estado = 'sospechosa'; sospechas = ['Marcas con 2 s de diferencia']; }
      store.ejecuciones.guardar({
        id: 'e' + k, rondaId: 'r1', condominioId: 'c1', guardiaId, inicio, fin: inicio, estado,
        escaneos: ids.filter(p => !faltantes.includes(p)).map(puntoId => ({ puntoId, ts: inicio })),
        evaluacion: { faltantes, sospechas, observaciones: [] }
      });
    }
  }

  const r = await generarInformeSemanal(store, { condominioId: 'c1', desde: '2026-09-14', hasta: '2026-09-20' });
  const problemas = revisarCoherencia(r.datos);
  store.cerrar();
  if (problemas.length) throw new Error('El ejemplo no cuadra: ' + problemas.join('; '));
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  fs.writeFileSync(salida, r.buffer);
  console.log(`Informe de ejemplo: ${salida}`);
}

if (require.main === module) {
  main(process.argv[2] || path.join(__dirname, '..', '..', 'entrega', 'ejemplos', 'Informe-semanal-ejemplo-v2.docx'))
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { main };
