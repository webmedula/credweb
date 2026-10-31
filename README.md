# credweb

Análise de crédito de empresas (PJ) para venda a prazo, vendida como SaaS. Nasceu da ferramenta interna da Águia Diesel, mas é um sistema separado: não usa o contrato da Águia Diesel com a Innove nem os dados dela.

## O que a fase 1 entrega

- Cadastro de empresa com teste grátis (14 dias, 10 análises), login por e-mail e senha, sessão por cookie.
- Análise **sem bureau** (plano Básico): Receita Federal + fontes públicas (sanções CEIS/CNEP/TCU, endereço e Google Maps, e-mail/domínio, sócios e outras empresas deles, notícias e busca na web).
- Score 0–100 calculado no servidor (`src/score.js`): Receita 60 + fontes públicas 40. Sem bureau a faixa máxima é a B.
- Faixa, limite sugerido em reais e entrada mínima, com teto por faixa configurável por empresa.
- Histórico por empresa, com o campo "o cliente pagou?" para calibrar o score depois.
- Limite de análises por mês por empresa, bloqueio de teste vencido e de conta suspensa.
- Tela de administração da plataforma para os e-mails em `SUPERADMIN_EMAILS` (plano, limite, teste, ativa).
- Registro de auditoria (LGPD): cadastro, login, cada análise, mudanças de configuração.

Fica para as próximas fases: credencial de bureau por empresa (Innove primeiro), convite de usuários, recuperação de senha por e-mail e cobrança recorrente.

## Como os dados ficam separados

Toda tabela de cliente tem `empresa_id`, e toda consulta da API filtra pela empresa do usuário logado. O único dado compartilhado entre empresas é o cache de **fontes públicas** (`cache_publico`, 7 dias), para economizar cota das chaves. Dado de bureau nunca vai para esse cache.

## Rodar localmente

```bash
npm install
cp .env.example .env      # ajuste DATABASE_URL
export $(grep -v '^#' .env | xargs)
COOKIE_SEGURO=false npm start   # migra o banco ao subir
```

## Testes

```bash
DATABASE_URL_TESTE=postgres://postgres@localhost/credweb_teste npm run teste
```

O banco de teste é **apagado** a cada execução. Sem `DATABASE_URL_TESTE`, os testes da API são pulados e só rodam os de score, Receita e pesquisa.

## Estrutura

| Arquivo | O quê |
| --- | --- |
| `src/server.js` | Lê as variáveis de ambiente, migra o banco e sobe o servidor |
| `src/app.js` | Rotas da API (Fastify) |
| `src/score.js` | Régua do modo Básico (função pura, testada) |
| `src/auth.js` | Senha (scrypt), sessões, limite de tentativas de login |
| `src/fontes/receita.js` | BrasilAPI / CNPJ.ws e normalização |
| `src/fontes/pesquisa.js` | Fontes públicas (vindo da ferramenta da Águia Diesel) |
| `sql/` | Migrações, aplicadas em ordem ao subir |
| `public/` | Telas (HTML + JS sem framework) |

Deploy: veja [DEPLOY-EASYPANEL.md](DEPLOY-EASYPANEL.md).
