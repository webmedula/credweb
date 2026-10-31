'use strict';

const { criarPool, migrar } = require('./db');
const { criarApp } = require('./app');
const { VERSAO } = require('./versao');

const lista = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const limpar = v => String(v || '').trim().replace(/^["']|["']$/g, '');

function lerConfig(env = process.env) {
  return {
    cookieSeguro: env.COOKIE_SEGURO !== 'false',
    cadastroAberto: env.CADASTRO_ABERTO !== 'false',
    testeDias: Number(env.PLANO_TESTE_DIAS) || 14,
    testeAnalises: Number(env.PLANO_TESTE_ANALISES) || 10,
    cacheDias: env.CACHE_PUBLICO_DIAS === undefined ? 7 : Number(env.CACHE_PUBLICO_DIAS),
    superAdmins: lista(env.SUPERADMIN_EMAILS),
    chaves: {
      google: limpar(env.GOOGLE_MAPS_API_KEY),
      tavily: limpar(env.TAVILY_API_KEY),
      cnpja: limpar(env.CNPJA_API_KEY),
      portal: limpar(env.PORTAL_TRANSPARENCIA_CHAVE),
    },
  };
}

async function iniciar() {
  const db = criarPool();
  const feitas = await migrar(db);
  const config = lerConfig();
  const app = criarApp({ db, config, logger: { level: process.env.LOG_LEVEL || 'info' } });
  if (feitas.length) app.log.info('Migrações aplicadas: ' + feitas.join(', '));
  const faltam = Object.entries(config.chaves).filter(([, v]) => !v).map(([k]) => k);
  if (faltam.length) app.log.warn('Fontes sem chave (ficam como "não verificado"): ' + faltam.join(', '));
  if (!config.superAdmins.length) app.log.warn('SUPERADMIN_EMAILS vazio: ninguém acessa a administração da plataforma.');

  const fechar = async () => { await app.close(); await db.end(); process.exit(0); };
  process.on('SIGTERM', fechar);
  process.on('SIGINT', fechar);

  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
  app.log.info(`credweb ${VERSAO} no ar`);
}

if (require.main === module) {
  iniciar().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { lerConfig };
