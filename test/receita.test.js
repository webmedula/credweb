'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cnpjValido, normalizarEmpresa, consultarReceita } = require('../src/fontes/receita');

test('valida dígitos do CNPJ', () => {
  assert.strictEqual(cnpjValido('11.222.333/0001-81'), true);
  assert.strictEqual(cnpjValido('11222333000182'), false);
  assert.strictEqual(cnpjValido('11111111111111'), false);
  assert.strictEqual(cnpjValido('123'), false);
});

test('normaliza BrasilAPI', () => {
  const e = normalizarEmpresa('BrasilAPI', {
    cnpj: '11222333000181', razao_social: 'X LTDA', descricao_situacao_cadastral: 'Ativa',
    capital_social: '1000.50', cnae_fiscal: 4930202, opcao_pelo_mei: false,
    regime_tributario: [{ ano: 2023 }, { ano: 2025 }],
    qsa: [{ nome_socio: 'FULANO', data_entrada_sociedade: '2020-01-01' }],
  });
  assert.strictEqual(e.situacao, 'ATIVA');
  assert.strictEqual(e.capital, 1000.5);
  assert.strictEqual(e.cnae, '4930202');
  assert.deepStrictEqual(e.regimeTributario.map(r => r.ano), [2025, 2023]);
  assert.strictEqual(e.socios[0].desde, '2020-01-01');
});

test('cai para o CNPJ.ws quando a BrasilAPI falha', async () => {
  const f = async url => url.includes('brasilapi')
    ? { ok: false, status: 500 }
    : { ok: true, status: 200, json: async () => ({ razao_social: 'Y' }) };
  const r = await consultarReceita('11222333000181', { fetch: f });
  assert.strictEqual(r.fonte, 'CNPJ.ws');
});

test('404 nas duas bases vira "não encontrado"', async () => {
  const f = async () => ({ ok: false, status: 404 });
  await assert.rejects(consultarReceita('11222333000181', { fetch: f }), e => e.naoEncontrado === true);
});
