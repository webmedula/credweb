'use strict';

const $ = id => document.getElementById(id);

async function enviar(url, corpo) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Erro ' + r.status);
  return j;
}

function aba(qual) {
  $('formLogin').classList.toggle('oculto', qual !== 'login');
  $('formCadastro').classList.toggle('oculto', qual !== 'cadastro');
  $('abaLogin').classList.toggle('prim', qual === 'login');
  $('abaCadastro').classList.toggle('prim', qual === 'cadastro');
}
$('abaLogin').addEventListener('click', () => aba('login'));
$('abaCadastro').addEventListener('click', () => aba('cadastro'));
aba(location.hash === '#cadastro' ? 'cadastro' : 'login');

// Já logado? Vai direto para o app.
fetch('/api/eu').then(r => { if (r.ok) location.href = '/app.html'; });

$('formLogin').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('erroLogin').textContent = '';
  try {
    await enviar('/api/login', { email: $('lEmail').value, senha: $('lSenha').value });
    location.href = '/app.html';
  } catch (e) { $('erroLogin').textContent = e.message; }
});

$('formCadastro').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('erroCadastro').textContent = '';
  try {
    await enviar('/api/cadastro', {
      empresaNome: $('cEmpresa').value, empresaCnpj: $('cCnpj').value, nome: $('cNome').value,
      email: $('cEmail').value, senha: $('cSenha').value, aceiteTermos: $('cTermos').checked,
    });
    location.href = '/app.html';
  } catch (e) { $('erroCadastro').textContent = e.message; }
});
