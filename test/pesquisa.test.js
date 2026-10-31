/**
 * Testa a pesquisa na internet (pesquisa.js) com respostas falsas:
 * não chama Google, registro.br, CNPJá nem BrasilAPI.
 *
 *   node scripts/teste-pesquisa.js
 */

'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'fontes', 'pesquisa.js'));

let falhas = 0;
function conferir(descricao, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log('  ' + (ok ? '✓' : '✕') + ' ' + descricao.padEnd(56) +
    (ok ? '' : 'obtido: ' + JSON.stringify(obtido) + ' · esperado: ' + JSON.stringify(esperado)));
}

const AGORA = Date.parse('2026-10-27T12:00:00Z');

/* ---------- respostas falsas, por URL ---------- */
function resposta(status, corpo, headers = {}) {
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] || null },
    json: async () => JSON.parse(texto), text: async () => texto,
  };
}

function falso(rotas) {
  const chamadas = [];
  const f = async (url, init = {}) => {
    chamadas.push(url);
    for (const [padrao, fn] of rotas) if (url.includes(padrao)) return fn(url, init);
    return resposta(404, {});
  };
  f.chamadas = chamadas;
  return f;
}
const lookupPublico = async () => [{ address: '200.160.2.3', family: 4 }];

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Transportadora Falcão inaugura filial em Goiânia - Jornal do Agro</title><link>https://n/1</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><source url="x">Jornal do Agro</source></item>
<item><title>Deputado estadual de GO é investigado por fraude - Plural</title><link>https://n/3</link><pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate><source url="x">Plural</source></item>
<item><title>Polícia investiga fraude em cargas da Transportadora Falcão &amp; Cia - G1</title><link>https://n/2</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><source url="x">G1</source></item>
</channel></rss>`;

const EMPRESA = {
  cnpj: '11222333000181', razao: 'TRANSPORTADORA FALCAO LTDA', fantasia: 'FALCAO LOG',
  abertura: '2015-03-10', email: 'financeiro@falcaolog.com.br',
  logradouro: 'RUA DAS FLORES', numero: '100', complemento: 'APTO 12', bairro: 'CENTRO',
  municipio: 'GOIANIA', uf: 'GO', cep: '74000000',
  socios: [{ nome: 'JOAO DA SILVA', documento: '***123456**', pj: false }],
};

(async () => {
  console.log('\nUTILITÁRIOS\n');
  conferir('tira LTDA do nome', P.nomeLimpo('TRANSPORTADORA FALCAO LTDA'), 'TRANSPORTADORA FALCAO');
  conferir('tira "- ME" e CPF de MEI', P.nomeLimpo('12.345.678 JOAO DA SILVA - ME'), 'JOAO DA SILVA');
  conferir('nome do Maps bate com o da empresa', P.mesmoNome('Falcão Log Transportes', 'TRANSPORTADORA FALCAO LTDA', 'FALCAO LOG'), true);
  conferir('palavra genérica sozinha não basta', P.mesmoNome('Auto Posto Central', 'AUTO POSTO SAO JOSE LTDA'), false);
  conferir('CNPJ da matriz a partir da raiz', P.cnpjMatriz('11222333'), '11222333000181');
  conferir('domínio .com.br registrado', P.dominioRegistrado('mail.falcaolog.com.br'), 'falcaolog.com.br');
  conferir('domínio .com', P.dominioRegistrado('www.empresa.com'), 'empresa.com');
  conferir('IP interno é bloqueado', ['10.0.0.1', '127.0.0.1', '192.168.1.1', '::1', '200.160.2.3'].map(P.ipPrivado), [true, true, true, true, false]);
  conferir('complemento de residência vira atenção', P.verificarEndereco(EMPRESA).itens.map(i => i.tipo), ['atencao']);
  conferir('caixa postal vira ruim', P.verificarEndereco({ ...EMPRESA, complemento: 'CAIXA POSTAL 12' }).itens.map(i => i.tipo), ['ruim']);
  conferir('RSS: título sem a fonte e entidades', P.lerRss(RSS).map(n => n.titulo)[2], 'Polícia investiga fraude em cargas da Transportadora Falcão & Cia');

  console.log('\nPESQUISA COMPLETA, SEM CHAVES\n');
  {
    const f = falso([
      ['rdap.registro.br', () => resposta(200, { events: [{ eventAction: 'registration', eventDate: '2026-08-01T00:00:00Z' }] })],
      ['https://falcaolog.com.br/', () => resposta(200, '<html><title>Falcão Log</title><body>' + 'x'.repeat(300) + ' CNPJ 11.222.333/0001-81</body></html>')],
      ['news.google.com', () => resposta(200, RSS)],
    ]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('Maps sem chave não chama o Google', [r.maps.status, f.chamadas.some(u => u.includes('googleapis'))], ['nao_configurado', false]);
    conferir('Maps sem chave ainda dá o link do endereço', r.maps.linkBusca.startsWith('https://www.google.com/maps/search/'), true);
    conferir('domínio novo em empresa antiga vira atenção', r.dominio.itens[0].tipo, 'atencao');
    conferir('site no ar e mostra o CNPJ', [r.dominio.site.noAr, r.dominio.site.mostraCnpj], [true, true]);
    conferir('notícia de risco vem primeiro', r.noticias.noticias[0].risco, true);
    conferir('notícia de risco vira atenção', r.noticias.itens[0].tipo, 'atencao');
    conferir('notícia sem o nome da empresa é descartada', [r.noticias.total, r.noticias.descartadas], [2, 1]);
    conferir('busca na web sem chave fica desligada', r.web.status, 'nao_configurado');
    conferir('TCU fora do ar não derruba a pesquisa', r.sancoes.status, 'erro');
    conferir('sócio PF sem chave do CNPJá fica de fora', [r.socios.status, r.socios.itens[0].tipo], ['parcial', 'info']);
    conferir('links de pesquisa manual', r.links.map(l => l.rotulo), ['Google', 'Google: golpe, fraude, calote', 'Reclame Aqui', 'Jusbrasil']);
  }

  console.log('\nE-MAIL\n');
  {
    const f = falso([]);
    const r = await P.pesquisarInternet({ ...EMPRESA, email: 'falcao@gmail.com' }, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('gmail é provedor gratuito, sem consulta', [r.dominio.gratuito, f.chamadas.some(u => u.includes('rdap'))], [true, false]);
  }
  {
    const f = falso([['rdap.registro.br', () => resposta(404, {})]]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('domínio inexistente vira atenção', [r.dominio.registrado, r.dominio.itens[0].tipo], [false, 'atencao']);
  }
  {
    const f = falso([['rdap.registro.br', () => resposta(200, { events: [] })]]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: async () => [{ address: '10.1.2.3' }], agora: AGORA });
    conferir('não acessa site que resolve para IP interno', f.chamadas.some(u => u.startsWith('https://falcaolog')), false);
  }
  {
    const f = falso([
      ['rdap.registro.br', () => resposta(200, { events: [{ eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' }] })],
      ['https://contabilbeta.com.br/', () => resposta(200, '<title>Contabilidade Beta</title>' + 'x'.repeat(300))],
    ]);
    const r = await P.pesquisarInternet({ ...EMPRESA, email: 'fiscal@contabilbeta.com.br' }, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('e-mail do contador é identificado', r.dominio.itens.map(i => i.tipo), ['info']);
  }

  console.log('\nGOOGLE MAPS\n');
  const ponto = { latitude: -16.68, longitude: -49.25 };
  const longe = { latitude: -16.60, longitude: -49.25 };
  const lugar = (nome, loc, extra = {}) => ({ displayName: { text: nome }, formattedAddress: 'Rua X, Goiânia', location: loc, types: ['establishment'], ...extra });
  const maps = (porNome, porEndereco) => falso([['places.googleapis.com', (u, init) =>
    resposta(200, { places: JSON.parse(init.body).textQuery.includes('RUA DAS FLORES') ? porEndereco : porNome })]]);
  {
    const f = maps([lugar('Falcão Log', ponto, { rating: 4.6, userRatingCount: 80 })], [{ ...lugar('Rua das Flores, 100', ponto), types: ['premise'] }]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('empresa no endereço da Receita vira bom', r.maps.itens.map(i => i.tipo), ['bom']);
  }
  {
    const f = maps([lugar('Falcão Log', longe)], [{ ...lugar('Rua das Flores, 100', ponto), types: ['premise'] }]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('empresa em outro endereço vira atenção', [r.maps.itens[0].tipo, r.maps.distanciaM > 400], ['atencao', true]);
  }
  {
    const f = maps([], [lugar('Espaço Coworking Centro', ponto)]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('coworking no endereço é apontado', /coworking/i.test(r.maps.itens[0].texto), true);
  }
  {
    const f = maps([], [{ ...lugar('Rua das Flores, 100', ponto), types: ['premise'] }]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('endereço sem comércio vira atenção', [r.maps.empresa, r.maps.itens[0].tipo], [null, 'atencao']);
  }
  {
    const f = maps([lugar('Falcão Log', ponto, { businessStatus: 'CLOSED_PERMANENTLY' })], []);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('fechada definitivamente vira ruim', r.maps.itens[0].tipo, 'ruim');
  }
  {
    const f = falso([['places.googleapis.com', () => resposta(403, { error: { message: 'API key not valid' } })]]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveGoogle: 'k', agora: AGORA });
    conferir('erro do Google não derruba a pesquisa', [r.maps.status, /API key/.test(r.maps.erro)], ['erro', true]);
  }

  console.log('\nNOMES\n');
  conferir('cita a empresa pelo nome inteiro', P.citaEmpresa('Costa Atacadão abre loja em Goiânia', ['COSTA ATACADAO']), true);
  conferir('palavras soltas não contam', P.citaEmpresa('Rede atacadista na costa do Pará', ['COSTA ATACADAO']), false);
  conferir('termo de busca com fantasia e razão', P.termoBusca(EMPRESA), '"FALCAO LOG" OR "TRANSPORTADORA FALCAO"');
  conferir('nome curto ganha a cidade', P.termoBusca({ razao: 'J R TRANSPORTES LTDA', fantasia: '', municipio: 'GOIANIA' }), '"J R TRANSPORTES" GOIANIA');

  console.log('\nBUSCA NA WEB\n');
  {
    const res = (titulo, trecho, url) => ({ title: titulo, content: trecho, url });
    const f = falso([['api.tavily.com', (u, init) => {
      const b = JSON.parse(init.body);
      if (b.include_domains && b.include_domains.includes('reclameaqui.com.br'))
        return resposta(200, { results: [res('Falcão Log - Reclame Aqui', 'Falcão Log tem reputação Não recomendada no Reclame Aqui', 'https://ra/1')] });
      if (b.include_domains) return resposta(200, { results: [
        res('Execução de título extrajudicial contra Transportadora Falcão Ltda', 'TJGO', 'https://jus/1'),
        res('Processo de outra empresa', 'Transportes Falcon', 'https://jus/2')] });
      if (/golpe/.test(b.query)) return resposta(200, { results: [res('Clientes acusam Falcão Log de golpe', 'calote em fretes', 'https://w/1')] });
      return resposta(200, { results: [res('Falcão Log | site', 'transportes em Goiânia', 'https://w/2'), res('Clientes acusam Falcão Log de golpe', 'calote', 'https://w/1')] });
    }]]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveTavily: 'k', agora: AGORA });
    conferir('quatro buscas na web', f.chamadas.filter(u => u.includes('tavily')).length, 4);
    conferir('página de golpe vira atenção', r.web.itens[0].tipo, 'atencao');
    conferir('processo de execução vira atenção', /execução/.test(r.web.itens[1].texto) && r.web.itens[1].tipo, 'atencao');
    conferir('processo de outra empresa é descartado', r.web.grupos.processos.length, 1);
    conferir('Reclame Aqui não recomendada vira atenção', r.web.itens[2].tipo, 'atencao');
    conferir('mesma página não repete entre grupos', r.web.grupos.geral.map(x => x.link), ['https://w/2']);
  }

  console.log('\nEMPRESAS PUNIDAS (TCU)\n');
  {
    const tcu = corpo => falso([['certidoes-apf.apps.tcu.gov.br', () => resposta(200, corpo)]]);
    let r = await P.pesquisarInternet(EMPRESA, { fetch: tcu({ certidoes: [
      { emissor: 'TCU', descricao: 'Licitantes Inidôneos', situacao: 'NADA_CONSTA' },
      { emissor: 'CGU', descricao: 'CEIS', situacao: 'NADA_CONSTA' }] }), lookup: lookupPublico, agora: AGORA });
    conferir('nada consta vira bom', r.sancoes.itens.map(i => i.tipo), ['bom']);
    r = await P.pesquisarInternet(EMPRESA, { fetch: tcu({ certidoes: [
      { emissor: 'CGU', descricao: 'CEIS', situacao: 'CONSTA' }, { emissor: 'TCU', descricao: 'Inidôneos', situacao: 'NADA_CONSTA' }] }), lookup: lookupPublico, agora: AGORA });
    conferir('consta em lista vira ruim', [r.sancoes.itens[0].tipo, /CEIS/.test(r.sancoes.itens[0].texto)], ['ruim', true]);
    r = await P.pesquisarInternet(EMPRESA, { fetch: tcu({ outra: 'coisa' }), lookup: lookupPublico, agora: AGORA });
    conferir('formato desconhecido não vira "nada consta"', r.sancoes.status, 'erro');
  }
  {
    const html = { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error('x'); }, text: async () => '<html><head></head></html>' };
    const f = falso([
      ['certidoes-apf.apps.tcu.gov.br', () => html],
      ['certidoes.apps.tcu.gov.br/api/publico/', () => resposta(200, [])],
    ]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('TCU em HTML usa as listas do TCU', [r.sancoes.status, r.sancoes.itens[0].tipo], ['parcial', 'info']);
    conferir('o aviso explica a página em vez de dados', /página em vez de dados/.test(r.sancoes.aviso), true);
    const g = falso([['tcu.gov.br', () => html]]);
    const r2 = await P.pesquisarInternet(EMPRESA, { fetch: g, lookup: lookupPublico, agora: AGORA });
    conferir('tudo em HTML vira erro legível', [r2.sancoes.status, /página em vez de dados/.test(r2.sancoes.erro)], ['erro', true]);
  }

  {
    // Firewall do TCU recusa o servidor; CEIS e CNEP vêm do Portal da Transparência
    const waf = { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error('x'); },
      text: async () => '<html><title>Requisição rejeitada</title>firewall de aplicações do Tribunal de Contas da União. Seu suporte ID: 123</html>' };
    const portal = (ceis, cnep, extra = []) => falso([
      ['certidoes-apf.apps.tcu.gov.br', () => waf],
      ['certidoes.apps.tcu.gov.br/api/publico/', () => resposta(200, [])],
      ['api-de-dados/ceis', ceis],
      ['api-de-dados/cnep', cnep],
      ...extra,
    ]);
    const vazio = () => resposta(200, []);
    let f = portal(vazio, vazio);
    let r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA });
    conferir('firewall do TCU não vira "fora do ar"', [/firewall/.test(r.sancoes.aviso), /fora do ar/.test(r.sancoes.itens[0].texto)], [true, false]);
    conferir('sem chave, diz que falta a chave do Portal', /chave do Portal da Transparência não está configurada/.test(r.sancoes.itens[0].texto), true);
    conferir('sem chave, não chama o Portal', f.chamadas.some(u => u.includes('portaldatransparencia')), false);

    f = portal(vazio, vazio);
    r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA, chavePortal: 'k' });
    conferir('com chave, CEIS e CNEP conferidos', [r.sancoes.status, r.sancoes.itens[0].tipo, /CEIS e CNEP/.test(r.sancoes.itens[0].texto)], ['parcial', 'info', true]);
    conferir('só improbidade fica de fora', /improbidade do CNJ só sai na consulta consolidada do TCU/.test(r.sancoes.itens[0].texto), true);
    conferir('chave vai no cabeçalho chave-api-dados', f.chamadas.filter(u => u.includes('api-de-dados/ceis')).length >= 1, true);

    let cabecalho;
    f = portal((u, init) => { cabecalho = init.headers['chave-api-dados']; return resposta(200, [{ id: 7,
      sancionado: { nome: 'X', codigoFormatado: EMPRESA.cnpj.replace(/\D/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') },
      tipoSancao: { descricaoResumida: 'Impedimento/proibição de contratar' }, orgaoSancionador: { nome: 'Prefeitura de X' } }]); }, vazio);
    r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA, chavePortal: 'minha-chave' });
    conferir('consta no CEIS vira ruim com o tipo da sanção', [r.sancoes.itens[0].tipo, /CEIS.*Impedimento/.test(r.sancoes.itens[0].texto), cabecalho], ['ruim', true, 'minha-chave']);

    f = portal(() => resposta(200, [{ id: 8, sancionado: { codigoFormatado: '11.111.111/0001-11' } }]), vazio);
    r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA, chavePortal: 'k' });
    conferir('registro de outra empresa é ignorado', r.sancoes.itens[0].tipo, 'info');

    f = portal(() => resposta(401, { erro: 'chave' }), () => resposta(401, { erro: 'chave' }));
    r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, agora: AGORA, chavePortal: 'errada' });
    conferir('chave recusada é dita com clareza', [r.sancoes.itens[0].tipo, /recusou a chave/.test(r.sancoes.itens[0].texto)], ['info', true]);
  }

  console.log('\nOUTRAS EMPRESAS DOS SÓCIOS\n');
  const receita = { [P.cnpjMatriz('99888777')]: { descricao_situacao_cadastral: 'INAPTA', razao_social: 'FALCAO CARGAS LTDA' },
                    [P.cnpjMatriz('55444333')]: { descricao_situacao_cadastral: 'INAPTA', razao_social: 'SILVA FRETES LTDA' } };
  const socios = (pessoas, membros) => falso([
    ['api.cnpja.com/person?', () => resposta(200, { records: pessoas })],
    ['api.cnpja.com/person/', () => resposta(200, { membership: membros })],
    ['brasilapi.com.br/api/cnpj/v1/', u => { const c = u.split('/').pop(); return receita[c] ? resposta(200, receita[c]) : resposta(404, {}); }],
  ]);
  const membros = [
    { company: { id: '11222333', name: 'TRANSPORTADORA FALCAO LTDA' }, role: { text: 'Sócio-Administrador' } },
    { company: { id: '99888777', name: 'FALCAO CARGAS LTDA' }, role: { text: 'Sócio' } },
    { company: { id: '55444333', name: 'SILVA FRETES LTDA' }, role: { text: 'Sócio' } },
  ];
  {
    const f = socios([
      { id: 'a', type: 'NATURAL', name: 'JOAO DA SILVA', taxId: '***999999**' },
      { id: 'b', type: 'NATURAL', name: 'JOAO DA SILVA', taxId: '***123456**' },
    ], membros);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveCnpja: 'k', agora: AGORA });
    conferir('homônimo separado pelos dígitos do CPF', f.chamadas.some(u => u.endsWith('/person/b')), true);
    conferir('a própria empresa não entra na lista', r.socios.socios[0].empresas.map(e => e.razao), ['FALCAO CARGAS LTDA', 'SILVA FRETES LTDA']);
    conferir('duas empresas inaptas viram ruim', r.socios.itens.map(i => i.tipo), ['ruim']);
  }
  {
    const f = socios([{ id: 'a', type: 'NATURAL', name: 'JOAO DA SILVA', taxId: '***999999**' }], membros);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveCnpja: 'k', agora: AGORA });
    conferir('sem CPF compatível não usa o homônimo', [r.socios.socios[0].encontrado, r.socios.itens.length], [false, 0]);
  }
  {
    const f = falso([
      ['api.cnpja.com/person?', () => resposta(200, { records: [{ id: 'b', type: 'NATURAL', name: 'JOAO DA SILVA', taxId: '***123456**' }] })],
      ['api.cnpja.com/person/', () => resposta(200, { membership: membros })],
      ['api.cnpja.com/office/', () => resposta(200, { status: { id: 2, text: 'Ativa' }, statusDate: '2010-01-01', founded: '2010-01-01', company: { name: 'X' } })],
    ]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveCnpja: 'k', agora: AGORA });
    conferir('situação vem do cache do CNPJá', [r.socios.socios[0].empresas.map(e => e.situacao), f.chamadas.some(u => u.includes('brasilapi'))], [['ATIVA', 'ATIVA'], false]);
    conferir('consulta no cache, que não gasta crédito', f.chamadas.filter(u => u.includes('/office/')).every(u => u.endsWith('?strategy=CACHE')), true);
    conferir('todas ativas vira bom', r.socios.itens.map(i => i.tipo), ['bom']);
  }
  {
    const f = falso([
      ['api.cnpja.com/person?', () => resposta(200, { records: [{ id: 'b', type: 'NATURAL', name: 'JOAO DA SILVA', taxId: '***123456**' }] })],
      ['api.cnpja.com/person/', () => resposta(200, { membership: membros })],
    ]);
    const r = await P.pesquisarInternet(EMPRESA, { fetch: f, lookup: lookupPublico, chaveCnpja: 'k', agora: AGORA });
    conferir('sem situação não diz que está tudo bem', [r.socios.itens.map(i => i.tipo), /não pôde ser consultada/.test(r.socios.itens[0].texto)], [['info'], true]);
  }

  console.log(falhas ? `\n✕ ${falhas} falha(s)\n` : '\n✓ Tudo certo\n');
  process.exit(falhas ? 1 : 0);
})();
