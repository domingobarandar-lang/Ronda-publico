// Datos semilla de demo: dos condominios con guardias, puntos y rondas.
// Uso:
//   node seed.js            → siembra la demo en la base (data/rondas.sqlite)
//   node seed.js --si-vacio → siembra solo si la base está vacía (npm run demo
//                             y el arranque en Railway)
const { crearStore, VACIA } = require('./lib/store');
const { hashPin } = require('./lib/auth');

// Misma resolución que el servidor: sin DB_PATH, data/rondas.sqlite.
const RUTA = process.env.DB_PATH;

function datosSemilla() {
  const db = VACIA();

  db.condominios.push(
    // codigoRegistro: el administrador se lo entrega a sus guardias para que
    // creen su cuenta solos (se puede ver/cambiar/regenerar desde el panel).
    // correosInforme: a quién le llega el informe semanal del lunes. Si un mismo
    // administrador tiene varios condominios, va su correo en cada uno y recibe
    // un solo mensaje con todos los informes adjuntos.
    { id: 'aromos', nombre: 'Condominio Los Aromos', codigoRegistro: 'AROMOS', correosInforme: [] },
    { id: 'mirador', nombre: 'Condominio Mirador del Valle', codigoRegistro: 'MIRADOR', correosInforme: [] }
  );

  db.usuarios.push(
    // Pareja de prueba para recorrer la app con los dos perfiles (mismo condominio):
    { id: 'u-admin', condominioId: 'aromos', usuario: 'admin', nombre: 'Administrador de prueba', rol: 'admin', pinHash: hashPin('1234') },
    { id: 'u-guardia', condominioId: 'aromos', usuario: 'guardia', nombre: 'Guardia de prueba', rol: 'guardia', pinHash: hashPin('5678') },
    { id: 'u-marta', condominioId: 'aromos', usuario: 'marta', nombre: 'Marta (administradora)', rol: 'admin', pinHash: hashPin('1111') },
    { id: 'u-pedro', condominioId: 'aromos', usuario: 'pedro', nombre: 'Pedro Soto', rol: 'guardia', pinHash: hashPin('2222') },
    { id: 'u-luis', condominioId: 'aromos', usuario: 'luis', nombre: 'Luis Rojas', rol: 'guardia', pinHash: hashPin('3333') },
    { id: 'u-carmen', condominioId: 'mirador', usuario: 'carmen', nombre: 'Carmen (administradora)', rol: 'admin', pinHash: hashPin('4444') },
    { id: 'u-jorge', condominioId: 'mirador', usuario: 'jorge', nombre: 'Jorge Díaz', rol: 'guardia', pinHash: hashPin('5555') }
  );

  // Códigos cortos fijos para la demo (sin 0/O/1/I, únicos entre condominios).
  const puntosAromos = [
    ['p-porteria', 'Portería', 'PRT234'],
    ['p-estacionamiento', 'Estacionamiento A', 'EST456'],
    ['p-quincho', 'Quincho', 'QCH789'],
    ['p-piscina', 'Piscina', 'PSC234'],
    ['p-bodega', 'Bodega', 'BDG567'],
    ['p-bombas', 'Sala de bombas', 'BMB892'],
    ['p-trasero', 'Acceso trasero', 'TRS345'],
    ['p-sede', 'Sede social', 'SDS678']
  ];
  const puntosMirador = [
    ['p-m-acceso', 'Acceso principal', 'MAP234'],
    ['p-m-terraza', 'Terraza', 'MTR567'],
    ['p-m-subterraneo', 'Subterráneo', 'MSB892']
  ];
  for (const [pid, nombre, codigo] of puntosAromos) {
    db.puntos.push({ id: pid, condominioId: 'aromos', nombre, codigoCorto: codigo });
  }
  for (const [pid, nombre, codigo] of puntosMirador) {
    db.puntos.push({ id: pid, condominioId: 'mirador', nombre, codigoCorto: codigo });
  }

  db.rondas.push(
    {
      id: 'ronda-nocturna',
      condominioId: 'aromos',
      nombre: 'Nocturna completa',
      puntoIds: puntosAromos.map(p => p[0]),
      ordenEstricto: true,
      duracionMaxMin: 45
    },
    {
      id: 'ronda-express',
      condominioId: 'aromos',
      nombre: 'Perimetral express',
      puntoIds: ['p-porteria', 'p-quincho', 'p-piscina', 'p-trasero'],
      ordenEstricto: false,
      duracionMaxMin: 20
    },
    {
      id: 'ronda-mirador',
      condominioId: 'mirador',
      nombre: 'Ronda general',
      puntoIds: puntosMirador.map(p => p[0]),
      ordenEstricto: true,
      duracionMaxMin: 15
    }
  );

  return db;
}

// "Vacía" se decide mirando el CONTENIDO, no si existe un archivo: desde la
// v1.17 el db.json se importa y se renombra, y mirar el archivo haría que el
// arranque de Railway (`seed.js --si-vacio && server.js`) sembrara la demo
// encima de producción en el deploy siguiente. Abrir el store ya importa el
// db.json si lo hay, así que esto ve los datos reales.
function estaVacia(store) {
  return !store.db.condominios.length && !store.db.usuarios.length && !store.ejecuciones.contar();
}

function sembrar({ soloSiVacio = false } = {}) {
  const store = crearStore(RUTA);
  if (soloSiVacio && !estaVacia(store)) {
    console.log('La base ya tiene datos — se conserva tal cual (usa "node seed.js" para resembrar la demo).');
    store.cerrar();
    return false;
  }
  Object.assign(store.db, datosSemilla());
  store.guardar();
  console.log('Base de demo sembrada en', store.ruta);
  store.cerrar();
  console.log(`
Usuarios de prueba (usuario / PIN):
  Para ti           → administrador: admin / 1234 · guardia: guardia / 5678 (mismo condominio)
  Los Aromos        → admin: marta / 1111 · guardias: pedro / 2222, luis / 3333
  Mirador del Valle → admin: carmen / 4444 · guardia: jorge / 5555
  (cada administrador ve solo SU condominio; para recorrerlos todos desde el
   panel, configura la cuenta de acceso total con ADMIN_TOTAL_* en app/.env)

Código de registro (para que un guardia cree su cuenta solo desde la app):
  Los Aromos → AROMOS · Mirador del Valle → MIRADOR
  (el administrador lo ve y lo cambia en el panel → pestaña Guardias)
`);
  return true;
}

if (require.main === module) {
  sembrar({ soloSiVacio: process.argv.includes('--si-vacio') });
}

module.exports = { datosSemilla, sembrar, estaVacia };
