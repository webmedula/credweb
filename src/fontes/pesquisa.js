/**
 * Pesquisa na internet sobre o CNPJ — só fontes gratuitas.
 *
 *  · Endereço      complemento residencial / caixa postal (sem rede)
 *  · Google Maps   a empresa aparece no endereço da Receita? (GOOGLE_MAPS_API_KEY)
 *  · Domínio       e-mail próprio, data de registro do domínio, site no ar
 *  · Notícias      Google Notícias (RSS) com termos de risco, só as que citam o nome
 *  · Web           busca geral, golpe/fraude, Jusbrasil/Escavador e Reclame Aqui
 *                  pela API do Tavily (TAVILY_API_KEY, plano grátis)
 *  · Sanções       Consulta Consolidada do TCU (inidôneos, CEIS, CNEP, improbidade);
 *                  se o TCU recusar, listas do TCU + CEIS/CNEP no Portal da
 *                  Transparência (PORTAL_TRANSPARENCIA_CHAVE, grátis)
 *  · Sócios        outras empresas de cada sócio (CNPJá, CNPJA_API_KEY) e
 *                  situação delas na Receita (BrasilAPI)
 *
 * Cada item volta como {tipo, texto, fonte?, link?}, com tipo
 * 'ruim' | 'atencao' | 'bom' | 'info'. Nada aqui mexe na nota: 'ruim' e
 * 'atencao' viram alertas na recomendação, para o vendedor conferir.
 *
 * Zero dependências. O fetch é injetável para os testes.
 */

'use strict';

const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ *
 *  Utilitários
 * ------------------------------------------------------------------ */

const soDigitos = s => String(s || '').replace(/\D/g, '');

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Tira o tipo societário do fim do nome ("LTDA", "- ME", "EIRELI"...). */
function nomeLimpo(razao) {
  let s = String(razao || '').replace(/\s+/g, ' ').trim();
  const sufixo = /[\s,.-]+(LTDA\.?|LIMITADA|EIRELI|EPP|ME|MEI|S\/A|S\.A\.?|SA|SLU|SS)$/i;
  while (sufixo.test(s)) s = s.replace(sufixo, '').trim();
  // MEI e empresário individual trazem o CPF no nome: "12.345.678 JOAO DA SILVA"
  return s.replace(/^[\d.\-/ ]{8,}\s*/, '').trim();
}

const PALAVRAS_GENERICAS = new Set(('LTDA ME EPP EIRELI SA DE DA DO DAS DOS E EM COM PARA ' +
  'COMERCIO COMERCIAL SERVICOS SERVICO TRANSPORTE TRANSPORTES TRANSPORTADORA LOGISTICA ' +
  'DISTRIBUIDORA INDUSTRIA AUTO POSTO PECAS EMPRESA GRUPO BRASIL BRASILEIRA ' +
  'AGRO AGROPECUARIA CONSTRUCOES CONSTRUTORA ENGENHARIA LOCACAO LOCADORA').split(' '));

function tokens(s) {
  return semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .filter(t => t.length >= 3 && !PALAVRAS_GENERICAS.has(t));
}

/** O nome do lugar no Maps é da empresa? Exige ao menos uma palavra própria em comum. */
function mesmoNome(nomeLugar, ...nomesEmpresa) {
  const lugar = tokens(nomeLugar);
  if (!lugar.length) return false;
  const empresa = new Set(nomesEmpresa.flatMap(tokens));
  const comuns = lugar.filter(t => empresa.has(t)).length;
  return comuns >= 1 && comuns / lugar.length >= 0.5;
}

/** Texto sem acento, só letras e números, com espaço nas pontas: " COSTA ATACADAO ". */
function normTexto(s) {
  return ' ' + semAcento(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() + ' ';
}

/** Nomes pelos quais a empresa pode ser citada: fantasia e razão sem o tipo societário. */
function nomesDaEmpresa(d) {
  const nomes = [d.fantasia, nomeLimpo(d.razao)].map(n => String(n || '').trim()).filter(n => normTexto(n).trim().length >= 4);
  return [...new Map(nomes.map(n => [normTexto(n), n])).values()];
}

/** O texto cita a empresa pelo nome inteiro? Busca de notícia e web traz muita coisa só parecida. */
function citaEmpresa(texto, nomes) {
  const t = normTexto(texto);
  return nomes.some(n => t.includes(normTexto(n)));
}

/** Termo de busca: os nomes entre aspas; nome curto ou genérico ganha a cidade. */
function termoBusca(d) {
  const nomes = nomesDaEmpresa(d);
  const termo = nomes.map(n => '"' + n + '"').join(' OR ');
  return nomes.every(n => tokens(n).length < 2) && d.municipio ? termo + ' ' + d.municipio : termo;
}

function distanciaM(a, b) {
  if (!a || !b) return null;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}

function mesesDesde(iso, agora) {
  const t = Date.parse(iso);
  return isNaN(t) ? null : (agora - t) / (30.44 * 864e5);
}

const fmtMeses = m => m < 24 ? Math.max(1, Math.round(m)) + ' meses' : Math.floor(m / 12) + ' anos';

function decodificar(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}

/** Dígitos verificadores do CNPJ, para montar o CNPJ da matriz a partir da raiz. */
function cnpjMatriz(raiz8) {
  const base = soDigitos(raiz8).padStart(8, '0').slice(0, 8) + '0001';
  const dv = (nums, pesos) => {
    const s = nums.split('').reduce((acc, n, i) => acc + Number(n) * pesos[i], 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + d1 + d2;
}

/** Roda fn em lotes de n, na ordem. */
async function emLotes(itens, n, fn) {
  const saida = [];
  for (let i = 0; i < itens.length; i += n) saida.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  return saida;
}

/* ------------------------------------------------------------------ *
 *  Dados da Receita que a pesquisa usa (BrasilAPI ou CNPJ.ws)
 * ------------------------------------------------------------------ */

function dadosBasicos(fonte, d) {
  if (fonte === 'CNPJ.ws') {
    const e = d.estabelecimento || {};
    return {
      cnpj: soDigitos(e.cnpj || ''),
      razao: d.razao_social || '', fantasia: e.nome_fantasia || '',
      abertura: e.data_inicio_atividade || null,
      email: e.email || '',
      logradouro: [e.tipo_logradouro, e.logradouro].filter(Boolean).join(' '),
      numero: e.numero || '', complemento: e.complemento || '', bairro: e.bairro || '',
      municipio: (e.cidade && e.cidade.nome) || '', uf: (e.estado && e.estado.sigla) || '', cep: e.cep || '',
      socios: (d.socios || []).map(s => ({
        nome: s.nome || '', documento: s.cpf_cnpj_socio || '', pj: /jur[ií]dica/i.test(s.tipo || ''),
      })),
    };
  }
  return {
    cnpj: soDigitos(d.cnpj || ''),
    razao: d.razao_social || '', fantasia: d.nome_fantasia || '',
    abertura: d.data_inicio_atividade || null,
    email: d.email || '',
    logradouro: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '),
    numero: d.numero || '', complemento: d.complemento || '', bairro: d.bairro || '',
    municipio: d.municipio || '', uf: d.uf || '', cep: d.cep || '',
    socios: (d.qsa || []).map(s => ({
      nome: s.nome_socio || s.nome || '', documento: s.cnpj_cpf_do_socio || '', pj: s.identificador_de_socio === 1,
    })),
  };
}

function enderecoTexto(d) {
  const rua = [d.logradouro, d.numero].filter(Boolean).join(', ');
  return [rua, d.bairro, [d.municipio, d.uf].filter(Boolean).join(' - '), d.cep].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ *
 *  Endereço (sem rede)
 * ------------------------------------------------------------------ */

function verificarEndereco(d) {
  const itens = [];
  const comp = semAcento(d.complemento).toUpperCase();
  if (/CAIXA POSTAL|CX\.? ?POSTAL/.test(comp)) {
    itens.push({ tipo: 'ruim', texto: `O endereço da Receita é uma caixa postal (“${d.complemento}”). Empresa sem endereço físico declarado.` });
  } else if (/\b(AP|APT|APTO|APARTAMENTO|CASA|FUNDOS|BLOCO|BL|CONDOMINIO|COND)\b/.test(comp)) {
    itens.push({ tipo: 'atencao', texto: `O endereço da Receita tem complemento de residência (“${d.complemento}”). Pode ser empresa aberta em casa: confirme onde ela funciona.` });
  }
  return { endereco: enderecoTexto(d), itens };
}

/* ------------------------------------------------------------------ *
 *  Google Maps (Places API New · Text Search)
 * ------------------------------------------------------------------ */

const CAMPOS_PLACES = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.types',
  'places.primaryType', 'places.businessStatus', 'places.rating', 'places.userRatingCount',
  'places.googleMapsUri', 'places.location'].join(',');

async function buscarPlaces(f, chave, texto) {
  const r = await f('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': chave, 'X-Goog-FieldMask': CAMPOS_PLACES },
    body: JSON.stringify({ textQuery: texto, languageCode: 'pt-BR', regionCode: 'BR', maxResultCount: 5 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Maps HTTP ' + r.status + (j.error && j.error.message ? ': ' + j.error.message : ''));
  return j.places || [];
}

const ENDERECO_DE_ALUGUEL = /cowork|co-work|escrit[oó]rio virtual|business center|centro empresarial|regus|wework|spaces|contabil|contador|domic[ií]lio fiscal/i;

function resumoLugar(p) {
  return {
    nome: (p.displayName && p.displayName.text) || '',
    endereco: p.formattedAddress || '',
    tipo: p.primaryType || '',
    situacao: p.businessStatus || '',
    nota: p.rating ?? null,
    avaliacoes: p.userRatingCount ?? 0,
    link: p.googleMapsUri || '',
  };
}

async function verificarMaps(d, { fetch: f, chaveGoogle }) {
  const endereco = enderecoTexto(d);
  const linkBusca = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(endereco);
  if (!chaveGoogle) return { status: 'nao_configurado', linkBusca, itens: [] };

  const nome = d.fantasia || nomeLimpo(d.razao);
  const [porNome, porEndereco] = await Promise.all([
    buscarPlaces(f, chaveGoogle, [nome, d.municipio, d.uf].filter(Boolean).join(' ')),
    buscarPlaces(f, chaveGoogle, endereco),
  ]);

  const pontoEndereco = porEndereco.length ? porEndereco[0].location : null;
  const empresa = porNome.find(p => mesmoNome(p.displayName && p.displayName.text, d.razao, d.fantasia))
    || porEndereco.find(p => mesmoNome(p.displayName && p.displayName.text, d.razao, d.fantasia));
  const itens = [];
  const fonte = 'Google Maps';

  if (empresa) {
    const lugar = resumoLugar(empresa);
    const dist = distanciaM(empresa.location, pontoEndereco);
    const nota = lugar.nota !== null ? `, nota ${String(lugar.nota).replace('.', ',')} (${lugar.avaliacoes} avaliações)` : ', sem avaliações';
    if (lugar.situacao === 'CLOSED_PERMANENTLY') {
      itens.push({ tipo: 'ruim', texto: `O Google Maps marca “${lugar.nome}” como fechada definitivamente.`, fonte, link: lugar.link });
    } else if (lugar.situacao === 'CLOSED_TEMPORARILY') {
      itens.push({ tipo: 'atencao', texto: `O Google Maps marca “${lugar.nome}” como fechada temporariamente.`, fonte, link: lugar.link });
    }
    if (dist !== null && dist > 400) {
      itens.push({ tipo: 'atencao', texto: `No Google Maps a empresa aparece em outro endereço (${lugar.endereco}), a ${(dist / 1000).toFixed(1).replace('.', ',')} km do endereço da Receita. Pode ter mudado sem atualizar o cadastro.`, fonte, link: lugar.link });
    } else if (lugar.situacao !== 'CLOSED_PERMANENTLY') {
      itens.push({ tipo: 'bom', texto: `Aparece no Google Maps como “${lugar.nome}”${dist !== null ? ' no endereço da Receita' : ''}${nota}.`, fonte, link: lugar.link });
    }
    return { status: 'ok', linkBusca, empresa: lugar, distanciaM: dist, noEndereco: [], itens };
  }

  // A empresa não apareceu: o que existe no endereço dela?
  const noEndereco = porEndereco
    .filter(p => (p.types || []).includes('establishment') || (p.types || []).includes('point_of_interest'))
    .filter(p => { const m = distanciaM(p.location, pontoEndereco); return m === null || m <= 60; })
    .map(resumoLugar);
  const aluguel = noEndereco.find(l => ENDERECO_DE_ALUGUEL.test(l.nome + ' ' + l.tipo));

  if (!porEndereco.length) {
    itens.push({ tipo: 'atencao', texto: 'O Google Maps não encontrou a empresa nem localizou o endereço da Receita.', fonte, link: linkBusca });
  } else if (aluguel) {
    itens.push({ tipo: 'atencao', texto: `A empresa não aparece no Google Maps, e no endereço da Receita funciona “${aluguel.nome}”, que parece coworking, escritório virtual ou contabilidade. Endereço fiscal desse tipo pode esconder empresa sem operação própria.`, fonte, link: aluguel.link || linkBusca });
  } else if (noEndereco.length) {
    itens.push({ tipo: 'atencao', texto: `A empresa não aparece no Google Maps. No endereço da Receita aparece outro negócio: ${noEndereco.slice(0, 2).map(l => '“' + l.nome + '”').join(' e ')}.`, fonte, link: linkBusca });
  } else {
    itens.push({ tipo: 'atencao', texto: 'A empresa não aparece no Google Maps e o endereço da Receita não tem comércio cadastrado. Pode ser endereço residencial ou empresa sem ponto físico: veja a foto da rua.', fonte, link: linkBusca });
  }
  return { status: 'ok', linkBusca, empresa: null, distanciaM: null, noEndereco, itens };
}

/* ------------------------------------------------------------------ *
 *  Domínio do e-mail e site
 * ------------------------------------------------------------------ */

const PROVEDORES_GRATUITOS = new Set(('gmail.com googlemail.com hotmail.com hotmail.com.br outlook.com ' +
  'outlook.com.br live.com msn.com yahoo.com yahoo.com.br ymail.com bol.com.br uol.com.br terra.com.br ' +
  'ig.com.br icloud.com me.com globo.com globomail.com r7.com zipmail.com.br oi.com.br protonmail.com ' +
  'proton.me gmx.com aol.com').split(' '));

const SLD_BR = new Set(('com net org ind eng adv arq art eco edu emp far fot gov inf jor med odo psi ' +
  'rec srv tmp tur vet agr esp etc imb mus coop bio ong blog app dev log').split(' '));

const HOST_VALIDO = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "contato@mail.empresa.com.br" → "empresa.com.br" */
function dominioRegistrado(host) {
  const p = host.split('.');
  if (p.length >= 3 && p[p.length - 1] === 'br' && SLD_BR.has(p[p.length - 2])) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
    || (s.startsWith('::ffff:') && ipPrivado(s.slice(7)));
}

/** O domínio vem do cadastro de terceiros: nunca deixar o servidor chamar a rede interna. */
async function hostPublico(host, lookup) {
  if (!HOST_VALIDO.test(host)) return false;
  try {
    const ips = await lookup(host, { all: true });
    return ips.length > 0 && ips.every(i => !ipPrivado(i.address));
  } catch { return false; }
}

async function lerSite(f, lookup, host) {
  let url = 'https://' + host + '/';
  for (let saltos = 0; saltos < 4; saltos++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!(await hostPublico(u.hostname, lookup))) return null;
    const r = await f(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (credweb)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = new URL(r.headers.get('location'), url).toString();
      continue;
    }
    if (!r.ok) return { url, status: r.status, html: '' };
    const html = (await r.text()).slice(0, 400000);
    return { url, status: r.status, html };
  }
  return null;
}

const PAGINA_PARADA = /dom[ií]nio (est[aá] )?(à|a) venda|comprar este dom[ií]nio|this domain is for sale|domain (is )?for sale|parked|site em constru[cç][aã]o|em constru[cç][aã]o|coming soon|em breve|index of \//i;

async function verificarDominio(d, { fetch: f, lookup, agora }) {
  const email = String(d.email || '').trim().toLowerCase();
  const itens = [];
  if (!email || !email.includes('@')) {
    itens.push({ tipo: 'info', texto: 'A Receita não tem e-mail cadastrado para a empresa.' });
    return { status: 'ok', email: '', itens };
  }
  const host = email.split('@').pop();
  if (PROVEDORES_GRATUITOS.has(host)) {
    itens.push({ tipo: 'info', texto: `O e-mail da Receita é de provedor gratuito (${host}), sem domínio próprio.` });
    return { status: 'ok', email, gratuito: true, itens };
  }
  if (!HOST_VALIDO.test(host)) {
    itens.push({ tipo: 'atencao', texto: `O e-mail da Receita (${email}) não tem um domínio válido.` });
    return { status: 'ok', email, itens };
  }

  const dominio = dominioRegistrado(host);
  const saida = { status: 'ok', email, dominio, registrado: null, criadoEm: null, site: null, itens };

  // RDAP: o registro.br responde os .br; o rdap.org redireciona os demais para o registro certo
  const urlRdap = dominio.endsWith('.br') ? 'https://rdap.registro.br/domain/' + dominio : 'https://rdap.org/domain/' + dominio;
  try {
    const r = await f(urlRdap, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 404) saida.registrado = false;
    else if (r.ok) {
      const j = await r.json();
      saida.registrado = true;
      const ev = (j.events || []).find(e => e.eventAction === 'registration');
      saida.criadoEm = ev ? ev.eventDate : null;
    }
  } catch { /* RDAP fora do ar: segue sem a data */ }

  try {
    const site = await lerSite(f, lookup, dominio);
    if (site) {
      const titulo = decodificar((site.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').slice(0, 120);
      const texto = site.html.replace(/<[^>]+>/g, ' ');
      const cnpj = soDigitos(d.cnpj);
      saida.site = {
        url: site.url, status: site.status, titulo,
        noAr: site.status >= 200 && site.status < 300 && site.html.length > 200,
        parado: PAGINA_PARADA.test(titulo + ' ' + texto.slice(0, 5000)),
        mostraCnpj: cnpj.length === 14 && soDigitos(texto).includes(cnpj),
      };
    }
  } catch { /* site não respondeu */ }

  const fonteRdap = dominio.endsWith('.br') ? 'registro.br' : 'RDAP';
  const contabilidade = /contab|contador|cont[aá]bil/i.test(dominio + ' ' + ((saida.site && saida.site.titulo) || ''));

  if (saida.registrado === false) {
    itens.push({ tipo: 'atencao', texto: `O domínio do e-mail da Receita (${dominio}) não está registrado: esse e-mail não funciona.`, fonte: fonteRdap });
    return saida;
  }
  if (contabilidade) {
    itens.push({ tipo: 'info', texto: `O e-mail da Receita (${email}) parece ser do escritório de contabilidade, não da empresa.`, link: saida.site && saida.site.url });
    return saida;
  }

  const mesesDominio = saida.criadoEm ? mesesDesde(saida.criadoEm, agora) : null;
  const mesesEmpresa = d.abertura ? mesesDesde(d.abertura, agora) : null;
  if (mesesDominio !== null) {
    const desde = new Date(saida.criadoEm).getFullYear();
    if (mesesDominio < 6 && mesesEmpresa !== null && mesesEmpresa >= 24) {
      itens.push({ tipo: 'atencao', texto: `O domínio do e-mail (${dominio}) foi registrado há ${fmtMeses(mesesDominio)}, numa empresa aberta há ${fmtMeses(mesesEmpresa)}. Domínio novo em empresa antiga é comum em golpe com CNPJ comprado.`, fonte: fonteRdap });
    } else {
      itens.push({ tipo: mesesDominio >= 36 ? 'bom' : 'info', texto: `E-mail com domínio próprio (${dominio}), registrado em ${desde}.`, fonte: fonteRdap });
    }
  } else {
    itens.push({ tipo: 'info', texto: `E-mail com domínio próprio (${dominio}).` });
  }

  const s = saida.site;
  if (s && s.noAr && !s.parado) {
    itens.push({ tipo: 'bom', texto: `Site no ar${s.titulo ? ': “' + s.titulo + '”' : ''}${s.mostraCnpj ? ', e ele mostra o CNPJ da empresa' : ''}.`, link: s.url });
  } else if (s && s.parado) {
    itens.push({ tipo: 'info', texto: `O site ${dominio} está em construção ou é página padrão de hospedagem.`, link: s.url });
  } else {
    itens.push({ tipo: 'info', texto: `O site ${dominio} não respondeu.` });
  }
  return saida;
}

/* ------------------------------------------------------------------ *
 *  Notícias (Google Notícias, RSS)
 * ------------------------------------------------------------------ */

const TERMOS_RISCO = /fraude|golpe|calote|estelionat|pol[ií]cia|opera[cç][aã]o (policial|da pf|da pol[ií]cia)|pris[aã]o|\bpres[oa]s?\b|investigad|investiga[cç][aã]o|den[uú]ncia|recupera[cç][aã]o judicial|fal[eê]ncia|faliu|sonega|lavagem|apreens|interditad|despejo|penhora|condenad|minist[eé]rio p[uú]blico|fecha as portas|trabalho escravo|an[aá]log[ao] [aà] escravid/i;

function lerRss(xml) {
  const itens = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = t => decodificar((m[1].match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '');
    const fonte = tag('source');
    let titulo = tag('title');
    if (fonte && titulo.endsWith(' - ' + fonte)) titulo = titulo.slice(0, -(fonte.length + 3));
    const data = Date.parse(tag('pubDate'));
    itens.push({ titulo, link: tag('link'), fonte, data: isNaN(data) ? null : new Date(data).toISOString() });
  }
  return itens;
}

function linksPesquisa(d) {
  const nome = d.fantasia || nomeLimpo(d.razao);
  const q = encodeURIComponent('"' + nome + '"');
  return [
    { rotulo: 'Google', link: 'https://www.google.com/search?q=' + q },
    { rotulo: 'Google: golpe, fraude, calote', link: 'https://www.google.com/search?q=' + q + encodeURIComponent(' golpe OR fraude OR calote OR "recuperação judicial"') },
    { rotulo: 'Reclame Aqui', link: 'https://www.reclameaqui.com.br/busca/?q=' + encodeURIComponent(d.fantasia || nome) },
    { rotulo: 'Jusbrasil', link: 'https://www.jusbrasil.com.br/busca?q=' + q },
  ];
}

async function verificarNoticias(d, { fetch: f }) {
  const nomes = nomesDaEmpresa(d);
  if (!nomes.length) return { status: 'ok', termo: '', total: 0, descartadas: 0, noticias: [], itens: [] };
  const termo = termoBusca(d);
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(termo) + '&hl=pt-BR&gl=BR&ceid=BR:pt-419';
  const r = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error('Google Notícias HTTP ' + r.status);
  // O Google Notícias ignora as aspas com frequência: só fica a notícia que cita o nome inteiro
  const lidas = lerRss(await r.text());
  const todas = lidas.filter(n => citaEmpresa(n.titulo, nomes))
    .map(n => ({ ...n, risco: TERMOS_RISCO.test(n.titulo) }))
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const noticias = [...todas.filter(n => n.risco), ...todas.filter(n => !n.risco)].slice(0, 10);
  const risco = todas.filter(n => n.risco);
  const fonte = 'Google Notícias';
  const itens = [];
  if (risco.length) {
    itens.push({ tipo: 'atencao', texto: `${risco.length} notícia(s) com termos de risco. Confira se é a mesma empresa: “${risco[0].titulo}”${risco[0].fonte ? ' (' + risco[0].fonte + ')' : ''}.`, fonte, link: risco[0].link });
  } else if (todas.length) {
    itens.push({ tipo: 'info', texto: `${todas.length} notícia(s) com o nome da empresa, nenhuma com termos de risco.`, fonte });
  } else {
    itens.push({ tipo: 'info', texto: 'Nenhuma notícia com o nome da empresa.', fonte });
  }
  return { status: 'ok', termo, total: todas.length, descartadas: lidas.length - todas.length, noticias, itens };
}

/* ------------------------------------------------------------------ *
 *  Busca na web (Tavily)
 *
 *  Uma API de busca, não raspagem: o Jusbrasil e o Reclame Aqui aparecem
 *  como resultados de busca, com título e trecho, sem abrir os sites.
 * ------------------------------------------------------------------ */

const PROCESSO_COBRANCA = /execu[cç][aã]o|cobran[cç]a|monit[oó]ria|fal[eê]ncia|recupera[cç][aã]o judicial|despejo|penhora|busca e apreens/i;
const RA_RUIM = /n[aã]o recomendada|reputa[cç][aã]o:? ?(ruim|n[aã]o recomendada)|sem resposta/i;
const RA_BOA = /ra1000|reputa[cç][aã]o:? ?([oó]tima|boa)/i;

async function buscarTavily(f, chave, query, extra = {}) {
  const r = await f('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + chave },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 8, ...extra }),
    signal: AbortSignal.timeout(TIMEOUT_MS + 4000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Tavily HTTP ' + r.status + (j.detail ? ': ' + (j.detail.error || JSON.stringify(j.detail)) : ''));
  return (j.results || []).map(x => ({
    titulo: decodificar(x.title || '').slice(0, 200),
    link: x.url || '',
    trecho: decodificar(String(x.content || '').replace(/\s+/g, ' ')).slice(0, 280),
  }));
}

async function verificarWeb(d, { fetch: f, chaveTavily }) {
  if (!chaveTavily) return { status: 'nao_configurado', itens: [] };
  const nomes = nomesDaEmpresa(d);
  if (!nomes.length) return { status: 'ok', itens: [] };
  const termo = termoBusca(d);
  const [geral, risco, processos, reclameAqui] = await Promise.all([
    buscarTavily(f, chaveTavily, termo),
    buscarTavily(f, chaveTavily, termo + ' golpe OR fraude OR calote OR "recuperação judicial" OR falência'),
    buscarTavily(f, chaveTavily, termo + ' processo', { include_domains: ['jusbrasil.com.br', 'escavador.com'] }),
    buscarTavily(f, chaveTavily, termo + ' Reclame Aqui', { include_domains: ['reclameaqui.com.br'], max_results: 3 }),
  ]);

  // Só resultado que cita o nome inteiro, e cada página uma vez só (a de risco primeiro)
  const vistos = new Set();
  const filtrar = lista => lista.filter(x => citaEmpresa(x.titulo + ' ' + x.trecho, nomes))
    .filter(x => !vistos.has(x.link) && vistos.add(x.link));
  const grupos = { risco: filtrar(risco).filter(x => TERMOS_RISCO.test(x.titulo + ' ' + x.trecho)), processos: filtrar(processos), reclameAqui: filtrar(reclameAqui) };
  grupos.geral = filtrar(geral).slice(0, 5);

  const itens = [];
  const fonte = 'busca na web';
  if (grupos.risco.length) {
    itens.push({ tipo: 'atencao', texto: `${grupos.risco.length} página(s) na web citam a empresa com termos de risco. Confira: “${grupos.risco[0].titulo}”.`, fonte, link: grupos.risco[0].link });
  }

  const cobranca = grupos.processos.filter(x => PROCESSO_COBRANCA.test(x.titulo + ' ' + x.trecho));
  if (cobranca.length) {
    itens.push({ tipo: 'atencao', texto: `${cobranca.length} página(s) do Jusbrasil ou Escavador citam a empresa em cobrança, execução ou falência. Confira se ela é a ré: “${cobranca[0].titulo}”.`, fonte: 'Jusbrasil/Escavador', link: cobranca[0].link });
  } else if (grupos.processos.length) {
    itens.push({ tipo: 'info', texto: `${grupos.processos.length} página(s) do Jusbrasil ou Escavador citam a empresa, nenhuma de cobrança ou execução.`, fonte: 'Jusbrasil/Escavador' });
  } else {
    itens.push({ tipo: 'info', texto: 'Nenhum processo citando a empresa nos resultados do Jusbrasil e do Escavador. A busca não cobre todos os tribunais.', fonte: 'Jusbrasil/Escavador' });
  }

  const ra = grupos.reclameAqui[0];
  if (!ra) {
    itens.push({ tipo: 'info', texto: 'Sem página da empresa no Reclame Aqui nos resultados da busca.', fonte: 'Reclame Aqui' });
  } else if (RA_RUIM.test(ra.titulo + ' ' + ra.trecho)) {
    itens.push({ tipo: 'atencao', texto: `Reclame Aqui com reputação ruim: “${ra.trecho || ra.titulo}”.`, fonte: 'Reclame Aqui', link: ra.link });
  } else {
    itens.push({ tipo: RA_BOA.test(ra.titulo + ' ' + ra.trecho) ? 'bom' : 'info', texto: `Tem página no Reclame Aqui: “${ra.trecho || ra.titulo}”.`, fonte: 'Reclame Aqui', link: ra.link });
  }
  return { status: 'ok', termo, grupos, itens };
}

/* ------------------------------------------------------------------ *
 *  Empresas punidas pelo governo
 *  1. Consulta Consolidada do TCU: inidôneos (TCU), CNIA de improbidade
 *     (CNJ), CEIS e CNEP (CGU), tudo de uma vez.
 *  2. Se o TCU recusar (o firewall dele costuma bloquear servidores de
 *     nuvem, mesmo com o site no ar para quem usa o navegador): listas do
 *     próprio TCU em outro servidor + CEIS e CNEP direto na API do Portal da
 *     Transparência (chave grátis, PORTAL_TRANSPARENCIA_CHAVE).
 * ------------------------------------------------------------------ */

const LINK_TCU = 'https://certidoes-apf.apps.tcu.gov.br/';
const LINK_CEIS = 'https://portaldatransparencia.gov.br/sancoes/consulta';
const API_PORTAL = 'https://api.portaldatransparencia.gov.br/api-de-dados/';

const NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** JSON de um serviço do governo. Quando vem uma página HTML (bloqueio, manutenção ou fora do ar), diz qual. */
async function jsonDoGoverno(r, nome) {
  const texto = await r.text();
  if (/^\s*</.test(texto)) {
    if (/firewall|requisi[cç][aã]o rejeitada|request rejected|suporte id/i.test(texto)) {
      throw new Error(nome + ' recusou a consulta feita pelo servidor (bloqueio do firewall do órgão; pelo navegador funciona)');
    }
    throw new Error(nome + ' devolveu uma página em vez de dados (serviço fora do ar ou acesso bloqueado)');
  }
  if (r.status === 401 || r.status === 403) throw new Error(nome + ' recusou a chave de acesso (HTTP ' + r.status + ')');
  if (!r.ok) throw new Error(nome + ' HTTP ' + r.status);
  try { return JSON.parse(texto); } catch { throw new Error(nome + ' devolveu uma resposta que não é JSON'); }
}

async function consultaConsolidada(f, cnpj) {
  const r = await f('https://certidoes-apf.apps.tcu.gov.br/api/rest/publico/certidoes/' + cnpj + '?seEmitirPDF=false',
    { headers: { Accept: 'application/json', 'User-Agent': NAVEGADOR }, signal: AbortSignal.timeout(TIMEOUT_MS + 7000) });
  const j = await jsonDoGoverno(r, 'A consulta consolidada do TCU');
  const certidoes = (j.certidoes || []).map(c => {
    const resultado = String(c.situacao || c.resultado || c.resultadoConsulta || '');
    return { cadastro: c.descricao || c.tipo || c.emissor || '', emissor: c.emissor || '', resultado,
      consta: /CONSTA/i.test(resultado) && !/NADA/i.test(resultado) };
  });
  // Formato desconhecido: melhor dizer que não leu do que dizer "nada consta"
  if (!certidoes.length || certidoes.some(c => !c.resultado)) throw new Error('A consulta consolidada do TCU respondeu em formato não reconhecido');
  return certidoes;
}

/** Plano B: as listas do próprio TCU, em outro servidor. Não cobrem CEIS, CNEP nem improbidade. */
async function listasTcu(f, cnpj) {
  const listas = [
    { cadastro: 'Licitantes inidôneos (TCU)', caminho: 'responsaveis-inidoneos' },
    { cadastro: 'Contas julgadas irregulares (TCU)', caminho: 'responsaveis-contas-irregulares' },
  ];
  return Promise.all(listas.map(async l => {
    const r = await f('https://certidoes.apps.tcu.gov.br/api/publico/' + l.caminho, {
      method: 'POST', body: JSON.stringify({ cnpj }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': NAVEGADOR },
      signal: AbortSignal.timeout(TIMEOUT_MS + 7000),
    });
    const j = await jsonDoGoverno(r, 'A lista do TCU');
    if (!Array.isArray(j)) throw new Error('A lista do TCU respondeu em formato não reconhecido');
    const meus = j.filter(x => !x.numeroRegistro || soDigitos(x.numeroRegistro) === cnpj);
    return { cadastro: l.cadastro, consta: meus.length > 0, registros: meus.length };
  }));
}

/**
 * CEIS ou CNEP na API do Portal da Transparência (CGU). Consulta o CNPJ e,
 * se for filial, também a matriz: a sanção costuma ser registrada na matriz
 * e vale para a empresa inteira.
 */
async function cadastroCgu(f, cnpj, chave, cadastro) {
  const nome = 'O Portal da Transparência (' + cadastro.toUpperCase() + ')';
  const raiz = cnpj.slice(0, 8);
  const alvos = [...new Set([cnpj, cnpjMatriz(raiz)])];
  const registros = [];
  for (const alvo of alvos) {
    const r = await f(API_PORTAL + cadastro + '?codigoSancionado=' + alvo + '&pagina=1', {
      headers: { Accept: 'application/json', 'chave-api-dados': chave },
      signal: AbortSignal.timeout(TIMEOUT_MS + 7000),
    });
    const j = await jsonDoGoverno(r, nome);
    if (!Array.isArray(j)) throw new Error(nome + ' respondeu em formato não reconhecido');
    for (const x of j) {
      const codigo = soDigitos((x.sancionado && x.sancionado.codigoFormatado) || (x.pessoa && (x.pessoa.cnpjFormatado || x.pessoa.numeroInscricaoSocial)) || '');
      // A API já filtra pelo CNPJ; o código, quando vem, só confirma que é a mesma empresa.
      if (codigo && codigo.slice(0, 8) !== raiz) continue;
      if (registros.some(y => y.id && y.id === x.id)) continue;
      registros.push({
        id: x.id,
        tipo: (x.tipoSancao && (x.tipoSancao.descricaoResumida || x.tipoSancao.descricaoPortal)) || '',
        orgao: (x.orgaoSancionador && x.orgaoSancionador.nome) || '',
        inicio: x.dataInicioSancao || '', fim: x.dataFimSancao || '',
      });
    }
  }
  return { cadastro: cadastro === 'ceis' ? 'CEIS (empresas inidôneas e suspensas)' : 'CNEP (empresas punidas)',
    consta: registros.length > 0, registros: registros.length, sancoes: registros };
}

function descreverSancao(l) {
  const s = (l.sancoes || [])[0];
  if (!s) return l.cadastro;
  const extra = [s.tipo, s.orgao].filter(Boolean).join(', ');
  return l.cadastro + (extra ? ' — ' + extra : '') + (l.sancoes.length > 1 ? ` (+${l.sancoes.length - 1})` : '');
}

async function verificarSancoes(d, { fetch: f, chavePortal }) {
  const cnpj = soDigitos(d.cnpj);
  let falhaConsolidada;
  try {
    const certidoes = await consultaConsolidada(f, cnpj);
    const constam = certidoes.filter(c => c.consta);
    const itens = constam.length
      ? [{ tipo: 'ruim', texto: `A empresa consta em lista de punidos pelo governo: ${constam.map(c => c.cadastro).join('; ')}.`, fonte: 'TCU', link: LINK_TCU }]
      : [{ tipo: 'bom', texto: `Nada consta nas ${certidoes.length} listas de empresas punidas (inidôneos do TCU, CEIS, CNEP e improbidade).`, fonte: 'TCU' }];
    return { status: 'ok', link: LINK_TCU, certidoes, itens };
  } catch (e) { falhaConsolidada = e.message; }

  // Plano B: cada fonte por conta própria; uma falha não derruba as outras.
  const tentar = async fn => { try { return { ok: await fn() }; } catch (e) { return { erro: e.message }; } };
  const [tcu, ceis, cnep] = await Promise.all([
    tentar(() => listasTcu(f, cnpj)),
    chavePortal ? tentar(() => cadastroCgu(f, cnpj, chavePortal, 'ceis')) : null,
    chavePortal ? tentar(() => cadastroCgu(f, cnpj, chavePortal, 'cnep')) : null,
  ]);
  const listas = [...(tcu.ok || []), ...(ceis && ceis.ok ? [ceis.ok] : []), ...(cnep && cnep.ok ? [cnep.ok] : [])];
  const erros = [tcu.erro, ceis && ceis.erro, cnep && cnep.erro].filter(Boolean);
  if (!listas.length) throw new Error([falhaConsolidada, ...erros].join('. ') + '.');

  const cgu = !!(ceis && ceis.ok && cnep && cnep.ok);
  const fonte = cgu ? (tcu.ok ? 'TCU e Portal da Transparência' : 'Portal da Transparência') : 'TCU';
  const constam = listas.filter(l => l.consta);
  if (constam.length) {
    return { status: 'parcial', link: LINK_TCU, aviso: [falhaConsolidada, ...erros].join('. '), certidoes: listas,
      itens: [{ tipo: 'ruim', texto: `A empresa consta em lista de punidos pelo governo: ${constam.map(descreverSancao).join('; ')}.`, fonte, link: constam.some(l => l.sancoes) ? LINK_CEIS : LINK_TCU }] };
  }

  const conferidas = [tcu.ok && 'inidôneos e contas irregulares do TCU', ceis && ceis.ok && 'CEIS', cnep && cnep.ok && 'CNEP'].filter(Boolean);
  const faltam = [!tcu.ok && 'listas do TCU', !(ceis && ceis.ok) && 'CEIS', !(cnep && cnep.ok) && 'CNEP', 'improbidade (CNJ)'].filter(Boolean);
  const porque = !chavePortal
    ? 'o TCU recusou a consulta automática do servidor e a chave do Portal da Transparência não está configurada'
    : (erros.length ? erros.join('; ') : 'o TCU recusou a consulta automática do servidor');
  const juntar = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1] : a[0];
  // Só a improbidade faltando: ela só existe na consulta do TCU, que recusou o servidor.
  const texto = faltam.length === 1
    ? `Nada consta em ${juntar(conferidas)}. A lista de improbidade do CNJ só sai na consulta consolidada do TCU, que recusa consultas automáticas do servidor: confira no link.`
    : `Nada consta em ${juntar(conferidas)}. Ficaram de fora ${juntar(faltam)}, porque ${porque}. Confira no link.`;
  return { status: 'parcial', link: LINK_TCU, aviso: [falhaConsolidada, ...erros].join('. '), certidoes: listas,
    itens: [{ tipo: 'info', texto, fonte, link: LINK_TCU }] };
}

/* ------------------------------------------------------------------ *
 *  Outras empresas dos sócios
 * ------------------------------------------------------------------ */

const MAX_EMPRESAS_POR_SOCIO = 12;

async function cnpja(f, chave, caminho) {
  const r = await f('https://api.cnpja.com' + caminho, { headers: { Authorization: chave }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('CNPJá HTTP ' + r.status + (j.message ? ': ' + j.message : ''));
  return j;
}

const SITUACOES_CNPJA = { 1: 'NULA', 2: 'ATIVA', 3: 'SUSPENSA', 4: 'INAPTA', 8: 'BAIXADA' };

/**
 * Situação da empresa na Receita. Primeiro o cache do CNPJá (com a chave, sem gastar
 * crédito), depois a BrasilAPI. A BrasilAPI demora vários segundos em CNPJ que ela
 * não tem em cache, por isso o prazo maior. Null quando nenhuma das duas respondeu.
 */
async function situacaoReceita(f, cnpj, chaveCnpja) {
  if (chaveCnpja) {
    try {
      const j = await cnpja(f, chaveCnpja, '/office/' + cnpj + '?strategy=CACHE');
      if (j && j.status) {
        return {
          razao: (j.company && j.company.name) || '',
          situacao: String(SITUACOES_CNPJA[j.status.id] || j.status.text || '').toUpperCase(),
          dataSituacao: j.statusDate || null,
          abertura: j.founded || null,
          fonte: 'CNPJá',
        };
      }
    } catch { /* fora do cache do CNPJá: tenta a BrasilAPI */ }
  }
  try {
    const r = await f('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      razao: j.razao_social || '',
      situacao: String(j.descricao_situacao_cadastral || '').toUpperCase(),
      dataSituacao: j.data_situacao_cadastral || null,
      abertura: j.data_inicio_atividade || null,
      fonte: 'BrasilAPI',
    };
  } catch { return null; }
}

/** Encontra o sócio no CNPJá. O CPF vem mascarado da Receita ("***123456**"): os 6 dígitos do meio separam homônimos. */
async function acharPessoa(f, chave, socio) {
  const j = await cnpja(f, chave, '/person?limit=10&name.in=' + encodeURIComponent(socio.nome));
  const digitos = soDigitos(socio.documento);
  const candidatos = (j.records || []).filter(p => p.type === (socio.pj ? 'LEGAL' : 'NATURAL'))
    .filter(p => semAcento(p.name).toUpperCase() === semAcento(socio.nome).toUpperCase());
  if (digitos.length >= 6) return candidatos.find(p => soDigitos(p.taxId).includes(digitos.slice(0, 6))) || null;
  return candidatos.length === 1 ? candidatos[0] : null;
}

function avaliarSocio(nome, empresas, agora) {
  const itens = [];
  const fonte = 'CNPJá + Receita';
  const problema = empresas.filter(e => /INAPTA|SUSPENSA|NULA/.test(e.situacao));
  const baixadasRecentes = empresas.filter(e => /BAIXADA/.test(e.situacao) && e.dataSituacao && mesesDesde(e.dataSituacao, agora) <= 36);
  const abertasRecentes = empresas.filter(e => e.abertura && mesesDesde(e.abertura, agora) <= 24);
  const ativas = empresas.filter(e => /ATIVA/.test(e.situacao));
  const consultadas = empresas.filter(e => e.situacao);
  const lista = l => l.slice(0, 3).map(e => e.razao || e.cnpj).join(', ') + (l.length > 3 ? '…' : '');

  if (problema.length) {
    itens.push({ tipo: problema.length >= 2 ? 'ruim' : 'atencao', texto: `${nome} é sócio de ${problema.length} empresa(s) inapta(s) ou suspensa(s) na Receita: ${lista(problema)}.`, fonte });
  }
  if (baixadasRecentes.length >= 2) {
    itens.push({ tipo: 'atencao', texto: `${nome} fechou ${baixadasRecentes.length} empresas nos últimos 3 anos: ${lista(baixadasRecentes)}.`, fonte });
  }
  if (abertasRecentes.length >= 3) {
    itens.push({ tipo: 'atencao', texto: `${nome} abriu ${abertasRecentes.length} empresas nos últimos 2 anos. Abrir CNPJ em série é padrão de golpe de crediário.`, fonte });
  }
  const naoConsultadas = empresas.length - consultadas.length;
  if (!empresas.length) {
    itens.push({ tipo: 'info', texto: `${nome} não tem outras empresas.`, fonte });
  } else if (!consultadas.length) {
    // Sem a situação não dá para dizer que está tudo bem
    itens.push({ tipo: 'info', texto: `${nome} participa de ${empresas.length} outra(s) empresa(s), mas a situação delas na Receita não pôde ser consultada agora. Tente "pesquisar de novo" mais tarde.`, fonte });
  } else if (!itens.length) {
    const resto = naoConsultadas ? ` A situação de ${naoConsultadas} não pôde ser consultada.` : '';
    itens.push({ tipo: naoConsultadas ? 'info' : 'bom', texto: `${nome} participa de ${empresas.length} outra(s) empresa(s): ${ativas.length} ativa(s) e nenhuma inapta ou suspensa entre as ${consultadas.length} consultada(s).${resto}`, fonte });
  } else if (naoConsultadas) {
    itens.push({ tipo: 'info', texto: `A situação de ${naoConsultadas} empresa(s) de ${nome} não pôde ser consultada.`, fonte });
  }
  return itens;
}

async function verificarSocios(d, { fetch: f, chaveCnpja, agora }) {
  const raiz = soDigitos(d.cnpj).slice(0, 8);
  const socios = (d.socios || []).filter(s => s.nome).slice(0, 6);
  const itens = [];
  if (!socios.length) return { status: 'ok', socios: [], itens: [{ tipo: 'info', texto: 'A Receita não traz quadro societário (comum em MEI e empresário individual).' }] };

  const saida = [];
  let semChave = 0, orcamento = 24;   // consultas de situação por análise
  for (const s of socios) {
    const doc = soDigitos(s.documento);
    // Sócio que é empresa: a própria situação dele conta
    if (s.pj && doc.length === 14) {
      const sit = await situacaoReceita(f, doc, chaveCnpja);
      const empresas = sit ? [{ cnpj: doc, ...sit, papel: 'sócia' }] : [];
      saida.push({ nome: s.nome, encontrado: !!sit, empresas });
      if (sit && /INAPTA|SUSPENSA|BAIXADA|NULA/.test(sit.situacao)) {
        itens.push({ tipo: 'atencao', texto: `A sócia ${s.nome} está ${sit.situacao} na Receita.`, fonte: 'Receita' });
      }
      continue;
    }
    if (!chaveCnpja) { semChave++; saida.push({ nome: s.nome, encontrado: null, empresas: [] }); continue; }

    let pessoa = null;
    try { pessoa = await acharPessoa(f, chaveCnpja, s); } catch (e) { saida.push({ nome: s.nome, erro: e.message, empresas: [] }); continue; }
    if (!pessoa) { saida.push({ nome: s.nome, encontrado: false, empresas: [] }); continue; }

    const detalhe = await cnpja(f, chaveCnpja, '/person/' + encodeURIComponent(pessoa.id));
    const todasOutras = (detalhe.membership || [])
      .filter(m => m.company && m.company.id && soDigitos(m.company.id) !== raiz);
    const empresas = await emLotes(todasOutras.slice(0, MAX_EMPRESAS_POR_SOCIO), 2, async m => {
      const cnpj = cnpjMatriz(m.company.id);
      const sit = orcamento-- > 0 ? await situacaoReceita(f, cnpj, chaveCnpja) : null;
      return {
        cnpj, razao: m.company.name || (sit && sit.razao) || '', papel: (m.role && m.role.text) || '', desde: m.since || null,
        situacao: sit ? sit.situacao : '', dataSituacao: sit ? sit.dataSituacao : null, abertura: sit ? sit.abertura : null,
      };
    });
    saida.push({ nome: s.nome, encontrado: true, totalEmpresas: todasOutras.length, empresas });
    itens.push(...avaliarSocio(s.nome, empresas, agora));
  }
  if (semChave) {
    itens.push({ tipo: 'info', texto: `Outras empresas de ${semChave} sócio(s) pessoa física não foram pesquisadas: falta configurar CNPJA_API_KEY (plano grátis do CNPJá).` });
  }
  return { status: chaveCnpja ? 'ok' : 'parcial', socios: saida, itens };
}

/* ------------------------------------------------------------------ *
 *  Orquestração
 * ------------------------------------------------------------------ */

async function seguro(fn) {
  try { return await fn(); } catch (e) {
    return { status: 'erro', erro: e.message, itens: [] };
  }
}

/**
 * @param {object} d  saída de dadosBasicos()
 * @param {object} op {fetch, lookup, chaveGoogle, chaveCnpja, chaveTavily, chavePortal, agora}
 */
async function pesquisarInternet(d, op = {}) {
  const opcoes = {
    fetch: op.fetch || globalThis.fetch,
    lookup: op.lookup || dns.lookup,
    chaveGoogle: op.chaveGoogle || '',
    chaveCnpja: op.chaveCnpja || '',
    chaveTavily: op.chaveTavily || '',
    chavePortal: op.chavePortal || '',
    agora: op.agora || Date.now(),
  };
  const endereco = verificarEndereco(d);
  const [maps, dominio, noticias, socios, web, sancoes] = await Promise.all([
    seguro(() => verificarMaps(d, opcoes)),
    seguro(() => verificarDominio(d, opcoes)),
    seguro(() => verificarNoticias(d, opcoes)),
    seguro(() => verificarSocios(d, opcoes)),
    seguro(() => verificarWeb(d, opcoes)),
    seguro(() => verificarSancoes(d, opcoes)),
  ]);
  if (!sancoes.link) sancoes.link = LINK_TCU;
  if (!maps.linkBusca) maps.linkBusca = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(endereco.endereco);
  return {
    consultadoEm: new Date(opcoes.agora).toISOString(),
    endereco, maps, dominio, noticias, socios, web, sancoes,
    links: linksPesquisa(d),
  };
}

module.exports = {
  pesquisarInternet, dadosBasicos, nomeLimpo, mesmoNome, cnpjMatriz, dominioRegistrado,
  ipPrivado, lerRss, verificarEndereco, TERMOS_RISCO, citaEmpresa, nomesDaEmpresa, termoBusca,
};
