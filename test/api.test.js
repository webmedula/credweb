'use strict';

/**
 * Testa a API de ponta a ponta contra um Postgres de verdade.
 * Precisa de DATABASE_URL_TESTE (o banco é APAGADO a cada execução).
 *   DATABASE_URL_TESTE=postgres://postgres@localhost/credweb_teste npm run teste
 */

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { migrar } = require('../src/db');
const { criarApp } = require('../src/app');
const { gerarHashSenha } = require('../src/auth');

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const opcoes = { skip: URL_TESTE ? false : 'defina DATABASE_URL_TESTE para rodar os testes da API' };

const CNPJ_CLIENTE = '11222333000181';   // quem é analisado
const CNPJ_LOJA_1 = '11444777000161';
const CNPJ_LOJA_2 = '45723174000110';

const chamadas = [];
async function fetchFalso(url) {
  chamadas.push(String(url));
  if (String(url).startsWith('https://brasilapi.com.br/api/cnpj/v1/')) {
    return {
      ok: true, status: 200, json: async () => ({
        cnpj: CNPJ_CLIENTE, razao_social: 'TRANSPORTES EXEMPLO LTDA', descricao_situacao_cadastral: 'ATIVA',
        data_inicio_atividade: '2008-03-01', data_situacao_cadastral: '2008-03-01', capital_social: 250000,
        porte: 'DEMAIS', cnae_fiscal: 4930202, email: '', municipio: 'GOIANIA', uf: 'GO',
        qsa: [{ nome_socio: 'FULANO DE TAL', data_entrada_sociedade: '2008-03-01', identificador_de_socio: 2 }],
      }),
    };
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
}

let pool, app;

function cookieDe(res) {
  const c = res.headers['set-cookie'];
  const linha = Array.isArray(c) ? c[0] : c;
  return linha.split(';')[0];
}

async function cadastrar(cnpj, email) {
  const res = await app.inject({ method: 'POST', url: '/api/cadastro', payload: {
    empresaNome: 'Loja ' + cnpj, empresaCnpj: cnpj, nome: 'Dono', email, senha: 'senha-forte-1', aceiteTermos: true,
  } });
  assert.strictEqual(res.statusCode, 201, res.body);
  return cookieDe(res);
}

test.describe('API', opcoes, () => {
  let loja1, loja2;

  test.before(async () => {
    pool = new Pool({ connectionString: URL_TESTE });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrar(pool);
    app = criarApp({
      db: pool, fetch: fetchFalso, lookup: async () => { throw new Error('sem DNS no teste'); },
      config: { cookieSeguro: false, superAdmins: ['root@credweb.test'], cacheDias: 7 },
    });
    await app.ready();
    loja1 = await cadastrar(CNPJ_LOJA_1, 'dono1@loja.test');
    loja2 = await cadastrar(CNPJ_LOJA_2, 'dono2@loja.test');
  });
  test.after(async () => { await app.close(); await pool.end(); });

  test('health responde', async () => {
    const r = await app.inject('/health');
    assert.strictEqual(r.statusCode, 200);
  });

  test('cadastro rejeita CNPJ inválido e empresa repetida', async () => {
    const base = { empresaNome: 'X', nome: 'Y', email: 'z@z.test', senha: '12345678', aceiteTermos: true };
    let r = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { ...base, empresaCnpj: '11222333000182' } });
    assert.strictEqual(r.statusCode, 400);
    r = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { ...base, empresaCnpj: CNPJ_LOJA_1 } });
    assert.strictEqual(r.statusCode, 409);
    r = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { ...base, empresaCnpj: '04252011000110', aceiteTermos: false } });
    assert.strictEqual(r.statusCode, 400);
  });

  test('login', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'dono1@loja.test', senha: 'errada' } });
    assert.strictEqual(r.statusCode, 401);
    r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'DONO1@loja.test', senha: 'senha-forte-1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.match(r.headers['set-cookie'], /HttpOnly/);
  });

  test('rotas da conta exigem login', async () => {
    const r = await app.inject('/api/eu');
    assert.strictEqual(r.statusCode, 401);
  });

  test('pedido de outra origem é recusado', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/analises', headers: { cookie: loja1, origin: 'https://malicioso.test', host: 'credweb.test' }, payload: { cnpj: CNPJ_CLIENTE } });
    assert.strictEqual(r.statusCode, 403);
  });

  let idAnalise;
  test('faz análise, grava no histórico e usa o cache na segunda vez', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/analises', headers: { cookie: loja1 }, payload: { cnpj: '11.222.333/0001-81', valor: 10000, entrada: 3000 } });
    assert.strictEqual(r.statusCode, 201, r.body);
    const a = r.json();
    idAnalise = a.id;
    assert.strictEqual(a.empresa.razao, 'TRANSPORTES EXEMPLO LTDA');
    assert.ok(['B', 'C', 'D'].includes(a.resultado.faixa), a.resultado.faixa);
    assert.strictEqual(a.resultado.modo, 'basico');

    const antes = chamadas.filter(u => u.includes('brasilapi.com.br/api/cnpj')).length;
    r = await app.inject({ method: 'POST', url: '/api/analises', headers: { cookie: loja1 }, payload: { cnpj: CNPJ_CLIENTE } });
    assert.strictEqual(r.statusCode, 201);
    assert.strictEqual(chamadas.filter(u => u.includes('brasilapi.com.br/api/cnpj')).length, antes);

    r = await app.inject({ url: '/api/analises', headers: { cookie: loja1 } });
    assert.strictEqual(r.json().analises.length, 2);
    r = await app.inject({ url: '/api/eu', headers: { cookie: loja1 } });
    assert.strictEqual(r.json().uso.usadas, 2);
  });

  test('uma empresa não vê a análise da outra', async () => {
    let r = await app.inject({ url: '/api/analises/' + idAnalise, headers: { cookie: loja2 } });
    assert.strictEqual(r.statusCode, 404);
    r = await app.inject({ url: '/api/analises', headers: { cookie: loja2 } });
    assert.strictEqual(r.json().analises.length, 0);
    r = await app.inject({ method: 'PATCH', url: '/api/analises/' + idAnalise, headers: { cookie: loja2 }, payload: { pagou: 'nao' } });
    assert.strictEqual(r.statusCode, 404);
    r = await app.inject({ url: '/api/analises/' + idAnalise, headers: { cookie: loja1 } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.json().empresa.razao, 'TRANSPORTES EXEMPLO LTDA');
  });

  test('marca se o cliente pagou', async () => {
    let r = await app.inject({ method: 'PATCH', url: '/api/analises/' + idAnalise, headers: { cookie: loja1 }, payload: { pagou: 'talvez' } });
    assert.strictEqual(r.statusCode, 400);
    r = await app.inject({ method: 'PATCH', url: '/api/analises/' + idAnalise, headers: { cookie: loja1 }, payload: { pagou: 'sim' } });
    assert.strictEqual(r.statusCode, 200);
    r = await app.inject({ url: '/api/analises/' + idAnalise, headers: { cookie: loja1 } });
    assert.strictEqual(r.json().pagou, 'sim');
  });

  test('limite do plano bloqueia a análise', async () => {
    await pool.query('UPDATE empresas SET limite_mensal = 2 WHERE cnpj = $1', [CNPJ_LOJA_1]);
    const r = await app.inject({ method: 'POST', url: '/api/analises', headers: { cookie: loja1 }, payload: { cnpj: CNPJ_CLIENTE } });
    assert.strictEqual(r.statusCode, 402);
  });

  test('teste vencido bloqueia a análise', async () => {
    await pool.query("UPDATE empresas SET teste_ate = '2020-01-01' WHERE cnpj = $1", [CNPJ_LOJA_2]);
    const r = await app.inject({ method: 'POST', url: '/api/analises', headers: { cookie: loja2 }, payload: { cnpj: CNPJ_CLIENTE } });
    assert.strictEqual(r.statusCode, 402);
    assert.match(r.json().erro, /teste acabou/);
    await pool.query('UPDATE empresas SET teste_ate = NULL WHERE cnpj = $1', [CNPJ_LOJA_2]);
  });

  test('só o admin muda a configuração', async () => {
    const { rows } = await pool.query('SELECT id FROM empresas WHERE cnpj = $1', [CNPJ_LOJA_2]);
    await pool.query(`INSERT INTO usuarios (empresa_id, nome, email, senha_hash, papel) VALUES ($1, 'Vend', 'vend@loja.test', $2, 'vendedor')`,
      [rows[0].id, await gerarHashSenha('senha-vendedor')]);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'vend@loja.test', senha: 'senha-vendedor' } });
    const vend = cookieDe(login);
    let r = await app.inject({ method: 'PUT', url: '/api/empresa/config', headers: { cookie: vend }, payload: { tetos: { A: 1 } } });
    assert.strictEqual(r.statusCode, 403);
    r = await app.inject({ method: 'PUT', url: '/api/empresa/config', headers: { cookie: loja2 }, payload: { tetos: { A: 50000, B: '20000', C: '' }, ramosAfins: ['49', '4930-2/02', 'x'] } });
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.deepStrictEqual(r.json().config, { tetos: { A: 50000, B: 20000 }, ramosAfins: ['49'] });
  });

  test('administração da plataforma é só para SUPERADMIN_EMAILS', async () => {
    let r = await app.inject({ url: '/api/admin/empresas', headers: { cookie: loja1 } });
    assert.strictEqual(r.statusCode, 404);
    const raiz = await cadastrar('04252011000110', 'root@credweb.test');
    r = await app.inject({ url: '/api/admin/empresas', headers: { cookie: raiz } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.json().empresas.length, 3);
    const id = r.json().empresas.find(e => e.cnpj === CNPJ_LOJA_1).id;
    r = await app.inject({ method: 'PATCH', url: '/api/admin/empresas/' + id, headers: { cookie: raiz }, payload: { ativa: false } });
    assert.strictEqual(r.statusCode, 200);
    r = await app.inject({ url: '/api/eu', headers: { cookie: loja1 } });
    assert.match(r.json().uso.bloqueio, /suspensa/);
  });

  test('logout encerra a sessão', async () => {
    await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: loja2 } });
    const r = await app.inject({ url: '/api/eu', headers: { cookie: loja2 } });
    assert.strictEqual(r.statusCode, 401);
  });
});
