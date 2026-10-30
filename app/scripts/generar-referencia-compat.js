// Genera la referencia del test de compatibilidad (test/compat-qr.test.js):
// corre test/compat/escenario-qr.js contra OTRA copia de la app —la versión en
// producción— y guarda lo que hizo.
//
// Uso (desde app/), con una copia de la versión anterior al lado:
//   git worktree add ../../v122 v1.22.0-o-el-commit && ln -s "$PWD/node_modules" ../../v122/app/node_modules
//   node scripts/generar-referencia-compat.js ../../v122/app test/fixtures/referencia-qr-v1.22.json
// Solo hace falta regenerarla para comparar contra otra versión de base.
'use strict';

const fs = require('fs');
const path = require('path');
const { correrEscenario } = require('../test/compat/escenario-qr');

(async () => {
  const [, , appAnterior, salida] = process.argv;
  if (!appAnterior || !salida) {
    console.error('Uso: node scripts/generar-referencia-compat.js <carpeta app/ de la versión anterior> <archivo de salida>');
    process.exit(1);
  }
  const raiz = path.resolve(appAnterior);
  const version = require(path.join(raiz, 'package.json')).version;
  const resultado = await correrEscenario({
    crearApp: require(path.join(raiz, 'server')).crearApp,
    datosSemilla: require(path.join(raiz, 'seed')).datosSemilla,
    calcularSemanal: require(path.join(raiz, 'lib/informe-semanal')).calcular,
    appJs: fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8'),
    geoJs: fs.readFileSync(path.join(raiz, 'public/geo.js'), 'utf8')
  });
  fs.writeFileSync(salida, JSON.stringify({ version, ...resultado }, null, 1) + '\n');
  console.log(`Referencia de la v${version} guardada en ${salida}`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
