-- Esquema inicial de la base de conocimiento.
--
-- OJO: este archivo SOLO se ejecuta la primera vez que se crea el volumen
-- kb_seo_pgdata. Si ya tienes datos y quieres cambiar el esquema, escribe el
-- cambio en sql/migrate.sql y aplicalo con:  uv run kb-migrate
--
-- Se usa la config 'simple' en el tsvector a proposito: las fuentes mezclan
-- espanol e ingles y un stemmer de un solo idioma estropearia el otro.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT UNIQUE NOT NULL,        -- o ruta local
  title         TEXT,
  source_type   TEXT NOT NULL,               -- web | youtube | pdf | local
  platforms     TEXT[] NOT NULL,             -- {youtube,tiktok,instagram,general}
  author        TEXT,
  published_at  DATE,                        -- critico: los algoritmos cambian
  lang          TEXT,
  topics        TEXT[],
  content_hash  TEXT NOT NULL,
  ingested_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INT NOT NULL,
  content      TEXT NOT NULL,
  embedding    VECTOR(384) NOT NULL,     -- multilingual-e5-small
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks USING gin (tsv);
CREATE INDEX ON documents (published_at);
CREATE INDEX ON documents USING gin (platforms);

-- Acelera el borrado en cascada y el reemplazo de chunks al reingerir.
CREATE INDEX ON chunks (document_id);

-- ---------------------------------------------------------------------------
-- Roles. Las credenciales vienen del entorno del contenedor (ver .env).
-- ---------------------------------------------------------------------------

\getenv kb_writer_user KB_WRITER_USER
\getenv kb_writer_password KB_WRITER_PASSWORD
\getenv kb_reader_user KB_READER_USER
\getenv kb_reader_password KB_READER_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'kb_writer_user', :'kb_writer_password') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'kb_reader_user', :'kb_reader_password') \gexec

-- kb_writer: lectura y escritura sobre los datos, pero no puede crear tablas.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'kb_writer_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'kb_writer_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'kb_writer_user') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'kb_writer_user') \gexec

-- kb_reader: SELECT y nada mas. Es el que usa el servidor MCP.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'kb_reader_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'kb_reader_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'kb_reader_user') \gexec

-- Que las tablas futuras (migraciones) hereden los mismos permisos.
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'kb_writer_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'kb_writer_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'kb_reader_user') \gexec

-- Nadie mas crea objetos en public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
