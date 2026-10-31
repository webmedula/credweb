'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PASTA_SQL = path.join(__dirname, '..', 'sql');

function criarPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL não configurada.');
  return new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX) || 10 });
}

/**
 * Aplica, em ordem, os arquivos sql/NNN_*.sql que ainda não rodaram.
 * Cada arquivo roda numa transação; um advisory lock evita que duas
 * instâncias migrem ao mesmo tempo.
 */
async function migrar(pool) {
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT pg_advisory_lock(727274)');
    await cliente.query(`CREATE TABLE IF NOT EXISTS migracoes (
      nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await cliente.query('SELECT nome FROM migracoes');
    const feitas = new Set(rows.map(r => r.nome));
    const arquivos = fs.readdirSync(PASTA_SQL).filter(a => /^\d+_.*\.sql$/.test(a)).sort();
    const aplicadas = [];
    for (const arq of arquivos) {
      if (feitas.has(arq)) continue;
      const sql = fs.readFileSync(path.join(PASTA_SQL, arq), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migracoes (nome) VALUES ($1)', [arq]);
        await cliente.query('COMMIT');
        aplicadas.push(arq);
      } catch (e) {
        await cliente.query('ROLLBACK');
        throw new Error(`Migração ${arq} falhou: ${e.message}`);
      }
    }
    return aplicadas;
  } finally {
    await cliente.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    cliente.release();
  }
}

module.exports = { criarPool, migrar };
