'use strict';

/**
 * Receita Federal pelas bases públicas (BrasilAPI, com CNPJ.ws de reserva).
 * O fetch é injetável para os testes.
 */

const { dadosBasicos } = require('./pesquisa');

const soDigitos = s => String(s || '').replace(/\D/g, '');

/** Valida os dígitos verificadores do CNPJ. */
function cnpjValido(v) {
  const c = soDigitos(v);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = base => {
    let soma = 0, peso = base.length - 7;
    for (const n of base) { soma += Number(n) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(String(d1) + String(d2));
}

async function consultarReceita(cnpj, { fetch: f = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const falhas = [];
  const tentar = async (nome, url) => {
    try {
      const r = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return { fonte: nome, dados: await r.json() };
      falhas.push(`${nome} HTTP ${r.status}`);
      if (r.status === 404) return { naoEncontrado: true };
    } catch (e) {
      falhas.push(`${nome} inacessível (${e.message})`);
    }
    return null;
  };
  const brasil = await tentar('BrasilAPI', 'https://brasilapi.com.br/api/cnpj/v1/' + cnpj);
  if (brasil && !brasil.naoEncontrado) return brasil;
  const ws = await tentar('CNPJ.ws', 'https://publica.cnpj.ws/cnpj/' + cnpj);
  if (ws && !ws.naoEncontrado) return ws;
  const erro = new Error('Não foi possível consultar o CNPJ nas bases públicas. ' + falhas.join(' · ') + '.');
  erro.naoEncontrado = !!(brasil && brasil.naoEncontrado && ws && ws.naoEncontrado);
  throw erro;
}

/** Converte a resposta bruta no formato que o score usa. */
function normalizarEmpresa(fonte, d) {
  if (fonte === 'CNPJ.ws') {
    const e = d.estabelecimento || {};
    return {
      cnpj: soDigitos(e.cnpj),
      razao: d.razao_social || '—', fantasia: e.nome_fantasia || '',
      situacao: String(e.situacao_cadastral || '').toUpperCase(),
      motivoSituacao: (e.motivo_situacao_cadastral && e.motivo_situacao_cadastral.descricao) || '',
      dataSituacao: e.data_situacao_cadastral || null, abertura: e.data_inicio_atividade || null,
      capital: Number(d.capital_social) || 0,
      porte: String((d.porte && (d.porte.descricao || d.porte.id)) || '').toUpperCase(),
      mei: !!(d.simples && d.simples.mei === 'Sim'), simples: !!(d.simples && d.simples.simples === 'Sim'),
      exclusaoSimples: (d.simples && d.simples.data_exclusao_simples) || null,
      cnae: String((e.atividade_principal && e.atividade_principal.id) || ''),
      cnaeDesc: (e.atividade_principal && e.atividade_principal.descricao) || '',
      naturezaJuridica: (d.natureza_juridica && d.natureza_juridica.descricao) || '',
      situacaoEspecial: e.situacao_especial || '',
      cidade: ((e.cidade && e.cidade.nome) || '') + (e.estado ? '/' + e.estado.sigla : ''),
      endereco: [e.tipo_logradouro, e.logradouro, e.numero].filter(Boolean).join(' ')
        + (e.bairro ? ', ' + e.bairro : '') + (e.cep ? ' · CEP ' + e.cep : ''),
      email: e.email || '',
      regimeTributario: [],
      socios: (d.socios || []).map(s => ({
        nome: s.nome || '—',
        qualificacao: (s.qualificacao_socio && s.qualificacao_socio.descricao) || '',
        desde: s.data_entrada || null,
      })),
    };
  }
  return {
    cnpj: soDigitos(d.cnpj),
    razao: d.razao_social || d.nome_fantasia || '—', fantasia: d.nome_fantasia || '',
    situacao: String(d.descricao_situacao_cadastral || d.situacao_cadastral || '').toUpperCase(),
    motivoSituacao: d.descricao_motivo_situacao_cadastral || '',
    dataSituacao: d.data_situacao_cadastral || null, abertura: d.data_inicio_atividade || null,
    capital: Number(d.capital_social) || 0,
    porte: String(d.porte || d.descricao_porte || d.codigo_porte || '').toUpperCase(),
    mei: d.opcao_pelo_mei === true, simples: d.opcao_pelo_simples === true,
    exclusaoSimples: d.data_exclusao_do_simples || null,
    cnae: String(d.cnae_fiscal || ''), cnaeDesc: d.cnae_fiscal_descricao || '',
    naturezaJuridica: d.natureza_juridica || '',
    situacaoEspecial: d.situacao_especial || '',
    cidade: (d.municipio || '') + (d.uf ? '/' + d.uf : ''),
    endereco: [d.descricao_tipo_de_logradouro, d.logradouro, d.numero, d.complemento].filter(Boolean).join(' ')
      + (d.bairro ? ', ' + d.bairro : '') + (d.cep ? ' · CEP ' + d.cep : ''),
    email: d.email || '',
    // Histórico de escrituração fiscal: mostra se a empresa vem declarando todo ano
    regimeTributario: (d.regime_tributario || []).filter(r => r && r.ano)
      .map(r => ({ ano: Number(r.ano), forma: r.forma_de_tributacao || '' }))
      .sort((a, b) => b.ano - a.ano),
    socios: (d.qsa || []).map(s => ({
      nome: s.nome_socio || s.nome || '—',
      qualificacao: s.qualificacao_socio || '',
      desde: s.data_entrada_sociedade || null,
    })),
  };
}

module.exports = { consultarReceita, normalizarEmpresa, dadosBasicos, cnpjValido, soDigitos };
