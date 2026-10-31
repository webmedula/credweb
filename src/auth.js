'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'credweb_sessao';
const DURACAO_SESSAO_MS = 30 * 24 * 3600 * 1000;
const PARAMS = { N: 16384, r: 8, p: 1 };

async function gerarHashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(senha, sal, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

async function conferirSenha(senha, guardado) {
  const [alg, n, sal64, hash64] = String(guardado || '').split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(hash64, 'base64');
  const obtido = await scrypt(senha, Buffer.from(sal64, 'base64'), esperado.length, { ...PARAMS, N: Number(n) });
  return crypto.timingSafeEqual(esperado, obtido);
}

// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (não revela quem tem conta)
let hashFalso = null;
async function conferirSenhaFalsa(senha) {
  if (!hashFalso) hashFalso = await gerarHashSenha('senha-que-nao-existe');
  await conferirSenha(senha, hashFalso);
  return false;
}

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

async function criarSessao(db, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + DURACAO_SESSAO_MS);
  await db.query('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES ($1, $2, $3)', [hashToken(token), usuarioId, expira]);
  // Limpeza oportunista das vencidas
  await db.query('DELETE FROM sessoes WHERE expira_em < now()');
  return { token, expira };
}

async function lerSessao(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.nome, u.email, u.papel, u.empresa_id,
            e.nome AS empresa_nome, e.cnpj AS empresa_cnpj, e.plano, e.limite_mensal, e.ativa AS empresa_ativa,
            e.teste_ate, e.config
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       JOIN empresas e ON e.id = u.empresa_id
      WHERE s.token_hash = $1 AND s.expira_em > now() AND u.ativo`,
    [hashToken(token)]);
  return rows[0] || null;
}

async function encerrarSessao(db, token) {
  if (token) await db.query('DELETE FROM sessoes WHERE token_hash = $1', [hashToken(token)]);
}

/** Limite simples de tentativas por chave (IP + e-mail), em memória. */
function criarLimitador({ max = 8, janelaMs = 15 * 60 * 1000 } = {}) {
  const tentativas = new Map();
  return {
    bloqueado(chave) {
      const t = tentativas.get(chave);
      if (!t) return false;
      if (Date.now() - t.inicio > janelaMs) { tentativas.delete(chave); return false; }
      return t.n >= max;
    },
    falhou(chave) {
      const t = tentativas.get(chave);
      if (!t || Date.now() - t.inicio > janelaMs) tentativas.set(chave, { n: 1, inicio: Date.now() });
      else t.n++;
    },
    limpar(chave) { tentativas.delete(chave); },
  };
}

module.exports = {
  COOKIE, DURACAO_SESSAO_MS, gerarHashSenha, conferirSenha, conferirSenhaFalsa,
  criarSessao, lerSessao, encerrarSessao, criarLimitador,
};
