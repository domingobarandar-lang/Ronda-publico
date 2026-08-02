// QA del reparto del informe semanal: quién recibe qué cuando un mismo
// administrador tiene varios condominios. Todo en memoria: cero correos, cero
// llamadas externas.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { esCorreo, normalizarCorreos, correosDelCondominio, agruparPorDestinatario } = require('../lib/destinatarios');

const cond = (id, correosInforme) => ({ id, nombre: id, correosInforme });

test('normaliza: minúsculas, sin repetidos y sin basura', () => {
  assert.deepEqual(normalizarCorreos('Ana@Correo.cl, ana@correo.cl'), ['ana@correo.cl']);
  assert.deepEqual(normalizarCorreos('  ana@correo.cl ;  luis@correo.cl  '), ['ana@correo.cl', 'luis@correo.cl']);
  assert.deepEqual(normalizarCorreos(['ana@correo.cl', 'no-es-correo', '', null]), ['ana@correo.cl']);
  assert.deepEqual(normalizarCorreos(undefined), []);
  assert.equal(esCorreo('ana@correo.cl'), true);
  assert.equal(esCorreo('ana@correo'), false);
});

test('4 administradores con 2 condominios cada uno = 4 correos, 2 adjuntos por correo', () => {
  const condominios = [
    cond('aromos', ['ana@corredora.cl']), cond('mirador', ['ana@corredora.cl']),
    cond('portal', ['luis@corredora.cl']), cond('vista', ['luis@corredora.cl']),
    cond('parque', ['sofia@corredora.cl']), cond('lomas', ['sofia@corredora.cl']),
    cond('piloto-sf', ['diego@corredora.cl']), cond('altos', ['diego@corredora.cl'])
  ];
  const grupos = agruparPorDestinatario(condominios);

  assert.equal(grupos.length, 4, 'un correo por administrador, no uno por condominio');
  assert.deepEqual(grupos.map(g => g.correo),
    ['ana@corredora.cl', 'diego@corredora.cl', 'luis@corredora.cl', 'sofia@corredora.cl'],
    'orden alfabético estable');
  for (const g of grupos) assert.equal(g.condominioIds.length, 2);
  assert.deepEqual(grupos.find(g => g.correo === 'ana@corredora.cl').condominioIds, ['aromos', 'mirador']);
});

test('nadie ve los condominios de otro administrador', () => {
  const grupos = agruparPorDestinatario([
    cond('aromos', ['ana@corredora.cl']),
    cond('portal', ['luis@corredora.cl'])
  ]);
  assert.deepEqual(grupos.find(g => g.correo === 'ana@corredora.cl').condominioIds, ['aromos']);
  assert.deepEqual(grupos.find(g => g.correo === 'luis@corredora.cl').condominioIds, ['portal']);
});

test('el comité recibe solo su condominio y el administrador los dos', () => {
  const grupos = agruparPorDestinatario([
    cond('aromos', ['ana@corredora.cl', 'comite.aromos@correo.cl']),
    cond('mirador', ['ana@corredora.cl'])
  ]);
  assert.equal(grupos.length, 2);
  assert.deepEqual(grupos.find(g => g.correo === 'ana@corredora.cl').condominioIds, ['aromos', 'mirador']);
  assert.deepEqual(grupos.find(g => g.correo === 'comite.aromos@correo.cl').condominioIds, ['aromos']);
});

test('sin correo cargado no se manda nada; con respaldo, va al respaldo', () => {
  const condominios = [cond('aromos', []), cond('mirador', ['ana@corredora.cl'])];

  assert.deepEqual(agruparPorDestinatario(condominios), [
    { correo: 'ana@corredora.cl', condominioIds: ['mirador'] }
  ], 'aromos queda fuera: el destinatario es el interruptor');

  assert.deepEqual(agruparPorDestinatario(condominios, { respaldo: 'fabrica@rondas.cl' }), [
    { correo: 'ana@corredora.cl', condominioIds: ['mirador'] },
    { correo: 'fabrica@rondas.cl', condominioIds: ['aromos'] }
  ], 'el respaldo NO se mete donde el administrador ya puso su correo');

  assert.deepEqual(correosDelCondominio(cond('x', ['ana@corredora.cl']), 'fabrica@rondas.cl'), ['ana@corredora.cl']);
  assert.deepEqual(correosDelCondominio(cond('x', []), 'fabrica@rondas.cl'), ['fabrica@rondas.cl']);
  assert.deepEqual(correosDelCondominio({ id: 'sin-campo' }, undefined), [], 'condominio viejo sin el campo no rompe');
});

test('el mismo correo escrito distinto es un solo destinatario', () => {
  const grupos = agruparPorDestinatario([
    cond('aromos', ['Ana@Corredora.cl']),
    cond('mirador', ['ana@corredora.cl'])
  ]);
  assert.equal(grupos.length, 1, 'mayúsculas no duplican el envío');
  assert.deepEqual(grupos[0].condominioIds, ['aromos', 'mirador']);
});
