# Deploy no EasyPanel

O credweb roda num **projeto próprio** no EasyPanel, separado do projeto da Águia Diesel.

## 1. Projeto e banco

1. No EasyPanel, crie um projeto novo chamado `credweb`.
2. Dentro dele, adicione um serviço **Postgres** (nome sugerido: `credweb_db`). Anote usuário, senha e o host interno.

## 2. App

1. Adicione um serviço **App** apontando para o repositório `webmedula/credweb`, branch `main`, build por **Dockerfile**.
2. Em **Environment**, preencha a partir do `.env.example`:
   - `DATABASE_URL=postgres://USUARIO:SENHA@credweb_db:5432/credweb` (o host é o nome interno do serviço Postgres)
   - `SUPERADMIN_EMAILS=seu-email@...` (o mesmo que você vai usar no cadastro)
   - As chaves das fontes públicas. **Crie chaves novas para o credweb**; não reaproveite as da Águia Diesel, para que a cota e a conta de uma não afetem a outra.
3. Porta do app: `3000`.
4. Em **Domains**, adicione o domínio com HTTPS.
5. Deploy. Na primeira subida o app cria as tabelas sozinho (veja o log: "Migrações aplicadas").

## 3. Conferir

- `https://SEU-DOMINIO/health` deve responder `{"ok":true,...}`.
- Crie a sua conta em `https://SEU-DOMINIO/#cadastro` com o e-mail de `SUPERADMIN_EMAILS`. A aba **Administração** aparece para você.
- Faça uma análise de um CNPJ conhecido e confira a seção "O que as fontes públicas mostram". Fonte que aparece como "não configurada" está sem chave.

## 4. Backup

Configure o backup diário do Postgres no EasyPanel (aba Backups do serviço), de preferência para um destino fora do VPS (S3 ou Backblaze B2).

## Observações

- Não há volume para montar: tudo fica no Postgres.
- O cookie de sessão exige HTTPS. Só use `COOKIE_SEGURO=false` para testar sem domínio.
- `CADASTRO_ABERTO=false` fecha o cadastro de novas empresas, se quiser liberar só por convite no começo.
