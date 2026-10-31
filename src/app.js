'use strict';

const path = require('path');
const Fastify = require('fastify');

const A = require('./auth');
const { consultarReceita, normalizarEmpresa, dadosBasicos, cnpjValido, soDigitos } = require('./fontes/receita');
const { pesquisarInternet } = require('./fontes/pesquisa');
const { calcularScore } = require('./score');
const { VERSAO } = require('./versao');

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGOU = new Set(['sim', 'atrasou', 'nao']);

/**
 * Monta o app. Tudo que fala com o mundo de fora é injetável para os testes:
 *   db       Pool do pg (ou algo com .query e .connect)
 *   fetch    usado pela Receita e pela pesquisa
 *   lookup   DNS da pesquisa
 *   config   chaves e parâmetros (ver lerConfig em server.js)
 */
function criarApp({ db, fetch: f = globalThis.fetch, lookup, config = {}, logger = false }) {
  const cfg = {
    cookieSeguro: config.cookieSeguro !== false,
    cadastroAberto: config.cadastroAberto !== false,
    testeDias: config.testeDias ?? 14,
    testeAnalises: config.testeAnalises ?? 10,
    cacheDias: config.cacheDias ?? 7,
    superAdmins: new Set((config.superAdmins || []).map(e => e.toLowerCase())),
    chaves: config.chaves || {},
  };

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });
  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), index: ['index.html'] });

  const limitador = A.criarLimitador();

  /* ---------- cabeçalhos de segurança e checagem de origem ---------- */
  app.addHook('onSend', async (req, reply, corpo) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return corpo;
  });

  // Requisição que muda algo precisa vir da própria página (defesa extra além do SameSite)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origem = req.headers.origin;
    if (origem) {
      let host;
      try { host = new URL(origem).host; } catch { host = null; }
      if (host !== req.headers.host) return reply.code(403).send({ erro: 'Origem não permitida.' });
    }
  });

  const ip = req => req.ip;
  const auditar = (usuario, acao, detalhe, req) => db.query(
    'INSERT INTO auditoria (empresa_id, usuario_id, acao, detalhe, ip) VALUES ($1, $2, $3, $4, $5)',
    [usuario ? usuario.empresa_id : null, usuario ? usuario.id : null, acao, detalhe ? JSON.stringify(detalhe) : null, req ? ip(req) : null]);

  function gravarCookie(reply, token, expira) {
    reply.setCookie(A.COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: cfg.cookieSeguro, expires: expira,
    });
  }

  async function exigirLogin(req, reply) {
    const u = await A.lerSessao(db, req.cookies[A.COOKIE]);
    if (!u) return reply.code(401).send({ erro: 'Faça login para continuar.' });
    req.usuario = u;
  }
  async function exigirAdmin(req, reply) {
    if (req.usuario.papel !== 'admin') return reply.code(403).send({ erro: 'Só o administrador da empresa pode fazer isso.' });
  }
  async function exigirSuperAdmin(req, reply) {
    if (!cfg.superAdmins.has(req.usuario.email)) return reply.code(404).send({ erro: 'Não encontrado.' });
  }

  /* ---------- uso do plano ---------- */
  const SQL_USO = `SELECT count(*)::int AS n FROM analises
                    WHERE empresa_id = $1
                      AND criada_em >= (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;

  function bloqueioDoPlano(u, usadas) {
    if (!u.empresa_ativa) return 'A conta da sua empresa está suspensa. Fale com o suporte.';
    if (u.plano === 'teste' && u.teste_ate && new Date(u.teste_ate) < hojeSP()) {
      return 'O período de teste acabou. Fale com o suporte para assinar um plano.';
    }
    if (usadas >= u.limite_mensal) return `Sua empresa já usou as ${u.limite_mensal} análises do mês.`;
    return null;
  }

  /* ---------- rotas públicas ---------- */
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, versao: VERSAO };
  });

  app.post('/api/cadastro', async (req, reply) => {
    if (!cfg.cadastroAberto) return reply.code(403).send({ erro: 'Cadastro fechado no momento.' });
    const b = req.body || {};
    const empresaNome = String(b.empresaNome || '').trim();
    const cnpj = soDigitos(b.empresaCnpj);
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    if (!empresaNome || !nome) return reply.code(400).send({ erro: 'Preencha o nome da empresa e o seu nome.' });
    if (!cnpjValido(cnpj)) return reply.code(400).send({ erro: 'CNPJ da sua empresa inválido.' });
    if (!EMAIL_OK.test(email)) return reply.code(400).send({ erro: 'E-mail inválido.' });
    if (senha.length < 8) return reply.code(400).send({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (b.aceiteTermos !== true) return reply.code(400).send({ erro: 'É preciso aceitar os termos de uso.' });

    const hash = await A.gerarHashSenha(senha);
    const cliente = await db.connect();
    let usuario;
    try {
      await cliente.query('BEGIN');
      const e = await cliente.query(
        `INSERT INTO empresas (nome, cnpj, plano, limite_mensal, teste_ate)
         VALUES ($1, $2, 'teste', $3, (now() AT TIME ZONE 'America/Sao_Paulo')::date + $4::int)
         ON CONFLICT (cnpj) DO NOTHING RETURNING id`,
        [empresaNome, cnpj, cfg.testeAnalises, cfg.testeDias]);
      if (!e.rows.length) { await cliente.query('ROLLBACK'); return reply.code(409).send({ erro: 'Essa empresa já tem conta. Peça acesso ao administrador dela.' }); }
      const u = await cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, papel, aceite_termos_em)
         VALUES ($1, $2, $3, $4, 'admin', now()) ON CONFLICT (email) DO NOTHING RETURNING id, empresa_id`,
        [e.rows[0].id, nome, email, hash]);
      if (!u.rows.length) { await cliente.query('ROLLBACK'); return reply.code(409).send({ erro: 'Esse e-mail já tem conta. Faça login.' }); }
      await cliente.query('COMMIT');
      usuario = u.rows[0];
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }
    await auditar(usuario, 'cadastro', { empresa: empresaNome, cnpj }, req);
    const s = await A.criarSessao(db, usuario.id);
    gravarCookie(reply, s.token, s.expira);
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/login', async (req, reply) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const senha = String((req.body || {}).senha || '');
    const chave = ip(req) + '|' + email;
    if (limitador.bloqueado(chave)) return reply.code(429).send({ erro: 'Muitas tentativas. Espere 15 minutos.' });
    const { rows } = await db.query('SELECT id, empresa_id, senha_hash FROM usuarios WHERE email = $1 AND ativo', [email]);
    const ok = rows.length ? await A.conferirSenha(senha, rows[0].senha_hash) : await A.conferirSenhaFalsa(senha);
    if (!ok) {
      limitador.falhou(chave);
      return reply.code(401).send({ erro: 'E-mail ou senha incorretos.' });
    }
    limitador.limpar(chave);
    const s = await A.criarSessao(db, rows[0].id);
    await auditar(rows[0], 'login', null, req);
    gravarCookie(reply, s.token, s.expira);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    await A.encerrarSessao(db, req.cookies[A.COOKIE]);
    reply.clearCookie(A.COOKIE, { path: '/' });
    return { ok: true };
  });

  /* ---------- rotas da conta ---------- */
  app.register(async rotas => {
    rotas.addHook('preHandler', exigirLogin);

    rotas.get('/api/eu', async req => {
      const u = req.usuario;
      const { rows } = await db.query(SQL_USO, [u.empresa_id]);
      return {
        usuario: { nome: u.nome, email: u.email, papel: u.papel },
        empresa: { nome: u.empresa_nome, cnpj: u.empresa_cnpj, plano: u.plano, testeAte: u.teste_ate, config: u.config },
        uso: { usadas: rows[0].n, limite: u.limite_mensal, bloqueio: bloqueioDoPlano(u, rows[0].n) },
        superAdmin: cfg.superAdmins.has(u.email),
        fontes: {
          googleMaps: !!cfg.chaves.google, tavily: !!cfg.chaves.tavily,
          cnpja: !!cfg.chaves.cnpja, portalTransparencia: !!cfg.chaves.portal,
        },
        versao: VERSAO,
      };
    });

    rotas.post('/api/analises', async (req, reply) => {
      const u = req.usuario;
      const b = req.body || {};
      const cnpj = soDigitos(b.cnpj);
      const valor = Number(b.valor) || 0;
      const entrada = Number(b.entrada) || 0;
      if (!cnpjValido(cnpj)) return reply.code(400).send({ erro: 'CNPJ inválido.' });
      if (valor < 0 || entrada < 0 || valor > 1e9 || entrada > 1e9) return reply.code(400).send({ erro: 'Valor ou entrada inválidos.' });

      const antes = (await db.query(SQL_USO, [u.empresa_id])).rows[0].n;
      const bloqueio = bloqueioDoPlano(u, antes);
      if (bloqueio) return reply.code(402).send({ erro: bloqueio });

      let receita;
      try {
        receita = await doCache(cnpj, 'receita', b.atualizar, () => consultarReceita(cnpj, { fetch: f }));
      } catch (e) {
        return reply.code(e.naoEncontrado ? 404 : 502).send({ erro: e.naoEncontrado ? 'CNPJ não encontrado na Receita Federal.' : e.message });
      }
      const empresa = normalizarEmpresa(receita.fonte, receita.dados);
      const pesquisa = await doCache(cnpj, 'pesquisa', b.atualizar, () => pesquisarInternet(dadosBasicos(receita.fonte, receita.dados), {
        fetch: f, lookup,
        chaveGoogle: cfg.chaves.google, chaveTavily: cfg.chaves.tavily,
        chaveCnpja: cfg.chaves.cnpja, chavePortal: cfg.chaves.portal,
      }));
      const resultado = calcularScore({ empresa, pesquisa, config: u.config || {}, valor, entrada });

      // Reconta dentro da transação, com a empresa travada, para duas análises
      // simultâneas não passarem do limite do plano.
      const cliente = await db.connect();
      let id, criadaEm;
      try {
        await cliente.query('BEGIN');
        await cliente.query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [u.empresa_id]);
        const agora = (await cliente.query(SQL_USO, [u.empresa_id])).rows[0].n;
        if (agora >= u.limite_mensal) {
          await cliente.query('ROLLBACK');
          return reply.code(402).send({ erro: `Sua empresa já usou as ${u.limite_mensal} análises do mês.` });
        }
        const r = await cliente.query(
          `INSERT INTO analises (empresa_id, usuario_id, cnpj, razao, valor, entrada, score, faixa, limite, modo, resultado)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, criada_em`,
          [u.empresa_id, u.id, cnpj, empresa.razao, valor || null, entrada || null, resultado.score, resultado.faixa,
            resultado.limite, resultado.modo, JSON.stringify({ ...resultado, empresa, pesquisa })]);
        await cliente.query('INSERT INTO auditoria (empresa_id, usuario_id, acao, detalhe, ip) VALUES ($1, $2, $3, $4, $5)',
          [u.empresa_id, u.id, 'analise', JSON.stringify({ cnpj, analise: r.rows[0].id, fontes: ['receita', 'pesquisa'] }), ip(req)]);
        await cliente.query('COMMIT');
        id = r.rows[0].id; criadaEm = r.rows[0].criada_em;
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        cliente.release();
      }
      return reply.code(201).send({ id: String(id), criadaEm, cnpj, valor, entrada, empresa, pesquisa, resultado });
    });

    rotas.get('/api/analises', async req => {
      const cnpj = soDigitos(req.query.cnpj);
      const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 500);
      const params = [req.usuario.empresa_id, limite];
      let filtro = '';
      if (cnpj) { params.push(cnpj + '%'); filtro = 'AND a.cnpj LIKE $3'; }
      const { rows } = await db.query(
        `SELECT a.id::text, a.cnpj, a.razao, a.valor, a.entrada, a.score, a.faixa, a.limite, a.modo, a.pagou, a.criada_em,
                u.nome AS usuario
           FROM analises a LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.empresa_id = $1 ${filtro}
          ORDER BY a.criada_em DESC LIMIT $2`, params);
      return { analises: rows };
    });

    rotas.get('/api/analises/:id', async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id)) return reply.code(404).send({ erro: 'Análise não encontrada.' });
      const { rows } = await db.query(
        `SELECT a.id::text, a.cnpj, a.valor, a.entrada, a.pagou, a.criada_em, a.resultado, u.nome AS usuario
           FROM analises a LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.id = $1 AND a.empresa_id = $2`, [id, req.usuario.empresa_id]);
      if (!rows.length) return reply.code(404).send({ erro: 'Análise não encontrada.' });
      const a = rows[0];
      const { empresa, pesquisa, ...resultado } = a.resultado;
      return { id: a.id, cnpj: a.cnpj, valor: Number(a.valor) || 0, entrada: Number(a.entrada) || 0, pagou: a.pagou,
        criadaEm: a.criada_em, usuario: a.usuario, empresa, pesquisa, resultado };
    });

    // "O cliente pagou?": é o dado que vai calibrar o score
    rotas.patch('/api/analises/:id', async (req, reply) => {
      const id = Number(req.params.id);
      const pagou = (req.body || {}).pagou ?? null;
      if (pagou !== null && !PAGOU.has(pagou)) return reply.code(400).send({ erro: 'Use sim, atrasou ou nao.' });
      if (!Number.isSafeInteger(id)) return reply.code(404).send({ erro: 'Análise não encontrada.' });
      const r = await db.query(
        `UPDATE analises SET pagou = $1, pagou_em = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END
          WHERE id = $2 AND empresa_id = $3`, [pagou, id, req.usuario.empresa_id]);
      if (!r.rowCount) return reply.code(404).send({ erro: 'Análise não encontrada.' });
      await auditar(req.usuario, 'pagou', { analise: id, pagou }, req);
      return { ok: true };
    });

    rotas.put('/api/empresa/config', { preHandler: exigirAdmin }, async (req, reply) => {
      const b = req.body || {};
      const tetos = {};
      for (const k of ['A', 'B', 'C']) {
        const v = b.tetos && b.tetos[k];
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (!(n > 0) || n > 1e9) return reply.code(400).send({ erro: `Teto da faixa ${k} inválido.` });
        tetos[k] = n;
      }
      const ramosAfins = [...new Set((Array.isArray(b.ramosAfins) ? b.ramosAfins : [])
        .map(r => soDigitos(r).slice(0, 2)).filter(r => r.length === 2))];
      const config = { tetos, ramosAfins };
      await db.query('UPDATE empresas SET config = $1 WHERE id = $2', [JSON.stringify(config), req.usuario.empresa_id]);
      await auditar(req.usuario, 'config', config, req);
      return { ok: true, config };
    });

    /* ---------- administração da plataforma (só SUPERADMIN_EMAILS) ---------- */
    rotas.get('/api/admin/empresas', { preHandler: exigirSuperAdmin }, async () => {
      const { rows } = await db.query(
        `SELECT e.id::text, e.nome, e.cnpj, e.plano, e.limite_mensal, e.ativa, e.teste_ate, e.criada_em,
                (SELECT count(*)::int FROM usuarios u WHERE u.empresa_id = e.id) AS usuarios,
                (SELECT count(*)::int FROM analises a WHERE a.empresa_id = e.id
                   AND a.criada_em >= date_trunc('month', now())) AS analises_mes
           FROM empresas e ORDER BY e.criada_em DESC`);
      return { empresas: rows };
    });

    rotas.patch('/api/admin/empresas/:id', { preHandler: exigirSuperAdmin }, async (req, reply) => {
      const b = req.body || {};
      const campos = [], params = [];
      if (b.plano !== undefined) {
        if (!['teste', 'basico', 'profissional'].includes(b.plano)) return reply.code(400).send({ erro: 'Plano inválido.' });
        params.push(b.plano); campos.push(`plano = $${params.length}`);
      }
      if (b.limiteMensal !== undefined) {
        const n = Number(b.limiteMensal);
        if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ erro: 'Limite inválido.' });
        params.push(n); campos.push(`limite_mensal = $${params.length}`);
      }
      if (b.ativa !== undefined) { params.push(!!b.ativa); campos.push(`ativa = $${params.length}`); }
      if (b.testeAte !== undefined) { params.push(b.testeAte || null); campos.push(`teste_ate = $${params.length}`); }
      if (!campos.length) return reply.code(400).send({ erro: 'Nada para alterar.' });
      params.push(Number(req.params.id));
      const r = await db.query(`UPDATE empresas SET ${campos.join(', ')} WHERE id = $${params.length}`, params);
      if (!r.rowCount) return reply.code(404).send({ erro: 'Empresa não encontrada.' });
      await auditar(req.usuario, 'admin_empresa', { empresa: req.params.id, ...b }, req);
      return { ok: true };
    });
  });

  /* ---------- cache de fontes públicas ---------- */
  async function doCache(cnpj, tipo, atualizar, buscar) {
    if (!atualizar && cfg.cacheDias > 0) {
      const { rows } = await db.query(
        `SELECT dados FROM cache_publico WHERE cnpj = $1 AND tipo = $2 AND criado_em > now() - make_interval(days => $3)`,
        [cnpj, tipo, cfg.cacheDias]);
      if (rows.length) return rows[0].dados;
    }
    const dados = await buscar();
    await db.query(
      `INSERT INTO cache_publico (cnpj, tipo, dados) VALUES ($1, $2, $3)
       ON CONFLICT (cnpj, tipo) DO UPDATE SET dados = EXCLUDED.dados, criado_em = now()`,
      [cnpj, tipo, JSON.stringify(dados)]);
    return dados;
  }

  app.setErrorHandler((err, req, reply) => {
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ erro: 'Requisição inválida.' });
    if (err.statusCode === 413) return reply.code(413).send({ erro: 'Requisição grande demais.' });
    req.log.error(err);
    reply.code(500).send({ erro: 'Erro interno. Tente de novo em instantes.' });
  });

  return app;
}

function hojeSP() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return new Date(s + 'T00:00:00Z');
}

module.exports = { criarApp };
