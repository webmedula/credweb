'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { calcularScore, pontuarSecao } = require('../src/score');

const AGORA = Date.parse('2026-10-31T12:00:00Z');

const EMPRESA_BOA = {
  cnpj: '11222333000181', razao: 'EMPRESA BOA LTDA', situacao: 'ATIVA',
  abertura: '2005-01-10', dataSituacao: '2005-01-10', capital: 800000, porte: 'DEMAIS',
  mei: false, cnae: '4930202', socios: [{ nome: 'A', desde: '2005-01-10' }],
  regimeTributario: [{ ano: 2025 }, { ano: 2024 }, { ano: 2023 }],
};
const PESQUISA_LIMPA = {
  endereco: { itens: [] },
  maps: { status: 'ok', itens: [{ tipo: 'bom', texto: 'Aparece no Maps' }] },
  dominio: { status: 'ok', itens: [{ tipo: 'bom', texto: 'domínio antigo' }] },
  noticias: { status: 'ok', itens: [{ tipo: 'info', texto: 'Nenhuma notícia' }] },
  web: { status: 'ok', itens: [{ tipo: 'bom', texto: 'Reclame Aqui bom' }] },
  socios: { status: 'ok', itens: [{ tipo: 'bom', texto: 'sócios ok' }] },
  sancoes: { status: 'ok', itens: [{ tipo: 'bom', texto: 'Nada consta' }] },
};

test('os pesos somam 100', () => {
  const r = calcularScore({ empresa: EMPRESA_BOA, pesquisa: PESQUISA_LIMPA, agora: AGORA });
  assert.strictEqual(r.criterios.reduce((a, c) => a + c.max, 0), 100);
});

test('empresa ótima sem bureau fica limitada à faixa B', () => {
  const r = calcularScore({ empresa: EMPRESA_BOA, pesquisa: PESQUISA_LIMPA, config: { ramosAfins: ['49'] }, agora: AGORA });
  assert.ok(r.score >= 80, 'score ' + r.score);
  assert.strictEqual(r.faixa, 'B');
  assert.ok(r.alertas.some(a => /limitada à faixa B/.test(a)));
});

test('CNPJ baixado reprova', () => {
  const r = calcularScore({ empresa: { ...EMPRESA_BOA, situacao: 'BAIXADA' }, pesquisa: PESQUISA_LIMPA, agora: AGORA });
  assert.strictEqual(r.faixa, 'REPROVADO');
  assert.strictEqual(r.limite, null);
});

test('empresa em lista de punidos reprova', () => {
  const pesquisa = { ...PESQUISA_LIMPA, sancoes: { status: 'ok', itens: [{ tipo: 'ruim', texto: 'consta no CEIS' }] } };
  const r = calcularScore({ empresa: EMPRESA_BOA, pesquisa, agora: AGORA });
  assert.strictEqual(r.reprovado, true);
});

test('limite respeita a % da faixa e o teto em reais', () => {
  const r = calcularScore({ empresa: EMPRESA_BOA, pesquisa: PESQUISA_LIMPA, valor: 10000, agora: AGORA });
  assert.strictEqual(r.faixa, 'B');
  assert.strictEqual(r.limite, 7000);          // 70% na faixa B
  assert.strictEqual(r.entradaMinima, 3000);
  const t = calcularScore({ empresa: EMPRESA_BOA, pesquisa: PESQUISA_LIMPA, valor: 10000, config: { tetos: { B: 5000 } }, agora: AGORA });
  assert.strictEqual(t.limite, 5000);
  assert.ok(t.alertas.some(a => /teto da faixa B/.test(a)));
});

test('empresa nova com sócio recente e endereço ruim cai para C ou D', () => {
  const empresa = { ...EMPRESA_BOA, abertura: '2025-12-01', dataSituacao: '2025-12-01', capital: 1000, porte: 'ME', socios: [{ nome: 'X', desde: '2026-06-01' }], regimeTributario: [] };
  const pesquisa = { ...PESQUISA_LIMPA, endereco: { itens: [{ tipo: 'ruim', texto: 'caixa postal' }] }, maps: { status: 'ok', itens: [{ tipo: 'atencao', texto: 'não aparece' }] } };
  const r = calcularScore({ empresa, pesquisa, agora: AGORA });
  assert.ok(['C', 'D'].includes(r.faixa), r.faixa + ' ' + r.score);
  assert.ok(r.alertas.includes('caixa postal'));
});

test('fonte sem chave conta como não verificada, com metade dos pontos', () => {
  assert.deepStrictEqual(pontuarSecao([{ status: 'nao_configurado', itens: [] }], 10), { pontos: 5, aval: 'não verificado' });
  assert.deepStrictEqual(pontuarSecao([{ status: 'ok', itens: [{ tipo: 'atencao' }] }], 10), { pontos: 4, aval: 'pontos de atenção' });
});

test('sem pesquisa nenhuma ainda calcula', () => {
  const r = calcularScore({ empresa: EMPRESA_BOA, agora: AGORA });
  assert.ok(r.score > 0);
  assert.strictEqual(r.modo, 'basico');
});
