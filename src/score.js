'use strict';

/**
 * Score do modo Básico (sem bureau): 0 a 100, calculado no servidor.
 *
 *   Receita Federal ........ 60   tempo de atividade, capital, ramo, porte,
 *                                 estabilidade, quadro societário, regularidade fiscal
 *   Fontes públicas ........ 40   sanções (CEIS/CNEP/TCU), presença física
 *                                 (endereço + Google Maps), sócios e outras
 *                                 empresas deles, e-mail/domínio, reputação
 *                                 (notícias + web)
 *
 * Reprova direto: CNPJ não ATIVO, situação especial na Receita, empresa em
 * lista de punidos pelo governo.
 *
 * Sem bureau não há faixa A: o teto do modo Básico é a faixa B. A régua ainda
 * não foi calibrada com inadimplência real; o campo "pagou?" do histórico é
 * o que vai permitir calibrar.
 *
 * Função pura: não faz rede nem banco. `agora` é injetável para os testes.
 */

const FAIXAS = {
  A: { nome: 'Baixo risco', pctLimite: 1.0, entradaMin: 10, parcelas: 4, rec: 'Aprovar crediário.' },
  B: { nome: 'Risco moderado', pctLimite: 0.7, entradaMin: 20, parcelas: 3, rec: 'Aprovar com condições.' },
  C: { nome: 'Risco elevado', pctLimite: 0.5, entradaMin: 40, parcelas: 2, rec: 'Somente com aval do gerente, com garantia ou fiador.' },
  D: { nome: 'Risco muito alto', pctLimite: 0, entradaMin: 70, parcelas: 1, rec: 'Não recomendado conceder crediário. Ofereça venda à vista ou cartão.' },
};

const TETO_MODO_BASICO = 'B';

const anosDesde = (s, agora) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : (agora - d) / (365.25 * 864e5);
};
const fmtBRL = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const arred = v => Math.round(v * 100) / 100;

/**
 * Pontua uma seção da pesquisa pelos tipos dos itens:
 * ruim → 0 · atenção → 40% · só informativo → 70% · bom → 100%.
 * Fonte que falhou ou não está configurada fica com metade, como "não verificado".
 */
function pontuarSecao(secoes, max) {
  const lista = secoes.filter(Boolean);
  const itens = lista.flatMap(s => s.itens || []);
  const tipos = new Set(itens.map(i => i.tipo));
  // 'parcial' sem nenhum sinal (só itens informativos) = a fonte não chegou a verificar
  const naoVerificado = lista.length > 0 && lista.every(s => s.status === 'erro' || s.status === 'nao_configurado'
    || (s.status === 'parcial' && !(s.itens || []).some(i => i.tipo !== 'info')));
  if (tipos.has('ruim')) return { pontos: 0, aval: 'problema encontrado' };
  if (tipos.has('atencao')) return { pontos: Math.round(max * 0.4), aval: 'pontos de atenção' };
  if (naoVerificado || !lista.length) return { pontos: Math.round(max * 0.5), aval: 'não verificado' };
  if (tipos.has('bom')) return { pontos: max, aval: 'sem problemas' };
  return { pontos: Math.round(max * 0.7), aval: 'nada encontrado' };
}

function calcularScore({ empresa, pesquisa = null, config = {}, valor = 0, entrada = 0, agora = Date.now() }) {
  const criterios = [], alertas = [];
  let score = 0, reprovado = false;
  const add = (criterio, avaliacao, pontos, max, grupo) => {
    criterios.push({ grupo, criterio, avaliacao, pontos, max });
    score += pontos;
  };

  /* ---------- reprovação direta ---------- */
  const sit = String(empresa.situacao || '');
  const ativa = sit.includes('ATIVA') || sit === '2' || sit === '02';
  if (!ativa) { reprovado = true; alertas.push(`CNPJ não está ATIVO na Receita Federal (situação: ${sit || 'não informada'}).`); }
  if (empresa.situacaoEspecial) { reprovado = true; alertas.push('Situação especial na Receita: ' + empresa.situacaoEspecial + '.'); }

  /* ---------- Receita Federal · 60 ---------- */
  const R = 'Receita Federal';
  const anos = anosDesde(empresa.abertura, agora);
  let p, t;
  if (anos === null) { p = 0; t = 'sem data de abertura'; }
  else if (anos >= 15) { p = 20; t = anos.toFixed(0) + ' anos'; }
  else if (anos >= 8) { p = 16; t = anos.toFixed(0) + ' anos'; }
  else if (anos >= 4) { p = 12; t = anos.toFixed(1).replace('.', ',') + ' anos'; }
  else if (anos >= 2) { p = 6; t = anos.toFixed(1).replace('.', ',') + ' anos'; }
  else { p = 2; t = 'menos de 2 anos'; }
  add('Tempo de atividade', t, p, 20, R);

  const c = Number(empresa.capital) || 0;
  add('Capital social', fmtBRL(c), c >= 500000 ? 9 : c >= 100000 ? 7 : c >= 30000 ? 4 : 1, 9, R);

  const afins = Array.isArray(config.ramosAfins) ? config.ramosAfins.map(String).filter(Boolean) : [];
  const cnae2 = String(empresa.cnae || '').slice(0, 2);
  if (!afins.length) add('Ramo de atividade', 'não configurado pela sua empresa', 3, 5, R);
  else if (afins.includes(cnae2)) add('Ramo de atividade', 'setor que você atende', 5, 5, R);
  else add('Ramo de atividade', 'fora dos setores que você atende', 2, 5, R);

  const porte = String(empresa.porte || '');
  add('Porte', empresa.mei ? 'MEI' : (porte || 'não informado'),
    empresa.mei ? 1 : /EPP|PEQUENO/.test(porte) ? 4 : /^ME$|MICRO/.test(porte) ? 3 : porte ? 5 : 3, 5, R);

  const anosSit = anosDesde(empresa.dataSituacao, agora);
  add('Estabilidade cadastral', anosSit !== null ? anosSit.toFixed(1).replace('.', ',') + ' anos na situação atual' : 'sem data',
    anosSit !== null && anosSit >= 2 ? 5 : 2, 5, R);

  // Troca de sócio recente em empresa madura é sinal clássico de CNPJ comprado
  const socios = Array.isArray(empresa.socios) ? empresa.socios : [];
  const recentes = socios.filter(s => { const a = anosDesde(s.desde, agora); return a !== null && a < 1; });
  if (!socios.length) { p = 4; t = 'quadro não informado'; }
  else if (!recentes.length) { p = 8; t = socios.length + ' sócio(s), sem entrada recente'; }
  else if (anos !== null && anos >= 3) {
    p = 1; t = recentes.length + ' sócio(s) entraram há menos de 12 meses';
    alertas.push('Mudança societária recente em empresa de ' + anos.toFixed(0) + ' anos.');
  } else { p = 6; t = 'empresa nova, quadro recente (esperado)'; }
  add('Quadro societário', t, p, 8, R);

  const rt = empresa.regimeTributario || [];
  const anoAtual = new Date(agora).getFullYear();
  if (empresa.exclusaoSimples) {
    p = 1; t = 'excluída do Simples Nacional';
    alertas.push('Excluída do Simples Nacional: a causa mais comum é débito tributário.');
  } else if (!rt.length) { p = 4; t = 'sem histórico de escrituração na base pública'; }
  else if (rt[0].ano >= anoAtual - 2 && rt.length >= 3) { p = 8; t = rt.length + ' anos declarados, até ' + rt[0].ano; }
  else if (rt[0].ano >= anoAtual - 2) { p = 6; t = rt.length + ' ano(s) declarado(s), até ' + rt[0].ano; }
  else { p = 2; t = 'última escrituração em ' + rt[0].ano; alertas.push('Sem escrituração fiscal registrada desde ' + rt[0].ano + '.'); }
  add('Regularidade fiscal', t, p, 8, R);

  /* ---------- Fontes públicas · 40 ---------- */
  const F = 'Fontes públicas';
  const ps = pesquisa || {};

  const sanc = ps.sancoes;
  if (sanc && (sanc.itens || []).some(i => i.tipo === 'ruim')) {
    reprovado = true;
    alertas.push('Empresa em lista de punidos pelo governo (CEIS/CNEP/TCU).');
    add('Sanções do governo', 'consta em lista de punidos', 0, 10, F);
  } else if (sanc && sanc.status === 'ok') add('Sanções do governo', 'nada consta', 10, 10, F);
  else if (sanc && sanc.status === 'parcial') add('Sanções do governo', 'nada consta nas listas conferidas', 8, 10, F);
  else add('Sanções do governo', 'não verificado', 5, 10, F);

  const pres = pontuarSecao([ps.endereco && { status: 'ok', itens: ps.endereco.itens }, ps.maps], 10);
  add('Presença física (endereço e Google Maps)', pres.aval, pres.pontos, 10, F);

  const soc = pontuarSecao([ps.socios], 10);
  add('Sócios e outras empresas deles', soc.aval, soc.pontos, 10, F);

  const dom = pontuarSecao([ps.dominio], 5);
  add('E-mail e domínio', dom.aval, dom.pontos, 5, F);

  const rep = pontuarSecao([ps.noticias, ps.web], 5);
  add('Reputação (notícias e web)', rep.aval, rep.pontos, 5, F);

  for (const chave of ['endereco', 'maps', 'dominio', 'noticias', 'socios', 'web']) {
    for (const i of ((ps[chave] && ps[chave].itens) || [])) {
      if (i.tipo === 'ruim' || i.tipo === 'atencao') alertas.push(i.texto);
    }
  }

  score = Math.max(0, Math.min(100, score));

  /* ---------- faixa e limite ---------- */
  let letra = null, limite = null, entradaMinima = null, recomendacao, limitadaPeloModo = false, pelaTeto = false;
  const tetos = (config && config.tetos) || {};
  if (reprovado) {
    letra = 'REPROVADO';
    recomendacao = 'Não conceder crediário. Ofereça somente venda à vista ou cartão.';
  } else {
    letra = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
    if (letra === 'A') { letra = TETO_MODO_BASICO; limitadaPeloModo = true; }
    const fx = FAIXAS[letra];
    recomendacao = fx.rec;
    if (fx.pctLimite > 0 && valor > 0) {
      const teto = Number(tetos[letra]) > 0 ? Number(tetos[letra]) : Infinity;
      limite = arred(Math.min(valor * (1 - fx.entradaMin / 100), valor * fx.pctLimite, teto));
      entradaMinima = arred(valor - limite);
      pelaTeto = teto < valor * Math.min(1 - fx.entradaMin / 100, fx.pctLimite);
      recomendacao += ` Crediário de até ${fmtBRL(limite)}, com entrada mínima de ${fmtBRL(entradaMinima)} e até ${fx.parcelas} parcela(s).`;
      if (pelaTeto) alertas.push(`A compra passa do teto da faixa ${letra} (${fmtBRL(teto)}); o restante precisa vir de entrada.`);
      if (entrada > 0 && entrada < entradaMinima) alertas.push(`A entrada oferecida (${fmtBRL(entrada)}) está abaixo do mínimo de ${fmtBRL(entradaMinima)}.`);
    } else if (fx.pctLimite > 0) {
      recomendacao += ` Entrada mínima de ${fx.entradaMin}% e até ${fx.parcelas} parcela(s). Informe o valor da compra para ver em reais.`;
    }
    if (limitadaPeloModo) alertas.push('A pontuação chegaria à faixa A, mas sem consulta a bureau a análise fica limitada à faixa B.');
  }

  return {
    modo: 'basico',
    score,
    faixa: letra,
    faixaNome: letra === 'REPROVADO' ? 'Reprovado' : FAIXAS[letra].nome,
    reprovado,
    limite, entradaMinima,
    parcelas: letra && FAIXAS[letra] ? FAIXAS[letra].parcelas : 0,
    recomendacao,
    alertas: [...new Set(alertas)],
    criterios,
    aviso: 'Análise sem bureau de crédito: usa só a Receita Federal e fontes públicas. Não mostra dívidas, protestos nem negativações.',
  };
}

module.exports = { calcularScore, pontuarSecao, FAIXAS };
