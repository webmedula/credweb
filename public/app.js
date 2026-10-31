'use strict';

const $ = id => document.getElementById(id);
let eu = null;

/* ---------- utilitários ---------- */
function el(tag, attrs, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : String(f));
  return n;
}
const brl = v => (v === null || v === undefined || v === '') ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataHora = s => s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtCnpj = c => String(c || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const linkSeguro = u => /^https?:\/\//i.test(String(u || '')) ? u : null;

async function api(url, opcoes = {}) {
  const r = await fetch(url, {
    ...opcoes,
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('Sessão encerrada.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Erro ' + r.status);
  return j;
}

/* ---------- navegação ---------- */
function mostrar(tela) {
  for (const s of document.querySelectorAll('main > section')) s.classList.toggle('oculto', s.id !== 'tela-' + tela);
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('ativo', b.dataset.tela === tela);
  if (tela === 'historico') carregarHistorico();
  if (tela === 'config') preencherConfig();
  if (tela === 'admin') carregarAdmin();
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => mostrar(b.dataset.tela));

$('sair').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

async function carregarEu() {
  eu = await api('/api/eu');
  $('quem').textContent = eu.usuario.nome + ' · ' + eu.empresa.nome;
  const plano = eu.empresa.plano === 'teste' && eu.empresa.testeAte
    ? 'teste até ' + new Date(eu.empresa.testeAte).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
    : 'plano ' + eu.empresa.plano;
  $('uso').textContent = `${eu.uso.usadas}/${eu.uso.limite} análises no mês · ${plano}`;
  $('navConfig').classList.toggle('oculto', eu.usuario.papel !== 'admin');
  $('navAdmin').classList.toggle('oculto', !eu.superAdmin);
  if (eu.uso.bloqueio) $('erroAnalise').textContent = eu.uso.bloqueio;
}

/* ---------- análise ---------- */
$('formAnalise').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('erroAnalise').textContent = '';
  $('btnAnalisar').disabled = true;
  $('statusAnalise').textContent = ' Consultando Receita e fontes públicas (até 30 segundos)…';
  try {
    const a = await api('/api/analises', { method: 'POST', body: {
      cnpj: $('aCnpj').value, valor: Number($('aValor').value) || 0, entrada: Number($('aEntrada').value) || 0,
    } });
    renderResultado(a);
    carregarEu();
  } catch (e) {
    $('erroAnalise').textContent = e.message;
  } finally {
    $('btnAnalisar').disabled = false;
    $('statusAnalise').textContent = '';
  }
});

const NOMES_SECOES = {
  sancoes: 'Sanções do governo', endereco: 'Endereço', maps: 'Google Maps', dominio: 'E-mail e site',
  socios: 'Sócios e outras empresas', noticias: 'Notícias', web: 'Busca na web',
};
const ROTULO_TIPO = { ruim: 'Problema', atencao: 'Atenção', bom: 'OK', info: 'Info' };

function renderResultado(a) {
  const r = a.resultado, e = a.empresa || {};
  const box = $('resultado');
  box.replaceChildren();

  box.append(el('div', { class: 'card' },
    el('div', { class: 'resumo' },
      el('div', { class: 'nota fx-' + r.faixa }, r.reprovado ? '✕' : r.score),
      el('div', {},
        el('div', { class: 'faixa' }, r.faixa === 'REPROVADO' ? 'Reprovado' : `Faixa ${r.faixa} · ${r.faixaNome}`),
        el('div', {}, el('b', {}, e.razao || ''), ' · ', fmtCnpj(a.cnpj), e.cidade ? ' · ' + e.cidade : ''),
        el('p', {}, r.recomendacao),
        r.limite !== null ? el('p', {}, 'Limite sugerido: ', el('b', {}, brl(r.limite)), ' · entrada mínima: ', el('b', {}, brl(r.entradaMinima))) : null,
      )),
    el('p', { class: 'aviso' }, r.aviso),
    r.alertas.length ? el('div', {}, el('h3', {}, 'Pontos de atenção'), el('ul', { class: 'alertas' }, r.alertas.map(t => el('li', {}, t)))) : null,
  ));

  box.append(el('div', { class: 'card' },
    el('h2', {}, 'Como a nota foi calculada'),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Critério'), el('th', {}, 'Avaliação'), el('th', { class: 'num' }, 'Pontos'))),
      el('tbody', {}, r.criterios.map(c => el('tr', {},
        el('td', {}, c.criterio, el('div', { class: 'muted' }, c.grupo)),
        el('td', {}, c.avaliacao),
        el('td', { class: 'num' }, `${c.pontos} / ${c.max}`)))))));

  const p = a.pesquisa || {};
  const secoes = Object.keys(NOMES_SECOES).filter(k => p[k]);
  if (secoes.length) {
    box.append(el('div', { class: 'card' },
      el('h2', {}, 'O que as fontes públicas mostram'),
      secoes.map(k => {
        const s = p[k];
        const itens = s.itens || [];
        const corpo = s.status === 'nao_configurado' ? [el('div', { class: 'item muted' }, 'Fonte não configurada.')]
          : s.status === 'erro' ? [el('div', { class: 'item muted' }, 'Não foi possível consultar agora: ' + (s.erro || ''))]
          : itens.length ? itens.map(i => el('div', { class: 'item' },
              el('span', { class: 't-' + i.tipo }, (ROTULO_TIPO[i.tipo] || i.tipo) + ': '), i.texto,
              linkSeguro(i.link) ? el('span', {}, ' ', el('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer' }, 'ver')) : null))
          : [el('div', { class: 'item muted' }, 'Nada a relatar.')];
        return el('div', {}, el('h3', {}, NOMES_SECOES[k]), corpo);
      })));
  }
  box.scrollIntoView({ behavior: 'smooth' });
}

/* ---------- histórico ---------- */
let buscaTimer = null;
$('hBusca').addEventListener('input', () => { clearTimeout(buscaTimer); buscaTimer = setTimeout(carregarHistorico, 300); });

async function carregarHistorico() {
  const q = $('hBusca').value.replace(/\D/g, '');
  const { analises } = await api('/api/analises' + (q ? '?cnpj=' + q : ''));
  const tb = $('hLista');
  tb.replaceChildren();
  if (!analises.length) { tb.append(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Nenhuma análise ainda.'))); return; }
  for (const a of analises) {
    const sel = el('select', { onclick: ev => ev.stopPropagation(), onchange: async ev => {
      try { await api('/api/analises/' + a.id, { method: 'PATCH', body: { pagou: ev.target.value || null } }); }
      catch (e) { alert(e.message); }
    } },
    [['', '—'], ['sim', 'Pagou em dia'], ['atrasou', 'Pagou com atraso'], ['nao', 'Não pagou']]
      .map(([v, t]) => el('option', { value: v, selected: (a.pagou || '') === v ? 'selected' : null }, t)));
    tb.append(el('tr', { class: 'clicavel', onclick: () => abrirAnalise(a.id) },
      el('td', {}, dataHora(a.criada_em)),
      el('td', {}, a.razao || '', el('div', { class: 'muted' }, fmtCnpj(a.cnpj))),
      el('td', {}, el('span', { class: 'etq fx-' + a.faixa }, a.faixa)),
      el('td', { class: 'num' }, a.score),
      el('td', { class: 'num' }, brl(a.limite)),
      el('td', {}, sel),
      el('td', {}, a.usuario || '')));
  }
}

async function abrirAnalise(id) {
  const a = await api('/api/analises/' + id);
  mostrar('analise');
  renderResultado(a);
}

/* ---------- configurações ---------- */
function preencherConfig() {
  const c = (eu && eu.empresa.config) || {};
  const t = c.tetos || {};
  $('tA').value = t.A || ''; $('tB').value = t.B || ''; $('tC').value = t.C || '';
  $('ramos').value = (c.ramosAfins || []).join(', ');
  const f = eu ? eu.fontes : {};
  $('fontes').replaceChildren(
    ...[['Receita Federal (BrasilAPI / CNPJ.ws)', true], ['Sanções CEIS/CNEP (Portal da Transparência)', f.portalTransparencia],
      ['Google Maps', f.googleMaps], ['Outras empresas dos sócios (CNPJá)', f.cnpja], ['Busca na web (Tavily)', f.tavily]]
      .map(([n, ok]) => el('div', { class: 'item' }, el('span', { class: ok ? 't-bom' : 't-atencao' }, ok ? 'Ativa: ' : 'Desligada: '), n)));
}

$('formConfig').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('okConfig').textContent = ''; $('erroConfig').textContent = '';
  try {
    await api('/api/empresa/config', { method: 'PUT', body: {
      tetos: { A: $('tA').value, B: $('tB').value, C: $('tC').value },
      ramosAfins: $('ramos').value.split(',').map(s => s.trim()).filter(Boolean),
    } });
    await carregarEu();
    preencherConfig();
    $('okConfig').textContent = 'Salvo.';
  } catch (e) { $('erroConfig').textContent = e.message; }
});

/* ---------- administração ---------- */
async function carregarAdmin() {
  $('erroAdmin').textContent = '';
  const { empresas } = await api('/api/admin/empresas');
  const tb = $('adLista');
  tb.replaceChildren();
  for (const e of empresas) {
    const plano = el('select', {}, ['teste', 'basico', 'profissional'].map(p => el('option', { value: p, selected: e.plano === p ? 'selected' : null }, p)));
    const limite = el('input', { type: 'number', min: 0, value: e.limite_mensal });
    const teste = el('input', { type: 'date', value: e.teste_ate ? String(e.teste_ate).slice(0, 10) : '' });
    const ativa = el('input', { type: 'checkbox', checked: e.ativa ? 'checked' : null });
    const salvar = el('button', { class: 'sec', type: 'button', onclick: async () => {
      try {
        await api('/api/admin/empresas/' + e.id, { method: 'PATCH', body: {
          plano: plano.value, limiteMensal: Number(limite.value), testeAte: teste.value || null, ativa: ativa.checked,
        } });
        salvar.textContent = 'Salvo';
      } catch (err) { $('erroAdmin').textContent = err.message; }
    } }, 'Salvar');
    tb.append(el('tr', {},
      el('td', {}, e.nome, el('div', { class: 'muted' }, fmtCnpj(e.cnpj) + ' · ' + e.usuarios + ' usuário(s)')),
      el('td', {}, plano), el('td', { class: 'num' }, e.analises_mes), el('td', {}, limite),
      el('td', {}, teste), el('td', {}, ativa), el('td', {}, salvar)));
  }
}

carregarEu().catch(e => { $('erroAnalise').textContent = e.message; });
