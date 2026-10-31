-- credweb · esquema inicial
-- Toda tabela de dados de cliente leva empresa_id, e toda consulta filtra por ele.

CREATE TABLE empresas (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  cnpj          TEXT NOT NULL UNIQUE,
  plano         TEXT NOT NULL DEFAULT 'teste',          -- teste | basico | profissional
  limite_mensal INTEGER NOT NULL DEFAULT 10,            -- análises por mês
  ativa         BOOLEAN NOT NULL DEFAULT TRUE,
  teste_ate     DATE,                                   -- fim do período de teste
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- tetos por faixa, ramos afins
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usuarios (
  id          BIGSERIAL PRIMARY KEY,
  empresa_id  BIGINT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,                     -- sempre em minúsculas
  senha_hash  TEXT NOT NULL,
  papel       TEXT NOT NULL DEFAULT 'vendedor',         -- admin | vendedor
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  aceite_termos_em TIMESTAMPTZ,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usuarios_empresa ON usuarios (empresa_id);

-- Guarda só o hash do token; o token em si vive apenas no cookie.
CREATE TABLE sessoes (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em   TIMESTAMPTZ NOT NULL,
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessoes_usuario ON sessoes (usuario_id);

CREATE TABLE analises (
  id          BIGSERIAL PRIMARY KEY,
  empresa_id  BIGINT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id  BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  cnpj        TEXT NOT NULL,
  razao       TEXT,
  valor       NUMERIC(14,2),
  entrada     NUMERIC(14,2),
  score       INTEGER,
  faixa       TEXT,                                     -- A | B | C | D | REPROVADO
  limite      NUMERIC(14,2),
  modo        TEXT NOT NULL DEFAULT 'basico',           -- basico (sem bureau) | bureau
  resultado   JSONB NOT NULL,                           -- critérios, alertas, recomendação
  pagou       TEXT,                                     -- sim | atrasou | nao (preenchido depois)
  pagou_em    TIMESTAMPTZ,
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analises_empresa_data ON analises (empresa_id, criada_em DESC);
CREATE INDEX analises_empresa_cnpj ON analises (empresa_id, cnpj);

-- Cache de fontes PÚBLICAS (Receita e pesquisa na internet), compartilhado
-- entre empresas para economizar cota. Dado de bureau NUNCA entra aqui.
CREATE TABLE cache_publico (
  cnpj       TEXT NOT NULL,
  tipo       TEXT NOT NULL,                             -- receita | pesquisa
  dados      JSONB NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cnpj, tipo)
);

-- Registro de quem fez o quê (LGPD): consultas, logins, mudanças de configuração.
CREATE TABLE auditoria (
  id          BIGSERIAL PRIMARY KEY,
  empresa_id  BIGINT REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id  BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  acao        TEXT NOT NULL,
  detalhe     JSONB,
  ip          TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_empresa_data ON auditoria (empresa_id, criado_em DESC);
